using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace CoinHunter.Operations.Api.Services;

public sealed class MatchService(IAccountStore store, AccountService accounts, IMapStore maps, GameContent content, StorageSettings storage, ExecutionClient execution, AlgorithmValidationService validation, IConfiguration? configuration = null) : BackgroundService
{
    private readonly AlgorithmLanguages languagePolicy = new(configuration ?? new ConfigurationBuilder().Build());
    private readonly SemaphoreSlim creation = new(1);
    private readonly SemaphoreSlim reconciliation = new(1);
    private readonly SemaphoreSlim applying = new(1);
    private FileSourceStore Exchange => new(storage.ExchangeRoot);
    private static string Owner(ExecutionScope scope) => scope.Kind + ":" + scope.SubjectId;
    public async Task<string> Create(ExecutionScope scope, JsonObject input, SourceReference? upload, string? idempotencyKey)
    {
        await creation.WaitAsync();
        var staged = new HashSet<Guid>(); if (upload is not null) staged.Add(upload.SourceKey);
        var committed = false;
        try
        {
            var owner = Owner(scope); var mode = input.Text("mode", "practice"); var dummy = input.Int("dummyCount", -1); var slot = input.Int("startSlot"); var character = input.Text("characterId", "pengko");
            if (mode is not ("practice" or "duel") || dummy is < 0 or > 3 || slot is < 0 or > 3 || !new[] { "pengko", "nyangtami", "dino", "lumi" }.Contains(character) || input["blackMatter"] is null || input["destroyWalls"] is null)
                throw new ServiceFault(400, "맵·더미·캐릭터·기믹 설정을 확인하세요.");
            if (mode == "duel" && (scope.Kind != "user" || dummy != 0 || string.IsNullOrEmpty(input.Text("opponentHistoryId"))) ||
                mode == "practice" && input.ContainsKey("opponentHistoryId") || input.ContainsKey("opponentSource") || input.ContainsKey("opponentAlgorithmId"))
                throw new ServiceFault(400, "이전 경기 대결은 로그인 후 본인의 경기 기록으로만 가능합니다.");
            var map = await maps.Get(input.Text("mapId"), published: true); MapRules.Validate(map, content, true);
            SourceReference primary;
            string language = input.Text("language", "javascript");
            if (input["algorithmId"] is not null)
            {
                if (scope.Kind != "user") throw new ServiceFault(401, "로그인이 필요합니다.");
                if (upload is not null || input.ContainsKey("source")) throw new ServiceFault(400, "파일과 저장 알고리즘 중 하나만 선택하세요.");
                var saved = await accounts.Algorithm(scope.SubjectId.ToString(), input.Text("algorithmId"));
                language = saved.Text("language", "javascript");
                if (input.ContainsKey("language") && input.Text("language") != language) throw new ServiceFault(400, "저장 알고리즘의 언어가 일치하지 않습니다.");
                languagePolicy.Require(language, true);
                primary = await accounts.Sources.Copy(Guid.Parse(saved.Text("sourceKey")), Exchange);
                staged.Add(primary.SourceKey);
            }
            else primary = upload ?? throw new ServiceFault(400, "알고리즘 코드가 필요합니다.");
            languagePolicy.Require(language, scope.Kind == "user");
            var sources = new List<SourceReference> { primary };
            var languages = new List<string> { language };
            if (mode == "duel")
            {
                var previous = await accounts.Algorithm(scope.SubjectId.ToString(), input.Text("opponentHistoryId"), true);
                var previousLanguage = previous.Text("language", "javascript");
                languagePolicy.Require(previousLanguage, true);
                var copied = await accounts.Sources.Copy(Guid.Parse(previous.Text("sourceKey")), Exchange); staged.Add(copied.SourceKey); sources.Add(copied);
                languages.Add(previousLanguage);
            }
            else
                for (var i = 0; i < dummy; i++)
                {
                    await using var example = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(content.Value.Text("example")));
                    var copied = await Exchange.Put(example); staged.Add(copied.SourceKey); sources.Add(copied);
                    languages.Add("javascript");
                }
            var requestKey = Guid.NewGuid();
            if (idempotencyKey is not null && (!Guid.TryParseExact(idempotencyKey, "D", out requestKey) || requestKey == Guid.Empty)) throw new ServiceFault(400, "Idempotency-Key는 UUID 형식이어야 합니다.");
            var fingerprintInput = input.CloneObject(); fingerprintInput.Remove("source");
            var fingerprint = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Canonical(fingerprintInput)!.ToJsonString() + string.Join(',', sources.Select(source => source.Sha256)) + (languages.Any(value => value != "javascript") ? "/languages:" + string.Join(',', languages) : ""))));
            var existing = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().SingleOrDefault(item => item.Text("owner") == owner && item.Text("requestKey") == requestKey.ToString())?.CloneObject());
            if (existing is not null)
            {
                if (existing.Text("fingerprint") != fingerprint) throw new ServiceFault(409, "요청 ID의 내용이 이전과 다릅니다.");
                return existing.Text("id");
            }
            var active = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().Any(item => item.Text("owner") == owner && !item.Bool("completed")));
            if (active) throw new ServiceFault(409, "진행 중인 게임을 먼저 종료하세요.");
            // Revalidate immutable snapshots at server admission, including history opponents.
            // Client-supplied flags, old stored statuses and a successful save are not execution permission.
            for (int i = 0; i < (mode == "duel" ? 2 : 1); i++) await validation.RequirePassed(scope, sources[i], languages[i]);
            var id = Guid.NewGuid();
            var slots = mode == "duel" ? new[] { slot, 3 - slot } : new[] { slot }.Concat(new[] { 0, 1, 2, 3 }.Where(value => value != slot)).ToArray();
            var request = new ExecutionRequest
            {
                ContractVersion = 1,
                RequestId = Guid.NewGuid(),
                MatchId = id,
                Scope = scope,
                Map = new MapSnapshot { Id = map.Text("id"), Revision = map.Int("revision"), Columns = map.Int("columns"), Rows = map.Int("rows"), Tiles = map["tiles"]!.AsArray().Select(value => value!.GetValue<int>()).ToArray(), Settings = JsonSerializer.SerializeToElement(map["settings"]) },
                Participants = sources.Select((source, index) => new ParticipantRequest { PlayerId = index, RunId = Guid.NewGuid(), Language = languages[index], Source = source, StartSlot = slots[index], CharacterId = index == 0 ? character : mode == "duel" ? character == "pengko" ? "nyangtami" : "pengko" : "kobi" }).ToArray(),
                Options = new MatchOptions { Mode = mode, BlackMatter = input.Bool("blackMatter"), DestroyWalls = input.Bool("destroyWalls") }
            };
            await store.Change(data =>
            {
                if (scope.Kind == "user" && !JsonData.Array(data, "users").OfType<JsonObject>().Any(user => user.Text("id") == scope.SubjectId.ToString() && user.Bool("active")))
                    throw new ServiceFault(403, "이용할 수 없는 계정입니다.");
                JsonData.Array(data, "matches").Add(new JsonObject { ["id"] = id.ToString(), ["owner"] = owner, ["scope"] = JsonSerializer.SerializeToNode(scope, Protocol.JsonOptions), ["requestKey"] = requestKey.ToString(), ["fingerprint"] = fingerprint, ["request"] = JsonSerializer.SerializeToNode(request, Protocol.JsonOptions), ["mapName"] = map.Text("name"), ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"), ["completed"] = false, ["applied"] = false });
                return Task.FromResult(true);
            });
            committed = true;
            try { await EnsureStarted(request); }
            catch (ServiceFault fault) when (fault.Code == Protocol.AdmissionRejectedCode)
            {
                // Only a confirmed pre-registration rejection can roll back. An
                // unavailable service/lost response may already own a running game.
                await store.Change(data => { var list = JsonData.Array(data, "matches"); list.Remove(JsonData.Find(data, "matches", id.ToString())); return Task.FromResult(true); });
                committed = false; throw;
            }
            return id.ToString();
        }
        finally
        {
            try { if (!committed) foreach (var key in staged) await Exchange.Delete(key); }
            finally { creation.Release(); }
        }
    }
    private async Task EnsureStarted(ExecutionRequest request)
    {
        var view = await execution.Call(HttpMethod.Post, "/internal/v1/matches", request, candidateValidation: request.Participants.Any(player => player.Language == "csharp"));
        for (var attempt = 0; view.Text("state") == "accepted" && attempt < 200; attempt++)
        {
            await Task.Delay(100);
            view = await execution.Call(HttpMethod.Get, $"/internal/v1/matches/{request.MatchId}");
        }
        if (view.Text("state") == "accepted") throw new ServiceFault(503, "게임 준비가 지연되고 있습니다. 같은 요청 ID로 다시 확인하세요.");
        if (view.Text("state") == "failed" || view["result"] is JsonObject result && result["snapshot"] is null) throw new ServiceFault(400, "알고리즘을 실행하지 못했습니다. 코드 검사를 실행하세요.");
        if (view.Text("state") == "prepared") await execution.Call(HttpMethod.Post, $"/internal/v1/matches/{request.MatchId}/start", new StartPayload(Guid.NewGuid()));
    }
    private static JsonNode? Canonical(JsonNode? value) => value switch
    {
        JsonObject obj => new JsonObject(obj.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new KeyValuePair<string, JsonNode?>(pair.Key, Canonical(pair.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonical).ToArray()),
        _ => value?.DeepClone()
    };
    public async Task<JsonObject> Owned(string id, ExecutionScope scope)
    {
        var item = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().SingleOrDefault(item => item.Text("id") == id && item.Text("owner") == Owner(scope))?.CloneObject());
        return item ?? throw new ServiceFault(404, "게임을 찾을 수 없습니다.");
    }
    public async Task<JsonObject> View(string id, ExecutionScope scope, int? afterSequence = null, CancellationToken token = default)
    {
        var item = await Owned(id, scope);
        if (item["finalSnapshot"] is JsonObject final) return final;
        var view = await execution.Call(HttpMethod.Get, $"/internal/v1/matches/{Guid.Parse(id)}" + (afterSequence.HasValue ? $"?afterSequence={afterSequence.Value}" : ""), token: token, waitForSnapshot: afterSequence.HasValue);
        if (view["result"] is JsonObject)
        {
            await Apply(item, view);
            var finalSnapshot = await store.Read(data => JsonData.Find(data, "matches", id)["finalSnapshot"]?.CloneObject());
            if (finalSnapshot is not null) return finalSnapshot;
        }
        return view["snapshot"]?.CloneObject() ?? throw new ServiceFault(409, "게임을 준비 중입니다.");
    }
    public async Task Stop(string id, ExecutionScope scope, string reason = "user-stopped")
    {
        var item = await Owned(id, scope);
        await store.Change(data => { JsonData.Find(data, "matches", id)["stopReason"] = reason; return Task.FromResult(true); });
        if (!item.Bool("completed"))
        {
            var request = item["request"]!.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!;
            await execution.Call(HttpMethod.Post, $"/internal/v1/matches/{Guid.Parse(id)}/stop", new ExecutionStop(Guid.NewGuid(), reason, request));
            var view = await execution.Call(HttpMethod.Get, $"/internal/v1/matches/{Guid.Parse(id)}"); await Apply(item, view);
        }
    }
    public async Task StopOwner(string userId)
    {
        var scope = new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(userId) };
        var ids = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().Where(item => item.Text("owner") == Owner(scope) && !item.Bool("completed")).Select(item => item.Text("id")).ToArray());
        foreach (var id in ids) await Stop(id, scope, "account-ended");
    }
    private async Task Apply(JsonObject item, JsonObject view)
    {
        if (view["result"] is not JsonObject result) return;
        await applying.WaitAsync();
        try
        {
            item = await store.Read(data => JsonData.Find(data, "matches", item.Text("id")).CloneObject());
            var id = item.Text("id"); var hash = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(result.ToJsonString())));
            var snapshot = (result["snapshot"] as JsonObject ?? view["snapshot"] as JsonObject)?.CloneObject();
            var reason = snapshot?["game"]?.Text("reason") ?? "";
            if (string.IsNullOrEmpty(reason)) reason = result.Text("reason", "runtime-failure");
            if (snapshot?["game"] is JsonObject game && game.Text("status") != "finished")
            {
                game["status"] = "finished"; game["reason"] = reason; snapshot["sequence"] = snapshot.Int("sequence") + 1;
            }
            var scope = item["scope"]!.Deserialize<ExecutionScope>(Protocol.JsonOptions)!;
            // Copy once before the metadata transaction. Losing this race leaves an offline-GC orphan, never a broken reference.
            Guid? historySource = null;
            if (!item.Bool("applied") && scope.Kind == "user" && !new[] { "server-shutdown", "account-ended", "runtime-failure", "execution-host-restarted", "recording-failure", "resource-memory-limit", "resource-cleanup-unconfirmed" }.Contains(reason) && snapshot?["game"]?["players"]?[0] is JsonObject)
            {
                var request = item["request"]!.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!;
                historySource = (await Exchange.Copy(request.Participants[0].Source.SourceKey, accounts.Sources)).SourceKey;
            }
            await store.Change(data =>
            {
                var current = JsonData.Find(data, "matches", id);
                if (current.Bool("applied")) { if (current.Text("resultHash") != hash) throw new ServiceFault(409, "상충하는 최종 결과입니다."); return Task.FromResult(true); }
                if (historySource is Guid key)
                {
                    var player = snapshot!["game"]!["players"]![0]!;
                    var primary = item["request"]!["participants"]![0]!;
                    JsonData.Array(data, "history").Add(new JsonObject { ["id"] = id, ["matchId"] = id, ["ownerId"] = scope.SubjectId.ToString(), ["playedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["mapId"] = item["request"]!["map"]!.Text("id"), ["mapName"] = item.Text("mapName"), ["algorithmName"] = player.Text("name"), ["characterId"] = player.Text("characterId"), ["score"] = player.Int("score"), ["reason"] = reason, ["mode"] = item["request"]!["options"]!.Text("mode"), ["sourceKey"] = key.ToString(), ["language"] = primary.Text("language", "javascript"), ["sourceHash"] = primary["source"]!.Text("sha256") });
                }
                current["resultHash"] = hash; current["completed"] = true; current["applied"] = true; current["finalSnapshot"] = snapshot?.DeepClone(); current["recording"] = result["recording"]?.DeepClone();
                return Task.FromResult(true);
            });
            await Acknowledge(id);
        }
        finally { applying.Release(); }
    }
    private async Task Acknowledge(string id)
    {
        await execution.Call(HttpMethod.Post, $"/internal/v1/results/{id}/ack", new ResultAcknowledgement(Guid.Parse(id), 1));
        await store.Change(data => { JsonData.Find(data, "matches", id)["acknowledged"] = true; return Task.FromResult(true); });
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Refresh(); }
            catch (Exception error) when (error is ServiceFault or HttpRequestException or OperationCanceledException or IOException) { }
            try { await Task.Delay(500, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }
    public async Task Refresh()
    {
        await creation.WaitAsync();
        await reconciliation.WaitAsync();
        try
        {
            var pending = await store.Read(data => JsonData.Array(data, "matches").OfType<JsonObject>().Where(item => !item.Bool("completed") || !item.Bool("acknowledged")).Select(item => item.CloneObject()).ToArray());
            foreach (var item in pending)
            {
                try { await Reconcile(item); }
                catch (Exception error) when (error is ServiceFault or HttpRequestException or IOException or OperationCanceledException or JsonException or InvalidOperationException)
                { /* Retain this receipt for retry; one game must not starve later owners. */ }
            }
        }
        finally { reconciliation.Release(); creation.Release(); }
    }
    private async Task Reconcile(JsonObject item)
    {
        // Applied summaries must never be recreated as games when an execution record is unavailable.
        if (item.Bool("completed"))
        {
            await Acknowledge(item.Text("id"));
            return;
        }
        var request = item["request"]!.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!;
        var ended = item.Text("stopReason");
        if (request.Scope.Kind == "user" && await accounts.User(request.Scope.SubjectId.ToString()) is null) ended = "account-ended";
        JsonObject? view = null;
        try { view = await execution.Call(HttpMethod.Get, $"/internal/v1/matches/{request.MatchId}"); }
        catch (ServiceFault fault) when (fault.Status == 404) { }
        if (view is null && ended.Length == 0)
        {
            if (request.Participants.Any(player => player.Language == "csharp") && !languagePolicy.CSharpEnabled) ended = "prepare-failed";
            else
            {
                try { view = await execution.Call(HttpMethod.Post, "/internal/v1/matches", request, candidateValidation: request.Participants.Any(player => player.Language == "csharp")); }
                catch (ServiceFault fault) when (fault.Code == Protocol.AdmissionRejectedCode) { ended = "prepare-failed"; }
            }
        }
        if (view?["result"] is JsonObject) { await Apply(item, view); return; }
        if (ended.Length > 0)
        {
            await execution.Call(HttpMethod.Post, $"/internal/v1/matches/{request.MatchId}/stop", new ExecutionStop(Guid.NewGuid(), ended, request));
            view = await execution.Call(HttpMethod.Get, $"/internal/v1/matches/{request.MatchId}");
            await Apply(item, view);
        }
        else if (view?.Text("state") == "prepared") await execution.Call(HttpMethod.Post, $"/internal/v1/matches/{request.MatchId}/start", new StartPayload(Guid.NewGuid()));
    }
}
