using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpPreflightChecks
{
    // Trusted test parent only. The large valid source keeps real analysis busy;
    // production compiler/host code has no crash or stall switch for this test.
    public static async Task CrashWorker(string directory,string host,Guid owner)
    {
        if(await Console.In.ReadLineAsync()!="go")return;
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build()));
        var limits=new CSharpPreparationLimits(new ResourceProfile("c4b-crash",768L*1024*1024,2,10000),TimeSpan.FromSeconds(30),16*1024*1024,1024*1024,64*1024*1024);
        await using var cache=new CSharpPreparationStore(Path.Combine(directory,"cache"),host,resources,limits);
        var source="public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"crash\";}public int MoveNext(int[] map,int p,int[] items){return -1;}}";
        var original=Path.Combine(directory,"small.cs");await File.WriteAllTextAsync(original,source);
        var prepared=await cache.PrepareAsync(owner,original,CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(source)));
        if(prepared.Status!="prepared")throw new Exception("Crash fixture could not publish its baseline artifact.");
        await File.WriteAllTextAsync(Path.Combine(directory,"published-key"),prepared.Key);
        var builder=new StringBuilder(source[..^1]);for(int i=0;i<40000;i++)builder.Append("private int field").Append(i).Append(';');builder.Append('}');
        var large=builder.ToString();var largePath=Path.Combine(directory,"large.cs");await File.WriteAllTextAsync(largePath,large);
        var pending=cache.PrepareAsync(owner,largePath,CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(large)));
        using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while(!pending.IsCompleted)
        {
            deadline.Token.ThrowIfCancellationRequested();
            foreach(var work in Directory.EnumerateDirectories(Path.Combine(directory,"cache","work")))
            {
                if(!File.Exists(Path.Combine(work,"process.json"))||!File.Exists(Path.Combine(work,"active.lock")))continue;
                bool held=false;
                try{using var active=new FileStream(Path.Combine(work,"active.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None);}
                catch(IOException){held=true;}
                if(held)
                {
                    // Only report after the compiler acquired its lifetime lease.
                    var receipt=JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(work,"process.json")))!;
                    Console.WriteLine("compile-active:"+receipt["pid"]!.GetValue<int>());
                    await pending;throw new Exception("Parent did not interrupt the active compilation.");
                }
            }
            await Task.Delay(2,deadline.Token);
        }
        await pending;throw new Exception("Compiler finished before crash coordination.");
    }

    public static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build()));
        var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var dir=Path.Combine(root,"artifacts","c4b-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var output=Path.GetDirectoryName(typeof(CSharpPreflightChecks).Assembly.Location)!;var bin=Directory.GetParent(Directory.GetParent(output)!.FullName)!.FullName;
        var host=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");if(!File.Exists(host))host=Path.Combine(root,"backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var profile=new ResourceProfile("c4b",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000);
        var limits=new CSharpPreparationLimits(profile,TimeSpan.FromSeconds(30),16*1024*1024,1024*1024,64*1024*1024);
        var cache=Path.Combine(dir,"cache");await using var store=new CSharpPreparationStore(cache,host,resources,limits);
        var owner=Guid.NewGuid();var dummy=new string('a',64);var workRoot=Path.Combine(cache,"work");Directory.CreateDirectory(workRoot);
        async Task<string> Job(bool receipt=true)
        {
            var work=Path.Combine(workRoot,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
            if(receipt)await File.WriteAllTextAsync(Path.Combine(work,"ownership.json"),JsonSerializer.Serialize(new{protocol="c4-work-v2",owner,sourceHash=dummy,artifactKey=dummy}));
            await File.WriteAllTextAsync(Path.Combine(work,"source.cs"),"synthetic orphan");return work;
        }
        var beforeStart=await Job();var recovery=await store.RecoverAsync();Assert(recovery.Removed==1&&!Directory.Exists(beforeStart),"Unauthorised abandoned snapshot not recovered.");
        var active=await Job();
        using(var current=Process.GetCurrentProcess())await File.WriteAllTextAsync(Path.Combine(active,"process.json"),JsonSerializer.Serialize(new{pid=current.Id,startedUtcTicks=current.StartTime.ToUniversalTime().Ticks,job=Path.GetFileName(active)}));
        recovery=await store.RecoverAsync();Assert(recovery.Retained==1&&File.Exists(Path.Combine(active,"source.cs")),"Live matching process reclaimed.");
        using(var current=Process.GetCurrentProcess())await File.WriteAllTextAsync(Path.Combine(active,"process.json"),JsonSerializer.Serialize(new{pid=current.Id,startedUtcTicks=current.StartTime.ToUniversalTime().Ticks-1,job=Path.GetFileName(active)}));
        recovery=await store.RecoverAsync();Assert(recovery.Removed==1&&!Directory.Exists(active),"Reused PID/start time blocked safe recovery.");
        var locked=await Job();using(var held=new FileStream(Path.Combine(locked,"active.lock"),FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None))
        {recovery=await store.RecoverAsync();Assert(recovery.Retained==1&&Directory.Exists(locked),"Exclusive compiler lease ignored.");}
        Assert((await store.RecoverAsync()).Removed==1,"Released compiler lease not recovered.");
        var unknown=await Job(false);recovery=await store.RecoverAsync();Assert(recovery.Retained==1&&Directory.Exists(unknown),"Unverified legacy work deleted.");
        var retained=Path.Combine(dir,"retained-legacy");if(!Path.GetFullPath(retained).StartsWith(Path.GetFullPath(dir)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Unsafe test move.");Directory.Move(unknown,retained);
        Assert((await store.RecoverAsync()).Retained==0,"Recovery did not unblock after operator separation.");
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(2),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        var fixture=Path.Combine(root,"backend/contracts/generated/algorithm-preflight.json");var checker=new CSharpArtifactPreflight(store,manager);
        ICSharpPreflightReportStore reports=new FileCSharpPreflightReportStore(Path.Combine(dir,"reports"));
        var observations=new List<CSharpPreflightReport>();
        string Code(string body,string init="",string name="return \"preflight\";")=>"public class Player{public void Initialize(int n,int c,int r){"+init+"}public string GetName(){"+name+"}public int MoveNext(int[] map,int p,int[] items){"+body+"}}";
        async Task<CSharpPreflightReport> Check(string source,string label)
        {
            var path=Path.Combine(dir,label+".cs");await File.WriteAllTextAsync(path,source);var hash=CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(source));
            var prepared=await store.PrepareAsync(owner,path,hash);Assert(prepared.Status=="prepared","Fixture source did not compile.");
            var launch=new CSharpPreparedLaunch(host,owner,prepared.Key!,0,3,3,profile,watchdogs);
            using var duration=new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var report=await checker.CheckAsync(launch,fixture,duration.Token);observations.Add(report);
            await reports.WriteAsync(report);var loaded=await reports.ReadAsync(owner,report.Key,report.FixtureHash);
            Assert(loaded==report&&!report.ExecutionAllowed,"Report metadata lost or authorized language.");
            Assert(File.Exists(path),"Validation removed original algorithm.");return report;
        }
        try
        {
            if(OperatingSystem.IsWindows())
            {
                var crash=Path.Combine(dir,"parent-crash");Directory.CreateDirectory(crash);
                using var group=new WindowsJobResourceGroup(new ResourceProfile("c4b-crash-tree",2L*1024*1024*1024,3,10000),()=>{});
                using var worker=new Process{StartInfo=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true}};
                if(string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath),"dotnet",StringComparison.OrdinalIgnoreCase))worker.StartInfo.ArgumentList.Add(typeof(CSharpPreflightChecks).Assembly.Location);
                foreach(var arg in new[]{root,"csharp-preparation-crash-worker",crash,host,owner.ToString()})worker.StartInfo.ArgumentList.Add(arg);
                CSharpHostSession.RestrictEnvironment(worker.StartInfo);
                worker.Start();var errors=worker.StandardError.ReadToEndAsync();
                try
                {
                    group.Assign(worker);await worker.StandardInput.WriteLineAsync("go");worker.StandardInput.Close();
                    var signal=await worker.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(30));
                    Assert(signal?.StartsWith("compile-active:",StringComparison.Ordinal)==true,"Real compiler did not enter its active lease: "+signal);
                    var compilerPid=int.Parse(signal![15..]);using var compiler=Process.GetProcessById(compilerPid);
                    Assert(!compiler.HasExited,"Compiler exited before parent crash.");
                    worker.Kill(entireProcessTree:false);await worker.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                    await compiler.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));Assert(compiler.HasExited,"Compiler survived kill-on-close parent crash.");
                    await using var restarted=new CSharpPreparationStore(Path.Combine(crash,"cache"),host,resources,limits);
                    var recovered=await restarted.RecoverAsync();Assert(recovered.Removed==1&&recovered.Retained==0,"Actual abandoned preparation was not recovered.");
                    var source=await File.ReadAllTextAsync(Path.Combine(crash,"small.cs"));
                    var reuse=await restarted.PrepareAsync(owner,Path.Combine(crash,"small.cs"),CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(source)));
                    Assert(reuse.Status=="prepared"&&reuse.CacheHit&&reuse.Key==await File.ReadAllTextAsync(Path.Combine(crash,"published-key"))&&restarted.CompilationStarts==0,"Parent crash damaged a published artifact.");
                    Assert(File.Exists(Path.Combine(crash,"large.cs")),"Crash recovery removed the original source.");
                }
                finally{await group.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(10));await worker.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));await errors;}
            }
            var bfs=await Check(await File.ReadAllTextAsync(Path.Combine(root,"backend/examples/csharp/nearest-coin.cs")),"bfs");
            Assert(bfs.Status=="passed"&&bfs.CheckedCalls==36,"Shared 36-call fixture did not pass BFS.");
            var idle=await Check(Code("return -1;"),"idle");Assert(idle.Status=="passed"&&idle.CheckedCalls==36,"Legal -1 treated as failed.");
            var timeout=await Check(Code("while(true){}"),"timeout");Assert(timeout.Status=="failed"&&timeout.Diagnostic is{Code:"AR012",Phase:"moveNext",Turn:1,Line:>0},"Timeout/source position classification lost.");
            var invalid=await Check(Code("return 7;"),"invalid");Assert(invalid.Status=="failed"&&invalid.Diagnostic?.Code=="AR013","Invalid direction accepted.");
            var exception=await Check(Code("return map[999999];"),"exception");Assert(exception.Status=="failed"&&exception.Diagnostic?.Code=="AX002","Runtime exception misclassified.");
            var init=await Check(Code("return 0;","while(true){}"),"initialize-timeout");Assert(init.Status=="failed"&&init.Diagnostic is{Phase:"initialize",Code:"AR012"},"Initialization timeout became infrastructure failure.");
            var name=await Check(Code("return 0;",name:"return null;"),"name");Assert(name.Status=="failed"&&name.Diagnostic is{Phase:"getName",Code:"AR013"},"Invalid name became infrastructure failure.");
            var quota=await Check(Code("var a=new System.Collections.Generic.List<int>(map.Length+65536);return 0;"),"quota");Assert(quota.Status=="failed"&&quota.Diagnostic is{Code:"AX003",Status:"operation-limit"},"Confirmed operation limit lost.");
            Assert(await reports.ReadAsync(Guid.NewGuid(),bfs.Key,bfs.FixtureHash) is null,"Foreign report visible.");
            Assert(await reports.ReadAsync(owner,bfs.Key,new string('f',64)) is null,"Stale fixture result reused.");
            try{await reports.WriteAsync(bfs with{CheckedCalls=0});throw new Exception("Incomplete passed report persisted.");}catch(ArgumentException){checks++;}
            var budget=JsonSerializer.SerializeToNode(resources.Status)!;
            using(var occupied=resources.Reserve(new ResourceProfile("c4b-saturated",budget["totalMemoryBytes"]!.GetValue<long>(),budget["totalProcesses"]!.GetValue<int>(),10000)))
            {
                var saturated=await checker.CheckAsync(new CSharpPreparedLaunch(host,owner,bfs.Key,0,3,3,profile,watchdogs),fixture);
                Assert(saturated.Status=="unverified"&&saturated.Diagnostic?.Code=="AX004","Resource saturation became a source failure or escaped classification.");
            }
            using(var cancel=new CancellationTokenSource())
            {
                var pending=checker.CheckAsync(new CSharpPreparedLaunch(host,owner,timeout.Key,0,3,3,profile,watchdogs),fixture,cancel.Token);
                while(manager.ManagedCount==0&&!pending.IsCompleted)await Task.Delay(1);
                cancel.Cancel();var cancelled=await pending;
                Assert(cancelled.Status=="unverified"&&cancelled.Diagnostic is{Code:"AX004",Status:"cancelled"},"Cancellation became failed/passed source verdict.");
            }
            await manager.StopAsync(default);
            var unavailable=await checker.CheckAsync(new CSharpPreparedLaunch(host,owner,bfs.Key,0,3,3,profile,watchdogs),fixture);
            Assert(unavailable.Status=="unverified"&&unavailable.Diagnostic?.Code=="AX004","Unavailable manager became source failure.");
            Assert(manager.ManagedCount==0,"Preflight leaked managed sessions.");
            var status=JsonSerializer.SerializeToNode(resources.Status)!;Assert(status["reservedProcesses"]!.GetValue<int>()==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0,"Preflight leaked execution resources.");
        }
        finally{await manager.StopAsync(default);}
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-c4b-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,reports=observations}));
        Console.WriteLine($"C# C4-B recovery/preflight checks: {checks} passed; shared 36 calls, user/infrastructure diagnostics and owner/version metadata.");
    }
}
