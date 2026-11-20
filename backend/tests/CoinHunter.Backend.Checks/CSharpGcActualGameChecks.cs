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

internal static class CSharpGcActualGameChecks
{
    internal static async Task Run(string root,int soakSeconds=180,int cpuRate=10000,bool entryCollection=false)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var dir=Path.Combine(root,"artifacts","gc-actual-game-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpGcActualGameChecks).Assembly.Location)!)!.FullName)!.FullName;
        var config=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{
            ["Backend:RepositoryRoot"]=root,["Backend:DataRoot"]=Path.Combine(dir,"operations"),["Backend:ExchangeRoot"]=Path.Combine(dir,"exchange"),["Backend:ExecutionRoot"]=Path.Combine(dir,"execution"),
            ["Backend:CSharpValidation:Enabled"]="true",["Backend:CSharpValidation:HostAssembly"]=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"),
            ["Backend:CSharpGameCandidate:Enabled"]="true",["Backend:CSharpGameCandidate:ExperimentalGcWindow"]="true",
            ["Backend:CSharpGameCandidate:GcEntryCollection"]=entryCollection?"true":"false",
            ["Backend:Resources:GameMemoryMiB"]="2304",["Backend:Resources:TotalMemoryMiB"]="8192",["Backend:Resources:GameCpuRate"]=cpuRate.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Backend:Resources:GameProcesses"]=OperatingSystem.IsWindows()?"5":"512"
        }).Build();
        var settings=new StorageSettings(config);var content=new GameContent(settings);var resourceSettings=new ExecutionResourceSettings(config);var resources=new ExecutionResources(resourceSettings);
        var hosts=new CSharpHostManager(resources);await hosts.StartAsync(default);
        await using var candidate=new CSharpValidationService(settings,content,resources,hosts,config);
        using var execution=new ExecutionManager(settings,content,resources,resourceSettings,candidate);await execution.StartAsync(default);await candidate.StartAsync(default);
        var exchange=new FileSourceStore(settings.ExchangeRoot);var owner=Guid.NewGuid();var rows=new List<object>();bool completed=false,soakPassed=false;
        async Task<SourceReference> Source(string text)=>await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(text)));
        string fields=string.Concat(Enumerable.Range(0,16).Select(i=>"long[] m"+i+";"));
        string initialize=string.Concat(Enumerable.Range(0,16).Select(i=>"m"+i+"=new long[1048576];for(int j=0;j<m"+i+".Length;j+=512)m"+i+"[j]=1;"));
        string Code(string body,bool retained=false)=>"public class Player{int turn;int[] scratch;"+(retained?fields:"")+"public void Initialize(int n,int c,int r){"+(retained?initialize:"")+"}public string GetName(){return \"gc-actual\";}public int MoveNext(int[] map,int p,int[] items){turn++;Debug.Print(turn);"+body+"}}";
        var source=await Source(Code("if(turn==4)return 99;if(turn==6){while(true){}}scratch=new int[16384];scratch[0]=turn;return -1;",true));
        var js=await Source("module.exports=class{initialize(){}getName(){return 'js-opponent';}moveNext(){return -1;}}");
        var options=content.Defaults;options["actionMs"]=50;options["runningTimeMs"]=3600000;options["itemFirstMs"]=3600000;
        var tiles=new int[1200];foreach(int p in new[]{579,580,619,620})tiles[p]=500;
        ExecutionRequest Request(SourceReference code,int count=1)=>new(){ContractVersion=1,RequestId=Guid.NewGuid(),MatchId=Guid.NewGuid(),Scope=new(){Kind="user",SubjectId=owner},Map=new(){Id="gc-largest-test",Revision=1,Columns=40,Rows=30,Tiles=tiles,Settings=JsonSerializer.SerializeToElement(options)},Options=new(){Mode="practice",BlackMatter=false,DestroyWalls=false},Participants=Enumerable.Range(0,count+1).Select(i=>new ParticipantRequest{PlayerId=i,RunId=Guid.NewGuid(),Language=i<count?"csharp":"javascript",Source=i<count?code:js,StartSlot=i,CharacterId="kobi"}).ToArray()};
        async Task<JsonObject[]> Journal(ExecutionRecord g)=>(await File.ReadAllLinesAsync(Path.Combine(settings.ExecutionRoot,"journals",g.Request.MatchId+".jsonl"))).Select(line=>JsonNode.Parse(line)!.AsObject()).ToArray();
        async Task Until(Func<bool> condition){using var t=new CancellationTokenSource(TimeSpan.FromSeconds(20));while(!condition())await Task.Delay(20,t.Token);}
        async Task Finish(ExecutionRecord g){if(!g.Closed.Task.IsCompleted)await execution.Stop(g,"user-stopped");await g.Closed.Task.WaitAsync(TimeSpan.FromSeconds(15));}
        void Released(){var s=JsonSerializer.SerializeToNode(resources.Status)!;Assert(hosts.ManagedCount==0&&s["reservedMemoryBytes"]!.GetValue<long>()==0&&s["reservedProcesses"]!.GetValue<int>()==0,"Actual game retained hosts/resource reservation.");}
        try
        {
            Assert(!JsonSerializer.SerializeToNode(CSharpRuntimePolicy.Read(new ConfigurationBuilder().Build()).Readiness(true))!.Bool("experimentalGcWindowEnabled"),"Default GC policy enabled.");
            config["Backend:CSharpGameCandidate:GcMemberMemoryMiB"]="4096";var rejected=Request(source);
            try{await execution.Accept(rejected,default,true);throw new Exception("GC plan bypassed whole-game budget.");}catch(ServiceFault e)when(e.Status==429){checks++;}
            Assert(!Directory.Exists(Path.Combine(settings.ExecutionRoot,"games",rejected.MatchId.ToString())),"Rejected GC plan persisted/copied sources.");Released();
            config["Backend:CSharpGameCandidate:GcMemberMemoryMiB"]="768";
            var games=new[]{await execution.Accept(Request(source,2),default,true),await execution.Accept(Request(source,2),default,true)};
            var dlls=Directory.GetFiles(Path.Combine(settings.ExecutionRoot,"csharp/artifacts/objects"),"artifact.dll",SearchOption.AllDirectories).Select(p=>(Path:p,Time:File.GetLastWriteTimeUtc(p))).ToArray();
            Assert(hosts.ManagedCount==4&&games.Select(g=>g.EnginePid).Distinct().Count()==2,"Real games did not own four C# actors/two Node engines.");
            config["Backend:CSharpGameCandidate:ExperimentalGcWindow"]="false";
            var clock=Stopwatch.StartNew();await Task.WhenAll(games.Select(execution.Start));
            await Until(()=>games.All(g=>g.Snapshot?["game"]?["players"]?[0]?.Int("turn")>=12&&g.Snapshot?["game"]?["players"]?[1]?.Int("turn")>=12)||games.Any(g=>g.Closed.Task.IsCompleted));
            Assert(games.All(g=>!g.Closed.Task.IsCompleted),"Functional GC game failed before state-reuse checks.");
            var samples=new List<object>();
            while(clock.Elapsed<TimeSpan.FromSeconds(soakSeconds)&&games.All(g=>!g.Closed.Task.IsCompleted))
            {
                samples.Add(new{atMs=clock.Elapsed.TotalMilliseconds,hosts=hosts.ManagedCount,games=games.Select(g=>new{matchId=g.Request.MatchId,usage=g.ResourceGroup!.Observe(),turns=g.Snapshot?["game"]?["players"]?.AsArray().Select(p=>p!.Int("turn")).ToArray()}).ToArray(),resources=resources.Status});
                await Task.Delay(1000);
            }
            soakPassed=games.All(g=>!g.Closed.Task.IsCompleted)&&clock.Elapsed>=TimeSpan.FromSeconds(soakSeconds);
            await Task.WhenAll(games.Select(Finish));
            foreach(var game in games)
            {
                var events=await Journal(game);var results=events.Where(e=>e.Text("type")=="algorithm-result").Select(e=>e["payload"]!).ToArray();
                foreach(int player in new[]{0,1})
                {
                    var own=results.Where(e=>e.Int("player")==player).Select(e=>e["result"]!).ToArray();
                    Assert(own.Length>=8&&own[3].Text("status")=="invalid-result"&&own[4].Text("status")=="ok"&&own[5].Text("status")=="timeout"&&own[5].Int("direction")==-1&&own[6].Text("status")=="ok","Invalid/timeout policy lost the next turn.");
                    Assert(own.Select(r=>r.Text("instanceId")).Distinct().Count()==1&&own[6]["logs"]![0]!.GetValue<string>()=="7","Actual GC timeout reset Player.");
                    var obs=events.Where(e=>e.Text("type")=="runtime-observation"&&e["payload"]!.Int("player")==player).ToArray();
                    Assert(obs.Length==own.Length&&obs.All(e=>e["payload"]!["memory"]!.Bool("regionIntact")),"GC observations mismatched turn results.");
                    var timeoutAt=events.First(e=>e.Text("type")=="algorithm-result"&&e["payload"]!.Int("player")==player&&e["payload"]!["result"]!.Text("status")=="timeout")["timeMs"]!.GetValue<double>();
                    Assert(events.Count(e=>e.Text("type")=="algorithm-result"&&e["payload"]!.Int("player")==2&&e["timeMs"]!.GetValue<double>()<timeoutAt)>=8,"C# timeout blocked JS actions.");
                }
                Assert(game.Result!["recording"]!.Text("status")=="complete","GC match did not durably close JSONL.");
                var reason=game.Result.Text("reason");
                Assert(reason=="user-stopped"||(new[]{"gc-reservation-unavailable","gc-state-conflict","gc-window-lost","gc-call-environment-failure","gc-host-allocation-budget"}.Contains(reason)&&events.Any(e=>e.Text("type")=="runtime-failure"&&e["payload"]!.Text("infrastructureFailure")==reason&&!e["payload"]!.AsObject().ContainsKey("status"))),"Soak failure lost its infrastructure classification.");
                var recoveryEvents=events.Where(e=>e.Text("type")=="runtime-observation"&&e["payload"]!["memory"]!["entry"]!.Int("attempts")==2).ToArray();
                if(entryCollection&&soakSeconds>=180)Assert(recoveryEvents.Length>0,"Actual game never exercised recovery.");
                rows.Add(new{scenario="two-concurrent-largest-map-games",matchId=game.Request.MatchId,result=game.Result.DeepClone(),calls=results.Length,observations=events.Count(e=>e.Text("type")=="runtime-observation"),recoveryEvents,timeouts=results.Where(r=>r["result"]!.Text("status")=="timeout").Select(r=>r["result"]!.DeepClone()).ToArray(),failures=events.Where(e=>e.Text("type")=="runtime-failure").ToArray()});
            }
            Assert(dlls.All(d=>File.GetLastWriteTimeUtc(d.Path)==d.Time),"Actual turns rebuilt prepared DLLs.");Released();
            rows.Add(new{scenario="bounded-soak",plannedSeconds=soakSeconds,actualMs=clock.Elapsed.TotalMilliseconds,soakPassed,retainedMiBPerCSharp=128,perTurnArrayBytes=65536,samples});
            config["Backend:CSharpGameCandidate:ExperimentalGcWindow"]="true";
            foreach(var (kind,body) in new[]{("operation-limit","if(turn==4){for(int i=0;i<8;i++)scratch=new int[1048576];}return -1;"),("exception","if(turn==4)return map[999999];return -1;")})
            {
                var game=await execution.Accept(Request(await Source(Code(body))),default,true);await execution.Start(game);await game.Closed.Task.WaitAsync(TimeSpan.FromSeconds(25));
                var events=await Journal(game);var failure=events.Single(e=>e.Text("type")=="runtime-failure")["payload"]!;
                Assert(game.Result?.Text("outcome")=="failed"&&game.Result["recording"]!.Text("status")=="complete"&&failure.Text("status")==kind&&failure.Int("callId")==4,"Fatal GC call lost its typed judgement.");
                Assert(!events.Any(e=>e.Text("type")=="algorithm-dispatched"&&e["payload"]!.Int("player")==0&&e["payload"]!.Int("callId")>4),"Fatal Player called again.");
                rows.Add(new{scenario=kind,result=game.Result!.DeepClone(),failure=failure.DeepClone()});Released();
            }
            config["Backend:CSharpGameCandidate:GcMemberMemoryMiB"]=entryCollection?"384":"512";
            var unavailable=await execution.Accept(Request(source),default,true);await execution.Start(unavailable);await unavailable.Closed.Task.WaitAsync(TimeSpan.FromSeconds(25));
            var bad=await Journal(unavailable);var infra=bad.Single(e=>e.Text("type")=="runtime-failure")["payload"]!;
            Assert(unavailable.Result?.Text("reason")=="gc-reservation-unavailable"&&unavailable.Result["recording"]!.Text("status")=="complete"&&infra.Text("infrastructureFailure")=="gc-reservation-unavailable"&&!infra.AsObject().ContainsKey("status"),"GC failure became user penalty/generic fault or lost durable result.");
            rows.Add(new{scenario="reservation-failure",result=unavailable.Result!.DeepClone(),failure=infra.DeepClone()});Released();completed=true;
        }
        finally
        {
            await execution.StopAsync(default);await candidate.StopAsync(default);await hosts.StopAsync(default);
            await File.WriteAllTextAsync(Path.Combine(root,entryCollection?"artifacts/csharp-gc-recovered-game-report.json":soakSeconds==1?"artifacts/csharp-gc-game-smoke-report.json":cpuRate==10000?"artifacts/csharp-gc-actual-game-report.json":"artifacts/csharp-gc-capped-game-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,soakPassed,cpuRate,entryCollection,artifactDirectory=Path.GetRelativePath(root,dir),publicCSharpEnabled=false,defaultGcEnabled=false,rows,resources=resources.Status,hosts=hosts.Status}));
        }
        Console.WriteLine($"C# actual GC game functional checks: {checks} passed; bounded soak {(soakPassed?"PASSED":"FAILED")}, CPU rate {cpuRate}/10000. See report; failed acceptance exits 2.");
        if(!soakPassed)Environment.ExitCode=2;
    }
}
