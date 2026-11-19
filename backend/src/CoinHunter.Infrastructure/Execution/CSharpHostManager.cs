using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Hosting;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("CoinHunter.Backend.Checks")]

namespace CoinHunter.Infrastructure.Execution;

// No grace/restart policy is silently selected here. The trusted caller must
// supply infrastructure watchdogs separately from the host's 500ms user budget.
public sealed record CSharpWatchdogs(TimeSpan Preparation, TimeSpan StartNotification,
    TimeSpan UnsettledExecution, TimeSpan HeartbeatInterval, TimeSpan HeartbeatResponse,
    TimeSpan StopGrace, TimeSpan Cleanup)
{
    internal void Validate()
    {
        if(new[]{Preparation,StartNotification,UnsettledExecution,HeartbeatInterval,HeartbeatResponse,StopGrace,Cleanup}.Any(t=>t<=TimeSpan.Zero||t>TimeSpan.FromMinutes(5)) || UnsettledExecution<=TimeSpan.FromMilliseconds(500))
            throw new ArgumentException("Explicit positive infrastructure watchdogs required; unsettled execution must allow the 500ms host budget.");
    }
}
public sealed record CSharpHostLaunch(string HostAssembly, string SourcePath, string SourceHash,
    int PlayerNumber, int Columns, int Rows, ResourceProfile Resources, CSharpWatchdogs Watchdogs)
{
    internal int ProbeStall { get; init; }
}
public sealed record CSharpHostReady(Guid Generation, Guid InstanceId, int ProcessId, long Frequency, string SourceHash, string Profile, string GuardVersion);
public sealed record CSharpParentCall(Guid Generation, Guid InstanceId, long CallId, int ProcessId, string Status,
    int? Direction, bool DeadlineReached, bool ExecutionSettled, double BudgetMs, double ElapsedMs, string? LimitCode);
public sealed record CSharpHostClosure(string Reason, bool Forced, bool CleanupConfirmed);
public sealed class CSharpHostFailure(string reason, bool cleanupConfirmed) : IOException(reason)
{
    public string Reason { get; } = reason;
    public bool CleanupConfirmed { get; } = cleanupConfirmed;
}

// Registered with the execution service, but no public/native runner capability
// calls it until artifact/ownership and game integration are implemented.
public sealed class CSharpHostManager(ExecutionResources resources) : IHostedService
{
    private readonly object gate=new();
    private readonly HashSet<CSharpHostSession> sessions=[];
    private bool stopping;
    public int ManagedCount { get { lock(gate)return sessions.Count; } }
    public Task StartAsync(CancellationToken cancellationToken)=>Task.CompletedTask;
    public async Task<CSharpHostSession> CreateAsync(CSharpHostLaunch launch,CancellationToken token=default)
    {
        token.ThrowIfCancellationRequested();
        CSharpHostSession session;
        lock(gate)
        {
            if(stopping)throw new InvalidOperationException("C# host manager is stopping.");
            session=new CSharpHostSession(launch,resources,closed=>{lock(gate)sessions.Remove(closed);});
            sessions.Add(session);
        }
        await session.ActivateAsync(token);
        return session;
    }
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        CSharpHostSession[] owned;
        lock(gate){stopping=true;owned=sessions.ToArray();}
        // Caller cancellation never turns a still-running host into a clean stop.
        var results=await Task.WhenAll(owned.Select(s=>s.StopAsync("manager-stopping")));
        if(results.Any(r=>!r.CleanupConfirmed))throw new IOException("C# host cleanup unconfirmed; resource reservations retained.");
    }
}
