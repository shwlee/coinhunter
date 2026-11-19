using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using Microsoft.Extensions.Configuration;

internal static class ResourceChecks
{
    public static async Task Child(string[] args)
    {
        if (await Console.In.ReadLineAsync() != "go") return;
        if (args[0] == "memory")
        {
            var allocations = new List<IntPtr>();
            try
            {
                for (var i = 0; i < 16; i++)
                {
                    var pointer = Marshal.AllocHGlobal(16 * 1024 * 1024); allocations.Add(pointer);
                    for (var offset = 0; offset < 16 * 1024 * 1024; offset += 4096) Marshal.WriteByte(pointer, offset, 1);
                }
                Console.WriteLine("unbounded");
            }
            catch (OutOfMemoryException) { Console.WriteLine("denied:" + allocations.Count); }
            finally { foreach (var pointer in allocations) Marshal.FreeHGlobal(pointer); }
        }
        else if (args[0] == "spawn" || args[0] == "tree")
        {
            try
            {
                using var child = new Process { StartInfo = StartInfo(args[1], "wait") };
                child.Start();
                Console.WriteLine("child:" + child.Id);
                if (args[0] == "spawn") { await child.WaitForExitAsync(); return; }
                await Task.Delay(Timeout.Infinite);
            }
            catch (Win32Exception) { Console.WriteLine("blocked"); }
        }
        else if (args[0] == "resident-memory")
        {
            var pointer = Marshal.AllocHGlobal(80 * 1024 * 1024);
            try { for (int offset = 0; offset < 80 * 1024 * 1024; offset += 4096) Marshal.WriteByte(pointer, offset, 1); Console.WriteLine("resident"); await Task.Delay(Timeout.Infinite); }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        else if (args[0] == "cpu")
        {
            using var current = Process.GetCurrentProcess();
            var before = current.TotalProcessorTime.TotalMilliseconds; var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < 2000) Thread.SpinWait(1000);
            Console.WriteLine("cpu:" + (current.TotalProcessorTime.TotalMilliseconds - before).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        else await Task.Delay(Timeout.Infinite);
    }

    private static ProcessStartInfo StartInfo(string root, string mode)
    {
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "dotnet", StringComparison.OrdinalIgnoreCase)) info.ArgumentList.Add(typeof(ResourceChecks).Assembly.Location);
        foreach (var argument in new[] { root, "resource-child", mode, root }) info.ArgumentList.Add(argument);
        return info;
    }

