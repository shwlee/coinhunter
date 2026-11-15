using System.Security.Cryptography;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using Microsoft.Extensions.Configuration;

namespace CoinHunter.Infrastructure.Storage;

public sealed class StorageSettings
{
    public string RepositoryRoot { get; }
    public string DataRoot { get; }
    public string ExchangeRoot { get; }
    public string ExecutionRoot { get; }
    public string NodeExecutable { get; }
    public StorageSettings(IConfiguration configuration)
    {
        RepositoryRoot = Path.GetFullPath(configuration["Backend:RepositoryRoot"] ?? "..");
        DataRoot = Path.GetFullPath(configuration["Backend:DataRoot"] ?? Path.Combine(RepositoryRoot, "data/backend/operations"));
        ExchangeRoot = Path.GetFullPath(configuration["Backend:ExchangeRoot"] ?? Path.Combine(RepositoryRoot, "data/backend/exchange"));
        ExecutionRoot = Path.GetFullPath(configuration["Backend:ExecutionRoot"] ?? Path.Combine(RepositoryRoot, "data/backend/execution"));
        NodeExecutable = configuration["Backend:NodeExecutable"] ?? "node";
        if (!File.Exists(Path.Combine(RepositoryRoot, "backend/node/src/game/match.js")))
            throw new InvalidOperationException("Backend:RepositoryRoot must point to the game repository.");
        // Never silently take over the existing writer's files.
        if (DataRoot.TrimEnd(Path.DirectorySeparatorChar).Equals(Path.Combine(RepositoryRoot, "data"), StringComparison.OrdinalIgnoreCase) ||
            DataRoot.Equals(Path.Combine(RepositoryRoot, "data/accounts"), StringComparison.OrdinalIgnoreCase) ||
            DataRoot.Equals(ExchangeRoot, StringComparison.OrdinalIgnoreCase) || DataRoot.Equals(ExecutionRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Use separate backend data/exchange/execution directories. Migrate offline.");
    }
}

public static class AtomicFile
{
    public static async Task Json(string path, JsonNode value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid() + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous))
            {
                await System.Text.Json.JsonSerializer.SerializeAsync(stream, value);
                await stream.FlushAsync();
                stream.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally { File.Delete(temporary); }
    }

    public static async Task<JsonObject> Read(string path, JsonObject fallback)
    {
        if (!File.Exists(path)) return fallback;
        await using var stream = File.OpenRead(path);
        return await JsonNode.ParseAsync(stream) as JsonObject ?? throw new InvalidDataException("Invalid stored document.");
    }
}

// A process-lifetime exclusive lease prevents another .NET host/maintenance command writing concurrently.
// Readers never mutate cached documents; every operation uses the same serialized unit of work.
public sealed class FileAccountStore : IAccountStore, IDisposable
{
    private readonly string path;
    private readonly SemaphoreSlim gate = new(1);
    private readonly FileStream lease;
    public FileAccountStore(StorageSettings settings)
    {
        Directory.CreateDirectory(settings.DataRoot);
        if (File.Exists(Path.Combine(settings.DataRoot, ".migration.in-progress"))) throw new InvalidOperationException("Incomplete migration. Restore the coordinated backup before starting.");
        path = Path.Combine(settings.DataRoot, "accounts/store.json");
        lease = new FileStream(Path.Combine(settings.DataRoot, ".writer.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    private static JsonObject Empty() => new() { ["users"] = new JsonArray(), ["identities"] = new JsonArray(), ["algorithms"] = new JsonArray(), ["history"] = new JsonArray(), ["matches"] = new JsonArray() };
    public async Task<T> Read<T>(Func<JsonObject, T> read)
    {
        await gate.WaitAsync();
        try { return read(await AtomicFile.Read(path, Empty())); }
        finally { gate.Release(); }
    }
    public async Task<T> Change<T>(Func<JsonObject, Task<T>> change)
    {
        await gate.WaitAsync();
        try
        {
            var data = await AtomicFile.Read(path, Empty());
            var result = await change(data);
            await AtomicFile.Json(path, data);
            return result;
        }
        finally { gate.Release(); }
    }
    public void Dispose() { lease.Dispose(); gate.Dispose(); }
}

public sealed class FileSourceStore(string root) : ISourceStore
{
    public string Root { get; } = Path.GetFullPath(root);
    public string PathFor(Guid key) => key == Guid.Empty ? throw new ServiceFault(400, "잘못된 코드 참조입니다.") : Path.Combine(Root, key.ToString("D") + ".js");
    public async Task<SourceReference> Put(Stream input, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Root);
        var key = Guid.NewGuid();
        var path = PathFor(key);
        var temporary = path + ".tmp";
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous))
            {
                var buffer = new byte[65536];
                long nextCheck = 0;
                while (true)
                {
                    var read = await input.ReadAsync(buffer, cancellationToken);
                    if (read == 0) break;
                    if (output.Position >= nextCheck)
                    {
                        var drive = new DriveInfo(Path.GetPathRoot(Root)!);
                        if (drive.AvailableFreeSpace < 256L * 1024 * 1024) throw new ServiceFault(507, "코드 저장 공간이 부족합니다.");
                        nextCheck = output.Position + 8 * 1024 * 1024;
                    }
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                await output.FlushAsync(cancellationToken);
                output.Flush(true);
            }
            File.Move(temporary, path);
            return await Describe(key);
        }
        catch { File.Delete(path); throw; }
        finally { File.Delete(temporary); }
    }
    // File handle is the read lease. Old immutable versions are retained until offline reconciliation.
    public FileStream Open(Guid key) => new(PathFor(key), FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
    public async Task<SourceReference> Describe(Guid key)
    {
        await using var stream = Open(key);
        return new SourceReference { SourceKey = key, ByteLength = stream.Length, Sha256 = Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant() };
    }
    public async Task<SourceReference> Copy(Guid key, ISourceStore destination)
    {
        await using var stream = Open(key);
        return await destination.Put(stream);
    }
    public Task Delete(Guid key) { File.Delete(PathFor(key)); return Task.CompletedTask; }
}
