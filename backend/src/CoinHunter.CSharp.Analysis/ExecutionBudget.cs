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
        if (scope.DeadlineReached())
        {
            scope.Line = line; scope.Column = column;
            throw new BudgetExpiredException();
        }
        if (scope.StopRequested) throw new BudgetStoppedException();
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
