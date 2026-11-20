using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using Microsoft.Extensions.Configuration;

internal static class CSharpGcGameAdmissionChecks
{
    internal static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);Interlocked.Increment(ref checks);}
        var dir=Path.Combine(root,"artifacts","gc-game-admission-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var config=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:RepositoryRoot"]=root,["Backend:ExecutionRoot"]=Path.Combine(dir,"execution")}).Build();
        var resources=new ExecutionResources(new ExecutionResourceSettings(config));var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpGcGameAdmissionChecks).Assembly.Location)!)!.FullName)!.FullName;
        string host=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");
        var prepareProfile=new ResourceProfile("gc-game-compiler",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000);
        await using var store=new CSharpPreparationStore(Path.Combine(dir,"cache"),host,resources,new(prepareProfile,TimeSpan.FromSeconds(30),16L*1024*1024,1024*1024,64L*1024*1024));
        int actorTasks=OperatingSystem.IsWindows()?1:128,engineTasks=OperatingSystem.IsWindows()?1:64;
        var member=new ResourceProfile("gc-member",512L*1024*1024,actorTasks,10000);var engineProfile=new ResourceProfile("gc-engine",256L*1024*1024,engineTasks,10000);
        var small=new ResourceProfile("gc-game-small",1024L*1024*1024,engineTasks+4*actorTasks,10000);
        var large=small with{Name="gc-game-admitted",MemoryBytes=2304L*1024*1024};
        var rows=new List<object>();bool completed=false;
        using(var group=resources.Reserve(small))
        {
            try{CSharpGcGameAdmission.Create(group,small,engineProfile,Enumerable.Repeat(member,4).ToArray());throw new Exception("1GiB GC game admitted four 512MiB hosts plus engine.");}
            catch(ServiceFault fault)when(fault.Status==429){checks++;rows.Add(new{scenario="1GiB-rejected",beforeAnyActor=true});}
            try{CSharpGcGameAdmission.Create(group,large,engineProfile,[member]);throw new Exception("Declared parent profile bypassed actual OS scope.");}catch(ArgumentException){checks++;}
            Assert(manager.ManagedCount==0&&store.CompilationStarts==0,"Rejected admission started user preparation/hosts.");
        }
        using(var group=resources.Reserve(large with{ProcessCount=large.ProcessCount-1}))
        {
            try{CSharpGcGameAdmission.Create(group,large with{ProcessCount=large.ProcessCount-1},engineProfile,Enumerable.Repeat(member,4).ToArray());throw new Exception("Process/task budget overflow admitted.");}catch(ServiceFault fault)when(fault.Status==429){checks++;}
        }
        using(var first=resources.Reserve(large))using(var second=resources.Reserve(large))
        {try{using var third=resources.Reserve(large);throw new Exception("Global GC game over-admission.");}catch(ServiceFault fault)when(fault.Status==429){checks++;}}

        int held=16;
        string fields=string.Concat(Enumerable.Range(0,held).Select(i=>"long[] m"+i+";"));
        string initialize=string.Concat(Enumerable.Range(0,held).Select(i=>"m"+i+"=new long[1048576];for(int j=0;j<m"+i+".Length;j+=512)m"+i+"[j]=1;"));
        string code="public class Player{int turn;"+fields+"public void Initialize(int n,int c,int r){"+initialize+"}public string GetName(){return \"gc-game\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1){while(true){}}int[] a={1,2,3};return (turn+a[0]-1)%4;}}";
        string source=Path.Combine(dir,"player.cs");await File.WriteAllTextAsync(source,code);
        var owner=Guid.NewGuid();var prepared=await store.PrepareAsync(owner,source,CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(code)));
        Assert(prepared.Status=="prepared","GC group source failed compilation.");
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(2),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        await manager.StopAsync(default);
        foreach(int memberMiB in new[]{512,768})
        {
        completed=false;manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var selectedMember=member with{MemoryBytes=memberMiB*1024L*1024};
        var selectedGame=large with{MemoryBytes=engineProfile.MemoryBytes+selectedMember.MemoryBytes*4};
        using var game=resources.Reserve(selectedGame);var plan=CSharpGcGameAdmission.Create(game,selectedGame,engineProfile,Enumerable.Repeat(selectedMember,4).ToArray());
        Assert(plan.RequiredMemoryBytes==selectedGame.MemoryBytes&&plan.RequiredProcesses==selectedGame.ProcessCount,"GC admission accounting omitted engine/members.");
        try{plan.Player(0).Claim(game,selectedMember);throw new Exception("Player claimed before engine budget scope.");}catch(InvalidOperationException){checks++;}
        using var engineScope=plan.CreateEngineScope();
        try{using var duplicate=plan.CreateEngineScope();throw new Exception("Engine budget claimed twice.");}catch(InvalidOperationException){checks++;}
        try{plan.Player(0).Claim(game,selectedMember with{MemoryBytes=selectedMember.MemoryBytes+1024*1024});throw new Exception("Different player memory budget accepted.");}catch(ArgumentException){checks++;}
        var start=new ProcessStartInfo("node"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};CSharpHostSession.RestrictEnvironment(start);
        start.ArgumentList.Add("-e");start.ArgumentList.Add("process.stdin.once('data',()=>console.log('ready'));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
        using var engine=new Process{StartInfo=start};var actors=new List<CSharpHostSession>();bool engineStarted=false;
        try
        {
            engineStarted=engine.Start();if(!engineStarted)throw new IOException("Engine fixture did not start.");engineScope.Assign(engine);await engine.StandardInput.WriteLineAsync("authorize");Assert(await engine.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5))=="ready","Scoped engine fixture did not start.");
            var launch=new CSharpPreparedLaunch(host,owner,prepared.Key!,0,20,16,selectedMember,watchdogs){ParentResources=game,ExperimentalGcWindow=true};
            try{await manager.CreatePreparedAsync(store,launch);throw new Exception("GC player started without batch admission.");}catch(ArgumentException){checks++;}
            for(int i=0;i<4;i++)actors.Add(await manager.CreatePreparedAsync(store,launch with{PlayerNumber=i,ExperimentalGcAdmission=plan.Player(i)}));
            Assert(actors.Select(a=>a.Identity!.InstanceId).Distinct().Count()==4&&actors.Select(a=>a.ProcessId).Distinct().Count()==4,"GC group shared process/object state.");
            var status=JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(status["reservedMemoryBytes"]!.GetValue<long>()==selectedGame.MemoryBytes,"Nested GC members charged the global budget twice.");
            try{await manager.CreatePreparedAsync(store,launch with{ExperimentalGcAdmission=plan.Player(0)});throw new Exception("GC admission reused for a second player process.");}catch(InvalidOperationException){checks++;}
            Assert(!engine.HasExited&&actors.All(a=>{using var p=Process.GetProcessById(a.ProcessId);return !p.HasExited;}),"GC actors were not simultaneously alive.");
            // Nested Windows job accounting can transiently exceed the live PID
            // count after attachment. Verify enforcement, not equality of that
            // aggregated counter: the parent must reject a sixth actual process.
            bool extraProcessDenied=false;
            if(OperatingSystem.IsWindows())
            {
                using var extra=new Process{StartInfo=start};
                try
                {
                    Assert(extra.Start(),"Extra process fixture did not start.");
                    try{game.Assign(extra);}catch(System.ComponentModel.Win32Exception error)when(error.NativeErrorCode==1816){extraProcessDenied=true;}
                    Assert(extraProcessDenied,"Parent game OS process quota admitted a sixth actual process.");
                }
                finally{try{if(!extra.HasExited)extra.Kill(true);await extra.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));}catch(InvalidOperationException){}}
            }
            var clock=Stopwatch.StartNew();var samples=new List<object>();var sampleGate=new object();int slowTimeout=0,infrastructureFailures=0;
            async Task Moves(int actor,int count,int position)
            {
                for(int call=0;call<count;call++)
                {
                    try
                    {
                        var result=await actors[actor].MoveNextAsync([0,0],position,[-1,-1,-1,-1]);
                        lock(sampleGate)samples.Add(new{actor,call,atMs=clock.Elapsed.TotalMilliseconds,result});
                        Assert(result.ExperimentalMemory?.RegionIntact==true&&result.InstanceId==actors[actor].Identity!.InstanceId&&result.Status==(position==1?"timeout":"ok"),"Grouped GC call failed binding/settlement.");
                        if(position==0)Assert(result.Direction==(actor==0?2:(call+1)%4),"Grouped GC call lost existing per-player field state.");
                        if(position==1)Interlocked.Increment(ref slowTimeout);
                    }
                    catch(CSharpHostFailure failure)when(failure.CleanupConfirmed&&failure.Reason.StartsWith("gc-",StringComparison.Ordinal))
                    {Interlocked.Increment(ref infrastructureFailures);lock(sampleGate)samples.Add(new{actor,call,atMs=clock.Elapsed.TotalMilliseconds,infrastructureFailure=failure.Reason});return;}
                }
            }
            var slow=Moves(0,1,1);var fast=Task.WhenAll(Enumerable.Range(1,3).Select(i=>Moves(i,12,0)));
            bool fastBeforeSlow=await Task.WhenAny(slow,fast)==fast;await Task.WhenAll(slow,fast);
            if(slowTimeout==1)Assert(fastBeforeSlow,"Slow player's actual 500ms call blocked other host channels.");
            else Assert(infrastructureFailures>0,"Slow player returned neither a settled timeout nor a typed infrastructure failure.");
            if(actors[0].State=="ready")await Moves(0,1,0);
            rows.Add(new{scenario="four-gc-actors-with-engine-scope",memberMiB,retainedMiBPerActor=128,gameMemoryMiB=selectedGame.MemoryBytes/1024/1024,liveParticipantProcessesBeforeCalls=actors.Count+1,extraProcessDenied,fastBeforeSlow,slowTimeout,infrastructureFailures,samples,observation=game.Observe(),global=resources.Status});
            await Task.WhenAll(actors.Select(a=>a.StopAsync("gc-group-complete")));
            try{await manager.CreatePreparedAsync(store,launch with{ExperimentalGcAdmission=plan.Player(0)});throw new Exception("Stopped GC actor silently restarted within the game.");}catch(InvalidOperationException){checks++;}
            completed=true;
        }
        finally
        {
            await manager.StopAsync(default);
            if(engineStarted)try{engine.StandardInput.Close();await engine.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));}catch{if(!engine.HasExited){engine.Kill(true);await engine.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));}}
            await engineScope.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5));engineScope.Dispose();
            await game.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(10));game.Dispose();
            await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-gc-admission-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,publicCSharpEnabled=false,defaultGcEnabled=false,rows,resources=resources.Status}));
        }
        }
        var final=JsonSerializer.SerializeToNode(resources.Status)!;
        Assert(manager.ManagedCount==0&&final["reservedMemoryBytes"]!.GetValue<long>()==0&&final["reservedProcesses"]!.GetValue<int>()==0,"GC game admission resource leak.");
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-gc-admission-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,publicCSharpEnabled=false,defaultGcEnabled=false,rows,resources=resources.Status}));
        Console.WriteLine($"C# GC game admission checks: {checks} passed; pre-launch aggregate budget, four isolated actors, independent calls and actual cleanup.");
    }
}
