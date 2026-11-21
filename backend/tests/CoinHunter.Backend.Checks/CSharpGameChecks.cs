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

internal static class CSharpGameChecks
{
    public static async Task Run(string root)
    {
        int checks = 0; void Assert(bool ok, string message) { if (!ok) throw new Exception(message); checks++; }
        var dir = Path.Combine(root, "artifacts", "c4d-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var output = Path.GetDirectoryName(typeof(CSharpGameChecks).Assembly.Location)!; var bin = Directory.GetParent(Directory.GetParent(output)!.FullName)!.FullName;
        var host = Path.Combine(bin, "CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"); if (!File.Exists(host)) host = Path.Combine(root, "backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var config = new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Backend:RepositoryRoot"] = root,
            ["Backend:DataRoot"] = Path.Combine(dir, "operations"),
            ["Backend:ExchangeRoot"] = Path.Combine(dir, "exchange"),
            ["Backend:ExecutionRoot"] = Path.Combine(dir, "execution"),
            ["Backend:CSharpValidation:Enabled"] = "true",
            ["Backend:CSharpValidation:HostAssembly"] = host,
            ["Backend:CSharpGameCandidate:Enabled"] = "true"
        }).Build();
        var settings = new StorageSettings(config); var content = new GameContent(settings); var resourceSettings = new ExecutionResourceSettings(config); var resources = new ExecutionResources(resourceSettings);
        var hosts = new CSharpHostManager(resources); await hosts.StartAsync(default);
        await using var candidate = new CSharpValidationService(settings, content, resources, hosts, config);
        using var execution = new ExecutionManager(settings, content, resources, resourceSettings, candidate); await execution.StartAsync(default); await candidate.StartAsync(default);
        var exchange = new FileSourceStore(settings.ExchangeRoot);
        var csharp = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("public class Player{private int turn;public void Initialize(int n,int c,int r){turn=0;}public string GetName(){return \"csharp\";}public int MoveNext(int[] map,int p,int[] items){turn++;Debug.Print(\"turn=\"+turn);if(turn==4){while(true){}}return turn%4;}}")));
        var js = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("module.exports=class{initialize(){}getName(){return 'fast-js';}moveNext(){return -1;}}")));
        var defaults = content.Defaults; defaults["actionMs"] = 50; defaults["runningTimeMs"] = 60000; defaults["itemFirstMs"] = 60000;
        var owner = Guid.NewGuid(); var cells = new int[36]; foreach (int p in new[] { 14, 15, 20, 21 }) cells[p] = 500;
        ExecutionRequest Request(params string[] languages) => new()
        {
            ContractVersion = 1,
            RequestId = Guid.NewGuid(),
            MatchId = Guid.NewGuid(),
            Scope = new() { Kind = "user", SubjectId = owner },
            Map = new() { Id = "candidate-test", Revision = 1, Columns = 6, Rows = 6, Tiles = cells, Settings = JsonSerializer.SerializeToElement(defaults) },
            Options = new() { Mode = "practice", BlackMatter = false, DestroyWalls = false },
            Participants = languages.Select((language, index) => new ParticipantRequest { PlayerId = index, RunId = Guid.NewGuid(), Language = language, Source = language == "csharp" ? csharp : js, StartSlot = index, CharacterId = index == 0 ? "pengko" : "kobi" }).ToArray()
        };
        async Task Until(Func<bool> condition, int seconds = 20)
        { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(seconds)); while (!condition()) await Task.Delay(10, timeout.Token); }
        async Task<JsonObject[]> Journal(ExecutionRecord record)
        {
            var path = Path.Combine(settings.ExecutionRoot, "journals", record.Request.MatchId + ".jsonl");
            return (await File.ReadAllLinesAsync(path)).Select(line => JsonNode.Parse(line)!.AsObject()).ToArray();
        }
        var observations = new List<object>();
        try
        {
            var request = Request("csharp", "csharp", "javascript");
            config["Backend:CSharpGameCandidate:Enabled"] = "false";
            try { await execution.Accept(request, default, candidate: true); throw new Exception("Disabled candidate route executed C#."); } catch (ServiceFault e) when (e.Status == 503) { checks++; }
            config["Backend:CSharpGameCandidate:Enabled"] = "true";
            try { ContractValidation.Execution(request); throw new Exception("Default contract activated C#."); } catch (InvalidDataException) { checks++; }
            try { await execution.Accept(request, default); throw new Exception("Default admission activated C#."); } catch (ServiceFault e) when (e.Status == 503 && e.Code == Protocol.AdmissionRejectedCode) { checks++; }
            ContractValidation.Execution(request, true);
            try { ContractValidation.Execution(request with { Scope = request.Scope with { Kind = "guest" } }, true); throw new Exception("Guest candidate admitted."); } catch (InvalidDataException) { checks++; }
            var game = await execution.Accept(request, default, candidate: true);
            var privateTokens = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(settings.ExecutionRoot, "games", request.MatchId.ToString(), "csharp-runners.private.json")))!["players"]!.AsArray().Select(p => p!.Text("token")).ToArray();
            Assert(game.State == "prepared" && hosts.ManagedCount == 2, "Mixed engine did not own two C# instances.");
            var artifactRoot = Path.Combine(settings.ExecutionRoot, "csharp", "artifacts", "objects", owner.ToString("N"));
            var before = Directory.GetFiles(artifactRoot, "artifact.dll", SearchOption.AllDirectories).Select(p => (Path: p, Time: File.GetLastWriteTimeUtc(p))).ToArray();
            Assert(before.Length == 1, "Identical C# participants did not share compiled bytes.");
            // The game must need only its pinned prepared DLL after startup.
            File.Delete(Path.Combine(settings.ExecutionRoot, "games", request.MatchId.ToString(), "sources", csharp.SourceKey + ".js"));
            var other = await execution.Accept(Request("csharp"), default, candidate: true);
            Assert(other.State == "prepared" && hosts.ManagedCount == 3, "Second game did not acquire its own C# object.");
            await execution.Start(game); await execution.Start(other);
            await Until(() => game.Snapshot?["game"]?["players"]?[0]?.Int("turn") >= 6 && game.Snapshot?["game"]?["players"]?[1]?.Int("turn") >= 6 && other.Snapshot?["game"]?["players"]?[0]?.Int("turn") >= 6);
            await execution.Stop(game, "user-stopped"); await execution.Stop(other, "user-stopped");
            Assert(game.State == "closed" && game.Result?.Text("reason") == "user-stopped", "Mixed game did not close normally.");
            var events = await Journal(game); var results = events.Where(e => e.Text("type") == "algorithm-result").Select(e => e["payload"]!.AsObject()).ToArray();
            foreach (int player in new[] { 0, 1 })
            {
                var own = results.Where(e => e.Int("player") == player).Select(e => e["result"]!).ToArray();
                Assert(own.Length >= 5 && own[0].Int("direction") == 1, "C# per-instance initial field state lost.");
                Assert(own[3].Text("status") == "timeout" && own[3].Int("direction") == -1 && own[4].Text("status") == "ok" && own[4].Int("direction") == 1, "500ms did not preserve fields for the next actual game call.");
                Assert(own.Select(e => e.Text("instanceId")).Distinct().Count() == 1, "Timeout restarted the C# instance.");
                Assert(own.All(e => e["timings"]!.Text("executionBoundary") == "dotnet-guarded-call-v1"), "C# call boundary hidden as QuickJS or IPC time.");
                Assert(own[0]["logs"]!.AsArray().Single()!.GetValue<string>()=="turn=1"&&own[3]["logs"]!.AsArray().Single()!.GetValue<string>()=="turn=4", "Direct C# debug output missing on normal/timeout turns.");
                Assert(own.All(e=>e["timings"]!["inputPreparationMs"]!.GetValue<double>()>=0),"C# input preparation timing missing.");
            }
            var prepared = events.Single(e => e.Text("type") == "prepared")["payload"]!["runners"]!.AsArray();
            Assert(prepared[0]!.Text("instanceId") != prepared[1]!.Text("instanceId"), "Different players share a Player object.");
            var timeoutTime = events.First(e => e.Text("type") == "algorithm-result" && e["payload"]!.Int("player") == 0 && e["payload"]!["result"]!.Text("status") == "timeout")["timeMs"]!.GetValue<double>();
            var firstTime = events.First(e => e.Text("type") == "algorithm-result")["timeMs"]!.GetValue<double>();
            Assert(events.Count(e => e.Text("type") == "algorithm-result" && e["payload"]!.Int("player") == 2 && e["timeMs"]!.GetValue<double>() < timeoutTime) >= 6, "Slow C# call blocked fast JS turns.");
            Assert(before.All(e => File.GetLastWriteTimeUtc(e.Path) == e.Time), "DLL was rebuilt while turns ran.");
            Assert(!File.Exists(Path.Combine(settings.ExecutionRoot, "games", request.MatchId.ToString(), "csharp-runners.private.json")), "Private channel credentials remained after cleanup.");
            var journalText = string.Join('\n', events.Select(e => e.ToJsonString()));
            Assert(!journalText.Contains("coinhunter-csharp-", StringComparison.Ordinal) && privateTokens.All(t => !journalText.Contains(t, StringComparison.Ordinal)), "Private endpoint/token leaked into journal.");
            var timingSamples = results.Where(r => r["result"]!.Text("status") == "ok").Select(r => new { player = r.Int("player"), language = prepared[r.Int("player")]!.Text("language"), callId = r["result"]!.Int("callId"), executionMs = r["result"]!["timings"]!["executionMs"]!.GetValue<double>(), roundTripMs = r["result"]!["timings"]!["roundTripMs"]!.GetValue<double>() }).ToArray();
            observations.Add(new { game = request.MatchId, players = 3, results = results.Length, elapsedToTimeoutMs = timeoutTime - firstTime, timingSamples, recording = game.Result!["recording"]!.DeepClone() });

            var cancelled = await execution.Accept(Request("csharp"), default, candidate: true); await execution.Start(cancelled);
            await Until(() => cancelled.Snapshot?["game"]?["players"]?[0]?.Int("turn") == 4 && cancelled.Snapshot?["game"]?["players"]?[0]?.Bool("thinking") == true);
            await execution.Stop(cancelled, "user-stopped"); Assert(cancelled.State == "closed" && hosts.ManagedCount == 0, "Stop during active C# call leaked a host.");
            var crashed = await execution.Accept(Request("csharp"), default, candidate: true); await execution.Start(crashed);
            using (var engine = Process.GetProcessById(crashed.EnginePid!.Value)) engine.Kill(entireProcessTree: false);
            await crashed.Closed.Task.WaitAsync(TimeSpan.FromSeconds(15)); Assert(crashed.Result?.Text("outcome") == "failed" && hosts.ManagedCount == 0, "Node crash left manager-owned C# processes alive.");
            Assert(crashed.Result!["recording"]!.Text("status") == "partial", "Engine crash claimed complete recording.");
            var faultSource = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("public class Player{private int turn;public void Initialize(int n,int c,int r){turn=0;}public string GetName(){return \"fault\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(turn==4)return 99;if(turn==6)return map[999999];return -1;}}")));
            var faultyRequest = Request("csharp"); faultyRequest = faultyRequest with { Participants = [faultyRequest.Participants[0] with { Source = faultSource }] };
            var faulty = await execution.Accept(faultyRequest, default, candidate: true); await execution.Start(faulty); await faulty.Closed.Task.WaitAsync(TimeSpan.FromSeconds(20));
            Assert(faulty.Result?.Text("outcome") == "failed" && hosts.ManagedCount == 0, "Fatal C# call left engine waiting indefinitely or leaked a host.");
            Assert(faulty.Result!["recording"]!.Text("status") == "complete", "Confirmed direct host cleanup lost the complete failure recording.");
            var partialPath = Path.Combine(settings.ExecutionRoot, "journals", faultyRequest.MatchId + ".jsonl");
            var partial = (await File.ReadAllLinesAsync(partialPath)).Select(line => JsonNode.Parse(line)!).Where(e => e.Text("type") == "algorithm-result").Select(e => e["payload"]!["result"]!).ToArray();
            Assert(partial.Length >= 5 && partial[3].Text("status") == "invalid-result" && partial[3].Int("direction") == -1 && partial[4].Text("status") == "ok", "Invalid direction did not consume only its own turn and preserve reuse.");
            Assert((await File.ReadAllLinesAsync(partialPath)).Select(line => JsonNode.Parse(line)!).Any(e => e.Text("type") == "runtime-failure" && e["payload"]!.Int("callId") == 6 && e["payload"]!.Text("status") == "exception"), "Fatal algorithm judgement missing from full turn journal.");
            var failure=(await File.ReadAllLinesAsync(partialPath)).Select(line=>JsonNode.Parse(line)!).Single(e=>e.Text("type")=="runtime-failure")["payload"]!;
            Assert(failure["diagnostic"]!.Text("code")=="IndexOutOfRangeException"&&failure["diagnostic"]!.Int("line")>0,"C# runtime diagnostic lost original guard location/type.");
            var fairCSharp=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(CSharpInvocationChecks.CSharp)));
            var fairJs=await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(CSharpInvocationChecks.JavaScript)));
            foreach(var roles in new[]{new[]{"csharp","javascript","javascript","csharp"},new[]{"javascript","csharp","csharp","javascript"}})
            {
                var fair=Request(roles);fair=fair with{Participants=fair.Participants.Select(p=>p with{Source=p.Language=="csharp"?fairCSharp:fairJs}).ToArray()};
                var match=await execution.Accept(fair,default,candidate:true);await execution.Start(match);await match.Closed.Task.WaitAsync(TimeSpan.FromSeconds(20));
                Assert(match.Result?.Text("outcome")=="finished"&&match.Result["recording"]!.Text("status")=="complete","Equivalent-strategy role swap did not finish/record cleanly.");
                var log=await Journal(match);var calls=log.Where(e=>e.Text("type")=="algorithm-result").Select(e=>e["payload"]!).ToArray();
                Assert(calls.Length>0&&calls.All(c=>c["result"]!.Text("status")=="ok")&&!log.Any(e=>e.Text("type")=="runtime-failure"),"Position-swapped BFS had an execution failure.");
                observations.Add(new{kind="equivalent-strategy-start-slot-swap",roles,result=match.Result!.DeepClone(),calls=calls.Select(c=>new{player=c.Int("player"),callId=c["result"]!.Int("callId"),timings=c["result"]!["timings"]!.DeepClone()}).ToArray()});
            }
            var last = await execution.Accept(Request("csharp"), default, candidate: true); await execution.Start(last);
            // Actual hosted shutdown order: candidate checks stop before games; cache
            // disposal must wait until game leases and host managers have drained.
            await candidate.StopAsync(default); await execution.StopAsync(default); await hosts.StopAsync(default);
            Assert(last.Closed.Task.IsCompletedSuccessfully && hosts.ManagedCount == 0, "Hosted shutdown with active game failed.");
            var status = JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(status["reservedMemoryBytes"]!.GetValue<long>() == 0 && status["reservedProcesses"]!.GetValue<int>() == 0, "Mixed game resource reservation leak.");
        }
        finally { await execution.StopAsync(default); await candidate.StopAsync(default); await hosts.StopAsync(default); }
        await File.WriteAllTextAsync(Path.Combine(root, "artifacts/csharp-c4d-report.json"), JsonSerializer.Serialize(new { date = DateTimeOffset.UtcNow, checks, publicCSharpEnabled = false, observations, resources = resources.Status }));
        Console.WriteLine($"C# C4-D Node game checks: {checks} passed; mixed independent turns, timeout instance reuse, pinned DLLs, active stop, Node crash and hosted shutdown.");
    }
}