    public static async Task<int> Run(string root)
    {
        if (OperatingSystem.IsLinux()) return await RunLinux(root);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows Job Object enforcement must be verified on Windows.");
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Backend:Resources:GameMemoryMiB"] = "128", ["Backend:Resources:ValidationMemoryMiB"] = "128", ["Backend:Resources:GameProcesses"] = "1", ["Backend:Resources:ValidationProcesses"] = "1", ["Backend:Resources:TotalMemoryMiB"] = "256", ["Backend:Resources:TotalProcesses"] = "2" }).Build();
        var manager = new ExecutionResources(new ExecutionResourceSettings(configuration));
        var small = new ResourceProfile("test", 128L * 1024 * 1024, 1, 10000);
        using (var a = manager.Reserve(small)) using (var b = manager.Reserve(small))
        {
            try { using var excess = manager.Reserve(small); throw new Exception("Budget overflow was admitted."); }
            catch (ServiceFault fault) when (fault.Status == 429) { }
        }
        if (JsonSerializer.SerializeToNode(manager.Status)!["reservedProcesses"]!.GetValue<int>() != 0) throw new Exception("Reservation leak.");
        Console.WriteLine("PASS OS resource reservations reject overflow and release empty groups");

        async Task<string> Run(string mode, ResourceProfile profile)
        {
            using var resources = new WindowsJobResourceGroup(profile, () => { });
            using var process = new Process { StartInfo = StartInfo(root, mode) };
            process.Start();
            try
            {
                resources.Assign(process);
                await process.StandardInput.WriteLineAsync("go"); process.StandardInput.Close();
                var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
                if (line is null) throw new Exception("Resource probe exited before result: " + await process.StandardError.ReadToEndAsync());
                if (mode == "tree")
                {
                    if (!line.StartsWith("child:")) throw new Exception(line);
                    var childId = int.Parse(line[6..]);
                    // The grandchild remains in its trusted stdin gate, but must inherit the job.
                    var until = DateTime.UtcNow.AddSeconds(5);
                    while (resources.Observe().ActiveProcesses < 2) { if (DateTime.UtcNow > until) throw new Exception("Descendant escaped job."); await Task.Delay(10); }
                    await resources.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5));
                    try { using var child = Process.GetProcessById(childId); if (!child.HasExited) throw new Exception("Descendant survived cleanup."); } catch (ArgumentException) { }
                }
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                return line;
            }
            finally
            {
                await resources.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5));
                if (!process.HasExited) await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
        }
        var native = await Run("memory", small with { MemoryBytes = 192L * 1024 * 1024 });
        if (!native.StartsWith("denied:") || int.Parse(native[7..]) >= 16) throw new Exception("Native memory limit was not enforced: " + native);
        Console.WriteLine("PASS Windows job denies native allocations beyond group commit limit");
        var spawn = await Run("spawn", small);
        if (spawn != "blocked") throw new Exception("Process limit was not enforced: " + spawn);
        Console.WriteLine("PASS Windows job denies extra child processes");
        await Run("tree", small with { ProcessCount = 3 });
        Console.WriteLine("PASS Windows job contains descendants and confirms zero active processes before cleanup");
        var count = GetActiveProcessorCount(0xffff);
        var rate = Math.Max(1, 2500 / (int)count);
        var cpu = await Run("cpu", small with { CpuRate = rate });
        var cpuMs = double.Parse(cpu[4..], System.Globalization.CultureInfo.InvariantCulture);
        if (!cpu.StartsWith("cpu:") || cpuMs >= 1700) throw new Exception("CPU cap did not throttle the probe: " + cpu);
        Console.WriteLine($"PASS Windows CPU hard cap observed: {cpuMs:F1} CPU ms / 2000 wall ms, rate {rate}/10000");
        await NestedWindows(root, rate);
        return 7;
    }
    private static async Task NestedWindows(string root, int cpuRate)
    {
        async Task<string> Nested(string parentMode, string childMode, ResourceProfile profile)
        {
            using var scope = new WindowsJobResourceGroup(profile, () => { });
            using var parent = new Process { StartInfo = StartInfo(root, parentMode) }; parent.Start(); var parentErrors = parent.StandardError.ReadToEndAsync();
            try
            {
                scope.Assign(parent);
                if (parentMode == "resident-memory")
                {
                    await parent.StandardInput.WriteLineAsync("go");
                    if (await parent.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)) != "resident") throw new Exception("Parent resident allocation failed.");
                }
                using var childScope = scope.CreateChild(profile with { Name = "nested-child", CpuRate = 10000, ProcessCount = 1 });
                using var child = new Process { StartInfo = StartInfo(root, childMode) }; child.Start(); var childErrors = child.StandardError.ReadToEndAsync();
                try
                {
                    childScope.Assign(child); await child.StandardInput.WriteLineAsync("go"); child.StandardInput.Close();
                    var output = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20)); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); return output ?? throw new Exception("Missing nested result.");
                }
                finally { await childScope.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5)); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); await childErrors; }
            }
            finally { await scope.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5)); await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); await parentErrors; }
        }
        var native = await Nested("resident-memory", "memory", new("nested-memory", 192L * 1024 * 1024, 4, 10000));
        if (!native.StartsWith("denied:") || int.Parse(native[7..]) >= 8) throw new Exception("Child allocation ignored memory already used by parent: " + native);
        Console.WriteLine("PASS nested job memory includes parent resident allocation and child native allocations");
        var result = await Nested("wait", "cpu", new("nested-cpu", 192L * 1024 * 1024, 4, cpuRate));
        var milliseconds = double.Parse(result[4..], System.Globalization.CultureInfo.InvariantCulture);
        if (!result.StartsWith("cpu:") || milliseconds >= 1700) throw new Exception("Child escaped parent CPU hard cap: " + result);
        Console.WriteLine($"PASS nested job child CPU hard cap inherited: {milliseconds:F1} CPU ms / 2000 wall ms");
    }
    private static async Task<int> RunLinux(string root)
    {
        var settings = new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build());
        var manager = new ExecutionResources(settings);
        async Task<(string? Line, ResourceObservation Observation)> Probe(string mode, ResourceProfile profile)
        {
            using var group = manager.Reserve(profile);
            using var process = new Process { StartInfo = StartInfo(root, mode) };
            process.Start();
            try
            {
                group.Assign(process); await process.StandardInput.WriteLineAsync("go"); process.StandardInput.Close();
                var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
                if (mode == "tree")
                {
                    if (line?.StartsWith("child:") != true) throw new Exception("Linux descendant probe failed.");
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (group.Observe().ActiveProcesses < 2) { if (DateTime.UtcNow > deadline) throw new Exception("Descendant escaped cgroup."); await Task.Delay(10); }
                    await group.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5));
                }
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                return (line, group.Observe());
            }
            finally { await group.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(5)); }
        }
        var profile = new ResourceProfile("linux-probe", 192L * 1024 * 1024, 128, 10000);
        var memory = await Probe("memory", profile);
        if (!(memory.Line?.StartsWith("denied:") == true || memory.Observation.OomKills > 0)) throw new Exception("Linux memory limit not enforced.");
        Console.WriteLine("PASS delegated cgroup denies memory expansion or records verified OOM kill");
        await Probe("tree", profile);
        Console.WriteLine("PASS delegated cgroup contains and drains descendants");
        var rate = Math.Max(100, 2500 / Math.Max(1, Environment.ProcessorCount));
        var cpu = await Probe("cpu", profile with { CpuRate = rate });
        if (cpu.Line?.StartsWith("cpu:") != true || double.Parse(cpu.Line[4..], System.Globalization.CultureInfo.InvariantCulture) >= 1700) throw new Exception("Linux CPU cap did not throttle the probe.");
        Console.WriteLine("PASS delegated cgroup CPU cap throttles trusted spin probe");
        if (JsonSerializer.SerializeToNode(manager.Status)!["reservedProcesses"]!.GetValue<int>() != 0) throw new Exception("Linux resource reservations leaked.");
        Console.WriteLine("PASS delegated cgroup releases reservations after cleanup");
        return 4;
    }
    [DllImport("kernel32.dll")] private static extern uint GetActiveProcessorCount(ushort group);
}
