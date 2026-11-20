using System.Diagnostics;
using System.Runtime;
using System.Text.Json;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpGcWindowChecks
{
    public static async Task Run(string root)
    {
        var config=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:RepositoryRoot"]=root,["Backend:ExecutionRoot"]=Path.Combine(root,"artifacts","gc-window-"+Guid.NewGuid().ToString("N"))}).Build();
        var resources=new ExecutionResources(new ExecutionResourceSettings(config));
        using var group=resources.Reserve(new("gc-window-probe",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000));
        var info=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        CSharpHostSession.RestrictEnvironment(info);
        if(Path.GetFileNameWithoutExtension(Environment.ProcessPath)=="dotnet")info.ArgumentList.Add(typeof(CSharpGcWindowChecks).Assembly.Location);
        info.ArgumentList.Add(root);info.ArgumentList.Add("csharp-gc-child");
        using var process=new Process{StartInfo=info};process.Start();
        try
        {
            group.Assign(process);var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
            await process.StandardInput.WriteLineAsync("go");process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(3));
            var text=await output;if(process.ExitCode!=0)throw new Exception("GC window probe failed: "+await errors+text);
            using var report=JsonDocument.Parse(text);
            if(!report.RootElement.GetProperty("PublicCSharpEnabled").GetBoolean()&&report.RootElement.GetProperty("Checks").GetInt32()>10)
                await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-gc-window-report.json"),text);
            else throw new Exception("Incomplete GC probe.");
            Console.WriteLine($"C# GC window checks: {report.RootElement.GetProperty("Checks").GetInt32()} passed; isolated experiment, typed reservation/lost-region failures and bounded worker allocation. Public host unchanged.");
        }
        finally{using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));await group.TerminateAndDrain(timeout.Token);}
        group.Dispose();
        await PreparedHosts(root,resources);
    }
    private static async Task PreparedHosts(string root,ExecutionResources resources)
    {
        int checks=0;var rows=new List<object>();void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var directory=Path.Combine(root,"artifacts","prepared-gc-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpGcWindowChecks).Assembly.Location)!)!.FullName)!.FullName;
        var host=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");var owner=Guid.NewGuid();
        var profile=new ResourceProfile("prepared-gc-probe",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000);
        await using var store=new CSharpPreparationStore(Path.Combine(directory,"cache"),host,resources,new(profile,TimeSpan.FromSeconds(30),16L*1024*1024,1024*1024,128L*1024*1024));
        var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(2),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        async Task<string> Prepare(string code,string name)
        {
            var path=Path.Combine(directory,name+".cs");await File.WriteAllTextAsync(path,code);
            var prepared=await store.PrepareAsync(owner,path,CoinHunter.Contracts.CSharpArtifactKeys.Hash(System.Text.Encoding.UTF8.GetBytes(code)));
            Assert(prepared.Status=="prepared","Prepared GC source failed: "+prepared.Status);return prepared.Key!;
        }
        string Stateful(int retainedMiB)
        {
            int fields=retainedMiB/8;
            string declarations=string.Concat(Enumerable.Range(0,fields).Select(i=>"long[] m"+i+";"));
            string initialize=string.Concat(Enumerable.Range(0,fields).Select(i=>"m"+i+"=new long[1048576];for(int j=0;j<m"+i+".Length;j+=512)m"+i+"[j]=1;"));
            return "public class Player{int turn;int state;"+declarations+"public void Initialize(int n,int c,int r){"+initialize+"}public string GetName(){return \"prepared-gc\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1){while(true){}}if(p==2){for(int i=0;i<64;i++){var a=new int[1048576];state=a[0];}}return turn%4;}}";
        }
        var bfs=await Prepare(await File.ReadAllTextAsync(Path.Combine(root,"backend/examples/csharp/nearest-coin.cs")),"bfs");
        var launch=new CSharpPreparedLaunch(host,owner,bfs,0,20,16,profile,watchdogs);
        var map=new int[320];map[^1]=500;
        bool completed=false;
        try
        {
            foreach(bool enabled in new[]{false,true})
            await using(var session=await manager.CreatePreparedAsync(store,launch with{ExperimentalGcWindow=enabled}))
            {
                for(int call=0;call<50;call++)
                {
                    var clock=Stopwatch.StartNew();
                    try
                    {
                        var result=await session.MoveNextAsync(map,0,[-1,-1,-1,-1]);
                        Assert(result.Status=="ok"&&result.Direction==2,"Prepared BFS changed result.");
                        Assert(enabled?result.ExperimentalMemory?.RegionIntact==true:result.ExperimentalMemory is null,"Prepared host memory-mode binding lost.");
                        rows.Add(new{scenario="prepared-identical-bfs",enabled,call,roundTripMs=clock.Elapsed.TotalMilliseconds,result});
                    }
                    catch(CSharpHostFailure failure)when(enabled&&failure.CleanupConfirmed&&failure.Reason.StartsWith("gc-",StringComparison.Ordinal))
                    {rows.Add(new{scenario="prepared-identical-bfs",enabled,call,status=failure.Reason,cleanupConfirmed=true});break;}
                }
            }
            foreach(int retainedMiB in new[]{0,128})
            {
                string key=await Prepare(Stateful(retainedMiB),"retained-"+retainedMiB);
                foreach(bool enabled in new[]{false,true})
                {
                    await using(var session=await manager.CreatePreparedAsync(store,launch with{Key=key,ExperimentalGcWindow=enabled}))
                    {
                        var identity=session.Identity!;int iteration=0;
                        try
                        {
                            foreach(int p in new[]{0,1,0})
                            {
                                var clock=Stopwatch.StartNew();var result=await session.MoveNextAsync([0,0,0],p,[-1,-1,-1,-1]);iteration++;
                                Assert(result.InstanceId==identity.InstanceId&&result.ProcessId==identity.ProcessId&&result.ExecutionSettled&&result.Status==(p==1?"timeout":"ok"),"Prepared GC timeout reused a different process/object or did not settle.");
                                if(p==0)Assert(result.Direction==iteration%4,"Prepared GC timeout discarded fields.");
                                rows.Add(new{scenario="prepared-state-reuse",enabled,retainedMiB,iteration,roundTripMs=clock.Elapsed.TotalMilliseconds,result});
                            }
                        }
                        catch(CSharpHostFailure failure)when(enabled&&failure.CleanupConfirmed&&failure.Reason.StartsWith("gc-",StringComparison.Ordinal))
                        {rows.Add(new{scenario="prepared-state-reuse",enabled,retainedMiB,iteration,status=failure.Reason,cleanupConfirmed=true});}
                    }
                    for(int repetition=0;repetition<3;repetition++)
                    {
                        // The trusted fixture waits inside the active budget;
                        // guest source still cannot use clock/sleep/thread APIs.
                        using var artifact=await store.AcquireAsync(owner,key);
                        var boundary=new CSharpHostLaunch(host,artifact.ManifestPath,artifact.Manifest.SourceHash,0,20,16,profile,watchdogs){PreparedArtifact=true,ExperimentalGcWindow=enabled,ProbeStall=-7};
                        await using var session=await manager.CreateAsync(boundary);
                        var clock=Stopwatch.StartNew();
                        try
                        {
                            var result=await session.MoveNextAsync([0,0,0],2,[-1,-1,-1,-1]);
                            Assert(result.ExecutionSettled&&result.Status is "ok" or "timeout" or "operation-limit","Prepared boundary did not classify the actual settled call.");
                            rows.Add(new{scenario="prepared-allocation-boundary",enabled,retainedMiB,repetition,roundTripMs=clock.Elapsed.TotalMilliseconds,result});
                        }
                        catch(CSharpHostFailure failure)when(enabled&&failure.CleanupConfirmed&&failure.Reason.StartsWith("gc-",StringComparison.Ordinal))
                        {rows.Add(new{scenario="prepared-allocation-boundary",enabled,retainedMiB,repetition,status=failure.Reason,cleanupConfirmed=true});}
                    }
                }
            }
            completed=true;
        }
        finally
        {
            await manager.StopAsync(default);
            await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-prepared-gc-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,publicCSharpEnabled=false,defaultPolicyEnabled=false,preparationCompilations=store.CompilationStarts,rows,resources=resources.Status}));
        }
        var status=JsonSerializer.SerializeToNode(resources.Status)!;
        Assert(manager.ManagedCount==0&&status["reservedProcesses"]!.GetValue<int>()==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0,"Prepared GC hosts/reservations leaked.");
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-prepared-gc-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,publicCSharpEnabled=false,defaultPolicyEnabled=false,preparationCompilations=store.CompilationStarts,rows,resources=resources.Status}));
        Console.WriteLine($"Prepared C# GC window checks: {checks} passed; real compiler-isolated DLL hosts, IPC cost, timeout state reuse and retained-memory boundary measurements.");
    }
    private sealed record ProbeSample(string Scenario,string Mode,int RetainedMiB,CSharpGcWindowResult Window);
    public static void Child(string root)
    {
        int checks=0;var samples=new List<ProbeSample>();
        void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        string Source(string body)=>"public class Player{int turn;int state;public void Initialize(int n,int c,int r){}public string GetName(){return \"gc-probe\";}public int MoveNext(int[] m,int p,int[] items){turn++;"+body+"}}";
        CSharpCandidate Ready(string code)
        {
            var candidate=CSharpCandidate.Prepare(code);
            Assert(candidate.Construct().Status=="ok"&&candidate.Initialize(0,20,16).Status=="ok"&&candidate.GetName().Status=="ok","GC probe initialization failed.");return candidate;
        }
        void Refuses(CSharpCandidate candidate)
        {
            try{candidate.MoveNext([0],0,[-1,-1,-1,-1]);throw new Exception("Environment-failed actor reused.");}catch(InvalidOperationException){checks++;}
        }
        var policy=CSharpGcWindowPolicy.Probe;
        foreach(var invalid in new[]{new CSharpGcWindowPolicy(-1,long.MaxValue,1),new CSharpGcWindowPolicy(long.MaxValue,1,long.MaxValue),new CSharpGcWindowPolicy(128L*1024*1024,64L*1024*1024,64L*1024*1024)})
        {try{invalid.Validate();throw new Exception("Invalid GC policy accepted.");}catch(ArgumentException){checks++;}}
        using(var refused=Ready(Source("return turn%4;")))
        {
            bool called=false,ended=false,blocking=false;
            var result=CSharpGcWindowCandidate.Run(refused,()=>{called=true;return refused.MoveNext([0],0,[-1,-1,-1,-1]);},policy,(_,_,disallow)=>{blocking=disallow;return false;},()=>ended=true);
            Assert(result.Status=="gc-reservation-unavailable"&&!result.Invoked&&result.Call is null&&!called&&!ended&&blocking,"Reservation failure invoked code/ended an unowned region/forced GC.");Refuses(refused);samples.Add(new("injected-reservation-failure","guarded-no-gc",0,result));
        }
        using(var ordinary=Ready(Source("for(int i=0;i<16;i++){var a=new int[1048576];state=a[0];}return state;")))
            Assert(ordinary.MoveNext([0],0,[-1,-1,-1,-1]).Status=="ok","Experimental allocation limit accidentally enabled on the normal host path.");
        foreach(bool throwing in new[]{false,true})
        using(var failedRecovery=Ready(Source("return turn%4;")))
        {
            int attempts=0,invoked=0;
            var result=CSharpGcWindowCandidate.Run(failedRecovery,()=>{invoked++;return failedRecovery.MoveNext([0],0,[-1,-1,-1,-1]);},policy with{AllowEntryCollection=true},(_,_,_)=>{attempts++;if(throwing&&attempts==2)throw new IOException("injected-entry-failure");return false;});
            Assert(attempts==2&&invoked==0&&!result.Invoked&&result.Entry?.Valid(true,true)==true,"Failed recovery replayed guest code or lost partial observation.");
            Assert(result.Status==(throwing?"gc-call-environment-failure":"gc-reservation-unavailable"),"Entry recovery failure classification changed.");Refuses(failedRecovery);samples.Add(new("failed-entry-recovery-"+throwing,"decommit-once-v2",0,result));
        }
        using(var recovered=Ready(Source("return turn%4;")))
        {
            int attempts=0,invoked=0;
            var result=CSharpGcWindowCandidate.Run(recovered,()=>{invoked++;return recovered.MoveNext([0],0,[-1,-1,-1,-1]);},policy with{AllowEntryCollection=true},(total,large,disallow)=>++attempts==1?false:GC.TryStartNoGCRegion(total,large,disallow));
            Assert(result.Status=="completed"&&attempts==2&&invoked==1&&(int?)result.Call?.Value==1&&result.Entry?.Valid(true)==true,"Successful entry recovery replayed guest call.");
            Assert((int?)recovered.MoveNext([0],0,[-1,-1,-1,-1]).Value==2,"Entry recovery reset original instance state.");samples.Add(new("single-guest-after-entry-recovery","decommit-once-v2",0,result));
        }
        using(var borrowed=Ready(Source("return -1;")))
        {
            if(GC.TryStartNoGCRegion(128L*1024*1024,64L*1024*1024,true))
            {
                try
                {
                    bool invoked=false;var result=CSharpGcWindowCandidate.Run(borrowed,()=>{invoked=true;return borrowed.MoveNext([0],0,[-1,-1,-1,-1]);},policy);
                    Assert(!invoked&&result.Status=="gc-state-conflict"&&GCSettings.LatencyMode==GCLatencyMode.NoGCRegion,"Probe ended another owner's active region.");
                }
                finally{if(GCSettings.LatencyMode==GCLatencyMode.NoGCRegion)GC.EndNoGCRegion();}
            }
        }
        using(var limited=Ready(Source("for(int i=0;i<16;i++){var a=new int[1048576];state=a[0];}return state;")))
        {
            limited.ExperimentalAllocationBudgetBytes=8L*1024*1024;
            var result=limited.MoveNext([0],0,[-1,-1,-1,-1]);
            Assert(result.Status=="operation-limit"&&result.LimitCode=="call-allocation-bytes"&&result.Line>0,"Cumulative allocation limit not enforced/classified.");
        }
        bool regionAvailable=false;
        using(var reusable=Ready(Source("state++;if(p==1){while(true){}}return state%4;")))
        {
            for(int turn=0;turn<3;turn++)
            {
                var result=CSharpGcWindowCandidate.Run(reusable,()=>reusable.MoveNext([0,0],turn==1?1:0,[-1,-1,-1,-1]),policy);
                samples.Add(new("same-instance-normal-timeout-normal","guarded-no-gc",0,result));
                if(result.Status!="completed"){Assert(!result.RegionIntact,"Invalid region reported intact.");Refuses(reusable);break;}
                regionAvailable=true;Assert(result.RegionIntact&&result.CollectionDeltas.All(n=>n==0),"GC occurred in a purported protected call.");
                Assert(result.Call!.InstanceId==reusable.InstanceId&&result.Call.ProcessId==Environment.ProcessId&&result.Call.Status==(turn==1?"timeout":"ok"),"No-GC timeout lost actual settlement/instance/PID.");
                if(turn==2)Assert((int?)result.Call.Value==3,"No-GC timeout discarded existing field mutations.");
            }
        }
        using(var lost=Ready(Source("return -1;")))
        {
            lost.CallStarted=(_,_)=>GC.Collect(2,GCCollectionMode.Forced,blocking:true,compacting:true); // Trusted runtime-fault injection, never guest API.
            var result=CSharpGcWindowCandidate.Run(lost,()=>lost.MoveNext([0],0,[-1,-1,-1,-1]),policy);
            Assert(result.Status is "gc-window-lost" or "gc-reservation-unavailable","Explicit GC loss was silently accepted.");Assert(!result.RegionIntact,"Lost region claimed protected execution.");Refuses(lost);samples.Add(new("injected-runtime-collection","guarded-no-gc",0,result));
        }
        using(var brokenExit=Ready(Source("return -1;")))
        {
            var result=CSharpGcWindowCandidate.Run(brokenExit,()=>brokenExit.MoveNext([0],0,[-1,-1,-1,-1]),policy,endProbe:()=>{GC.EndNoGCRegion();throw new InvalidOperationException("injected-exit-failure");});
            Assert(result.Status is "gc-window-lost" or "gc-reservation-unavailable","GC exit failure accepted.");Refuses(brokenExit);samples.Add(new("injected-exit-failure","guarded-no-gc",0,result));
        }
        using(var otherThread=Ready(Source("return -1;")))
        {
            otherThread.CallStarted=(_,_)=>
            {
                var allocator=new Thread(()=>{GC.KeepAlive(new byte[64*1024*1024]);GC.Collect(2,GCCollectionMode.Forced,blocking:true);}){IsBackground=true};
                allocator.Start();if(!allocator.Join(TimeSpan.FromSeconds(5)))throw new IOException("Trusted host-thread probe stalled.");
            }; // Trusted other-thread allocation/collection; not guest API.
            var result=CSharpGcWindowCandidate.Run(otherThread,()=>otherThread.MoveNext([0],0,[-1,-1,-1,-1]),new(96L*1024*1024,48L*1024*1024,16L*1024*1024));
            Assert(result.Status is "gc-window-lost" or "gc-reservation-unavailable","Another host thread escaped GC-window verification.");Refuses(otherThread);samples.Add(new("other-host-thread-allocation-and-collection","guarded-no-gc",0,result));
        }
        using(var replaced=Ready(Source("return -1;")))
        {
            bool foreign=false;
            replaced.CallStarted=(_,_)=>{GC.Collect(2,GCCollectionMode.Forced,blocking:true);foreign=GC.TryStartNoGCRegion(128L*1024*1024,64L*1024*1024,true);};
            var result=CSharpGcWindowCandidate.Run(replaced,()=>replaced.MoveNext([0],0,[-1,-1,-1,-1]),policy);
            try{Assert(result.Status is "gc-window-lost" or "gc-reservation-unavailable","Replaced GC region accepted.");if(foreign)Assert(GCSettings.LatencyMode==GCLatencyMode.NoGCRegion,"Probe ended an active region established after it lost ownership.");}
            finally{if(foreign&&GCSettings.LatencyMode==GCLatencyMode.NoGCRegion)GC.EndNoGCRegion();}
            Refuses(replaced);samples.Add(new("replaced-region-ownership","guarded-no-gc",0,result));
        }
        using(var tail=Ready(Source("return -1;")))
        {
            var result=CSharpGcWindowCandidate.Run(tail,()=>
            {
                var call=tail.MoveNext([0],0,[-1,-1,-1,-1]);
                var thread=new Thread(()=>GC.KeepAlive(new byte[80*1024*1024])){IsBackground=true};thread.Start();if(!thread.Join(5000))throw new IOException("Tail allocation fixture stalled.");
                return call;
            },policy);
            Assert(result.Status is "gc-host-allocation-budget" or "gc-window-lost" or "gc-reservation-unavailable","Post-call host allocation escaped final process accounting.");
            Refuses(tail);samples.Add(new("host-allocation-after-final-guest-guard","guarded-no-gc",0,result));
        }
        // Same simple call exposes entry/exit costs hidden by executionMs alone.
        foreach(var reservationMiB in new[]{128,256})
        using(var fast=Ready(Source("return turn%4;")))
        {
            var selected=new CSharpGcWindowPolicy(reservationMiB*1024L*1024,reservationMiB/2*1024L*1024,32L*1024*1024);
            for(int call=0;call<50;call++)
            {
                var sample=CSharpGcWindowCandidate.Run(fast,()=>fast.MoveNext([0],0,[-1,-1,-1,-1]),selected);samples.Add(new("short-call-reservation-"+reservationMiB,"guarded-no-gc",0,sample));
                if(sample.Status!="completed"){Assert(!sample.RegionIntact,"Unavailable fast path marked protected.");break;}
                Assert(sample.Call!.Status=="ok"&&sample.RegionIntact,"Short protected call failed.");
            }
        }
        foreach(int retainedMiB in new[]{0,128})
        {
            var pressure=new byte[retainedMiB*1024*1024];for(int i=0;i<pressure.Length;i+=4096)pressure[i]=1;
            for(int repetition=0;repetition<3;repetition++)
            foreach(bool guarded in new[]{false,true})
            using(var candidate=Ready(Source("for(int i=0;i<64;i++){var a=new int[1048576];state=a[p];}return state;")))
            {
                candidate.CallStarted=(_,_)=>{var clock=Stopwatch.StartNew();while(clock.Elapsed.TotalMilliseconds<499)Thread.SpinWait(20);}; // Trusted boundary fixture, not user sleep.
                CSharpGcWindowResult sample;
                if(guarded)sample=CSharpGcWindowCandidate.Run(candidate,()=>candidate.MoveNext([0],0,[-1,-1,-1,-1]),policy);
                else
                {
                    var collections=new[]{GC.CollectionCount(0),GC.CollectionCount(1),GC.CollectionCount(2)};var before=GC.GetAllocatedBytesForCurrentThread();var clock=Stopwatch.StartNew();var call=candidate.MoveNext([0],0,[-1,-1,-1,-1]);
                    sample=new("baseline",true,call,0,0,clock.Elapsed.TotalMilliseconds,GC.GetAllocatedBytesForCurrentThread()-before,Enumerable.Range(0,3).Select(i=>GC.CollectionCount(i)-collections[i]).ToArray(),false,null);
                }
                samples.Add(new("near-deadline-allocation-"+repetition,guarded?"guarded-no-gc":"baseline",retainedMiB,sample));
                if(guarded&&sample.Status=="completed")Assert(sample.RegionIntact&&sample.CollectionDeltas.All(n=>n==0),"Collection during guarded boundary call.");
                if(sample.Call is { } settled)Assert(settled.ExecutionSettled&&settled.Status is "ok" or "timeout" or "operation-limit","Boundary call did not settle independently.");
                else if(sample.Invoked)Assert(sample.Status.StartsWith("gc-",StringComparison.Ordinal),"Missing call result without typed infrastructure failure.");
                GC.KeepAlive(pressure);
            }
        }
        Assert(GCSettings.LatencyMode!=GCLatencyMode.NoGCRegion,"Probe left GC disabled.");
        var successes=samples.Where(s=>s.Mode=="guarded-no-gc"&&s.Window.Status=="completed").ToArray();
        var report=new{Date=DateTimeOffset.UtcNow,Checks=checks,Pid=Environment.ProcessId,PublicCSharpEnabled=false,DefaultHostPolicyChanged=false,RegionAvailable=regionAvailable,Policy=policy,ReservationFailures=samples.Count(s=>s.Window.Status=="gc-reservation-unavailable"),MaxProtectedOvershootMs=successes.Where(s=>s.Window.Call?.Status=="timeout").Select(s=>s.Window.Call!.ElapsedMs-500).DefaultIfEmpty().Max(),Samples=samples};
        Console.Write(JsonSerializer.Serialize(report));
    }
}
