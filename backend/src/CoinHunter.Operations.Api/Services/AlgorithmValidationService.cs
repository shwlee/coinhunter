using System.Threading.Channels;
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

// Bounded background validation never determines whether source persistence succeeds.
// Game admission always revalidates its immutable exchange snapshot; no client receipt is trusted.
public sealed class AlgorithmValidationService(AccountService accounts, StorageSettings settings, GameContent content, ExecutionClient execution) : BackgroundService
{
    private sealed record Job(string Owner, string Id, int Revision, Guid SourceKey);
    private readonly Channel<Job> jobs = Channel.CreateBounded<Job>(new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
    private readonly ConcurrentDictionary<string, Job> queuedOwners = new();
    private readonly object gatesLock = new();
    private readonly Dictionary<string, (SemaphoreSlim Gate, int Users)> gates = new();
    public string Version => "javascript-preflight-v2/fixture-2.0.0/500ms/32MiB/" + content.Contract.Text("contentVersion");
    private FileSourceStore Exchange => new(settings.ExchangeRoot);

    public async Task Queue(string owner, JsonObject saved, Guid sourceKey)
    {
        var job = new Job(owner, saved.Text("id"), saved.Int("revision"), sourceKey);
        var state = State("pending", "저장됨 · 코드 검사 대기 중입니다.");
        var reserved = false;
        var enqueued = false;
        try
        {
            reserved = queuedOwners.TryAdd(owner, job);
            if (!reserved)
            {
                if (queuedOwners.TryGetValue(owner, out var running) && running == job)
                {
                    // Do not write pending again: the active job may have just posted its final result.
                    var current = await accounts.Algorithm(owner, job.Id);
                    saved["validation"] = current.Int("revision") == job.Revision && current.Text("sourceKey") == sourceKey.ToString()
                        ? current["validation"]?.DeepClone() : State("unverified", "코드가 변경됐습니다. 현재 코드를 다시 검사하세요.");
                    return;
                }
                state = State("unverified", "저장됨 · 이전 코드 검사가 진행 중입니다. 완료 후 다시 검사하세요.");
                await accounts.SetValidation(owner, job.Id, job.Revision, sourceKey, state);
            }
            else
            {
                if (!await accounts.SetValidation(owner, job.Id, job.Revision, sourceKey, state)) { queuedOwners.TryRemove(owner, out _); return; }
                enqueued = jobs.Writer.TryWrite(job);
                if (!enqueued)
                {
                    state = State("unverified", "저장됨 · 검사 한도에 도달했습니다. 다시 검사하세요.");
                    await accounts.SetValidation(owner, job.Id, job.Revision, sourceKey, state);
                    queuedOwners.TryRemove(owner, out _);
                }
            }
        }
        catch (Exception error) when (error is IOException or ServiceFault or InvalidOperationException)
        {
            if (reserved && !enqueued) queuedOwners.TryRemove(owner, out _);
            state = State("unverified", "저장됨 · 검사 상태를 갱신하지 못했습니다. 다시 검사하세요.");
        }
        saved["validation"] = state.DeepClone();
    }

    public async Task<JsonObject> Check(ExecutionScope scope, SourceReference source, CancellationToken token = default)
    {
        var owner = scope.Kind + ":" + scope.SubjectId;
        SemaphoreSlim gate;
        lock (gatesLock)
        {
            if (!gates.TryGetValue(owner, out var entry)) entry = (new SemaphoreSlim(1), 0);
            if (entry.Users >= 4) throw new ServiceFault(429, "코드 검사 요청이 대기 중입니다. 잠시 후 다시 시도하세요.");
            gates[owner] = (entry.Gate, entry.Users + 1); gate = entry.Gate;
        }
        var entered = false;
        try { await gate.WaitAsync(token); entered = true; return await CheckCore(scope, source, token); }
        finally
        {
            if (entered) gate.Release();
            lock (gatesLock)
            {
                var entry = gates[owner];
                if (entry.Users == 1) { gates.Remove(owner); gate.Dispose(); }
                else gates[owner] = (gate, entry.Users - 1);
            }
        }
    }

    private async Task<JsonObject> CheckCore(ExecutionScope scope, SourceReference source, CancellationToken token)
    {
        if (scope.Kind == "user" && await accounts.User(scope.SubjectId.ToString()) is null) throw new ServiceFault(403, "이용할 수 없는 계정입니다.");
        var targets = scope.Kind == "user" ? await accounts.ValidationTargets(scope.SubjectId.ToString(), source.Sha256) : [];
        var result = await execution.Call(HttpMethod.Post, "/internal/v1/validations", new { requestId = Guid.NewGuid(), scope, source }, token);
        if (scope.Kind == "user" && await accounts.User(scope.SubjectId.ToString()) is null) throw new ServiceFault(403, "이용할 수 없는 계정입니다.");
        foreach (var target in targets)
            await accounts.SetValidation(scope.SubjectId.ToString(), target.Text("id"), target.Int("revision"), Guid.Parse(target.Text("sourceKey")), ResultState(result, source.Sha256));
        return result;
    }

    public async Task RequirePassed(ExecutionScope scope, SourceReference source)
    {
        var result = await Check(scope, source);
        if (!result.Bool("ok")) throw new ServiceFault(400, result.Text("error", "알고리즘 검사에 실패했습니다. 작업실에서 검사 결과를 확인하세요."));
        if (result.Text("profileVersion") != "javascript-preflight-v2" || result.Text("fixtureVersion") != "2.0.0")
            throw new ServiceFault(503, "검사 서비스 버전이 일치하지 않습니다. 서버를 업데이트하세요.");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await accounts.RecoverValidations(Version);
        try
        {
            await foreach (var job in jobs.Reader.ReadAllAsync(stoppingToken))
            {
                SourceReference? copied = null;
                var state = State("unverified", "검사를 완료하지 못했습니다. 다시 검사하세요.");
                try
                {
                    var current = await accounts.Algorithm(job.Owner, job.Id);
                    if (current.Int("revision") != job.Revision || current.Text("sourceKey") != job.SourceKey.ToString() || await accounts.User(job.Owner) is null) continue;
                    copied = await accounts.Sources.Copy(job.SourceKey, Exchange);
                    var result = await Check(new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(job.Owner) }, copied, stoppingToken);
                    state = ResultState(result, copied.Sha256);
                }
                catch (Exception error) when (error is ServiceFault or IOException or OperationCanceledException or InvalidOperationException or System.Text.Json.JsonException)
                { /* Account disable, overload, cancellation and service outage never discard source. */ }
                finally
                {
                    try
                    {
                        if (copied is not null) { try { await Exchange.Delete(copied.SourceKey); } catch (IOException) { /* Offline exchange reconciliation retains cleanup responsibility. */ } }
                        try { await accounts.SetValidation(job.Owner, job.Id, job.Revision, job.SourceKey, state); }
                        catch (IOException) { /* Persisted pending receipts are recovered on startup/recheck. */ }
                    }
                    finally { queuedOwners.TryRemove(job.Owner, out _); }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            jobs.Writer.TryComplete();
            while (jobs.Reader.TryRead(out var job))
            {
                await accounts.SetValidation(job.Owner, job.Id, job.Revision, job.SourceKey, State("unverified", "서버 종료로 검사가 취소됐습니다. 다시 검사하세요."));
                queuedOwners.TryRemove(job.Owner, out _);
            }
        }
    }

    private JsonObject State(string state, string message) => new() { ["state"] = state, ["message"] = message, ["version"] = Version, ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O") };
    private JsonObject ResultState(JsonObject result, string hash)
    {
        var validVersion = result.Text("profileVersion") == "javascript-preflight-v2" && result.Text("fixtureVersion") == "2.0.0";
        var infrastructure = result["diagnostic"]?.Text("stage") == "environment";
        var state = State(result.Bool("ok") ? validVersion ? "passed" : "unverified" : infrastructure ? "unverified" : "failed",
            result.Bool("ok") ? validVersion ? "저장됨 · 코드 검사 통과" : "검사 서비스 버전을 확인하세요." : result.Text("error", "코드 검사 실패"));
        state["sourceHash"] = hash;
        if (result["diagnostic"] is JsonObject diagnostic) state["diagnostic"] = diagnostic.DeepClone();
        return state;
    }
}
