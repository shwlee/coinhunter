using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Execution.Host.Services;

// Opt-in candidate checks only. This service is not a game runner capability.
// Operations sends immutable references; it never loads Roslyn or a user DLL.
public sealed class CSharpValidationService(StorageSettings settings, GameContent content, ExecutionResources resources, CSharpHostManager manager, IConfiguration configuration) : IHostedService, IAsyncDisposable
{
    private readonly SemaphoreSlim gate = new(1);
    private readonly CancellationTokenSource stopping = new();
    private CSharpPreparationStore? preparations;
    private ICSharpPreflightReportStore? reports;
    private string? host;
    private ResourceProfile? profile;
    private bool closed;
    internal bool GameCandidateEnabled => configuration.GetValue("Backend:CSharpGameCandidate:Enabled", false) && preparations is not null && !closed;
    internal async Task<CSharpCandidatePlayer> PreparePlayer(ExecutionRequest game, ParticipantRequest player, string snapshot, IExecutionResourceGroup gameScope, ResourceProfile gameLimits, CancellationToken token)
    {
        if (!GameCandidateEnabled || game.Scope.Kind != "user") throw new ServiceFault(503, "C# 게임 후보 실행은 비활성입니다.");
        var result = await Validate(game.Scope, player.Source, snapshot, token);
        if (!result.Bool("ok")) throw new ServiceFault(400, "C# 후보 코드가 실행 검사를 통과하지 못했습니다.");
        var report = result["report"]!.Deserialize<CSharpPreflightReport>(Protocol.JsonOptions)!;
        var lease = await preparations!.AcquireAsync(game.Scope.SubjectId, report.Key, token);
        try
        {
            var watchdogs = new CSharpWatchdogs(TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5));
            // A child may use its share of the parent CPU cap, never a fraction
            // of that cap again. Windows interprets child CPU rates relatively.
            var member = new ResourceProfile("csharp-game-member-v1", Math.Min(gameLimits.MemoryBytes, 768L * 1024 * 1024), Math.Min(gameLimits.ProcessCount, OperatingSystem.IsWindows() ? 1 : 128), 10000);
            return new CSharpCandidatePlayer(game, player, lease, preparations, manager, new CSharpPreparedLaunch(host!, game.Scope.SubjectId, report.Key, player.PlayerId, game.Map.Columns, game.Map.Rows, member, watchdogs) { ParentResources = gameScope });
        }
        catch { lease.Dispose(); throw; }
    }
    public Task StartAsync(CancellationToken token)
    {
        if (!configuration.GetValue("Backend:CSharpValidation:Enabled", false)) return Task.CompletedTask;
        host = configuration["Backend:CSharpValidation:HostAssembly"];
        if (string.IsNullOrWhiteSpace(host) || !Path.IsPathFullyQualified(host) || !File.Exists(host)) throw new InvalidOperationException("C# candidate validation requires an explicit trusted HostAssembly.");
        profile = new ResourceProfile("csharp-candidate-validation-v1", 768L * 1024 * 1024, OperatingSystem.IsWindows() ? 2 : 128, 10000);
        preparations = new CSharpPreparationStore(Path.Combine(settings.ExecutionRoot, "csharp", "artifacts"), host, resources, new(profile, TimeSpan.FromSeconds(30), 16L * 1024 * 1024, 1024 * 1024, 256L * 1024 * 1024));
        reports = new FileCSharpPreflightReportStore(Path.Combine(settings.ExecutionRoot, "csharp", "reports"));
        return Recover(token);
    }
    private async Task Recover(CancellationToken token)
    { var result = await preparations!.RecoverAsync(token); if (result.Retained != 0) throw new IOException("C# preparation recovery requires operator inspection."); }

    public async Task<JsonObject> Validate(ExecutionScope scope, SourceReference source, string snapshot, CancellationToken token)
    {
        if (preparations is null || scope.Kind != "user") throw new ServiceFault(503, "C# 후보 검사가 활성화되지 않았습니다.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, stopping.Token); deadline.CancelAfter(TimeSpan.FromSeconds(110));
        await gate.WaitAsync(deadline.Token);
        try
        {
            ObjectDisposedException.ThrowIf(closed, this);
            var prepared = await preparations.PrepareAsync(scope.SubjectId, snapshot, source.Sha256, deadline.Token);
            if (prepared.Status != "prepared")
            {
                var codeFailure = prepared.Status == "failed";
                return new JsonObject
                {
                    ["language"] = "csharp",
                    ["sourceHash"] = source.Sha256,
                    ["ok"] = false,
                    ["executionAllowed"] = false,
                    ["profileVersion"] = CSharpArtifactPreflight.Profile,
                    ["fixtureVersion"] = "2.0.0",
                    ["fixtureHash"] = content.PreflightHash,
                    ["error"] = codeFailure ? "C# 작성 규약 또는 컴파일 검사에 실패했습니다." : "C# 준비를 완료하지 못했습니다. 다시 검사하세요.",
                    ["diagnostic"] = new JsonObject { ["stage"] = codeFailure ? "compile" : "environment", ["code"] = prepared.Status, ["details"] = JsonSerializer.SerializeToNode(prepared.Diagnostics, Protocol.JsonOptions) }
                };
            }
            var watchdogs = new CSharpWatchdogs(TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5));
            var launch = new CSharpPreparedLaunch(host!, scope.SubjectId, prepared.Key!, 0, 1, 1, profile!, watchdogs);
            var result = await new CSharpArtifactPreflight(preparations, manager).CheckAsync(launch, Path.Combine(settings.RepositoryRoot, "backend/contracts/generated/algorithm-preflight.json"), deadline.Token);
            if (result.FixtureHash != content.PreflightHash) throw new InvalidDataException("Preflight fixture changed during service lifetime.");
            await reports!.WriteAsync(result, deadline.Token);
            var response = new JsonObject
            {
                ["language"] = "csharp",
                ["sourceHash"] = source.Sha256,
                ["ok"] = result.Status == "passed",
                ["executionAllowed"] = false,
                ["profileVersion"] = result.Profile,
                ["fixtureVersion"] = result.FixtureVersion,
                ["fixtureHash"] = result.FixtureHash,
                ["calls"] = result.CheckedCalls,
                ["report"] = JsonSerializer.SerializeToNode(result, Protocol.JsonOptions)
            };
            if (result.Status != "passed")
            {
                response["error"] = result.Status == "unverified" ? "검사 환경 문제로 C# 검사를 완료하지 못했습니다." : "C# 실행 검사에 실패했습니다.";
                response["diagnostic"] = new JsonObject { ["stage"] = result.Status == "unverified" ? "environment" : result.Diagnostic!.Phase, ["code"] = result.Diagnostic?.Code, ["detail"] = JsonSerializer.SerializeToNode(result.Diagnostic, Protocol.JsonOptions) };
            }
            return response;
        }
        finally { gate.Release(); }
    }
    public async Task StopAsync(CancellationToken token)
    {
        stopping.Cancel(); await gate.WaitAsync();
        // Cache leases may still belong to games: ExecutionManager stops after
        // this hosted service. Dispose only after every hosted service stopped.
        try { if (closed) return; closed = true; }
        finally { gate.Release(); }
    }
    public async ValueTask DisposeAsync() { await StopAsync(default); if (preparations is not null) await preparations.DisposeAsync(); }
}
