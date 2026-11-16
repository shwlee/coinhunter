using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CoinHunter.Infrastructure.Resources;

// Windows job limits apply before the trusted host is allowed to load user code.
// A job is a process/memory/CPU boundary, not a file/network sandbox.
public sealed class WindowsJobResourceGroup : IExecutionResourceGroup
{
    private readonly SafeFileHandle job;
    private readonly ResourceProfile profile;
    private readonly Action release;
    private bool disposed;
    private bool assigned;
    public WindowsJobResourceGroup(ResourceProfile profile, Action release)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        profile.Validate(); this.profile = profile; this.release = release;
        job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var limits = new ExtendedLimits
            {
                Basic = new BasicLimits { Flags = 0x2000 | 0x200 | 0x8, ActiveProcesses = (uint)profile.ProcessCount },
                JobMemory = (UIntPtr)(ulong)profile.MemoryBytes
            };
            Set(9, limits);
            Set(15, new CpuControl { Flags = 0x1 | 0x4, Rate = (uint)profile.CpuRate });
            var read = Query<ExtendedLimits>(9); var cpu = Query<CpuControl>(15);
            if ((read.Basic.Flags & limits.Basic.Flags) != limits.Basic.Flags || read.JobMemory != limits.JobMemory ||
                read.Basic.ActiveProcesses != limits.Basic.ActiveProcesses || cpu.Flags != 5 || cpu.Rate != profile.CpuRate)
                throw new InvalidOperationException("OS resource limits were not confirmed.");
        }
        catch { job.Dispose(); throw; }
    }
    public void Assign(Process trustedWaitingHost)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (assigned) throw new InvalidOperationException("A root host is already assigned.");
        if (!Native.AssignProcessToJobObject(job, trustedWaitingHost.Handle) ||
            !Native.IsProcessInJob(trustedWaitingHost.Handle, job, out var contained) || !contained)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        assigned = true;
    }
    public ResourceObservation Observe()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var usage = Query<Accounting>(1); var memory = Query<ExtendedLimits>(9);
        return new((int)usage.Active, checked((long)memory.PeakJobMemory.ToUInt64()), profile.MemoryBytes, profile.CpuRate, profile.ProcessCount);
    }
    public async Task TerminateAndDrain(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!Native.TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        while (Observe().ActiveProcesses != 0) await Task.Delay(10, cancellationToken);
    }
    public void Dispose()
    {
        if (disposed) return;
        // Synchronous Dispose must not release admission while descendant processes still run.
        // No timeout-success path: an unconfirmed cleanup keeps its reservation and raises.
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try { TerminateAndDrain(deadline.Token).GetAwaiter().GetResult(); }
        catch { disposed = true; job.Dispose(); throw; }
        disposed = true; job.Dispose(); release();
    }
    private void Set<T>(int kind, T value) where T : struct
    {
        var size = Marshal.SizeOf<T>(); var pointer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, pointer, false); if (!Native.SetInformationJobObject(job, kind, pointer, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    private T Query<T>(int kind) where T : struct
    {
        var size = Marshal.SizeOf<T>(); var pointer = Marshal.AllocHGlobal(size);
        try { if (!Native.QueryInformationJobObject(job, kind, pointer, (uint)size, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); return Marshal.PtrToStructure<T>(pointer); }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] private struct CpuControl { public uint Flags, Rate; }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting
    { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint Faults, Total, Active, Terminated; }
    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(SafeFileHandle job, int kind, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, IntPtr info, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool contained);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    }
}
