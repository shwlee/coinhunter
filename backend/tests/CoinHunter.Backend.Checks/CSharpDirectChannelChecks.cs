using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpDirectChannelChecks
{
    public static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var directory=Path.Combine(root,"artifacts","csharp-direct-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        string code="public class Player{int turn;public void Initialize(int n,int c,int r){}public string GetName(){return \"direct\";}public int MoveNext(int[] map,int p,int[] items){turn++;for(int i=0;i<32;i++)Debug.Print(\""+new string('가',1100)+"\");if(p==1){while(true){}}return turn%4;}}";
        var source=Path.Combine(directory,"source.cs");await File.WriteAllTextAsync(source,code);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpDirectChannelChecks).Assembly.Location)!)!.FullName)!.FullName;
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:RepositoryRoot"]=root,["Backend:ExecutionRoot"]=Path.Combine(directory,"execution")}).Build()));var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromMilliseconds(1200),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromMilliseconds(300),TimeSpan.FromSeconds(5));
        var launch=new CSharpHostLaunch(Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"),source,CSharpArtifactKeys.Hash(System.Text.Encoding.UTF8.GetBytes(code)),0,6,6,new("direct-test",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000),watchdogs);
        CSharpGameChannel Binding()=>new("coinhunter-direct-check-"+Guid.NewGuid().ToString("N"),new string('d',64),Guid.NewGuid(),0,Guid.NewGuid(),Guid.NewGuid());
        async Task Send(NamedPipeClientStream pipe,CSharpGameChannel binding,int call,int position,string? token=null)
        {
            var bytes=JsonSerializer.SerializeToUtf8Bytes(new{version=1,id=Guid.NewGuid(),method="move",gameId=binding.GameId,playerId=0,runId=binding.RunId,artifactId=binding.ArtifactId,token=token??binding.Token,input=new{contractVersion=1,gameId=binding.GameId,playerId=0,runId=binding.RunId,callId=call,map=new int[36],myPosition=position,items=new[]{-1,-1,-1,-1}}},Protocol.JsonOptions);
            var header=new byte[4];BinaryPrimitives.WriteInt32LittleEndian(header,bytes.Length);await pipe.WriteAsync(header);await pipe.WriteAsync(bytes);await pipe.FlushAsync();
        }
        async Task<JsonNode?> Read(NamedPipeClientStream pipe)
        {
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(5));var header=new byte[4];if(await pipe.ReadAsync(header.AsMemory(0,1),timeout.Token)==0)return null;await pipe.ReadExactlyAsync(header.AsMemory(1),timeout.Token);int size=BinaryPrimitives.ReadInt32LittleEndian(header);Assert(size is >0 and <=262144,"Direct frame response bound.");var bytes=new byte[size];await pipe.ReadExactlyAsync(bytes,timeout.Token);return JsonNode.Parse(bytes);
        }
        async Task Closed(CSharpHostSession session)
        {using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(8));while(session.State!="closed")await Task.Delay(10,timeout.Token);}
        try
        {
            var binding=Binding();await using(var session=await manager.CreateAsync(launch with{GameChannel=binding}))
            {
                using var pipe=new NamedPipeClientStream(".",binding.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous);await pipe.ConnectAsync(3000);
                await Send(pipe,binding,1,0);var first=(await Read(pipe))!["result"]!;
                Assert(first["direction"]!.GetValue<int>()==1&&first["logs"]!.AsArray().Count==30&&first["droppedLogs"]!.GetValue<int>()==2&&first["logs"]![0]!.GetValue<string>().Length==1024,"Direct Unicode debug bounds/large response failed.");
                await Send(pipe,binding,2,1);var timeout=(await Read(pipe))!["result"]!;
                await Send(pipe,binding,3,0);var next=(await Read(pipe))!["result"]!;
                Assert(timeout["status"]!.GetValue<string>()=="timeout"&&next["direction"]!.GetValue<int>()==3&&timeout["instanceId"]!.GetValue<string>()==next["instanceId"]!.GetValue<string>(),"Direct timeout recreated/lost Player state.");
                Assert((await session.StopAsync()).CleanupConfirmed,"Direct host cooperative stop failed.");
            }
            binding=Binding();await using(var session=await manager.CreateAsync(launch with{GameChannel=binding}))
            {
                using var pipe=new NamedPipeClientStream(".",binding.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous);await pipe.ConnectAsync(3000);await Send(pipe,binding,1,0,new string('e',64));Assert(await Read(pipe) is null,"Wrong direct token accepted.");await Closed(session);Assert((await session.StopAsync()).CleanupConfirmed,"Bad token leaked host.");
            }
            foreach(var (probe,reason) in new[]{(-1,"execution-unsettled"),(-2,"start-notification-missing")})
            {
                binding=Binding();await using var session=await manager.CreateAsync(launch with{GameChannel=binding,ProbeStall=probe});
                using var pipe=new NamedPipeClientStream(".",binding.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous);await pipe.ConnectAsync(3000);await Send(pipe,binding,1,0);Assert(await Read(pipe) is null,"Stalled worker fabricated a result.");await Closed(session);var closure=await session.StopAsync();Assert(closure.CleanupConfirmed&&closure.Forced&&closure.Reason==reason,"Direct parent supervision lost independent deadline: "+closure.Reason);
            }
            string longCode="public class Player{int turn;public void Initialize(int n,int c,int r){}public string GetName(){return \"long-game\";}public int MoveNext(int[] m,int p,int[] i){return ++turn%4;}}";
            var longSource=Path.Combine(directory,"long-game.cs");await File.WriteAllTextAsync(longSource,longCode);binding=Binding();
            await using(var session=await manager.CreateAsync(launch with{SourcePath=longSource,SourceHash=CSharpArtifactKeys.Hash(System.Text.Encoding.UTF8.GetBytes(longCode)),GameChannel=binding}))
            {
                using var pipe=new NamedPipeClientStream(".",binding.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous);await pipe.ConnectAsync(3000);
                for(int call=1;call<=10005;call++){await Send(pipe,binding,call,0);var response=(await Read(pipe))!["result"]!;if(response["direction"]!.GetValue<int>()!=call%4||response["instanceId"]!.GetValue<string>()!=session.Identity!.InstanceId.ToString())throw new Exception("Long game restarted or hit an arbitrary call limit.");}
                Assert(true,"Long game retained instance for 10,005 calls.");
                await Send(pipe,binding,10005,0);Assert(await Read(pipe) is null,"Replayed call accepted after UUID history window rotated.");await Closed(session);
            }
        }
        finally{await manager.StopAsync(default);}
        var hosts=JsonSerializer.SerializeToNode(manager.Status,Protocol.JsonOptions)!;
        Assert(hosts["active"]!.GetValue<int>()==0&&hosts["forced"]!.GetValue<long>()>=2&&hosts["recentClosures"]!.AsArray().Any(c=>c!["reason"]!.GetValue<string>()=="execution-unsettled"),"Host supervisor metrics lost forced closure reason.");
        Assert(!hosts.ToJsonString().Contains(new string('d',64),StringComparison.Ordinal),"Host supervisor metrics leaked channel credential.");
        var status=JsonSerializer.SerializeToNode(resources.Status,Protocol.JsonOptions)!;Assert(status["reservedProcesses"]!.GetValue<int>()==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0,"Direct probes leaked resource reservation.");
        Console.WriteLine($"C# direct channel checks: {checks} passed; Unicode bounds, auth, timeout reuse and independent start/settlement watchdogs.");
    }
}
