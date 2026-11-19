using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpManagerChecks
{
    public static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string error){if(!value)throw new Exception(error);checks++;}
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build()));
        var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var directory=Path.Combine(root,"artifacts","csharp-parent-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        string code="public class Player{int turn;int width;public void Initialize(int n,int c,int r){width=c;}public string GetName(){return \"manager\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1)while(true){}return width==20?turn%4:0;}}";
        var source=Path.Combine(directory,"player.cs");await File.WriteAllTextAsync(source,code);
        var testOutput=Path.GetDirectoryName(typeof(CSharpManagerChecks).Assembly.Location)!;
        var buildBin=Directory.GetParent(Directory.GetParent(testOutput)!.FullName)!.FullName;
        var hostAssembly=Path.Combine(buildBin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");
        if(!File.Exists(hostAssembly))hostAssembly=Path.Combine(root,"backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var policy=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromMilliseconds(900),TimeSpan.FromMilliseconds(50),TimeSpan.FromMilliseconds(500),TimeSpan.FromMilliseconds(700),TimeSpan.FromSeconds(5));
        var launch=new CSharpHostLaunch(hostAssembly,source,Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code))).ToLowerInvariant(),0,20,16,
            new ResourceProfile("managed-csharp-test",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000),policy);
        var observations=new JsonArray();
        async Task Dead(int pid)
        {
            try{using var p=Process.GetProcessById(pid);Assert(p.HasExited,"Owned process survived cleanup.");}catch(ArgumentException){checks++;}
            await Task.CompletedTask;
        }
        try
        {
            await using(var host=await manager.CreateAsync(launch))
            {
                var id=host.Identity!;Assert(id.SourceHash==launch.SourceHash&&host.State=="ready","Readiness mismatch.");
                for(int i=0;i<3;i++)
                {
                    var running=host.MoveNextAsync([0,0,0],1,[-1,-1,-1,-1]);
                    try{await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);throw new Exception("Overlap accepted.");}catch(InvalidOperationException){checks++;}
                    var timeout=await running;Assert(timeout.Status=="timeout"&&timeout.ExecutionSettled&&timeout.DeadlineReached,"Timeout was not actually settled.");
                    var next=await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                    Assert(next.Generation==id.Generation&&next.InstanceId==id.InstanceId&&next.ProcessId==id.ProcessId&&next.Direction==(2*(i+1))%4,"Normal timeout restarted state.");
                    observations.Add(System.Text.Json.JsonSerializer.SerializeToNode(timeout));
                }
                foreach(var invalid in new[]{new int[600000],Enumerable.Repeat(int.MinValue,100000).ToArray()})
                {
                    try{await host.MoveNextAsync(invalid,0,[-1,-1,-1,-1]);throw new Exception("Oversized input accepted.");}
                    catch(ArgumentException){Assert(host.State=="ready","Local input failure closed/busied host.");}
                }
                var afterInvalid=await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                Assert(afterInvalid.Generation==id.Generation&&afterInvalid.InstanceId==id.InstanceId&&afterInvalid.ProcessId==id.ProcessId&&afterInvalid.Direction==3&&afterInvalid.CallId==10,"Rejected input changed PID/instance/turn/pending sequence.");
                var stopped=await host.StopAsync();Assert(stopped.CleanupConfirmed&&!stopped.Forced,"Cooperative stop failed.");await Dead(id.ProcessId);
                Assert((await host.StopAsync())==stopped,"Repeated stop not idempotent.");
            }
            foreach(var (probe,reason) in new[]{(-2,"start-notification-missing"),(-1,"execution-unsettled"),(-3,"protocol-failure")})
            {
                await using(var host=await manager.CreateAsync(launch with{ProbeStall=probe}))
                {
                    int pid=host.Identity!.ProcessId;
                    try{await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);throw new Exception("Faulting host succeeded.");}
                    catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed&&failure.Reason==reason,"Misclassified infrastructure fault: "+failure.Reason);}
                    Assert(host.State=="closed","Faulting session kept accepting work.");await Dead(pid);
                }
            }
            await using(var host=await manager.CreateAsync(launch with{ProbeStall=-4,Watchdogs=policy with{HeartbeatResponse=TimeSpan.FromMilliseconds(100)}}))
            {
                try{await host.MoveNextAsync([0,0],1,[-1,-1,-1,-1]);throw new Exception("Unresponsive control accepted.");}
                catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed&&failure.Reason=="control-unresponsive","Control watchdog did not act independently.");}
            }
            try{await manager.CreateAsync(launch with{ProbeStall=-5,Watchdogs=policy with{Preparation=TimeSpan.FromMilliseconds(500)}});throw new Exception("Stalled preparation succeeded.");}
            catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed&&failure.Reason=="preparation-failed","Preparation watchdog did not clean up.");}
            await using(var slow=await manager.CreateAsync(launch with{ProbeStall=2000}))
            await using(var fast=await manager.CreateAsync(launch))
            {
                var stalled=slow.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                Assert((await fast.MoveNextAsync([0],0,[-1,-1,-1,-1])).Status=="ok","One host blocked another.");
                try{await stalled;throw new Exception("Late direction accepted.");}catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed&&failure.Reason=="execution-unsettled","Late settlement not independently stopped.");}
            }
            await using(var host=await manager.CreateAsync(launch))
            {
                using var cancel=new CancellationTokenSource();var call=host.MoveNextAsync([0,0],1,[-1,-1,-1,-1],cancel.Token);cancel.CancelAfter(50);
                try{await call;throw new Exception("Cancellation ignored.");}catch(OperationCanceledException){Assert(host.State=="closed","Cancellation completed before cleanup.");}
            }
            await using(var host=await manager.CreateAsync(launch with{ProbeStall=-1}))
            {
                using var cancel=new CancellationTokenSource(100);
                try{await host.MoveNextAsync([0],0,[-1,-1,-1,-1],cancel.Token);throw new Exception("Stalled cancellation ignored.");}
                catch(OperationCanceledException){Assert(host.State=="closed","Stalled cancellation finished before forced drain.");}
            }
            using(var cancel=new CancellationTokenSource(30))
            {
                try{await manager.CreateAsync(launch,cancel.Token);throw new Exception("Preparation cancellation ignored.");}
                catch(OperationCanceledException){Assert(manager.ManagedCount==0,"Cancelled preparation retained host.");}
            }
            try{await manager.CreateAsync(launch with{SourceHash=new string('0',64)});throw new Exception("Wrong source hash accepted.");}catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed,"Bad source leaked process.");}
            var invalidNameSource=Path.Combine(directory,"invalid-name.cs");var invalidNameCode=code.Replace("return \"manager\";","return null;");
            await File.WriteAllTextAsync(invalidNameSource,invalidNameCode);
            var invalidNameLaunch=launch with{SourcePath=invalidNameSource,SourceHash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(invalidNameCode))).ToLowerInvariant()};
            try{await manager.CreateAsync(invalidNameLaunch);throw new Exception("Null name became ready.");}
            catch(CSharpHostFailure failure){Assert(failure.Reason=="invalid-name"&&failure.CleanupConfirmed&&manager.ManagedCount==0,"Name contract failure lost or leaked.");}
            try{await manager.CreateAsync(launch with{ProbeStall=-6});throw new Exception("Malformed successful name became ready.");}
            catch(CSharpHostFailure failure){Assert(failure.Reason=="invalid-name"&&failure.CleanupConfirmed,"Parent trusted status without validating name value.");}
            await using(var host=await manager.CreateAsync(launch))
            {
                int pid=host.Identity!.ProcessId;using(var process=Process.GetProcessById(pid))process.Kill(true);
                var closed=await host.StopAsync();Assert(closed.CleanupConfirmed,"Crashed process not drained.");await Dead(pid);
            }
            await using(var host=await manager.CreateAsync(launch))
            {
                var call=host.MoveNextAsync([0,0],1,[-1,-1,-1,-1]);
                var shutdown=manager.StopAsync(default);
                try{await call;}catch(CSharpHostFailure failure){Assert(failure.CleanupConfirmed,"Shutdown fault before cleanup.");}
                await shutdown;Assert(host.State=="closed","Manager shutdown left active host.");
            }
            Assert(manager.ManagedCount==0,"Manager retained closed sessions.");
            var status=System.Text.Json.JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(status["reservedProcesses"]!.GetValue<int>()==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0,"Manager leaked reservations.");
            try{await manager.CreateAsync(launch);throw new Exception("Shutdown admitted host.");}catch(InvalidOperationException){checks++;}
        }
        finally{await manager.StopAsync(default);}
        var report=new JsonObject{["date"]=DateTimeOffset.UtcNow.ToString("O"),["checks"]=checks,["observations"]=observations};
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-parent-report.json"),report.ToJsonString());
        Console.WriteLine($"C# parent manager checks: {checks} passed; actual settlement, independent watchdogs, cancellation and confirmed resource cleanup.");
    }
}
