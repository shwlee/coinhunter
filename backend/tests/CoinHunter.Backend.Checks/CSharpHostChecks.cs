using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpHostChecks
{
    internal static void RestrictEnvironment(ProcessStartInfo info)
    {
        var allowed=new HashSet<string>(StringComparer.OrdinalIgnoreCase){"PATH","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","DOTNET_ROOT","DOTNET_ROOT_X64","DOTNET_CLI_HOME","DOTNET_CLI_TELEMETRY_OPTOUT","DOTNET_NOLOGO"};
        foreach(var key in info.Environment.Keys.ToArray())if(!allowed.Contains(key))info.Environment.Remove(key);
    }
    private sealed class Host : IAsyncDisposable
    {
        public Process Process { get; }
        private readonly IExecutionResourceGroup group;
        private readonly NamedPipeClientStream control;
        private readonly StreamReader reader;
        private readonly StreamWriter writer;
        private readonly ConcurrentQueue<JsonObject> events = new();
        private readonly List<JsonObject> history = [];
        public IReadOnlyList<JsonObject> History => history;
        private readonly Task readTask;
        private readonly Task<string> errors;
        public Host(Process process, IExecutionResourceGroup group, NamedPipeClientStream control)
        {
            Process=process; this.group=group; this.control=control; reader=new(control); writer=new(control){AutoFlush=true};
            errors=Process.StandardError.ReadToEndAsync();
            readTask=Task.Run(async()=>{string? line; while((line=await Process.StandardOutput.ReadLineAsync()) is not null) events.Enqueue(JsonNode.Parse(line)!.AsObject());});
        }
        public async Task<JsonObject> Wait(string kind, string? request=null)
        {
            var clock=Stopwatch.StartNew();
            while(clock.Elapsed < TimeSpan.FromSeconds(15))
            {
                while(events.TryDequeue(out var item))
                {
                    history.Add(item);
                    if ((string?)item["kind"]==kind && (request is null || (string?)item["request"]==request)) return item;
                    if ((string?)item["kind"]=="host-failed") throw new Exception(item.ToJsonString());
                }
                if(Process.HasExited) { await readTask; if(events.IsEmpty) throw new Exception("Host exited: "+await errors); continue; }
                await Task.Delay(2);
            }
            throw new TimeoutException("No "+kind+" for "+request);
        }
        public async Task Send(string id, int position) => await Process.StandardInput.WriteLineAsync(new JsonObject{["Id"]=id,["Map"]=new JsonArray(0,0,0),["Position"]=position,["Items"]=new JsonArray(-1,-1,-1,-1)}.ToJsonString());
        public void DisconnectInput() => Process.StandardInput.Close();
        public async Task SendMalformed() => await Process.StandardInput.WriteLineAsync("{\"Id\":\"bad\",\"Extra\":true}");
        public async Task<JsonObject> Control(string command)
        {
            await writer.WriteLineAsync(command);
            return JsonNode.Parse(await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(3)) ?? throw new IOException("Control EOF"))!.AsObject();
        }
        public async ValueTask DisposeAsync()
        {
            using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await group.TerminateAndDrain(limit.Token); await Process.WaitForExitAsync(); await readTask;
            group.Dispose(); control.Dispose(); Process.Dispose();
        }
    }
    public static async Task Run(string root)
    {
        var settings=new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build());
        var resources=new ExecutionResources(settings); int checks=0;
        void Assert(bool success,string message){if(!success)throw new Exception(message);checks++;}
        var directory=Path.Combine(root,"artifacts","c3-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        var source=Path.Combine(directory,"player.cs");
        await File.WriteAllTextAsync(source,"public class Player{int turn; public void Initialize(int n,int c,int r){}public string GetName(){return \"C3\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1)while(true){}return turn%4;}}");
        var testOutput=Path.GetDirectoryName(typeof(CSharpHostChecks).Assembly.Location)!;
        var buildBin=Directory.GetParent(Directory.GetParent(testOutput)!.FullName)!.FullName;
        var hostAssembly=Path.Combine(buildBin,"CoinHunter.CSharp.Host","debug","CoinHunter.CSharp.Host.dll");
        if(!File.Exists(hostAssembly))hostAssembly=Path.Combine(root,"backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        async Task<Host> Start(int stall=0)
        {
            var group=resources.Reserve(new ResourceProfile("c3-host-probe",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000));
            var pipe="coinhunter-c3-"+Guid.NewGuid().ToString("N");
            var info=new ProcessStartInfo("dotnet"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
            RestrictEnvironment(info);
            foreach(var arg in new[]{hostAssembly,source,pipe,stall.ToString(System.Globalization.CultureInfo.InvariantCulture)})info.ArgumentList.Add(arg);
            var process=new Process{StartInfo=info}; var client=new NamedPipeClientStream(".",pipe,PipeDirection.InOut,PipeOptions.Asynchronous);
            Host? managedHost=null;
            try
            {
                process.Start(); group.Assign(process); await process.StandardInput.WriteLineAsync("authorize");
                await client.ConnectAsync(10000); managedHost=new Host(process,group,client);
                await managedHost.Wait("ready");return managedHost;
            }
            catch
            {
                if(managedHost is not null)await managedHost.DisposeAsync();
                else
                {
                    using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(10));await group.TerminateAndDrain(limit.Token);
                    try { if(!process.HasExited){process.Kill(true);await process.WaitForExitAsync();} }catch(InvalidOperationException){}
                    group.Dispose();client.Dispose();process.Dispose();
                }
                throw;
            }
        }
        var observations=new List<JsonObject>();
        await using(var host=await Start())
        {
            var pong=await host.Control("ping");Assert((string?)pong["kind"]=="pong","No control heartbeat.");
            for(int i=0;i<3;i++)
            {
                await host.Send("slow"+i,1); var started=await host.Wait("execution-started","slow"+i);
                await host.Send("overlap"+i,0);await host.Wait("rejected","overlap"+i);checks++;
                var timeout=await host.Wait("execution-settled","slow"+i); observations.Add(timeout);
                Assert((string?)timeout["data"]?["Status"]=="timeout" && (bool?)timeout["data"]?["ExecutionSettled"]==true,"Normal deadline failed.");
                await host.Send("fast"+i,0);var next=await host.Wait("execution-settled","fast"+i);
                Assert((string?)next["data"]?["InstanceId"]==(string?)timeout["data"]?["InstanceId"] && (int?)next["data"]?["ProcessId"]==host.Process.Id && (int?)next["data"]?["Value"]==(2*(i+1))%4,"Instance/field continuity failed.");
                Assert((long?)started["data"]?["StartedTicks"] <= (long?)timeout["ticks"],"Invalid host timestamps.");
            }
            await host.Send("fast2",0);await host.Wait("rejected","fast2");checks++;
            await host.Send("stop-active",1);await host.Wait("execution-started","stop-active");
            var stopped=await host.Control("stop");Assert((bool?)stopped["executionSettled"]==false,"Stop ack falsely settled.");
            var settled=await host.Wait("execution-settled","stop-active");Assert((string?)settled["data"]?["Status"] is "cancelled" or "timeout","Stop did not settle.");
            await host.Wait("closed");await host.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3));checks++;
        }
        await using(var slow=await Start(2000))
        await using(var fast=await Start())
        {
            await slow.Send("stalled",0);await slow.Wait("execution-started","stalled");
            await slow.Wait("deadline-reached","stalled");Assert(!slow.History.Any(x=>(string?)x["kind"]=="execution-settled"&&(string?)x["request"]=="stalled"),"Deadline conflated with settlement.");
            var before=Stopwatch.GetTimestamp();var pong=await slow.Control("ping");var after=Stopwatch.GetTimestamp();
            Assert((string?)pong["kind"]=="pong" && after>before && (bool?)pong["busy"]==true,"Control stalled behind computation.");
            Assert((long?)pong["frequency"]==Stopwatch.Frequency && (long?)pong["ticks"]>=before && (long?)pong["ticks"]<=after,"Host clock sample outside parent round-trip bracket.");
            // Clock mapping interval from a ping round trip, not a claimed exact offset.
            observations.Add(new JsonObject{["kind"]="clock-sample",["parentBeforeTicks"]=before,["parentAfterTicks"]=after,["parentFrequency"]=Stopwatch.Frequency,["hostTicks"]=pong["ticks"]!.DeepClone(),["hostFrequency"]=pong["frequency"]!.DeepClone()});
            await fast.Send("independent",0);var good=await fast.Wait("execution-settled","independent");Assert((string?)good["data"]?["Status"]=="ok","Other host blocked.");
            var late=await slow.Wait("execution-settled","stalled");observations.Add(late);Assert((string?)late["data"]?["Status"]=="timeout"&&late["data"]?["Value"] is null,"Late result accepted.");
        }
        Guid oldGeneration;
        await using(var missing=await Start(-2))
        {
            await missing.Send("no-start",0);await Task.Delay(600);
            var pong=await missing.Control("ping");
            Assert((bool?)pong["busy"]==true && pong["activeCall"] is null,"Missing-start probe incorrectly acquired a user call budget.");
            Assert(!missing.History.Any(x=>(string?)x["request"]=="no-start"),"Missing start became a user timeout.");
        }
        await using(var hung=await Start(-1))
        {
            oldGeneration=Guid.Parse((string)(await hung.Control("ping"))["generation"]!);
            await hung.Send("hung",0);await hung.Wait("execution-started","hung");await hung.Wait("deadline-reached","hung");
            await hung.Control("stop");Assert(!hung.Process.HasExited,"Stalled worker claimed stopped.");
            // Infrastructure recovery probe: Dispose kills/drains the whole group.
        }
        await using(var replacement=await Start())
        {
            var newGeneration=Guid.Parse((string)(await replacement.Control("ping"))["generation"]!);
            Assert(newGeneration!=oldGeneration,"Generation reused after forced cleanup.");
            await replacement.Send("fresh",0);Assert((int?)(await replacement.Wait("execution-settled","fresh"))["data"]?["Value"]==1,"Replacement claimed restored state.");
        }
        await using(var disconnected=await Start())
        {
            await disconnected.Send("disconnect-active",1);await disconnected.Wait("execution-started","disconnect-active");
            disconnected.DisconnectInput();
            await disconnected.Wait("execution-settled","disconnect-active");await disconnected.Wait("closed");checks++;
        }
        await using(var malformed=await Start())
        { await malformed.SendMalformed();await malformed.Wait("closed");checks++; }
        var status=System.Text.Json.JsonSerializer.SerializeToNode(resources.Status)!;
        Assert((int?)status["reservedProcesses"]==0 && (long?)status["reservedMemoryBytes"]==0,"Resource reservations leaked.");
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-c3-report.json"),new JsonObject{["date"]=DateTimeOffset.UtcNow.ToString("O"),["checks"]=checks,["observations"]=new JsonArray(observations.Select(x=>(JsonNode)x).ToArray())}.ToJsonString());
        Console.WriteLine($"C# host IPC checks: {checks} passed; timeout reuse, independent control/host, late results, stop, forced drain and fresh generation.");
    }
}
