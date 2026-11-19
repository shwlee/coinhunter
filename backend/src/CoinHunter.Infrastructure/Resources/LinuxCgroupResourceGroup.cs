using System.Diagnostics;
using System.Globalization;

namespace CoinHunter.Infrastructure.Resources;

// Requires an administrator-delegated cgroup v2 subtree. Never falls back to
// unbounded execution or writes to the administrator's root. Controllers are
// enabled only inside newly created, service-owned scopes, never at that root.
public sealed class LinuxCgroupResourceGroup : IExecutionResourceGroup
{
    private readonly string directory;
    private readonly ResourceProfile profile;
    private readonly Action release;
    private bool disposed, assigned;
    private readonly string main;
    private readonly object scopeGate = new();
    private readonly HashSet<LinuxCgroupResourceGroup> children = [];
    private bool stopping;
    private readonly LinuxCgroupResourceGroup? parent;
    public LinuxCgroupResourceGroup(string? root, string scopeKey, ResourceProfile profile, Action release)
        : this(OwnedDirectory(root, scopeKey), profile, release, null) { }
    private static string OwnedDirectory(string? root, string scopeKey)
    { if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException(); return Path.Combine(Root(root), "coinhunter-" + scopeKey + "-" + Guid.NewGuid().ToString("N")); }
    private LinuxCgroupResourceGroup(string directory, ResourceProfile profile, Action release, LinuxCgroupResourceGroup? parent)
    {
        if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException();
        profile.Validate(); this.profile = profile; this.release = release;
        this.directory = directory; main = Path.Combine(directory, "main"); this.parent = parent;
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
            // Domain controllers require an empty interior cgroup. The engine
            // and each nested member live in leaves beneath this aggregate.
            var available = File.ReadAllText(Path.Combine(directory, "cgroup.controllers")).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
            if (!new[] { "cpu", "memory", "pids" }.All(available.Contains)) throw new InvalidOperationException("Nested resource controllers are not delegated.");
            File.WriteAllText(Path.Combine(directory, "cgroup.subtree_control"), "+cpu +memory +pids");
            var enabled = File.ReadAllText(Path.Combine(directory, "cgroup.subtree_control")).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
            if (!new[] { "cpu", "memory", "pids" }.All(enabled.Contains)) throw new InvalidOperationException("Nested controller enablement failed.");
            Directory.CreateDirectory(main);
        }
        catch { RemoveTree(directory); throw; }
    }
    public IExecutionResourceGroup CreateChild(ResourceProfile profile)
    {
        profile.Validate();
        lock (scopeGate)
        {
            ObjectDisposedException.ThrowIf(disposed || stopping, this);
            if (profile.MemoryBytes > this.profile.MemoryBytes || profile.ProcessCount > this.profile.ProcessCount) throw new ArgumentException("Child limits exceed game scope.");
            LinuxCgroupResourceGroup? child = null;
            WithinAncestors(() => { child = new(Path.Combine(directory, "member-" + Guid.NewGuid().ToString("N")), profile, () => { lock (scopeGate) children.Remove(child!); }, this); children.Add(child); }); return child!;
        }
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
            RemoveTree(directory);
        }
    }
    private static void RemoveTree(string owned)
    {
        // cgroup control files are virtual: only remove empty directories, never
        // issue a filesystem recursive delete against their virtual files.
        if (!Directory.Exists(owned)) return;
        foreach (var child in Directory.EnumerateDirectories(owned))
        {
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) throw new IOException("cgroup reparse point refused.");
            RemoveTree(child);
        }
        Directory.Delete(owned);
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
        lock (scopeGate)
        {
            ObjectDisposedException.ThrowIf(disposed || stopping, this);
            if (assigned) throw new InvalidOperationException("A root host is already assigned.");
            WithinAncestors(() =>
            {
                File.WriteAllText(Path.Combine(main, "cgroup.procs"), trustedWaitingHost.Id.ToString(CultureInfo.InvariantCulture));
                if (!File.ReadAllLines(Path.Combine(main, "cgroup.procs")).Contains(trustedWaitingHost.Id.ToString(CultureInfo.InvariantCulture))) throw new InvalidOperationException("cgroup assignment was not confirmed.");
                assigned = true;
            });
        }
    }
    private void WithinAncestors(Action action)
    {
        lock (scopeGate)
        {
            ObjectDisposedException.ThrowIf(disposed || stopping, this);
            if (parent is null) action(); else parent.WithinAncestors(action);
        }
    }
    public ResourceObservation Observe()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var peakPath = Path.Combine(directory, "memory.peak");
        var memory = long.Parse(File.ReadAllText(File.Exists(peakPath) ? peakPath : Path.Combine(directory, "memory.current")).Trim(), CultureInfo.InvariantCulture);
        var oom = File.ReadAllLines(Path.Combine(directory, "memory.events")).Single(line => line.StartsWith("oom_kill ", StringComparison.Ordinal)).Split(' ')[1];
        var tasks = int.Parse(File.ReadAllText(Path.Combine(directory, "pids.current")).Trim(), CultureInfo.InvariantCulture);
        return new(tasks, memory, profile.MemoryBytes, profile.CpuRate, profile.ProcessCount, File.Exists(peakPath) ? "cgroup-charged-peak" : "cgroup-charged-current", long.Parse(oom, CultureInfo.InvariantCulture), "tasks-including-threads");
    }
    public async Task TerminateAndDrain(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        lock (scopeGate) stopping = true;
        File.WriteAllText(Path.Combine(directory, "cgroup.kill"), "1");
        while (File.ReadAllLines(Path.Combine(directory, "cgroup.events")).Contains("populated 1")) await Task.Delay(10, cancellationToken);
    }
    public void Dispose()
    {
        if (disposed) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        TerminateAndDrain(deadline.Token).GetAwaiter().GetResult();
        while (true) { lock (scopeGate) { if (children.Count == 0) break; } Task.Delay(10, deadline.Token).GetAwaiter().GetResult(); }
        RemoveTree(directory);
        disposed = true; release();
    }
}
