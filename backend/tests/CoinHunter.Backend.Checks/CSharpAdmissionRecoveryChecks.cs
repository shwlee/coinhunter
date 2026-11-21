using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.Extensions.Configuration;

internal static class CSharpAdmissionRecoveryChecks
{
    public static async Task Run(string root)
    {
        int checks = 0;
        void Check(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        async Task Fault(Func<Task> action, int status, string? code = null) { try { await action(); } catch (ServiceFault e) when (e.Status == status && (code is null || e.Code == code)) { checks++; return; } throw new Exception("Expected fault " + status); }
        var directory = Path.Combine(root, "artifacts", "csharp-recovery-fixes-" + Guid.NewGuid().ToString("N"));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Backend:RepositoryRoot"] = root, ["Backend:DataRoot"] = Path.Combine(directory, "operations"), ["Backend:ExchangeRoot"] = Path.Combine(directory, "exchange"), ["Backend:ExecutionRoot"] = Path.Combine(directory, "execution") }).Build();
        var settings = new StorageSettings(config); var content = new GameContent(settings);
        using var store = new FileAccountStore(settings);
        var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources")); var exchange = new FileSourceStore(settings.ExchangeRoot);
        var accounts = new AccountService(store, sources); var owner = Guid.Parse((await accounts.Login("admin@company.test")).Text("id")); var other = Guid.Parse((await accounts.Login("tester@company.test")).Text("id"));
        var scope = new ExecutionScope { Kind = "user", SubjectId = owner };
        var map = content.Value["samples"]![0]!["document"]!;
        ExecutionRequest Request(string language = "csharp", Guid? subject = null) => new() { ContractVersion = 1, MatchId = Guid.NewGuid(), RequestId = Guid.NewGuid(), Scope = scope with { SubjectId = subject ?? owner }, Map = new() { Id = map.Text("id"), Revision = map.Int("revision"), Columns = map.Int("columns"), Rows = map.Int("rows"), Tiles = map["tiles"]!.AsArray().Select(p => p!.GetValue<int>()).ToArray(), Settings = JsonSerializer.SerializeToElement(map["settings"]) }, Options = new() { Mode = "practice", BlackMatter = false, DestroyWalls = false }, Participants = [new() { PlayerId = 0, RunId = Guid.NewGuid(), Language = language, StartSlot = 0, CharacterId = "pengko", Source = new() { SourceKey = Guid.NewGuid(), ByteLength = 1, Sha256 = new string('a', 64) } }] };
        var resourceSettings = new ExecutionResourceSettings(config); var resources = new ExecutionResources(resourceSettings);
        var original = Request();
        using (var manager = new ExecutionManager(settings, content, resources, resourceSettings))
        {
            await manager.StartAsync(default);
            await Fault(() => manager.Accept(original, default), 503, Protocol.AdmissionRejectedCode);
            var cancelled = await manager.Cancel(original, "user-stopped", default);
            Check(cancelled.Closed.Task.IsCompletedSuccessfully && cancelled.Result!.Text("outcome") == "aborted", "Unknown cancellation was not terminal.");
            Check(ReferenceEquals(cancelled, await manager.Accept(original, default)), "Late admission ignored cancellation.");
            Check(cancelled.EnginePid is null && cancelled.ResourceGroup is null, "Cancellation allocated a runtime.");
            await Fault(() => manager.Accept(original with { RequestId = Guid.NewGuid() }, default), 409, Protocol.AdmissionRejectedCode);
            await Fault(() => manager.Cancel(original with { Scope = scope with { SubjectId = other } }, "user-stopped", default), 409);
            await manager.StopAsync(default);
        }
        using (var restarted = new ExecutionManager(settings, content, resources, resourceSettings))
        {
            await restarted.StartAsync(default);
            var recovered = await restarted.Accept(original, default);
            Check(recovered.Result!.Text("reason") == "user-stopped" && recovered.Closed.Task.IsCompletedSuccessfully && recovered.EnginePid is null, "Restart lost the cancellation fence.");
            await Fault(() => restarted.Accept(Request(), default), 503, Protocol.AdmissionRejectedCode);
            await restarted.StopAsync(default);
        }
        Check(JsonSerializer.SerializeToNode(resources.Status)!["reservedMemoryBytes"]!.GetValue<long>() == 0, "Cancellation leaked resource reservations.");

        using var transport = new RecoveryTransport();
        var backend = new BackendSettings { Service = Protocol.OperationsService, ListenUrl = new("http://127.0.0.1:3101"), PublicUrl = new("http://127.0.0.1:3000"), ExecutionUrl = new("http://127.0.0.1:3102"), InternalServiceKey = "test-" + new string('a', 40), TrustedProxies = [] };
        var client = new ExecutionClient(transport, backend);
        using var validation = new AlgorithmValidationService(accounts, settings, content, client, config);
        using var operations = new MatchService(store, accounts, new FileMapStore(settings, content, store), content, settings, client, validation, config);
        async Task Add(ExecutionRequest request) => await store.Change(data => { JsonData.Array(data, "matches").Add(new JsonObject { ["id"] = request.MatchId.ToString(), ["owner"] = "user:" + request.Scope.SubjectId, ["scope"] = JsonSerializer.SerializeToNode(request.Scope, Protocol.JsonOptions), ["request"] = JsonSerializer.SerializeToNode(request, Protocol.JsonOptions), ["completed"] = false, ["applied"] = false }); return Task.FromResult(true); });
        async Task<bool> Completed(Guid id) => await store.Read(data => JsonData.Find(data, "matches", id.ToString()).Bool("completed"));
        var first = Request(); var next = Request("javascript", other);
        await Add(first); await Add(next);
        transport.BrokenLookup = first.MatchId; transport.Views[next.MatchId] = RecoveryTransport.Closed("runtime-failure");
        await operations.Refresh();
        Check(!await Completed(first.MatchId), "A transient lookup failure was prematurely finalized.");
        Check(await Completed(next.MatchId), "One failing C# receipt starved another JS owner.");
        Check(transport.Admissions == 0, "Recovery recreated an existing execution.");
        transport.BrokenLookup = null;
        transport.Views[first.MatchId] = RecoveryTransport.Closed("runtime-failure");
        await operations.Refresh();
        Check(await Completed(first.MatchId), "Disabled C# result was not applied.");
        var missing = Request(); await Add(missing);
        await operations.Stop(missing.MatchId.ToString(), scope);
        Check(await Completed(missing.MatchId) && transport.Cancelled.Contains(missing.MatchId), "Unknown execution cannot be stopped.");
        Check(transport.CancellationRequests[missing.MatchId].RequestId == missing.RequestId, "Cancellation did not bind the immutable request.");
        var orphan = Request(); await Add(orphan); await operations.Refresh();
        Check(await Completed(orphan.MatchId) && transport.Cancelled.Contains(orphan.MatchId), "Disabled uncreated receipt did not settle.");

        JsonObject Options() => new() { ["mapId"] = map.Text("id"), ["mode"] = "practice", ["dummyCount"] = 0, ["startSlot"] = 0, ["characterId"] = "pengko", ["blackMatter"] = false, ["destroyWalls"] = false };
        transport.Reject = true; transport.RejectionCode = Protocol.AdmissionRejectedCode;
        var rejectedSource = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(content.Value.Text("example"))));
        await Fault(() => operations.Create(scope, Options(), rejectedSource, null), 503, Protocol.AdmissionRejectedCode);
        Check(!File.Exists(exchange.PathFor(rejectedSource.SourceKey)), "Confirmed rejection leaked staged source.");
        Check(!await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().Any(item => item.Text("owner") == "user:" + owner && !item.Bool("completed"))), "Confirmed rejection occupied an owner slot.");
        config["Backend:Languages:CSharpBetaEnabled"] = "true";
        var oldRejected = Request(); await Add(oldRejected); await operations.Refresh();
        Check(await Completed(oldRejected.MatchId) && transport.Cancelled.Contains(oldRejected.MatchId), "Legacy policy-rejected receipt did not settle.");
        config["Backend:Languages:CSharpBetaEnabled"] = "false";
        transport.RejectionCode = "request_failed";
        var uncertainSource = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes(content.Value.Text("example"))));
        await Fault(() => operations.Create(scope, Options(), uncertainSource, null), 503, "request_failed");
        var uncertain = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().Single(item => !item.Bool("completed")).CloneObject());
        Check(File.Exists(exchange.PathFor(uncertainSource.SourceKey)), "Ambiguous failure discarded a possibly active source.");
        await operations.Stop(uncertain.Text("id"), scope);
        Check(await Completed(Guid.Parse(uncertain.Text("id"))), "Ambiguous admission could not be cancelled safely.");
        await File.WriteAllTextAsync(Path.Combine(root, "artifacts/csharp-recovery-fixes-components.json"), JsonSerializer.Serialize(new { checks, passed = true, directory, actualCancellationFence = true, operationsTransport = "test-double" }, Protocol.JsonOptions));
        Console.WriteLine($"C# admission/recovery fix checks: {checks} passed; durable cancellation, immutable identity, error isolation, rejection versus uncertain reply.");
    }

    private sealed class RecoveryTransport : HttpMessageHandler, IHttpClientFactory
    {
        internal Guid? BrokenLookup;
        internal bool Reject;
        internal string RejectionCode = Protocol.AdmissionRejectedCode;
        internal int Admissions;
        internal Dictionary<Guid, JsonObject> Views { get; } = [];
        internal HashSet<Guid> Cancelled { get; } = [];
        internal Dictionary<Guid, ExecutionRequest> CancellationRequests { get; } = [];
        public HttpClient CreateClient(string name) => new(this, false);
        internal static JsonObject Closed(string reason) => new() { ["state"] = "closed", ["result"] = new JsonObject { ["reason"] = reason, ["snapshot"] = null, ["recording"] = new JsonObject { ["status"] = "failed" } } };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath;
            JsonObject Response(string error, string code = "request_failed") => new() { ["error"] = error, ["code"] = code };
            HttpResponseMessage Reply(JsonObject body, int status = 200) => new((HttpStatusCode)status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
            if (path.EndsWith("/validations", StringComparison.Ordinal)) return Reply(new() { ["ok"] = true, ["profileVersion"] = "javascript-preflight-v2", ["fixtureVersion"] = "2.0.0", ["calls"] = 36 });
            if (request.Method == HttpMethod.Get)
            {
                var id = Guid.Parse(path.Split('/').Last());
                if (id == BrokenLookup) return Reply(Response("Temporary outage"), 503);
                return Views.TryGetValue(id, out var view) ? Reply(view) : Reply(Response("Not found"), 404);
            }
            if (path.EndsWith("/stop", StringComparison.Ordinal))
            {
                var stop = JsonSerializer.Deserialize<ExecutionStop>(await request.Content!.ReadAsStringAsync(token), Protocol.JsonOptions)!;
                var original = stop.Execution ?? throw new Exception("Missing cancellation request.");
                Cancelled.Add(original.MatchId); CancellationRequests[original.MatchId] = original;
                Views[original.MatchId] = Closed(stop.Reason); return Reply(new() { ["ok"] = true });
            }
            if (path.EndsWith("/matches", StringComparison.Ordinal))
            {
                Admissions++;
                if (Reject) return Reply(Response("Admission unavailable", RejectionCode), 503);
                throw new Exception("Unexpected new admission.");
            }
            return Reply(new() { ["ok"] = true });
        }
    }
}
