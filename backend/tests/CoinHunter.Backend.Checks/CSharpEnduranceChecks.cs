using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using Microsoft.Extensions.Configuration;

internal sealed record CSharpEnduranceOptions
{
    public int DurationSeconds { get; init; }=1800;
    public int Games { get; init; }=2;
    public int RestartCycles { get; init; }=3;
    public int SampleSeconds { get; init; }=5;
    public int NoProgressSeconds { get; init; }=20;
    public int MinimumFreeDiskMiB { get; init; }=1024;
    public int MaxJournalMiB { get; init; }=4096;
    public bool Smoke { get; init; }
    internal void Validate()
    {
        if(DurationSeconds<(Smoke?15:1800)||DurationSeconds>(Smoke?120:3300)||Games is <1 or >4||RestartCycles is <1 or >20||SampleSeconds is <1 or >10||NoProgressSeconds<SampleSeconds*2||NoProgressSeconds>120||MinimumFreeDiskMiB is <512 or >65536||MaxJournalMiB is <64 or >16384)throw new ArgumentException("Invalid endurance options. A qualified run requires 1800+ seconds; smoke is explicitly separate.");
    }
}

internal static class CSharpEnduranceChecks
{
    private sealed record NativeStamp(int Pid,long Started)
    {
        internal static NativeStamp Capture(int pid){using var process=Process.GetProcessById(pid);return new(pid,process.StartTime.ToUniversalTime().Ticks);}
        internal Process Open(){var process=Process.GetProcessById(Pid);try{_=process.Handle;if(process.HasExited||process.StartTime.ToUniversalTime().Ticks!=Started)throw new InvalidOperationException("Owned process exited or PID changed.");return process;}catch{process.Dispose();throw;}}
        internal bool Alive(){try{using var process=Open();return true;}catch(ArgumentException){return false;}catch(InvalidOperationException){return false;}}
        internal object Observe(){using var process=Open();return new{pid=Pid,privateBytes=process.PrivateMemorySize64,workingSetBytes=process.WorkingSet64,cpuMs=process.TotalProcessorTime.TotalMilliseconds};}
        internal void Kill(){using var process=Open();process.Kill(entireProcessTree:false);}
    }
    private sealed record OwnedGame(ExecutionRecord Record,NativeStamp Engine,NativeStamp[] Actors,Guid[] Instances)
    {
        internal IEnumerable<NativeStamp> Processes=>Actors.Prepend(Engine);
    }
    internal static async Task<int> Run(string root,string optionsFile)
    {
        optionsFile=Path.GetFullPath(optionsFile);string output=Path.GetDirectoryName(optionsFile)!;
        string relative=Path.GetRelativePath(Path.Combine(root,"artifacts"),output);
        if(Path.IsPathRooted(relative)||relative==".."||relative.StartsWith(".."+Path.DirectorySeparatorChar)||!Path.GetFileName(output).StartsWith("csharp-endurance-",StringComparison.Ordinal)||File.Exists(Path.Combine(output,"report.json")))throw new ArgumentException("A fresh private artifacts/csharp-endurance-* output directory is required.");
        var options=JsonSerializer.Deserialize<CSharpEnduranceOptions>(await File.ReadAllTextAsync(optionsFile),Protocol.JsonOptions)??throw new ArgumentException("Missing endurance options.");options.Validate();
        using var stop=new CancellationTokenSource();
        _=Task.Run(async()=>{try{while(!stop.IsCancellationRequested){var line=await Console.In.ReadLineAsync(stop.Token);if(line is null||line=="stop"){stop.Cancel();break;}}}catch(OperationCanceledException){}catch(ObjectDisposedException){}});
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpEnduranceChecks).Assembly.Location)!)!.FullName)!.FullName;
        var config=new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{
            ["Backend:RepositoryRoot"]=root,["Backend:DataRoot"]=Path.Combine(output,"operations"),["Backend:ExchangeRoot"]=Path.Combine(output,"exchange"),["Backend:ExecutionRoot"]=Path.Combine(output,"execution"),
            ["Backend:CSharpValidation:Enabled"]="true",["Backend:CSharpValidation:HostAssembly"]=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"),
            ["Backend:CSharpGameCandidate:Enabled"]="true",["Backend:CSharpGameCandidate:ExperimentalGcWindow"]="true",["Backend:CSharpGameCandidate:GcEntryCollection"]="true",
            ["Backend:Resources:GameMemoryMiB"]="2304",["Backend:Resources:TotalMemoryMiB"]=(options.Games*2304+1536).ToString(),["Backend:Resources:GameCpuRate"]="10000",["Backend:Resources:GameProcesses"]=OperatingSystem.IsWindows()?"5":"512",
            ["Backend:Resources:CgroupRoot"]=Environment.GetEnvironmentVariable("Backend__Resources__CgroupRoot")
        }).Build();
        var settings=new StorageSettings(config);var content=new GameContent(settings);var resourceSettings=new ExecutionResourceSettings(config);var resources=new ExecutionResources(resourceSettings);
        var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        await using var candidate=new CSharpValidationService(settings,content,resources,manager,config);
        using var execution=new ExecutionManager(settings,content,resources,resourceSettings,candidate);
        var rows=new List<object>();var owned=new List<OwnedGame>();var seen=new HashSet<Guid>();var summaries=new List<EnduranceJournalSummary>();
        int checks=0;string phase="initialize";bool completed=false,longComplete=false,interrupted=false;double soakMs=0;Exception? failure=null;var clock=Stopwatch.StartNew();
        void Assert(bool value,string message){if(!value)throw new InvalidDataException(message);checks++;}
        async Task Progress(string state,double elapsed=0)
        {
            await AtomicFile.Json(Path.Combine(output,"progress.json"),JsonSerializer.SerializeToNode(new{state,elapsedSeconds=elapsed,targetSeconds=options.DurationSeconds,smoke=options.Smoke,checks,hosts=manager.ManagedCount,at=DateTimeOffset.UtcNow},Protocol.JsonOptions)!);
            Console.WriteLine($"[{DateTimeOffset.UtcNow:HH:mm:ss}] {state}: {elapsed:F1}/{options.DurationSeconds}s, hosts={manager.ManagedCount}, checks={checks}");
        }
        void StorageGuard()
        {
            if(new DriveInfo(Path.GetPathRoot(output)!).AvailableFreeSpace<options.MinimumFreeDiskMiB*1024L*1024)throw new IOException("Endurance disk reserve reached.");
            string journals=Path.Combine(settings.ExecutionRoot,"journals");
            if(Directory.Exists(journals)&&Directory.EnumerateFiles(journals).Sum(p=>new FileInfo(p).Length)>options.MaxJournalMiB*1024L*1024)throw new IOException("Endurance journal budget reached.");
        }
        void Released()
        {
            var status=JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(manager.ManagedCount==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0&&status["reservedProcesses"]!.GetValue<int>()==0,"Hosts or resource reservations leaked.");
            Assert(owned.SelectMany(g=>g.Processes).All(p=>!p.Alive()),"Owned native process survived confirmed cleanup.");
        }
        async Task Until(Func<bool> condition)
        {using var deadline=CancellationTokenSource.CreateLinkedTokenSource(stop.Token);deadline.CancelAfter(TimeSpan.FromSeconds(30));while(!condition())await Task.Delay(10,deadline.Token);}
        int[] Turns(ExecutionRecord record){lock(record.Gate)return record.Snapshot?["game"]?["players"]?.AsArray().Select(p=>p!.Int("turn")).ToArray()??new int[record.Request.Participants.Length];}
        async Task Finish(OwnedGame game){if(!game.Record.Closed.Task.IsCompleted)await execution.Stop(game.Record,"user-stopped");await game.Record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(30));}
        async Task CheckJournal(OwnedGame game,string expectedRecording)
        {
            var summary=await CSharpEnduranceJournal.Validate(settings.ExecutionRoot,game.Record,stop.Token);
            Assert(summary.Recording==expectedRecording&&summary.Results>0,"Unexpected journal durability/empty results.");
            summaries.Add(summary);
            Assert(!File.Exists(Path.Combine(settings.ExecutionRoot,"games",game.Record.Request.MatchId.ToString(),"csharp-runners.private.json")),"Private runner descriptor survived cleanup.");
        }
        try
        {
            StorageGuard();await execution.StartAsync(stop.Token);await candidate.StartAsync(stop.Token);
            var exchange=new FileSourceStore(settings.ExchangeRoot);var owner=Guid.NewGuid();
            string fields=string.Concat(Enumerable.Range(0,16).Select(i=>"long[] m"+i+";"));
            string init=string.Concat(Enumerable.Range(0,16).Select(i=>"m"+i+"=new long[1048576];for(int j=0;j<m"+i+".Length;j+=512)m"+i+"[j]=1;"));
            string code="public class Player{int turn;int[] scratch;"+fields+"public void Initialize(int n,int c,int r){"+init+"}public string GetName(){return \"endurance\";}public int MoveNext(int[] map,int p,int[] items){turn++;Debug.Print(turn);if(turn%257==6){while(true){}}if(turn%509==4)return 99;scratch=new int[16384];scratch[0]=turn;return -1;}}";
            var csharp=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(code)));
            var js=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("module.exports=class{initialize(){this.turn=0;}getName(){return 'js-endurance';}moveNext(){debug.print(++this.turn);return -1;}}")));
            var settingsNode=content.Defaults;settingsNode["actionMs"]=50;settingsNode["runningTimeMs"]=3600000;settingsNode["itemFirstMs"]=3600000;
            var tiles=new int[1200];foreach(int p in new[]{579,580,619,620})tiles[p]=500;
            ExecutionRequest Request(int count)=>new(){ContractVersion=1,RequestId=Guid.NewGuid(),MatchId=Guid.NewGuid(),Scope=new(){Kind="user",SubjectId=owner},Map=new(){Id="endurance-map",Revision=1,Columns=40,Rows=30,Tiles=tiles,Settings=JsonSerializer.SerializeToElement(settingsNode)},Options=new(){Mode="practice",BlackMatter=false,DestroyWalls=false},Participants=Enumerable.Range(0,count+1).Select(i=>new ParticipantRequest{PlayerId=i,RunId=Guid.NewGuid(),Language=i<count?"csharp":"javascript",Source=i<count?csharp:js,StartSlot=i,CharacterId="kobi"}).ToArray()};
            async Task<OwnedGame> Prepare(int count)
            {
                StorageGuard();var record=await execution.Accept(Request(count),stop.Token,true);
                var identities=record.CSharpPlayers.Select(p=>p.RuntimeIdentity??throw new IOException("Missing runner identity.")).ToArray();
                foreach(var identity in identities)Assert(seen.Add(identity.InstanceId),"New game reused an old Player instance.");
                var game=new OwnedGame(record,NativeStamp.Capture(record.EnginePid!.Value),identities.Select(i=>NativeStamp.Capture(i.ProcessId)).ToArray(),identities.Select(i=>i.InstanceId).ToArray());owned.Add(game);return game;
            }
            async Task ActiveTurn(OwnedGame game)
            {await execution.Start(game.Record);await Until(()=>game.Record.Snapshot?["game"]?["players"]?[0]?.Int("turn")==6&&game.Record.Snapshot?["game"]?["players"]?[0]?.Bool("thinking")==true);}
            phase="restart-cycles";await Progress(phase);
            for(int i=0;i<options.RestartCycles;i++)
            {
                var game=await Prepare(1);await ActiveTurn(game);await Finish(game);
                Assert(game.Record.Result?.Text("reason")=="user-stopped","Explicit stop changed game outcome.");await CheckJournal(game,"complete");Released();rows.Add(new{phase,cycle=i+1,matchId=game.Record.Request.MatchId,passed=true});
            }
            phase="engine-crash";await Progress(phase);
            var crashed=await Prepare(1);await execution.Start(crashed.Record);await Until(()=>Turns(crashed.Record)[0]>=3);
            crashed.Engine.Kill();await crashed.Record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert(crashed.Record.Result?.Text("outcome")=="failed","Engine crash reported success.");await CheckJournal(crashed,"partial");Released();rows.Add(new{phase,matchId=crashed.Record.Request.MatchId,passed=true});
            phase="runner-crash";await Progress(phase);
            var killed=await Prepare(1);await ActiveTurn(killed);killed.Actors[0].Kill();await killed.Record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(30));
            Assert(killed.Record.Result?.Text("outcome")=="failed","Runner crash reported success.");await CheckJournal(killed,"complete");Released();
            Assert(summaries[^1].RuntimeFailures>0,"Runner crash lost its failure judgement.");rows.Add(new{phase,matchId=killed.Record.Request.MatchId,passed=true});
            phase="restart-after-fault";await Progress(phase);
            var recovered=await Prepare(1);await execution.Start(recovered.Record);await Until(()=>Turns(recovered.Record)[0]>=3);await Finish(recovered);await CheckJournal(recovered,"complete");Released();rows.Add(new{phase,matchId=recovered.Record.Request.MatchId,passed=true});

            phase="prepare-soak";await Progress(phase);
            var games=new List<OwnedGame>();for(int i=0;i<options.Games;i++){var game=await Prepare(2);await execution.Start(game.Record);games.Add(game);}
            var dlls=Directory.GetFiles(Path.Combine(settings.ExecutionRoot,"csharp/artifacts/objects"),"artifact.dll",SearchOption.AllDirectories).Select(p=>(Path:p,Time:File.GetLastWriteTimeUtc(p))).ToArray();
            Assert(dlls.Length==1,"Identical sources were recompiled per game/player.");
            await Until(()=>games.All(g=>Turns(g.Record).All(t=>t>=1)));var soak=Stopwatch.StartNew();phase="soak";
            var last=games.Select(g=>new int[g.Record.Request.Participants.Length]).ToArray();var advanced=games.Select(g=>new double[g.Record.Request.Participants.Length]).ToArray();
            await using(var samples=new StreamWriter(new FileStream(Path.Combine(output,"samples.jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false)))
            {
                while(soak.Elapsed.TotalSeconds<options.DurationSeconds)
                {
                    stop.Token.ThrowIfCancellationRequested();StorageGuard();var observations=new List<object>();
                    var reservation=JsonSerializer.SerializeToNode(resources.Status)!;
                    Assert(manager.ManagedCount==games.Count*2&&reservation["reservedMemoryBytes"]!.GetValue<long>()==games.Count*2304L*1024*1024,"Unexpected host/reservation growth during soak.");
                    for(int i=0;i<games.Count;i++)
                    {
                        var game=games[i];Assert(!game.Record.Closed.Task.IsCompleted,"Soak game closed early.");var turns=Turns(game.Record);
                        for(int p=0;p<turns.Length;p++){if(turns[p]>last[i][p]){last[i][p]=turns[p];advanced[i][p]=soak.Elapsed.TotalSeconds;}Assert(soak.Elapsed.TotalSeconds-advanced[i][p]<options.NoProgressSeconds,"A player stopped making progress.");}
                        observations.Add(new{matchId=game.Record.Request.MatchId,turns,engine=game.Engine.Observe(),actors=game.Actors.Select(p=>p.Observe()).ToArray(),instances=game.Instances,group=game.Record.ResourceGroup!.Observe()});
                    }
                    var sample=new{elapsedSeconds=soak.Elapsed.TotalSeconds,games=observations,hosts=manager.ManagedCount,resources=resources.Status};
                    await samples.WriteLineAsync(JsonSerializer.Serialize(sample,Protocol.JsonOptions));await samples.FlushAsync(stop.Token);
                    await Progress(phase,soak.Elapsed.TotalSeconds);await Task.Delay(TimeSpan.FromSeconds(options.SampleSeconds),stop.Token);
                }
                soakMs=soak.Elapsed.TotalMilliseconds;longComplete=true;
            }
            phase="close-soak";await Progress(phase,soak.Elapsed.TotalSeconds);await Task.WhenAll(games.Select(Finish));
            foreach(var game in games){Assert(game.Record.Result?.Text("reason")=="user-stopped","Soak result changed unexpectedly.");await CheckJournal(game,"complete");Assert(summaries[^1].RuntimeFailures==0,"Healthy soak contained runtime failures.");if(!options.Smoke)Assert(summaries[^1].Recoveries>0&&summaries[^1].Timeouts>0,"Long run did not exercise GC recovery/timeouts.");}
            Assert(dlls.All(d=>File.GetLastWriteTimeUtc(d.Path)==d.Time),"Prepared DLL changed during turns.");Released();rows.Add(new{phase="soak",plannedSeconds=options.DurationSeconds,actualMs=soakMs,games=options.Games,passed=true});completed=true;
        }
        catch(Exception error){interrupted=stop.IsCancellationRequested;failure=error;Console.Error.WriteLine($"Endurance failed during {phase}: {error}");}
        finally
        {
            foreach(var cleanup in new Func<Task>[]{()=>execution.StopAsync(default),()=>candidate.StopAsync(default),()=>manager.StopAsync(default)})try{await cleanup().WaitAsync(TimeSpan.FromSeconds(45));}catch(Exception error){failure=failure is null?error:new AggregateException(failure,error);}
            try{Released();}catch(Exception error){failure=failure is null?error:new AggregateException(failure,error);}
            stop.Cancel();bool passed=completed&&failure is null;
            await AtomicFile.Json(Path.Combine(output,"report.json"),JsonSerializer.SerializeToNode(new{schemaVersion=1,at=DateTimeOffset.UtcNow,options,passed,completed,qualifiedLongRun=passed&&!options.Smoke&&longComplete&&soakMs>=1800000,failedPhase=passed?null:phase,error=failure?.ToString(),checks,elapsedMs=clock.Elapsed.TotalMilliseconds,soakMs,rows,journals=summaries,resources=resources.Status,hosts=manager.Status,environment=new{os=RuntimeInformation.OSDescription,architecture=RuntimeInformation.ProcessArchitecture.ToString(),runtime=Environment.Version.ToString()},publicCSharpEnabled=false,defaultGcEnabled=false},Protocol.JsonOptions)!);
            await Progress(passed?"passed":"failed",soakMs/1000);
        }
        return failure is null&&completed?0:interrupted?2:1;
    }
}
