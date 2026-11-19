using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Infrastructure.Resources;

namespace CoinHunter.Execution.Host.Services;

public sealed record ValidationRequest(Guid RequestId, ExecutionScope Scope, SourceReference Source,string Language="javascript");

public sealed class ExecutionRecord
{
    public required ExecutionRequest Request { get; init; }
    public required string Fingerprint { get; init; }
    public string State { get; set; } = "accepted";
    public JsonObject? Snapshot { get; set; }
    public JsonObject? Result { get; set; }
    public bool Acknowledged { get; set; }
    public Process? Process { get; set; }
    public int? EnginePid { get; set; }
    public IExecutionResourceGroup? ResourceGroup { get; set; }
    internal List<CSharpCandidatePlayer> CSharpPlayers {get;}=[];
    internal bool Candidate {get;init;}
    public ResourceObservation? ResourceUsage { get; set; }
    public SemaphoreSlim Input { get; } = new(1);
    public CancellationTokenSource Preparation { get; } = new();
    public TaskCompletionSource Prepared { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Closed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public string? StopReason { get; set; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public object Gate { get; } = new();
    private TaskCompletionSource snapshotChanged = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public void NotifySnapshotChanged()
    {
        lock (Gate)
        {
            var previous = snapshotChanged;
            snapshotChanged = new(TaskCreationOptions.RunContinuationsAsynchronously);
            previous.TrySetResult();
        }
    }
    public async Task WaitForSnapshot(int afterSequence, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        // Bound an idle wait so Operations can recheck session/owner and send heartbeats.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(1));
        try
        {
            while (true)
            {
                Task changed;
                lock (Gate)
                {
                    if ((Snapshot?.Int("sequence", -1) ?? -1) > afterSequence || Result is not null || Closed.Task.IsCompleted) return;
                    changed = snapshotChanged.Task;
                }
                // Capture and check under the same gate: an update before this await is not lost.
                await changed.WaitAsync(deadline.Token);
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
    }
}

public sealed class ExecutionManager : IHostedService, IDisposable
{
    private readonly StorageSettings settings;
    private readonly GameContent content;
    private readonly ExecutionResources resources;
    private readonly ExecutionResourceSettings resourceSettings;
    private readonly CSharpValidationService? csharp;
    public object ResourceStatus => resources.Status;
    private readonly ConcurrentDictionary<Guid, ExecutionRecord> records = new();
    private readonly SemaphoreSlim admission = new(1);
    private readonly SemaphoreSlim validations = new(2);
    private readonly ConcurrentDictionary<string, byte> validating = new();
    private readonly FileStream lease;
    private volatile bool stopping;
    public ExecutionManager(StorageSettings settings, GameContent content, ExecutionResources resources, ExecutionResourceSettings resourceSettings,CSharpValidationService? csharp=null)
    {
        this.settings = settings; this.content = content;
        this.resources = resources; this.resourceSettings = resourceSettings;
        this.csharp=csharp;
        Directory.CreateDirectory(settings.ExecutionRoot);
        lease = new FileStream(Path.Combine(settings.ExecutionRoot, ".writer.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    private string DirectoryFor(Guid id) => Path.Combine(settings.ExecutionRoot, "games", id.ToString());
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // Startup/readiness fails closed if this OS cannot apply and verify its limits.
        resources.RecoverAbandonedGroups();
        using (resources.Reserve(resourceSettings.Validation)) { }
        var games = Path.Combine(settings.ExecutionRoot, "games"); if (!Directory.Exists(games)) return;
        foreach (var directory in Directory.EnumerateDirectories(games))
        {
            var path = Path.Combine(directory, "request.json"); if (!File.Exists(path)) continue;
            var request = JsonSerializer.Deserialize<ExecutionRequest>(await File.ReadAllTextAsync(path, cancellationToken), Protocol.JsonOptions)!;
            var state = await AtomicFile.Read(Path.Combine(directory, "status.json"), new JsonObject());
            var record = new ExecutionRecord { Request = request, Fingerprint = Fingerprint(request), State = state.Text("state", "failed"), Snapshot = state["snapshot"] as JsonObject, Result = state["result"] as JsonObject, Acknowledged = state.Bool("acknowledged") };
            if (record.Result is null)
            {
                // The engine fsyncs a receipt before delivering IPC. Recover that same result after a host crash.
                for (var retry = 0; retry < 50; retry++)
                {
                    var receiptPath = Path.Combine(settings.ExecutionRoot, "journals", request.MatchId + ".result.json");
                    if (File.Exists(receiptPath))
                    {
                        var receipt = await AtomicFile.Read(receiptPath, new JsonObject());
                        if (receipt.Int("contractVersion") != 1 || receipt.Text("matchId") != request.MatchId.ToString()) throw new InvalidDataException("Invalid engine receipt.");
                        record.Result = receipt["payload"]!.CloneObject(); record.Snapshot = record.Result["snapshot"]?.CloneObject(); record.State = "closed"; break;
                    }
                    if (!File.Exists(Path.Combine(settings.ExecutionRoot, "journals", request.MatchId + ".partial.jsonl"))) break;
                    await Task.Delay(100, cancellationToken);
                }
            }
            if (record.Result is null)
            {
                record.State = "failed";
                record.Result = Failure(record, "execution-host-restarted", await JournalRecovery.Recover(settings.ExecutionRoot, request.MatchId));
            }
            record.Closed.TrySetResult(); records[request.MatchId] = record;
            var privateSnapshot=Path.Combine(directory,"csharp-runners.private.json");if(File.Exists(privateSnapshot))File.Delete(privateSnapshot);
            await Persist(record);
        }
    }
    private static string Fingerprint(ExecutionRequest request) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request, Protocol.JsonOptions)));
    public async Task<ExecutionRecord> Accept(ExecutionRequest request, CancellationToken cancellationToken,bool candidate=false)
    {
        if(candidate&&(csharp?.GameCandidateEnabled!=true||request.Participants?.Any(p=>p?.Language=="csharp")!=true))throw new ServiceFault(503,"C# 게임 후보 실행은 비활성입니다.");
        ContractValidation.Execution(request,candidate);
        var map = JsonSerializer.SerializeToNode(request.Map, Protocol.JsonOptions)!.AsObject(); map["schemaVersion"] = 1; map["name"] = "Execution snapshot"; map["description"] = "";
        MapRules.Validate(map, content, true);
        await admission.WaitAsync(cancellationToken);
        ExecutionRecord record;
        try
        {
            if (stopping) throw new ServiceFault(503, "실행 서비스 종료 중입니다.");
            if (records.TryGetValue(request.MatchId, out var found))
            {
                if (found.Fingerprint != Fingerprint(request)) throw new ServiceFault(409, "경기 ID와 요청 내용이 충돌합니다.");
                return found;
            }
            if (records.Values.Any(value => value.Request.RequestId == request.RequestId)) throw new ServiceFault(409, "실행 요청 ID가 이미 사용되었습니다.");
            if (records.Values.Count(value => !value.Closed.Task.IsCompleted) >= 4) throw new ServiceFault(429, "동시 경기 한도에 도달했습니다.");
            if (records.Count >= 10000) throw new ServiceFault(503, "실행 기록 보존 한도입니다. 오프라인 보관 정리가 필요합니다.");
            record = new ExecutionRecord { Request = request, Fingerprint = Fingerprint(request),Candidate=candidate };
            if(candidate)record.Preparation.CancelAfter(TimeSpan.FromSeconds(120));
            record.ResourceGroup = resources.Reserve(resourceSettings.Game);
            try
            {
                var directory = DirectoryFor(request.MatchId); Directory.CreateDirectory(directory);
                await AtomicFile.Json(Path.Combine(directory, "request.json"), JsonSerializer.SerializeToNode(request, Protocol.JsonOptions)!);
            }
            catch { record.ResourceGroup.Dispose(); throw; }
            records[request.MatchId] = record;
        }
        finally { admission.Release(); }
        _ = Run(record);
        try { await record.Prepared.Task.WaitAsync(TimeSpan.FromSeconds(candidate?120:20), cancellationToken); }
        catch { await Stop(record, "prepare-failed"); throw new ServiceFault(400, "알고리즘을 준비하지 못했습니다. 코드 검사를 실행하세요."); }
        return record;
    }
    private async Task CopySource(SourceReference source, string directory, CancellationToken token)
    {
        var exchange = new FileSourceStore(settings.ExchangeRoot);
        var actual = await exchange.Describe(source.SourceKey);
        if (actual.Sha256 != source.Sha256 || actual.ByteLength != source.ByteLength) throw new InvalidDataException("Source integrity failure.");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, source.SourceKey + ".js");
        if (File.Exists(path)) return;
        await using var input = exchange.Open(source.SourceKey);
        await using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous);
        await input.CopyToAsync(output, token); await output.FlushAsync(token); output.Flush(true);
    }
    private ProcessStartInfo StartInfo(string entry, string sourceDirectory)
    {
        var info = new ProcessStartInfo(settings.NodeExecutable) { WorkingDirectory = settings.RepositoryRoot, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(Path.Combine(settings.RepositoryRoot, "backend/node/src/execution", entry));
        // Algorithms must never inherit OAuth/internal keys from their parent host.
        var allowed = new HashSet<string>(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"], StringComparer.OrdinalIgnoreCase);
        foreach (var key in info.Environment.Keys.ToArray()) if (!allowed.Contains(key)) info.Environment.Remove(key);
        info.Environment["COINHUNTER_ENGINE_SOURCES"] = sourceDirectory;
        return info;
    }
    private async Task Run(ExecutionRecord record)
    {
        var directory = DirectoryFor(record.Request.MatchId);
        Process? process = null;
        try
        {
            var sourceDirectory = Path.Combine(directory, "sources");
            foreach (var participant in record.Request.Participants) await CopySource(participant.Source, sourceDirectory, record.Preparation.Token);
            if(record.Candidate)
            {
                foreach(var player in record.Request.Participants.Where(p=>p.Language=="csharp"))
                    record.CSharpPlayers.Add(await csharp!.PreparePlayer(record.Request,player,Path.Combine(sourceDirectory,player.Source.SourceKey+".js"),record.Preparation.Token));
                await AtomicFile.Json(Path.Combine(directory,"csharp-runners.private.json"),new JsonObject{["gameId"]=record.Request.MatchId.ToString(),["players"]=new JsonArray(record.CSharpPlayers.Select(p=>(JsonNode)p.Descriptor.DeepClone()).ToArray())});
            }
            record.Preparation.Token.ThrowIfCancellationRequested();
            var info = StartInfo("engine-host.js", sourceDirectory); info.Environment["COINHUNTER_ENGINE_LOGS"] = Path.Combine(settings.ExecutionRoot, "journals");
            if(record.Candidate)info.Environment["COINHUNTER_CSHARP_CANDIDATE_SNAPSHOT"]=Path.Combine(directory,"csharp-runners.private.json");
            process = new Process { StartInfo = info }; record.Process = process;
            if (!process.Start()) throw new IOException("Engine start failed.");
            record.ResourceGroup!.Assign(process); // Before initialize can load user code or spawn players.
            record.EnginePid = process.Id;
            _ = DiscardDiagnostics(process.StandardError);
            await Send(record, "initialize", JsonSerializer.SerializeToElement(record.Request, Protocol.JsonOptions));
            using var deadline = new CancellationTokenSource(TimeSpan.FromHours(24));
            while (await EngineFrameCodec.ReadAsync(process.StandardOutput.BaseStream, deadline.Token) is { } message)
            {
                if (message.MatchId != record.Request.MatchId) throw new InvalidDataException("Wrong match envelope.");
                var payload = JsonNode.Parse(message.Payload.GetRawText())!.AsObject();
                lock (record.Gate)
                {
                    switch (message.Type)
                    {
                        case "prepared": record.State = "prepared"; record.Prepared.TrySetResult(); _ = ExpirePreparation(record); break;
                        case "snapshot": record.Snapshot = payload; break;
                        case "closed":
                            var result = payload.Deserialize<FinalExecutionResult>(Protocol.JsonOptions)!;
                            if (result.ContractVersion != 1 || result.MatchId != record.Request.MatchId || result.ResultVersion != 1 || result.Outcome is not ("finished" or "aborted" or "failed") || result.Recording.Status is not ("complete" or "partial" or "failed")) throw new InvalidDataException("Invalid final result.");
                            record.Snapshot = payload["snapshot"]?.CloneObject() ?? record.Snapshot; record.Result = payload; record.State = "closed"; break;
                        case "failed": record.State = "failed"; record.StopReason = "runtime-failure"; throw new IOException("Engine reported failure.");
                        case "ack": break;
                        default: throw new InvalidDataException("Unexpected engine reply.");
                    }
                }
                record.NotifySnapshotChanged();
                if (message.Type == "closed") break;
            }
            if (record.Result is null) throw new IOException("Engine disconnected.");
        }
        catch
        {
            lock (record.Gate)
            {
                record.State = "failed";
                record.Result ??= Failure(record, record.StopReason ?? "runtime-failure", new JsonObject { ["status"] = "partial", ["key"] = record.Request.MatchId.ToString(), ["durableThroughSeq"] = 0 });
            }
            record.NotifySnapshotChanged();
        }
        finally
        {
            if (process is not null)
            {
                try { process.StandardInput.Close(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)); }
                // Group disposal below is the authoritative descendant cleanup. A failed
                // root kill/wait must not bypass it or wait forever before reaching it.
                catch { try { process.Kill(true); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)); } catch { } }
            }
            record.Prepared.TrySetException(new IOException("Engine preparation failed."));
            var resourcesReleased = false;
            try
            {
                try
                {
                    // Telemetry failure must never skip actual descendant termination.
                    try { record.ResourceUsage = record.ResourceGroup?.Observe(); }
                    catch { record.ResourceUsage = null; }
                    if (record.ResourceUsage?.OomKills > 0)
                        record.Result = Failure(record, "resource-memory-limit", new JsonObject { ["status"] = "partial", ["key"] = record.Request.MatchId.ToString(), ["durableThroughSeq"] = 0 });
                    Exception? cleanupFailure=null;
                    try{record.ResourceGroup?.Dispose();}catch(Exception error){cleanupFailure=error;}
                    // These hosts belong to the shared .NET manager, not Node's
                    // descendant tree. Actual closure is mandatory before final receipt.
                    try{await Task.WhenAll(record.CSharpPlayers.Select(player=>player.Close()));}catch(Exception error){cleanupFailure??=error;}
                    if(cleanupFailure is not null)throw new IOException("Game resource cleanup unconfirmed.",cleanupFailure);
                    var privateSnapshot=Path.Combine(directory,"csharp-runners.private.json");if(File.Exists(privateSnapshot))File.Delete(privateSnapshot);
                    resourcesReleased = true;
                }
                catch
                {
                    record.State = "cleanup-unconfirmed";
                    record.Result = Failure(record, "resource-cleanup-unconfirmed", new JsonObject { ["status"] = "partial", ["key"] = record.Request.MatchId.ToString(), ["durableThroughSeq"] = 0 });
                }
                if (record.Result?["recording"]?.Text("status") != "complete") record.Result!["recording"] = await JournalRecovery.Recover(settings.ExecutionRoot, record.Request.MatchId);
                await Persist(record);
            }
            finally { if (resourcesReleased) record.Closed.TrySetResult(); record.NotifySnapshotChanged(); }
        }
    }
    private static async Task DiscardDiagnostics(StreamReader reader) { var buffer = new char[4096]; while (await reader.ReadAsync(buffer) != 0) { } }
    private static JsonObject Failure(ExecutionRecord record, string reason, JsonObject recording) => new()
    {
        ["contractVersion"] = 1,
        ["matchId"] = record.Request.MatchId.ToString(),
        ["resultVersion"] = 1,
        ["outcome"] = "failed",
        ["reason"] = reason,
        ["scores"] = new JsonArray(),
        ["snapshot"] = record.Snapshot?.DeepClone(),
        ["recording"] = recording
    };
    private async Task ExpirePreparation(ExecutionRecord record)
    {
        await Task.Delay(TimeSpan.FromSeconds(30));
        if (record.State == "prepared" && !record.Closed.Task.IsCompleted) await Stop(record, "prepare-expired");
    }
    private static async Task Send(ExecutionRecord record, string type, JsonElement payload)
    {
        await record.Input.WaitAsync();
        try
        {
            var message = new EngineEnvelope { ContractVersion = 1, MatchId = record.Request.MatchId, MessageId = Guid.NewGuid(), Type = type, Payload = payload };
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await record.Process!.StandardInput.BaseStream.WriteAsync(EngineFrameCodec.Encode(message), deadline.Token);
            await record.Process.StandardInput.BaseStream.FlushAsync(deadline.Token);
        }
        finally { record.Input.Release(); }
    }
    public ExecutionRecord Get(Guid id) => records.GetValueOrDefault(id) ?? throw new ServiceFault(404, "실행을 찾을 수 없습니다.");
    public JsonObject View(ExecutionRecord record)
    {
        lock (record.Gate) return new JsonObject { ["id"] = record.Request.MatchId.ToString(), ["state"] = record.State, ["snapshot"] = record.Snapshot?.DeepClone(), ["result"] = record.Result?.DeepClone(), ["acknowledged"] = record.Acknowledged, ["enginePid"] = record.EnginePid,
            ["resourceUsage"] = record.ResourceUsage is null ? null : JsonSerializer.SerializeToNode(record.ResourceUsage, Protocol.JsonOptions) };
    }
    public async Task Start(ExecutionRecord record)
    {
        lock (record.Gate)
        {
            if (record.State == "running") return;
            if (record.State != "prepared") throw new ServiceFault(409, "준비된 실행만 시작할 수 있습니다.");
            record.State = "running";
        }
        try { await Send(record, "start", JsonSerializer.SerializeToElement(new StartPayload(Guid.NewGuid()), Protocol.JsonOptions)); }
        catch { await Stop(record, "start-failed"); throw; }
    }
    public async Task Stop(ExecutionRecord record, string reason)
    {
        if (record.Closed.Task.IsCompleted) return;
        record.Preparation.Cancel();
        record.StopReason = reason;
        try { if (record.Process is { HasExited: false }) await Send(record, "stop", JsonSerializer.SerializeToElement(new StopPayload(Guid.NewGuid(), reason), Protocol.JsonOptions)); }
        catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException) { }
        try { await record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (TimeoutException) { try { record.Process?.Kill(true); } catch (InvalidOperationException) { } await record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); }
    }
    public async Task Acknowledge(Guid id, ResultAcknowledgement acknowledgement)
    {
        var record = Get(id);
        if (record.State == "cleanup-unconfirmed") throw new ServiceFault(503, "실행 자원 정리를 확인하지 못했습니다.");
        try { await record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (TimeoutException) { throw new ServiceFault(503, "실행 자원 정리를 기다리고 있습니다."); }
        if (acknowledgement.MatchId != id || acknowledgement.ResultVersion != 1) throw new ServiceFault(409, "결과 버전이 일치하지 않습니다.");
        record.Acknowledged = true; await Persist(record);
    }
    private Task Persist(ExecutionRecord record) => AtomicFile.Json(Path.Combine(DirectoryFor(record.Request.MatchId), "status.json"), View(record));
    public async Task<JsonObject> Validate(ValidationRequest request, CancellationToken token)
    {
        if (stopping || request.RequestId == Guid.Empty || request.Scope is null || request.Source is null || request.Scope.SubjectId == Guid.Empty || request.Scope.Kind is not ("user" or "guest")) throw new ServiceFault(400, "검사 요청을 확인하세요.");
        if(request.Language is not ("javascript" or "csharp")||request.Source.SourceKey==Guid.Empty||request.Source.ByteLength<0||!CSharpArtifactKeys.Valid(request.Source.Sha256))throw new ServiceFault(400,"검사 언어·코드 참조를 확인하세요.");
        if(request.Language=="csharp"&&(csharp is null||request.Scope.Kind!="user"))throw new ServiceFault(503,"C# 후보 검사가 활성화되지 않았습니다.");
        var owner = request.Scope.Kind + request.Scope.SubjectId;
        if (!validating.TryAdd(owner, 0)) throw new ServiceFault(429, "코드 검사가 진행 중입니다.");
        try { if (!await validations.WaitAsync(0, token)) throw new ServiceFault(429, "검사 한도에 도달했습니다."); }
        catch { validating.TryRemove(owner, out _); throw; }
        var directory = Path.Combine(settings.ExecutionRoot, "validations", request.RequestId.ToString());
        IExecutionResourceGroup? resourceGroup = null;
        var resourcesReleased = false;
        try
        {
            if(request.Language=="csharp")
            {
                await CopySource(request.Source,directory,token);
                return await csharp!.Validate(request.Scope,request.Source,Path.Combine(directory,request.Source.SourceKey+".js"),token);
            }
            resourceGroup = resources.Reserve(resourceSettings.Validation);
            await CopySource(request.Source, directory, token);
            var info = StartInfo("validation-host.js", directory); info.ArgumentList.Add(request.Source.SourceKey.ToString());
            info.Environment["COINHUNTER_REQUIRE_RESOURCE_GATE"] = "1";
            using var process = new Process { StartInfo = info }; process.Start();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(35));
            try
            {
                resourceGroup.Assign(process);
                await process.StandardInput.WriteLineAsync("start"); process.StandardInput.Close();
                _ = DiscardDiagnostics(process.StandardError);
                var output = await ReadBounded(process.StandardOutput, 262144, timeout.Token);
                await process.WaitForExitAsync(timeout.Token);
                return JsonNode.Parse(output)!.AsObject();
            }
            finally { if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); } }
        }
        finally
        {
            try { if (resourceGroup is not null) { resourceGroup.Dispose(); resourcesReleased = true; } }
            finally
            {
                if (resourceGroup is null || resourcesReleased)
                {
                    try { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
                    finally { validations.Release(); validating.TryRemove(owner, out _); }
                }
            }
        }
    }
    private static async Task<string> ReadBounded(StreamReader reader, int limit, CancellationToken token)
    {
        var result = new System.Text.StringBuilder(); var buffer = new char[8192];
        while (true) { var count = await reader.ReadAsync(buffer, token); if (count == 0) break; if (result.Length + count > limit) throw new IOException("Validation output too large."); result.Append(buffer, 0, count); }
        return result.ToString();
    }
    public async Task StopAsync(CancellationToken cancellationToken) { stopping = true; await Task.WhenAll(records.Values.Where(record => !record.Closed.Task.IsCompleted).Select(record => Stop(record, "server-shutdown"))); }
    public void Dispose() { lease.Dispose(); admission.Dispose(); validations.Dispose(); foreach (var record in records.Values) record.Process?.Dispose(); }
}
