using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.Extensions.Configuration;

// Component checks only. The execution service is a deterministic transport double;
// these checks do not constitute final browser/engine/beta acceptance.
internal static class CSharpUserSupportChecks
{
    public static async Task Run(string root)
    {
        int checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        async Task Fault(Func<Task> action, int status) { try { await action(); } catch (ServiceFault e) when (e.Status == status) { checks++; return; } throw new Exception("Expected " + status); }
        var directory = Path.Combine(root, "artifacts", "csharp-user-components-" + Guid.NewGuid().ToString("N"));
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Backend:RepositoryRoot"] = root, ["Backend:DataRoot"] = Path.Combine(directory, "operations"),
            ["Backend:ExchangeRoot"] = Path.Combine(directory, "exchange"), ["Backend:ExecutionRoot"] = Path.Combine(directory, "execution")
        }).Build();
        var policy = new AlgorithmLanguages(configuration);
        Check(!policy.CSharpEnabled, "Default C# gate opened.");
        Check(AlgorithmLanguages.CSharpProfile == PlayerAnalyzer.Profile, "Public profile differs from analyzer.");
        await Fault(() => { policy.Require("csharp", true); return Task.CompletedTask; }, 503);
        await Fault(() => { policy.Require("csharp", false); return Task.CompletedTask; }, 401);
        await Fault(() => { policy.Require("python", true); return Task.CompletedTask; }, 400);
        configuration["Backend:Languages:CSharpBetaEnabled"] = "true";
        Check(policy.CSharpEnabled == OperatingSystem.IsWindows(), "OS gate mismatch.");
        if (!OperatingSystem.IsWindows()) { Console.WriteLine($"C# user component policy checks: {checks} passed; Windows-only component cases skipped."); return; }
        Check(!policy.Describe(false)["languages"]![1]!.Bool("enabled"), "Unready execution capability opened.");
        var resourceSettings = new ExecutionResourceSettings(configuration);
        Check(resourceSettings.Game.MemoryBytes == 1024L * 1024 * 1024 && resourceSettings.CSharpBetaGame.MemoryBytes == 2304L * 1024 * 1024, "JS or beta resource policy changed unexpectedly.");
        configuration["Backend:Languages:CSharpGameMemoryMiB"] = "1024";
        try { _ = new ExecutionResourceSettings(configuration); throw new Exception("Undersized beta budget accepted."); } catch (InvalidOperationException) { checks++; }
        configuration["Backend:Languages:CSharpGameMemoryMiB"] = "2304";
        string sample = await File.ReadAllTextAsync(Path.Combine(root, "backend/samples/csharp/nearest-coin.cs"));
        Check(PlayerAnalyzer.Analyze(sample).StaticPassed, "Public C# sample violates policy.");
        var settings = new StorageSettings(configuration); var content = new GameContent(settings);
        using var store = new FileAccountStore(settings); var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources"));
        var accounts = new AccountService(store, sources); var owner = (await accounts.Login("component@company.test")).Text("id");
        var scope = new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(owner) };
        var savedSource = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes(sample)));
        var saved = await accounts.Save(owner, null, "C# component", 0, savedSource.SourceKey, savedSource.Sha256, "csharp");
        Check(saved.Text("language") == "csharp" && !saved["validation"]!.Bool("executionAllowed"), "Saving granted execution permission.");
        using var transport = new SupportTransport(content.PreflightHash);
        var backend = new BackendSettings { Service = Protocol.OperationsService, ListenUrl = new("http://127.0.0.1:3101"), PublicUrl = new("http://127.0.0.1:3000"), ExecutionUrl = new("http://127.0.0.1:3102"), InternalServiceKey = "component-" + new string('a', 40), TrustedProxies = [] };
        var client = new ExecutionClient(transport, backend);
        using var validation = new AlgorithmValidationService(accounts, settings, content, client, configuration);
        var exchange = new FileSourceStore(settings.ExchangeRoot);
        var reference = await sources.Copy(savedSource.SourceKey, exchange);
        await validation.RequirePassed(scope, reference, "csharp");
        var current = await accounts.Algorithm(owner, saved.Text("id"));
        Check(current["validation"]!.Bool("executionAllowed") && current["validation"]!.Text("state") == "passed", "Bound beta report was not applied.");
        transport.WrongOwner = true;
        await Fault(() => validation.RequirePassed(scope, reference, "csharp"), 503);
        current = await accounts.Algorithm(owner, saved.Text("id"));
        Check(current["validation"]!.Text("state") == "unverified" && !current["validation"]!.Bool("executionAllowed"), "Foreign report granted permission.");
        transport.WrongOwner = false;
        configuration["Backend:Languages:CSharpBetaEnabled"] = "false";
        await Fault(() => validation.RequirePassed(scope, reference, "csharp"), 503);
        configuration["Backend:Languages:CSharpBetaEnabled"] = "true";
        var maps = new FileMapStore(settings, content, store);
        var map = (await maps.Registry()).OfType<JsonObject>().First(item => item.Bool("enabled"));
        using var matches = new MatchService(store, accounts, maps, content, settings, client, validation, configuration);
        JsonObject Options(string mode = "practice") => new() { ["algorithmId"] = saved.Text("id"), ["mapId"] = map.Text("id"), ["mode"] = mode, ["dummyCount"] = mode == "practice" ? 1 : 0, ["characterId"] = "pengko", ["startSlot"] = 0, ["blackMatter"] = false, ["destroyWalls"] = false };
        var id = await matches.Create(scope, Options(), null, null);
        Check(transport.LastMatch!.Participants.Select(p => p.Language).SequenceEqual(new[] { "csharp", "javascript" }), "Saved C# primary/JS dummy language lost.");
        transport.Closed = true;
        await matches.View(id, scope);
        var history = (await accounts.History(owner)).OfType<JsonObject>().Single();
        Check(history.Text("language") == "csharp" && history.Text("sourceHash") == savedSource.Sha256, "History lost language/hash.");
        var historical = await accounts.Algorithm(owner, history.Text("id"), true);
        Check((await sources.Describe(Guid.Parse(historical.Text("sourceKey")))).Sha256 == savedSource.Sha256, "History source bytes changed.");
        var jsReference = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes(content.Value.Text("example"))));
        var js = await accounts.Save(owner, null, "JS primary", 0, jsReference.SourceKey, jsReference.Sha256, "javascript");
        var duel = Options("duel"); duel["algorithmId"] = js.Text("id"); duel["opponentHistoryId"] = history.Text("id");
        transport.Closed = false;
        await matches.Create(scope, duel, null, null);
        Check(transport.LastMatch!.Participants.Select(p => p.Language).SequenceEqual(new[] { "javascript", "csharp" }), "Cross-language history opponent lost its language.");
        Check(transport.ValidatedLanguages.Contains("csharp") && transport.ValidatedLanguages.Contains("javascript"), "Admission did not check each language.");
        var spoof = Options(); spoof["language"] = "javascript";
        await Fault(() => matches.Create(scope, spoof, null, null), 400);
        Check((await sources.Describe(savedSource.SourceKey)).Sha256 == savedSource.Sha256, "Component checks changed source bytes.");
        await File.WriteAllTextAsync(Path.Combine(root, "artifacts/csharp-user-component-report.json"), JsonSerializer.Serialize(new { checks, passed = true, finalAcceptance = false, executionTransport = "test-double", directory }, Protocol.JsonOptions));
        Console.WriteLine($"C# user support component checks: {checks} passed; policy, report binding, metadata, mixed request and history. Final acceptance not run.");
    }

    private sealed class SupportTransport(string fixtureHash) : HttpMessageHandler, IHttpClientFactory
    {
        internal bool WrongOwner;
        internal bool Closed;
        internal ExecutionRequest? LastMatch;
        internal HashSet<string> ValidatedLanguages { get; } = [];
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            JsonObject body = new();
            if (request.Content is not null) body = JsonNode.Parse(await request.Content.ReadAsStringAsync(token))!.AsObject();
            JsonObject response;
            if (request.RequestUri!.AbsolutePath.EndsWith("/validations", StringComparison.Ordinal))
            {
                string language = body.Text("language"); ValidatedLanguages.Add(language);
                response = new() { ["ok"] = true, ["calls"] = 36, ["profileVersion"] = "javascript-preflight-v2", ["fixtureVersion"] = "2.0.0" };
                if (language == "csharp")
                {
                    var owner = Guid.Parse(body["scope"]!.Text("subjectId")); string hash = body["source"]!.Text("sha256"); string toolchain = new('a', 64);
                    var report = new CSharpPreflightReport(WrongOwner ? Guid.NewGuid() : owner, CSharpArtifactKeys.Build(hash, toolchain), hash, toolchain, CSharpArtifactPreflight.Profile, "2.0.0", fixtureHash, "passed", 36, null);
                    response["language"] = "csharp"; response["sourceHash"] = hash; response["executionAllowed"] = false; response["profileVersion"] = CSharpArtifactPreflight.Profile; response["fixtureHash"] = fixtureHash; response["report"] = JsonSerializer.SerializeToNode(report, Protocol.JsonOptions);
                }
            }
            else if (request.Method == HttpMethod.Post && request.RequestUri.AbsolutePath.EndsWith("/matches", StringComparison.Ordinal))
            { LastMatch = body.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!; response = new() { ["state"] = "running" }; }
            else if (request.Method == HttpMethod.Get && Closed)
            {
                var snapshot = new JsonObject { ["sequence"] = 1, ["game"] = new JsonObject { ["status"] = "finished", ["reason"] = "user-stopped", ["players"] = new JsonArray(new JsonObject { ["name"] = "component", ["characterId"] = "pengko", ["score"] = 100 }) } };
                response = new() { ["result"] = new JsonObject { ["reason"] = "user-stopped", ["snapshot"] = snapshot, ["recording"] = new JsonObject { ["status"] = "complete" } } };
            }
            else response = new() { ["ok"] = true };
            return new(HttpStatusCode.OK) { Content = new StringContent(response.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}
