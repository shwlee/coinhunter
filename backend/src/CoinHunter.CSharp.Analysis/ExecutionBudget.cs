using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("CoinHunter.Backend.Checks")]
[assembly: InternalsVisibleTo("CoinHunter.CSharp.Host")]

namespace CoinHunter.CSharp.Analysis;

// Only generated code references this bridge. Original source is analyzed without
// this assembly in its reference set; reflection/dynamic are not admitted.
public static class BudgetGuard
{
    [ThreadStatic] private static BudgetScope? current;
    internal static BudgetScope Begin(TimeSpan budget)
    {
        if (current is not null) throw new InvalidOperationException("Nested host budget.");
        return current = new BudgetScope(budget);
    }
    internal static void End(BudgetScope scope)
    {
        if (!ReferenceEquals(scope, current)) throw new InvalidOperationException("Budget ownership mismatch.");
        current = null;
    }
    internal static OperationLimitException Limit(string code,int line,int column)
    {
        var scope=current ?? throw new InvalidOperationException("No host budget.");
        scope.Line=line;scope.Column=column;return new OperationLimitException(code);
    }
    public static void Poll(int line, int column)
    {
        var scope = current ?? throw new InvalidOperationException("No host budget.");
        scope.Line=line;scope.Column=column;
        if (scope.DeadlineReached())
        {
            scope.Line = line; scope.Column = column;
            throw new BudgetExpiredException();
        }
        if (scope.StopRequested) throw new BudgetStoppedException();
        scope.CheckAllocationBudget();
    }
    public static void BeforeAllocation(long upperBytes,int line,int column)
    {
        if(upperBytes<0)throw new ArgumentOutOfRangeException(nameof(upperBytes));
        Poll(line,column);current!.CheckAllocationBudget(upperBytes);
    }
    internal static void Print<T>(T value)
    {
        var scope=current??throw new InvalidOperationException("No host budget.");
        if(scope.Logs.Count>=30){scope.DroppedLogs++;return;}
        var text=value is IFormattable formatted?formatted.ToString(null,System.Globalization.CultureInfo.InvariantCulture):value?.ToString()??"null";
        if(text.Length>1024){int size=char.IsHighSurrogate(text[1023])&&char.IsLowSurrogate(text[1024])?1023:1024;text=text[..size];}
        scope.Logs.Add(text);
    }
}

internal sealed class BudgetExpiredException : Exception;
internal sealed class BudgetStoppedException : Exception;
internal sealed class InvalidPlayerNameException : Exception;
internal sealed class BudgetScope(TimeSpan budget)
{
    private readonly object gate = new();
    public long StartedTicks { get; } = Stopwatch.GetTimestamp();
    public TimeSpan Budget => budget;
    private bool expired;
    private int stopRequested;
    public bool Expired { get { lock (gate) return expired; } }
    public bool Completed { get { lock (gate) return completedMs is not null; } }
    public bool StopRequested => Volatile.Read(ref stopRequested) != 0;
    public void RequestStop() => Interlocked.Exchange(ref stopRequested, 1);
    public int? Line { get; set; }
    public int? Column { get; set; }
    public List<string> Logs { get; } = [];
    public int DroppedLogs { get; set; }
    private long? allocationLimit;
    private long allocationStart;
    private long? processAllocationLimit;
    private long processAllocationStart;
    internal long AllocatedBytes=>allocationLimit is null?0:Math.Max(0,GC.GetAllocatedBytesForCurrentThread()-allocationStart);
    internal void SetExperimentalAllocationBudget(long bytes)
    {
        if(bytes<=0||allocationLimit is not null)throw new ArgumentOutOfRangeException(nameof(bytes));
        allocationStart=GC.GetAllocatedBytesForCurrentThread();allocationLimit=bytes;
    }
    internal void SetExperimentalProcessAllocationBudget(long bytes)
    {
        if(bytes<=0||processAllocationLimit is not null)throw new ArgumentOutOfRangeException(nameof(bytes));
        processAllocationStart=GC.GetTotalAllocatedBytes(precise:true);processAllocationLimit=bytes;
    }
    internal void CheckAllocationBudget(long upperBytes=0)
    {
        if(processAllocationLimit is { } total)
        {
            long used=Math.Max(0,GC.GetTotalAllocatedBytes(precise:false)-processAllocationStart);
            if(used>=total||upperBytes>total-used)throw new CSharpGcWindowFailure("gc-host-allocation-budget");
        }
        if(allocationLimit is { } maximum&&(AllocatedBytes>=maximum||upperBytes>maximum-AllocatedBytes))throw new OperationLimitException("call-allocation-bytes");
    }
    private double? completedMs;
    public double ElapsedMs { get { lock (gate) return completedMs ?? Stopwatch.GetElapsedTime(StartedTicks).TotalMilliseconds; } }
    public bool DeadlineReached()
    {
        // The common poll path avoids a lock until the deadline is due.
        if (Stopwatch.GetElapsedTime(StartedTicks) < budget) return false;
        lock (gate) { if (completedMs is null) expired = true; return expired; }
    }
    public void Complete() { lock (gate) { completedMs = Stopwatch.GetElapsedTime(StartedTicks).TotalMilliseconds; expired |= completedMs >= budget.TotalMilliseconds; } }
}

internal sealed record BudgetOutcome(BudgetScope Scope, object? Value, Exception? Error)
{
    public string Status => Scope.Expired ? "timeout" : Scope.StopRequested ? "cancelled" : Error is OperationLimitException ? "operation-limit" : Error is InvalidPlayerNameException ? "invalid-result" : Error is null ? "ok" : "exception";
}
internal static class BudgetInvocation
{
    internal static BudgetOutcome Run(Func<object?> action, TimeSpan budget, Action<BudgetScope>? started = null)
    {
        var scope = BudgetGuard.Begin(budget);
        object? value = null; Exception? error = null;
        try { started?.Invoke(scope); value = action(); }
        catch (TargetInvocationException e) { error = e.InnerException ?? e; }
        catch (Exception e) { error = e; }
        finally { scope.Complete(); BudgetGuard.End(scope); }
        return new(scope, scope.Expired || scope.StopRequested || error is not null ? null : value, error);
    }
}
