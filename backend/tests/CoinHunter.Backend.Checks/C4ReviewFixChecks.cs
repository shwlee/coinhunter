using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Win32.SafeHandles;

internal static class C4ReviewFixChecks
{
    public static async Task Run(string root)
    {
        int checks = 0; void Assert(bool ok, string message) { if (!ok) throw new Exception(message); checks++; }
        var dir = Path.Combine(root, "artifacts", "c4-review-fixes-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var output = Path.GetDirectoryName(typeof(C4ReviewFixChecks).Assembly.Location)!; var bin = Directory.GetParent(Directory.GetParent(output)!.FullName)!.FullName;
        var host = Path.Combine(bin, "CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"); if (!File.Exists(host)) host = Path.Combine(root, "backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var cfg = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Backend:RepositoryRoot"] = root,
            ["Backend:DataRoot"] = Path.Combine(dir, "operations"),
            ["Backend:ExchangeRoot"] = Path.Combine(dir, "exchange"),
            ["Backend:ExecutionRoot"] = Path.Combine(dir, "execution"),
            ["Backend:CSharpValidation:Enabled"] = "true",
            ["Backend:CSharpValidation:HostAssembly"] = host,
            ["Backend:CSharpGameCandidate:Enabled"] = "true",
            ["Backend:Resources:GameMemoryMiB"] = "512",
            ["Backend:Resources:GameCpuRate"] = "1000"
        }).Build();
        var settings = new StorageSettings(cfg); var content = new GameContent(settings);
        using (var files = new FileAccountStore(settings))
        {
            var held = new HeldResultStore(files); var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources")); var accounts = new AccountService(held, sources);
            var user = await accounts.Login("review-fix@company.test"); var owner = user.Text("id"); var source = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("module.exports=class{}")));
            var saved = await accounts.Save(owner, null, "review", 0, source.SourceKey, source.Sha256);
            var backend = new BackendSettings { Service = "review", ListenUrl = new("http://127.0.0.1:3101"), PublicUrl = new("http://127.0.0.1:3000"), ExecutionUrl = new("http://127.0.0.1:3102"), InternalServiceKey = "test-" + new string('r', 40), TrustedProxies = [] };
            using var transport = new ResultTransport(); using var service = new AlgorithmValidationService(accounts, settings, content, new ExecutionClient(transport, backend)); await service.StartAsync(default);
            try
            {
                held.Armed = true; await service.Queue(owner, saved, source.SourceKey); await held.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                var scope = new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(owner) };
                var prior = await accounts.Algorithm(owner, saved.Text("id")); var oldAttempt = Guid.Parse(prior.Text("validationAttempt"));
                await service.Check(scope, source); var latest = await accounts.Algorithm(owner, saved.Text("id"));
                Assert(latest["validation"]!.Text("state") == "failed", "New manual result missing.");
                held.Resume.TrySetResult(); await held.Applied.Task.WaitAsync(TimeSpan.FromSeconds(5)); var after = await accounts.Algorithm(owner, saved.Text("id"));
                Assert(after["validation"]!.Text("state") == "failed" && after["validation"]!.Text("checkedAt") == latest["validation"]!.Text("checkedAt"), "Old background result overwrote latest attempt.");
                Assert(after.Text("validationAttempt") != oldAttempt.ToString() && !JsonData.Metadata(after).ContainsKey("validationAttempt"), "Attempt identity not renewed or exposed publicly.");
                transport.Hold = true; using var cancel = new CancellationTokenSource(); var pending = service.Check(scope, source, cancel.Token); await transport.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
                try { await pending; throw new Exception("Cancelled check completed."); } catch (OperationCanceledException) { checks++; }
                var cancelled = await accounts.Algorithm(owner, saved.Text("id")); Assert(cancelled["validation"]!.Text("state") == "unverified", "Cancelled attempt remained pending.");
                Assert(!await accounts.SetValidation(owner, saved.Text("id"), 1, source.SourceKey, new JsonObject { ["state"] = "passed" }, "javascript", source.Sha256, oldAttempt), "Stale final/cancellation write accepted.");
                Assert(File.Exists(sources.PathFor(source.SourceKey)), "Original source removed by attempt cancellation.");
            }
            finally { held.Resume.TrySetResult(); await service.StopAsync(default); }
        }
        var resourceSettings = new ExecutionResourceSettings(cfg); var resources = new ExecutionResources(resourceSettings); var hosts = new CSharpHostManager(resources); await hosts.StartAsync(default);
        await using var candidate = new CSharpValidationService(settings, content, resources, hosts, cfg);
        var execution = new ExecutionManager(settings, content, resources, resourceSettings, candidate); await execution.StartAsync(default); await candidate.StartAsync(default);
        var exchange = new FileSourceStore(settings.ExchangeRoot); var csharp = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"scope\";}public int MoveNext(int[] m,int p,int[] i){return -1;}}")));
        var js = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("module.exports=class{initialize(){}getName(){return 'idle';}moveNext(){return -1;}}")));
        var ownerId = Guid.NewGuid(); var cells = new int[36]; foreach (var p in new[] { 14, 15, 20, 21 }) cells[p] = 500;
        ExecutionRequest Request(string language = "csharp") => new() { ContractVersion = 1, RequestId = Guid.NewGuid(), MatchId = Guid.NewGuid(), Scope = new() { Kind = "user", SubjectId = ownerId }, Map = new() { Id = "review", Revision = 1, Columns = 6, Rows = 6, Tiles = cells, Settings = JsonSerializer.SerializeToElement(content.Defaults) }, Options = new() { Mode = "practice", BlackMatter = false, DestroyWalls = false }, Participants = [new() { PlayerId = 0, RunId = Guid.NewGuid(), Language = language, Source = language == "csharp" ? csharp : js, StartSlot = 0, CharacterId = "pengko" }] };
        async Task Until(Func<bool> condition) { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)); while (!condition()) await Task.Delay(20, timeout.Token); }
        try
        {
            var request = Request(); var game = await execution.Accept(request, default, candidate: true);
            Assert(game.ResourceGroup!.Observe().MemoryLimitBytes == 512L * 1024 * 1024 && game.ResourceGroup.Observe().CpuRate == 1000, "Game configured aggregate limits missing.");
            var reservation = JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(reservation["reservedMemoryBytes"]!.GetValue<long>() == 512L * 1024 * 1024 && reservation["reservedProcesses"]!.GetValue<int>() == resourceSettings.Game.ProcessCount, "C# child charged a second global reservation.");
            if (OperatingSystem.IsWindows())
            {
                var sessions = (System.Collections.IEnumerable)typeof(CSharpHostManager).GetField("sessions", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(hosts)!;
                var job = (SafeFileHandle)game.ResourceGroup.GetType().GetField("job", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(game.ResourceGroup)!;
                foreach (CSharpHostSession session in sessions)
                {
                    using var process = Process.GetProcessById(session.ProcessId); Assert(IsProcessInJob(process.Handle, job, out var inside) && inside, "Actual C# process remains outside game job.");
                    var child = (IExecutionResourceGroup)typeof(CSharpHostSession).GetField("resources", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(session)!;
                    Assert(child.Observe().MemoryLimitBytes <= game.ResourceGroup.Observe().MemoryLimitBytes, "Child memory limit exceeds parent.");
                }
                var path = Path.Combine(settings.ExecutionRoot, "games", request.MatchId.ToString(), "csharp-runners.private.json");
                using (var reader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    await execution.Stop(game, "user-stopped"); Assert(game.Closed.Task.IsCompletedSuccessfully && game.State == "closed" && hosts.ManagedCount == 0, "File lock blocked actual game closure.");
                    Assert(execution.View(game).Bool("privateCleanupPending") && File.Exists(path), "Failed delete was hidden instead of queued.");
                    var games = new List<ExecutionRecord>();
                    for (int i = 0; i < 4; i++) games.Add(await execution.Accept(Request("javascript"), default));
                    Assert(games.Count == 4, "Closed game still occupies an admission slot."); foreach (var current in games) await execution.Stop(current, "user-stopped");
                }
                await Until(() => !File.Exists(path) && !game.PrivateCleanupPending);
                await Until(() => !AtomicFile.Read(Path.Combine(settings.ExecutionRoot, "games", request.MatchId.ToString(), "status.json"), new()).GetAwaiter().GetResult().Bool("privateCleanupPending"));
                Assert(!game.PrivateCleanupPending, "Unlocked private file not retried/persisted.");
                // Recovery must start even when a previously closed game's private file stays locked.
                await File.WriteAllTextAsync(path, "synthetic retained private file");
                using (var reader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    await execution.StopAsync(default); execution.Dispose(); execution = new ExecutionManager(settings, content, resources, resourceSettings, candidate); await execution.StartAsync(default);
                    game = execution.Get(request.MatchId); Assert(game.Closed.Task.IsCompletedSuccessfully && game.PrivateCleanupPending, "Restart blocked or discarded pending private cleanup.");
                }
                await Until(() => !File.Exists(path) && !game.PrivateCleanupPending); Assert(!File.Exists(path), "Recovered private cleanup did not retry.");
                // A one-process game cannot host both Node and a C# actor.
                var quotaDir = Path.Combine(dir, "strict"); var strictCfg = new ConfigurationBuilder().AddConfiguration(cfg).AddInMemoryCollection(new Dictionary<string, string?> { ["Backend:ExecutionRoot"] = quotaDir, ["Backend:Resources:GameProcesses"] = "1" }).Build();
                var strictSettings = new StorageSettings(strictCfg); var strictLimits = new ExecutionResourceSettings(strictCfg); var strictResources = new ExecutionResources(strictLimits);
                var strictHosts = new CSharpHostManager(strictResources); await strictHosts.StartAsync(default);
                await using var strictCandidate = new CSharpValidationService(strictSettings, content, strictResources, strictHosts, strictCfg);
                using var strict = new ExecutionManager(strictSettings, content, strictResources, strictLimits, strictCandidate); await strict.StartAsync(default); await strictCandidate.StartAsync(default);
                try { await strict.Accept(Request(), default, candidate: true); throw new Exception("One-process cap admitted C# outside the game."); } catch (ServiceFault error) when (error.Status == 400) { checks++; }
                Assert(strictHosts.ManagedCount == 0 && JsonSerializer.SerializeToNode(strictResources.Status)!["reservedProcesses"]!.GetValue<int>() == 0, "Rejected child retained hosts/reservations.");
                await strictCandidate.StopAsync(default); await strict.StopAsync(default); await strictHosts.StopAsync(default);
            }
            else await execution.Stop(game, "user-stopped");
            Assert(JsonSerializer.SerializeToNode(resources.Status)!["reservedProcesses"]!.GetValue<int>() == 0, "Review regression leaked reservations.");
        }
        finally { await execution.StopAsync(default); execution.Dispose(); await candidate.StopAsync(default); await hosts.StopAsync(default); }
        await File.WriteAllTextAsync(Path.Combine(root, "artifacts/c4-review-fixes-report.json"), JsonSerializer.Serialize(new { date = DateTimeOffset.UtcNow, checks, resources = resources.Status }));
        Console.WriteLine($"C4 review-fix checks: {checks} passed; nested quota/membership, attempt ordering/cancellation, private file lock/admission/restart recovery.");
    }
    [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool contained);
    private sealed class HeldResultStore(IAccountStore inner) : IAccountStore
    {
        public bool Armed;
        public TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously), Resume = new(TaskCreationOptions.RunContinuationsAsynchronously), Applied = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<T> Read<T>(Func<JsonObject, T> read) => inner.Read(read);
        public async Task<T> Change<T>(Func<JsonObject, Task<T>> change)
        {
            bool hold = false;
            if (Armed && typeof(T) == typeof(bool))
            {
                var preview = await inner.Read(d => d.CloneObject()); await change(preview);
                if (preview["algorithms"]!.AsArray().Any(a => a!["validation"]?.Text("state") == "passed")) { Armed = false; hold = true; Entered.TrySetResult(); await Resume.Task; }
            }
            var result = await inner.Change(change); if (hold) Applied.TrySetResult(); return result;
        }
    }
    private sealed class ResultTransport : HttpMessageHandler, IHttpClientFactory
    {
        int calls; public bool Hold; public TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (Hold) { Entered.TrySetResult(); await Task.Delay(Timeout.Infinite, token); }
            bool ok = Interlocked.Increment(ref calls) == 1; var value = new JsonObject { ["ok"] = ok, ["calls"] = 36, ["profileVersion"] = "javascript-preflight-v2", ["fixtureVersion"] = "2.0.0" };
            if (!ok) { value["error"] = "new manual result"; value["diagnostic"] = new JsonObject { ["stage"] = "execution" }; }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(value.ToJsonString()) };
        }
    }
}
