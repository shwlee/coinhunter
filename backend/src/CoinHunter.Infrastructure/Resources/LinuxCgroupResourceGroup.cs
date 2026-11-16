using System.Diagnostics;
using System.Globalization;

namespace CoinHunter.Infrastructure.Resources;

// Requires an administrator-delegated cgroup v2 subtree. Never falls back to
// unbounded execution, writes to the cgroup root, or enables controllers itself.
public sealed class LinuxCgroupResourceGroup : IExecutionResourceGroup
{
    private readonly string directory;
    private readonly ResourceProfile profile;
    private readonly Action release;
    private bool disposed, assigned;
    public LinuxCgroupResourceGroup(string? root, string scopeKey, ResourceProfile profile, Action release)
    {
        if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException();
        profile.Validate(); this.profile = profile; this.release = release;
        var absolute = Root(root);
        directory = Path.Combine(absolute, "coinhunter-" + scopeKey + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            WriteAndVerify("memory.max", profile.MemoryBytes.ToString(CultureInfo.InvariantCulture));
            WriteAndVerify("memory.swap.max", "0");
            WriteAndVerify("memory.oom.group", "1");
            // Linux pids counts threads too. Profiles/admission use explicit task limits on Linux.
            WriteAndVerify("pids.max", profile.ProcessCount.ToString(CultureInfo.InvariantCulture));
            var quota = checked((long)profile.CpuRate * Math.Max(1, Environment.ProcessorCount) * 10);
            if (quota < 1000) throw new InvalidOperationException("Requested CPU cap is below cgroup granularity.");
            WriteAndVerify("cpu.max", quota.ToString(CultureInfo.InvariantCulture) + " 100000");
            if (!File.Exists(Path.Combine(directory, "cgroup.kill"))) throw new PlatformNotSupportedException("cgroup.kill is required for descendant cleanup.");
        }
        catch { Directory.Delete(directory); throw; }
    }
    private static string Root(string? root)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new InvalidOperationException("Backend:Resources:CgroupRoot must name a writable delegated cgroup v2 subtree.");
        var absolute = Path.GetFullPath(root);
        if (!absolute.StartsWith("/sys/fs/cgroup/", StringComparison.Ordinal) || !File.Exists(Path.Combine(absolute, "cgroup.controllers")))
            throw new InvalidOperationException("A delegated /sys/fs/cgroup subtree is required.");
        return absolute;
    }
    public static void Recover(string? root, string scopeKey)
    {
        var prefix = "coinhunter-" + scopeKey + "-";
        foreach (var directory in Directory.EnumerateDirectories(Root(root), prefix + "*"))
        {
            if (!Guid.TryParseExact(Path.GetFileName(directory)[prefix.Length..], "N", out _)) continue;
            File.WriteAllText(Path.Combine(directory, "cgroup.kill"), "1");
            var deadline = Stopwatch.StartNew();
            while (File.ReadAllLines(Path.Combine(directory, "cgroup.events")).Contains("populated 1"))
            { if (deadline.Elapsed > TimeSpan.FromSeconds(10)) throw new IOException("Abandoned cgroup cleanup was not confirmed."); Thread.Sleep(10); }
            Directory.Delete(directory);
        }
    }
    private void WriteAndVerify(string file, string value)
    {
        var path = Path.Combine(directory, file);
        if (!File.Exists(path)) throw new InvalidOperationException("Delegated memory/cpu/pids controllers are required.");
        File.WriteAllText(path, value);
        if (File.ReadAllText(path).Trim() != value) throw new InvalidOperationException("cgroup limit readback failed.");
    }
    public void Assign(Process trustedWaitingHost)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (assigned) throw new InvalidOperationException("A root host is already assigned.");
        File.WriteAllText(Path.Combine(directory, "cgroup.procs"), trustedWaitingHost.Id.ToString(CultureInfo.InvariantCulture));
        if (!Pids().Contains(trustedWaitingHost.Id)) throw new InvalidOperationException("cgroup assignment was not confirmed.");
        assigned = true;
    }
    private int[] Pids() => File.ReadAllLines(Path.Combine(directory, "cgroup.procs")).Where(line => line.Length > 0).Select(int.Parse).ToArray();
    public ResourceObservation Observe()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var peakPath = Path.Combine(directory, "memory.peak");
        var memory = long.Parse(File.ReadAllText(File.Exists(peakPath) ? peakPath : Path.Combine(directory, "memory.current")).Trim(), CultureInfo.InvariantCulture);
        var oom = File.ReadAllLines(Path.Combine(directory, "memory.events")).Single(line => line.StartsWith("oom_kill ", StringComparison.Ordinal)).Split(' ')[1];
        return new(Pids().Length, memory, profile.MemoryBytes, profile.CpuRate, profile.ProcessCount, File.Exists(peakPath) ? "cgroup-charged-peak" : "cgroup-charged-current", long.Parse(oom, CultureInfo.InvariantCulture), "tasks-including-threads");
    }
    public async Task TerminateAndDrain(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        File.WriteAllText(Path.Combine(directory, "cgroup.kill"), "1");
        while (File.ReadAllLines(Path.Combine(directory, "cgroup.events")).Contains("populated 1")) await Task.Delay(10, cancellationToken);
    }
    public void Dispose()
    {
        if (disposed) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        TerminateAndDrain(deadline.Token).GetAwaiter().GetResult();
        Directory.Delete(directory);
        disposed = true; release();
    }
}
