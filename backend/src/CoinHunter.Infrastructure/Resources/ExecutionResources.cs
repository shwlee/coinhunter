using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;

namespace CoinHunter.Infrastructure.Resources;

public sealed record ResourceProfile(string Name, long MemoryBytes, int ProcessCount, int CpuRate)
{
    public void Validate()
    {
        if (MemoryBytes < 64L * 1024 * 1024 || ProcessCount is < 1 or > 4096 || CpuRate is < 1 or > 10000)
            throw new InvalidOperationException("Invalid execution resource profile.");
    }
}

public sealed class ExecutionResourceSettings
{
    public ResourceProfile Game { get; }
    public ResourceProfile Validation { get; }
    public ResourceProfile CSharpBetaGame { get; }
    public long TotalMemoryBytes { get; }
    public int TotalProcesses { get; }
    public string? CgroupRoot { get; }
    public string ScopeKey { get; }
    public ExecutionResourceSettings(IConfiguration configuration)
    {
        long Bytes(string key, int fallback) => checked(configuration.GetValue("Backend:Resources:" + key, fallback) * 1024L * 1024L);
        Game = new("game-group-v1", Bytes("GameMemoryMiB", 1024), configuration.GetValue("Backend:Resources:GameProcesses", OperatingSystem.IsWindows() ? 5 : 256), configuration.GetValue("Backend:Resources:GameCpuRate", 2500));
        Validation = new("validation-group-v1", Bytes("ValidationMemoryMiB", 512), configuration.GetValue("Backend:Resources:ValidationProcesses", OperatingSystem.IsWindows() ? 3 : 128), configuration.GetValue("Backend:Resources:ValidationCpuRate", 1250));
        CSharpBetaGame = new("csharp-windows-beta-game-v1", checked(configuration.GetValue("Backend:Languages:CSharpGameMemoryMiB", 2304) * 1024L * 1024), 5, configuration.GetValue("Backend:Languages:CSharpGameCpuRate", 10000));
        TotalMemoryBytes = Bytes("TotalMemoryMiB", 6144);
        TotalProcesses = configuration.GetValue("Backend:Resources:TotalProcesses", OperatingSystem.IsWindows() ? 32 : 1536);
        CgroupRoot = configuration["Backend:Resources:CgroupRoot"];
        var repository = Path.GetFullPath(configuration["Backend:RepositoryRoot"] ?? "..");
        var executionRoot = Path.GetFullPath(configuration["Backend:ExecutionRoot"] ?? Path.Combine(repository, "data/backend/execution"));
        ScopeKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(executionRoot))).ToLowerInvariant()[..16];
        Game.Validate(); Validation.Validate();
        if (new AlgorithmLanguages(configuration).CSharpEnabled)
        {
            CSharpBetaGame.Validate();
            if (CSharpBetaGame.MemoryBytes < 2304L * 1024 * 1024 || TotalMemoryBytes < CSharpBetaGame.MemoryBytes + 1536L * 1024 * 1024)
                throw new InvalidOperationException("C# beta requires a 2304MiB game budget and 1536MiB preparation headroom.");
        }
        if (TotalMemoryBytes < Math.Max(Game.MemoryBytes, Validation.MemoryBytes) || TotalProcesses < Math.Max(Game.ProcessCount, Validation.ProcessCount))
            throw new InvalidOperationException("Execution resource budget cannot admit one configured group.");
    }
}

public interface IExecutionResourceGroup : IDisposable
{
    // Subscopes consume the parent's already reserved budget; they never add a
    // second global reservation. Assignment must enforce every ancestor limit.
    IExecutionResourceGroup CreateChild(ResourceProfile profile) => throw new NotSupportedException("Nested resource scopes are required.");
    void Assign(Process trustedWaitingHost);
    ResourceObservation Observe();
    Task TerminateAndDrain(CancellationToken cancellationToken = default);
}

public sealed record ResourceObservation(int ActiveProcesses, long PeakMemoryBytes, long MemoryLimitBytes, int CpuRate, int ProcessLimit, string MemoryAccounting = "windows-private-commit", long? OomKills = null, string ProcessLimitUnit = "processes");

// Reservations cover whole runtime groups, not just algorithm heaps. CPU rates are
// OS ceilings, not dedicated-core reservations or substitutes for the 500ms budget.
public sealed class ExecutionResources(ExecutionResourceSettings settings)
{
    private readonly object gate = new();
    private long memory;
    private int processes;
    // Must be called while the ExecutionManager's exclusive writer lease is held.
    public void RecoverAbandonedGroups()
    {
        if (OperatingSystem.IsLinux()) LinuxCgroupResourceGroup.Recover(settings.CgroupRoot, settings.ScopeKey);
    }
    public object Status { get { lock (gate) return new { adapter = OperatingSystem.IsWindows() ? "windows-job-v1" : OperatingSystem.IsLinux() ? "linux-cgroup-v2" : "unsupported", processLimitUnit = OperatingSystem.IsLinux() ? "tasks-including-threads" : "processes", reservedMemoryBytes = memory, reservedProcesses = processes, totalMemoryBytes = settings.TotalMemoryBytes, totalProcesses = settings.TotalProcesses }; } }
    public IExecutionResourceGroup Reserve(ResourceProfile profile)
    {
        profile.Validate();
        lock (gate)
        {
            if (profile.MemoryBytes > settings.TotalMemoryBytes - memory || profile.ProcessCount > settings.TotalProcesses - processes)
                throw new Storage.ServiceFault(429, "실행 자원 예약 한도에 도달했습니다.");
            memory += profile.MemoryBytes; processes += profile.ProcessCount;
        }
        void Release() { lock (gate) { memory -= profile.MemoryBytes; processes -= profile.ProcessCount; } }
        try
        {
            if (OperatingSystem.IsWindows()) return new WindowsJobResourceGroup(profile, Release);
            if (OperatingSystem.IsLinux()) return new LinuxCgroupResourceGroup(settings.CgroupRoot, settings.ScopeKey, profile, Release);
            throw new PlatformNotSupportedException("An enforced resource adapter is required for this OS.");
        }
        catch { Release(); throw; }
    }
}
