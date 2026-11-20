using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using Microsoft.Extensions.Configuration;

internal static class CSharpInvocationChecks
{
    // Equivalent traversal, storage reuse and direction order in both languages.
    internal const string CSharp="""
        public class Player {
          int col; int[] queue; int[] seen; int[] first;
          public void Initialize(int n,int c,int r){col=c;queue=new int[c*r];seen=new int[c*r];first=new int[c*r];}
          public string GetName(){return "same-bfs";}
          public int MoveNext(int[] map,int p,int[] items){
            for(int i=0;i<map.Length;i++)seen[i]=0;
            int head=0;int tail=1;queue[0]=p;seen[p]=1;first[p]=-1;
            while(head<tail){int at=queue[head++];if(at!=p&&map[at]>0)return first[at];
              for(int d=0;d<4;d++){
                if(d==0&&at%col==0||d==2&&at%col==col-1)continue;
                int next=at+(d==0?-1:d==1?-col:d==2?1:col);
                if(next<0||next>=map.Length||map[next]==-1||seen[next]!=0)continue;
                seen[next]=1;first[next]=at==p?d:first[at];queue[tail++]=next;
              }
            }return -1;
          }
        }
        """;
    internal const string JavaScript="""
        module.exports=class{
          initialize(n,c,r){this.col=c;this.queue=new Int32Array(c*r);this.seen=new Int32Array(c*r);this.first=new Int32Array(c*r);}
          getName(){return 'same-bfs';}
          moveNext(map,p,items){
            const col=this.col,queue=this.queue,seen=this.seen,first=this.first;
            for(let i=0;i<map.length;i++)seen[i]=0;
            let head=0,tail=1;queue[0]=p;seen[p]=1;first[p]=-1;
            while(head<tail){const at=queue[head++];if(at!==p&&map[at]>0)return first[at];
              for(let d=0;d<4;d++){
                if(d===0&&at%col===0||d===2&&at%col===col-1)continue;
                const next=at+(d===0?-1:d===1?-col:d===2?1:col);
                if(next<0||next>=map.length||map[next]===-1||seen[next]!==0)continue;
                seen[next]=1;first[next]=at===p?d:first[at];queue[tail++]=next;
              }
            }return -1;
          }
        };
        """;
    public static async Task Run(string root)
    {
        var dir=Path.Combine(root,"artifacts","csharp-invocation-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpInvocationChecks).Assembly.Location)!)!.FullName)!.FullName;
        var configuration=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{
            ["Backend:RepositoryRoot"]=root,["Backend:DataRoot"]=Path.Combine(dir,"operations"),["Backend:ExchangeRoot"]=Path.Combine(dir,"exchange"),["Backend:ExecutionRoot"]=Path.Combine(dir,"execution"),
            ["Backend:CSharpValidation:Enabled"]="true",["Backend:CSharpGameCandidate:Enabled"]="true",["Backend:CSharpValidation:HostAssembly"]=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"),["Backend:Resources:GameCpuRate"]="10000"
        }).Build();
        var settings=new StorageSettings(configuration);var content=new GameContent(settings);var limits=new ExecutionResourceSettings(configuration);var resources=new ExecutionResources(limits);var manager=new CSharpHostManager(resources);
        await using var candidate=new CSharpValidationService(settings,content,resources,manager,configuration);await candidate.StartAsync(default);
        var exchange=new FileSourceStore(settings.ExchangeRoot);var cs=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(CSharp)));var js=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(JavaScript)));
        var owner=Guid.NewGuid();var observations=new JsonArray();
        foreach(var size in new[]{(6,6),(20,16),(40,30)})
        {
            var game=new ExecutionRequest{ContractVersion=1,RequestId=Guid.NewGuid(),MatchId=Guid.NewGuid(),Scope=new(){Kind="user",SubjectId=owner},Map=new(){Id="benchmark",Revision=1,Columns=size.Item1,Rows=size.Item2,Tiles=new int[size.Item1*size.Item2],Settings=JsonSerializer.SerializeToElement(content.Defaults)},Options=new(){Mode="practice",BlackMatter=false,DestroyWalls=false},Participants=[]};
            using var group=resources.Reserve(limits.Game);var players=new List<CSharpCandidatePlayer>();
            try
            {
                var descriptors=new JsonArray();
                foreach(var role in new[]{"csharp","javascript","javascript","csharp"})
                {
                    int id=descriptors.Count;var player=new ParticipantRequest{PlayerId=id,RunId=Guid.NewGuid(),Language=role,Source=role=="csharp"?cs:js,StartSlot=id,CharacterId="kobi"};JsonNode? descriptor=null;
                    if(role=="csharp"){var instance=await candidate.PreparePlayer(game,player,exchange.PathFor(cs.SourceKey),group,limits.Game,default);players.Add(instance);descriptor=instance.Descriptor.DeepClone();}
                    descriptors.Add(new JsonObject{["id"]=id,["runId"]=player.RunId.ToString(),["language"]=role,["source"]=JsonSerializer.SerializeToNode(player.Source,Protocol.JsonOptions),["descriptor"]=descriptor,["call"]=0});
                }
                using var process=new Process{StartInfo=new ProcessStartInfo("node"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root}};
                CSharpHostSession.RestrictEnvironment(process.StartInfo);process.StartInfo.ArgumentList.Add(Path.Combine(root,"scripts/measure-csharp-invocation.js"));process.Start();group.Assign(process);
                var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
                await process.StandardInput.WriteLineAsync(new JsonObject{["gameId"]=game.MatchId.ToString(),["columns"]=size.Item1,["rows"]=size.Item2,["javascript"]=JavaScript,["players"]=descriptors}.ToJsonString(Protocol.JsonOptions));process.StandardInput.Close();
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90));
                if(process.ExitCode!=0)throw new Exception("Invocation measurement failed: "+await errors);
                observations.Add(JsonNode.Parse(await output));
            }
            finally{foreach(var player in players)await player.Close();using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(10));await group.TerminateAndDrain(timeout.Token);}
        }
        await candidate.StopAsync(default);await manager.StopAsync(default);
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-invocation-report.json"),new JsonObject{["date"]=DateTimeOffset.UtcNow.ToString("O"),["os"]=System.Runtime.InteropServices.RuntimeInformation.OSDescription,["cpuCount"]=Environment.ProcessorCount,["perTurnCompilations"]=0,["transportHops"]=new JsonObject{["javascript"]=1,["csharp"]=1},["publicCSharpEnabled"]=false,["observations"]=observations,["resources"]=JsonSerializer.SerializeToNode(resources.Status,Protocol.JsonOptions)}.ToJsonString(Protocol.JsonOptions));
        Console.WriteLine("C# invocation comparison passed: identical BFS, all first calls included, 3 map sizes, 3,600 calls, serial and independent concurrent streams; paired language roles.");
    }
}
