using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using CoinHunter.Contracts;

namespace CoinHunter.CSharp.Analysis;

public sealed record CandidateCall(Guid InstanceId, long CallId, int ProcessId, string Status, object? Value,
    double BudgetMs, double ElapsedMs, bool DeadlineReached, bool ExecutionSettled, int? Line, int? Column, string? ErrorType, string? LimitCode = null, string? DiagnosticCode = null)
{
    public double InputPreparationMs { get; init; }
    public string[] Logs { get; init; } = [];
    public int DroppedLogs { get; init; }
    public CSharpCallMemoryObservation? ExperimentalMemory { get; init; }
}

// Experimental C2 host only. Caller must place analysis/compilation/loading in
// an OS-limited process. This class is not registered as a production runner.
public sealed class CSharpCandidate : IDisposable
{
    private AssemblyLoadContext? context;
    private Type? type;
    private object? player;
    private Action<int,int,int>? initialize;
    private Func<string>? getName;
    private Func<int[],int,int[],int>? moveNext;
    private readonly object gate = new();
    private long callId;
    private bool disposed, faulted, constructed, initialized;
    public Guid InstanceId { get; } = Guid.NewGuid();
    public AnalysisResult Analysis { get; }
    public IReadOnlyList<GuardSite> GuardSites { get; }
    public const string GuardVersion = "c2-poll-bounded-v4";
    internal Action<long, BudgetScope>? CallStarted { get; set; }
    // Opt-in candidate memory window only; default game/preflight leave it unset.
    internal long? ExperimentalAllocationBudgetBytes { get; set; }
    internal long? ExperimentalProcessAllocationBudgetBytes { get; set; }
    internal void InvalidateAfterEnvironmentFailure(){lock(gate)faulted=true;}
    public static CSharpCandidate Prepare(string source, CancellationToken cancellationToken = default) => new(source, cancellationToken);
    private CSharpCandidate(string source, CancellationToken cancellationToken) : this(CandidateCompiler.Compile(source,cancellationToken)) { }
    private CSharpCandidate(CandidateImage image)
    {
        Analysis=image.Analysis;GuardSites=image.GuardSites.Select(s=>new GuardSite(s.Kind,s.Line,s.Column)).ToArray();
        context = new AssemblyLoadContext("candidate-" + InstanceId, isCollectible: true);
        try { using var bytes=new MemoryStream(image.Dll,writable:false);type = context.LoadFromStream(bytes).GetType("Player", throwOnError: true)!; }
        catch { context.Unload(); throw; }
    }
    public static CSharpCandidate LoadPrepared(CSharpArtifactManifest manifest,byte[] dll)
    {
        var toolchain=CandidateCompiler.Describe();
        if(manifest.Schema!=1||!CSharpArtifactKeys.Valid(manifest.SourceHash)||manifest.GuardSites is null||manifest.Toolchain is null||manifest.Toolchain.Key!=toolchain.Key||manifest.Key!=CSharpArtifactKeys.Build(manifest.SourceHash,toolchain.Key)||manifest.DllBytes!=dll.LongLength||manifest.DllHash!=CSharpArtifactKeys.Hash(dll))throw new InvalidDataException("Prepared artifact mismatch.");
        var analysis=new AnalysisResult(manifest.SourceHash,toolchain.Profile,true,false,[]);
        return new CSharpCandidate(new CandidateImage(analysis,toolchain,manifest.Key,dll,manifest.GuardSites));
    }
    // Direct synchronous invocation: no Task timeout pretending to stop execution.
    private CandidateCall Call(Func<object?> action, TimeSpan budget, bool preparation = false)
    {
        if (budget <= TimeSpan.Zero || budget > TimeSpan.FromMilliseconds(500)) throw new ArgumentOutOfRangeException(nameof(budget));
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (faulted) throw new InvalidOperationException("Failed candidate cannot be reused.");
            var outcome = BudgetInvocation.Run(action, budget, scope =>
            {
                if(ExperimentalAllocationBudgetBytes is { } allocationBytes)scope.SetExperimentalAllocationBudget(allocationBytes);
                if(ExperimentalProcessAllocationBudgetBytes is { } processBytes)scope.SetExperimentalProcessAllocationBudget(processBytes);
                CallStarted?.Invoke(callId + 1, scope);
            });
            var scope = outcome.Scope; var error = outcome.Error;
            if(error is CSharpGcWindowFailure memoryFailure){faulted=true;throw memoryFailure;}
            // A late normal return becomes timeout. Fatal errors below remain
            // terminal and cannot advertise a reusable timeout instance.
            var status = outcome.Status;
            if (error is OutOfMemoryException || error is not null && error is not BudgetExpiredException)
            {
                faulted = true;
                // A fatal error remains fatal even if its settlement crosses
                // the deadline; never advertise a reusable normal timeout.
                if(error is not BudgetStoppedException)status=error is OperationLimitException?"operation-limit":error is InvalidPlayerNameException?"invalid-result":"exception";
            }
            if (preparation && status != "ok") faulted = true;
            return new(InstanceId, ++callId, Environment.ProcessId, status, outcome.Value,
                budget.TotalMilliseconds, scope.ElapsedMs, scope.Expired, true, scope.Line, scope.Column, error?.GetType().Name, (error as OperationLimitException)?.Code, error is InvalidPlayerNameException ? "AR013" : null) { Logs=scope.Logs.ToArray(),DroppedLogs=scope.DroppedLogs };
        }
    }
    public CandidateCall Construct() => Call(() =>
    {
        if (constructed) throw new InvalidOperationException("Already constructed.");
        player = Activator.CreateInstance(type!);
        initialize=type!.GetMethod("Initialize")!.CreateDelegate<Action<int,int,int>>(player);
        getName=type.GetMethod("GetName")!.CreateDelegate<Func<string>>(player);
        moveNext=type.GetMethod("MoveNext")!.CreateDelegate<Func<int[],int,int[],int>>(player);
        constructed = true; return null;
    }, TimeSpan.FromMilliseconds(500), preparation: true);
    public CandidateCall Initialize(int number, int columns, int rows) => Call(() =>
    {
        if (!constructed || initialized) throw new InvalidOperationException("Invalid initialization state.");
        initialize!(number, columns, rows); initialized = true; return null;
    }, TimeSpan.FromMilliseconds(500), preparation: true);
    public CandidateCall GetName() => Call(() =>
    {
        if (!initialized) throw new InvalidOperationException("Not initialized.");
        var value=getName!();
        if(value is not string name)throw new InvalidPlayerNameException();
        // Match the existing JS 40 UTF-16 unit display limit. Keep empty/space
        // strings valid; avoid splitting a surrogate pair on truncation.
        if(name.Length<=40)return name;
        var length=char.IsHighSurrogate(name[39])&&char.IsLowSurrogate(name[40])?39:40;
        return name[..length];
    }, TimeSpan.FromMilliseconds(500));
    public CandidateCall MoveNext(int[] map, int position, int[] items, TimeSpan? budget = null)
    {
        // Owned input snapshots prepared outside the timed reflection/user call.
        var before=System.Diagnostics.Stopwatch.GetTimestamp();
        var mapCopy = (int[])map.Clone(); var itemCopy = (int[])items.Clone();
        var inputMs=System.Diagnostics.Stopwatch.GetElapsedTime(before).TotalMilliseconds;
        var result = Call(() =>
        {
            if (!initialized) throw new InvalidOperationException("Not initialized.");
            return moveNext!(mapCopy, position, itemCopy);
        }, budget ?? TimeSpan.FromMilliseconds(500)) with { InputPreparationMs=inputMs };
        return result.Status == "ok" && result.Value is not (int and >= -1 and <= 3)
            ? result with { Status = "invalid-result", Value = null } : result;
    }
    public void Dispose()
    {
        lock (gate) { if (disposed) return; disposed = true; initialize=null;getName=null;moveNext=null;player = null; type = null; context!.Unload(); context = null; }
    }
}
