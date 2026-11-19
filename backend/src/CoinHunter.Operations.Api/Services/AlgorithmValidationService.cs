using System.Threading.Channels;
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Infrastructure.Execution;
using System.Text.Json;

namespace CoinHunter.Operations.Api.Services;

// Bounded background validation never determines whether source persistence succeeds.
// Game admission always revalidates its immutable exchange snapshot; no client receipt is trusted.
public sealed class AlgorithmValidationService(AccountService accounts, StorageSettings settings, GameContent content, ExecutionClient execution) : BackgroundService
{
    private sealed record Job(string Owner, string Id, int Revision, Guid SourceKey,string Language,string Hash);
    private readonly Channel<Job> jobs = Channel.CreateBounded<Job>(new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
    private readonly ConcurrentDictionary<string, Job> queuedOwners = new();
    private readonly object gatesLock = new();
    private readonly Dictionary<string, (SemaphoreSlim Gate, int Users)> gates = new();
    public string Version => "javascript-preflight-v2/fixture-2.0.0/500ms/32MiB/" + content.Contract.Text("contentVersion");
    public string VersionFor(string language)=>language=="javascript"?Version:CSharpArtifactPreflight.Profile+"/"+content.PreflightHash+"/500ms/candidate-only";
    private FileSourceStore Exchange => new(settings.ExchangeRoot);

    public async Task Queue(string owner, JsonObject saved, Guid sourceKey)
    {
        var job = new Job(owner, saved.Text("id"), saved.Int("revision"), sourceKey,saved.Text("language","javascript"),saved.Text("sourceHash"));
        var state = State("pending", "저장됨 · 코드 검사 대기 중입니다.",job.Language);
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
                        ? current["validation"]?.DeepClone() : State("unverified", "코드가 변경됐습니다. 현재 코드를 다시 검사하세요.",job.Language);
                    return;
                }
                state = State("unverified", "저장됨 · 이전 코드 검사가 진행 중입니다. 완료 후 다시 검사하세요.",job.Language);
                await SetJobState(job,state);
            }
            else
            {
                if (!await SetJobState(job,state)) { queuedOwners.TryRemove(owner, out _); return; }
                enqueued = jobs.Writer.TryWrite(job);
                if (!enqueued)
                {
                    state = State("unverified", "저장됨 · 검사 한도에 도달했습니다. 다시 검사하세요.",job.Language);
                    await SetJobState(job,state);
                    queuedOwners.TryRemove(owner, out _);
                }
            }
        }
        catch (Exception error) when (error is IOException or ServiceFault or InvalidOperationException)
        {
            if (reserved && !enqueued) queuedOwners.TryRemove(owner, out _);
            state = State("unverified", "저장됨 · 검사 상태를 갱신하지 못했습니다. 다시 검사하세요.",job.Language);
        }
        saved["validation"] = state.DeepClone();
    }

    public async Task<JsonObject> Check(ExecutionScope scope, SourceReference source, CancellationToken token = default,string language="javascript",bool updateStored=true)
    {
        if(language is not ("javascript" or "csharp")||language=="csharp"&&scope.Kind!="user")throw new ServiceFault(400,"검사 언어와 계정을 확인하세요.");
        var owner = scope.Kind + ":" + scope.SubjectId;
        SemaphoreSlim gate;
        lock (gatesLock)
        {
            if (!gates.TryGetValue(owner, out var entry)) entry = (new SemaphoreSlim(1), 0);
            if (entry.Users >= 4) throw new ServiceFault(429, "코드 검사 요청이 대기 중입니다. 잠시 후 다시 시도하세요.");
            gates[owner] = (entry.Gate, entry.Users + 1); gate = entry.Gate;
        }
        var entered = false;
        try { await gate.WaitAsync(token); entered = true; return await CheckCore(scope, source, token,language,updateStored); }
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

    private async Task<JsonObject> CheckCore(ExecutionScope scope, SourceReference source, CancellationToken token,string language,bool updateStored)
    {
        if (scope.Kind == "user" && await accounts.User(scope.SubjectId.ToString()) is null) throw new ServiceFault(403, "이용할 수 없는 계정입니다.");
        var targets = updateStored&&scope.Kind == "user" ? await accounts.ValidationTargets(scope.SubjectId.ToString(), source.Sha256,language) : [];
        var result = await execution.Call(HttpMethod.Post, "/internal/v1/validations", new { requestId = Guid.NewGuid(), scope, source,language }, token,candidateValidation:language=="csharp");
        if (scope.Kind == "user" && await accounts.User(scope.SubjectId.ToString()) is null) throw new ServiceFault(403, "이용할 수 없는 계정입니다.");
        foreach (var target in targets)
            await accounts.SetValidation(scope.SubjectId.ToString(), target.Text("id"), target.Int("revision"), Guid.Parse(target.Text("sourceKey")), ResultState(result, source.Sha256,language,scope.SubjectId),language,source.Sha256);
        return result;
    }

    public async Task RequirePassed(ExecutionScope scope, SourceReference source)
    {
        var result = await Check(scope, source);
        if (!result.Bool("ok")) throw new ServiceFault(400, result.Text("error", "알고리즘 검사에 실패했습니다. 작업실에서 검사 결과를 확인하세요."));
        if (result.Text("profileVersion") != "javascript-preflight-v2" || result.Text("fixtureVersion") != "2.0.0")
            throw new ServiceFault(503, "검사 서비스 버전이 일치하지 않습니다. 서버를 업데이트하세요.");
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        RecoverSnapshotLeases();
        await accounts.RecoverValidations(Version);
        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in jobs.Reader.ReadAllAsync(stoppingToken))
            {
                SourceReference? copied = null;
                Guid? lease = null;
                var state = State("unverified", "검사를 완료하지 못했습니다. 다시 검사하세요.",job.Language);
                try
                {
                    var current = await accounts.Algorithm(job.Owner, job.Id);
                    if (current.Int("revision") != job.Revision || current.Text("sourceKey") != job.SourceKey.ToString() ||current.Text("language","javascript")!=job.Language||current.Text("sourceHash")!=job.Hash|| await accounts.User(job.Owner) is null) continue;
                    lease = Guid.NewGuid();
                    copied = await CopySnapshot(job.SourceKey, lease.Value, stoppingToken);
                    if(!string.IsNullOrEmpty(job.Hash)&&copied.Sha256!=job.Hash)throw new InvalidDataException("Saved source content changed.");
                    var result = await Check(new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(job.Owner) }, copied, stoppingToken,job.Language,updateStored:false);
                    state = ResultState(result, copied.Sha256,job.Language,Guid.Parse(job.Owner));
                }
                catch (Exception error) when (error is ServiceFault or IOException or InvalidDataException or OperationCanceledException or InvalidOperationException or System.Text.Json.JsonException)
                { /* Account disable, overload, cancellation and service outage never discard source. */ }
                finally
                {
                    try
                    {
                        if (lease is Guid key) ReleaseSnapshot(key);
                        try { await SetJobState(job,state); }
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
                await SetJobState(job,State("unverified", "서버 종료로 검사가 취소됐습니다. 다시 검사하세요.",job.Language));
                queuedOwners.TryRemove(job.Owner, out _);
            }
        }
    }

    private Task<bool> SetJobState(Job job,JsonObject state)=>accounts.SetValidation(job.Owner,job.Id,job.Revision,job.SourceKey,state,job.Language,string.IsNullOrEmpty(job.Hash)?null:job.Hash);
    private JsonObject State(string state, string message,string language="javascript")
    {
        var value=new JsonObject { ["state"] = state, ["message"] = message, ["version"] = VersionFor(language), ["checkedAt"] = DateTimeOffset.UtcNow.ToString("O") };
        if(language!="javascript")value["executionAllowed"]=false;
        return value;
    }
    private string LeaseDirectory => Path.Combine(settings.DataRoot, "validation-leases");
    private string LeasePath(Guid key) => Path.Combine(LeaseDirectory, key.ToString("D") + ".json");
    private async Task<SourceReference> CopySnapshot(Guid sourceKey, Guid key, CancellationToken token)
    {
        // Persist ownership before creating bytes, so a crash at any copy stage is recoverable.
        await AtomicFile.Json(LeasePath(key), new JsonObject { ["sourceKey"] = key.ToString("D") });
        await using var input = accounts.Sources.Open(sourceKey);
        return await Exchange.PutReserved(input, key, token);
    }
    private void ReleaseSnapshot(Guid key)
    {
        try { File.Delete(Exchange.PathFor(key)); File.Delete(Exchange.PathFor(key) + ".tmp"); File.Delete(LeasePath(key)); }
        catch (IOException) { /* Keep ownership evidence for the next startup; never delete match snapshots. */ }
    }
    private void RecoverSnapshotLeases()
    {
        if (!Directory.Exists(LeaseDirectory)) return;
        foreach (var path in Directory.EnumerateFiles(LeaseDirectory, "*.json"))
            if (Guid.TryParseExact(Path.GetFileNameWithoutExtension(path), "D", out var key)) ReleaseSnapshot(key);
    }
    private JsonObject ResultState(JsonObject result, string hash,string language="javascript",Guid owner=default)
    {
        if(language=="csharp")return CSharpResultState(result,hash,owner);
        var validVersion = result.Text("profileVersion") == "javascript-preflight-v2" && result.Text("fixtureVersion") == "2.0.0";
        var infrastructure = result["diagnostic"]?.Text("stage") == "environment";
        var state = State(result.Bool("ok") ? validVersion ? "passed" : "unverified" : infrastructure ? "unverified" : "failed",
            result.Bool("ok") ? validVersion ? "저장됨 · 코드 검사 통과" : "검사 서비스 버전을 확인하세요." : result.Text("error", "코드 검사 실패"));
        state["sourceHash"] = hash;
        if (result["diagnostic"] is JsonObject diagnostic) state["diagnostic"] = diagnostic.DeepClone();
        return state;
    }
    private JsonObject CSharpResultState(JsonObject result,string hash,Guid owner)
    {
        bool bound=result.Text("language")=="csharp"&&result.Text("sourceHash")==hash&&result.Text("profileVersion")==CSharpArtifactPreflight.Profile&&result.Text("fixtureVersion")=="2.0.0"&&result.Text("fixtureHash")==content.PreflightHash&&result["executionAllowed"] is not null&&!result.Bool("executionAllowed");
        CSharpPreflightReport? report=null;
        try
        {
            if(result["report"] is JsonObject value)
            {
                bound&=value["executionAllowed"] is not null&&!value.Bool("executionAllowed");
                report=value.Deserialize<CSharpPreflightReport>(Protocol.JsonOptions);
            }
        }
        catch(JsonException){bound=false;}
        if(report is not null)
        {
            bound&=report.Owner==owner&&report.SourceHash==hash&&report.FixtureHash==content.PreflightHash
                &&report.Profile==CSharpArtifactPreflight.Profile&&report.FixtureVersion=="2.0.0"
                &&CSharpArtifactKeys.Valid(report.ToolchainKey)&&report.Key==CSharpArtifactKeys.Build(hash,report.ToolchainKey)
                &&report.CheckedCalls is >=0 and <=36&&result.Int("calls",-1)==report.CheckedCalls
                &&(report.Status=="passed"?report.CheckedCalls==36&&report.Diagnostic is null:report.Status is "failed" or "unverified"&&report.Diagnostic is not null)
                &&result.Bool("ok")== (report.Status=="passed");
        }
        else if(result.Bool("ok")||result["diagnostic"]?.Text("stage") is not ("compile" or "environment"))bound=false;
        bool infrastructure=result["diagnostic"]?.Text("stage")=="environment"||report?.Status=="unverified";
        var state=State(!bound||infrastructure?"unverified":result.Bool("ok")?"passed":"failed",!bound?"검사 결과의 코드·소유자·버전이 일치하지 않습니다.":result.Bool("ok")?"저장됨 · C# 후보 검사 통과 · 게임 지원 대기":result.Text("error","C# 코드 검사 실패"),"csharp");
        state["sourceHash"]=hash;
        if(bound&&report is not null)
        {
            state["artifact"]=new JsonObject{["key"]=report.Key,["sourceHash"]=report.SourceHash,["toolchainKey"]=report.ToolchainKey,["profile"]=report.Profile,["fixtureVersion"]=report.FixtureVersion,["fixtureHash"]=report.FixtureHash};
        }
        if(bound&&result["diagnostic"] is JsonObject diagnostic)state["diagnostic"]=diagnostic.DeepClone();
        return state;
    }
}
