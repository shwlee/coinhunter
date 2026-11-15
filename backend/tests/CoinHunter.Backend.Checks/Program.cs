using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

if (args.Length < 1) throw new ArgumentException("Repository root is required.");
var root = Path.GetFullPath(args[0]);
var example = JsonSerializer.Deserialize<EngineEnvelope>(
    await File.ReadAllTextAsync(Path.Combine(root, "backend/contracts/initialize.example.json")), Protocol.JsonOptions)!;
if (args.Length == 3 && args[1] == "verify-frame")
{
    await using var input = File.OpenRead(args[2]);
    var message = await EngineFrameCodec.ReadAsync(input) ?? throw new Exception("Expected one frame.");
    if (message.Type != "initialize" || message.MatchId != example.MatchId || await EngineFrameCodec.ReadAsync(input) is not null)
        throw new Exception("Cross-language frame differs.");
    ContractValidation.Execution(message.Payload.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!);
    Console.WriteLine("PASS Node -> .NET frame");
    return;
}

var checks = 0;
void Check(string name, Action action)
{
    action();
    checks++;
    Console.WriteLine($"PASS {name}");
}
async Task CheckAsync(string name, Func<Task> action)
{
    await action();
    checks++;
    Console.WriteLine($"PASS {name}");
}
void Throws<T>(Action action) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}.");
}
async Task RejectFrame(byte[] bytes)
{
    try { await EngineFrameCodec.ReadAsync(new MemoryStream(bytes)); }
    catch (InvalidDataException) { return; }
    throw new Exception("Expected invalid frame rejection.");
}

var request = example.Payload.Deserialize<ExecutionRequest>(Protocol.JsonOptions)!;
Check("shared protocol manifest agrees with .NET constants", () =>
{
    using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "backend/contracts/engine-protocol-v1.json")));
    var spec = manifest.RootElement;
    if (spec.GetProperty("contractVersion").GetInt32() != Protocol.Version ||
        spec.GetProperty("maxFrameBytes").GetInt32() != Protocol.MaxFrameBytes ||
        !Protocol.MessageTypes.SetEquals(spec.GetProperty("messageTypes").EnumerateArray().Select(item => item.GetString()!)))
        throw new Exception("Protocol constants drifted.");
});
Check("execution fixture and player/source identity", () => ContractValidation.Execution(request));
Check("unknown version rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { ContractVersion = 2 })));
Check("duplicate player rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Participants = [request.Participants[0], request.Participants[0]] })));
Check("null player rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Participants = [null!] })));
Check("guest duel rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Options = request.Options with { Mode = "duel" } })));
Check("unsupported language rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Participants = [request.Participants[0] with { Language = "python" }] })));
Check("invalid map dimensions rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Map = request.Map with { Rows = 3 } })));
Check("source hash rejected", () => Throws<InvalidDataException>(() => ContractValidation.Execution(request with { Participants = [request.Participants[0] with { Source = request.Participants[0].Source with { Sha256 = "invalid" } }] })));
Check("unknown JSON fields rejected", () => Throws<JsonException>(() => JsonSerializer.Deserialize<EngineEnvelope>("{\"unexpected\":1}", Protocol.JsonOptions)));
Check("missing required fields rejected", () => Throws<JsonException>(() => JsonSerializer.Deserialize<EngineEnvelope>("{}", Protocol.JsonOptions)));
Check("AI route stays outside active business catalog", () => { if (ApiCatalog.Find(ApiCatalog.Public, "POST", "/api/ai/create") is not null) throw new Exception("AI route restored."); });
Check("source metadata header contract retained", () => { if (!ApiCatalog.Find(ApiCatalog.Public, "GET", "/api/algorithms/id/source")!.Output.Contains("X-Coinhunter-Metadata")) throw new Exception("Metadata missing."); });

var encoded = EngineFrameCodec.Encode(example);
await CheckAsync("fragmented reads and clean EOF", async () =>
{
    using var stream = new FragmentedStream(encoded);
    var decoded = await EngineFrameCodec.ReadAsync(stream);
    if (decoded?.MessageId != example.MessageId || await EngineFrameCodec.ReadAsync(stream) is not null) throw new Exception("Fragmented frame failed.");
});
await CheckAsync("coalesced frames", async () =>
{
    using var stream = new MemoryStream([.. encoded, .. encoded]);
    if (await EngineFrameCodec.ReadAsync(stream) is null || await EngineFrameCodec.ReadAsync(stream) is null || await EngineFrameCodec.ReadAsync(stream) is not null)
        throw new Exception("Coalesced frame failed.");
});
await CheckAsync("truncated header", () => RejectFrame(encoded[..3]));
await CheckAsync("truncated body", () => RejectFrame(encoded[..^1]));
await CheckAsync("oversized frame rejected before allocation", () =>
{
    var header = new byte[4];
    BinaryPrimitives.WriteInt32BigEndian(header, Protocol.MaxFrameBytes + 1);
    return RejectFrame(header);
});
await CheckAsync("zero-length frame", () => RejectFrame(new byte[4]));
await CheckAsync("malformed JSON frame", () => RejectFrame([0, 0, 0, 1, (byte)'{']));
await CheckAsync("invalid UTF8 frame", () => RejectFrame([0, 0, 0, 1, 255]));
Check("encode rejects unsupported version", () => Throws<InvalidDataException>(() => EngineFrameCodec.Encode(example with { ContractVersion = 99 })));
Check("encode byte limit", () => Throws<InvalidDataException>(() => EngineFrameCodec.Encode(example, 1)));

BackendSettings Settings(Dictionary<string, string?>? changes = null, string environment = "Development")
{
    var values = new Dictionary<string, string?>
    {
        ["Backend:ListenUrl"] = "http://127.0.0.1:3101",
        ["Backend:PublicUrl"] = "http://127.0.0.1:3000",
        ["Backend:ExecutionUrl"] = "http://127.0.0.1:3102",
        ["COINHUNTER_INTERNAL_KEY"] = new string('a', 43)
    };
    foreach (var pair in changes ?? []) values[pair.Key] = pair.Value;
    return BackendSettings.Read(new ConfigurationBuilder().AddInMemoryCollection(values).Build(), new TestEnvironment { EnvironmentName = environment }, Protocol.OperationsService);
}
Check("loopback development settings", () => _ = Settings());
Check("missing service key", () => Throws<InvalidOperationException>(() => Settings(new() { ["COINHUNTER_INTERNAL_KEY"] = null })));
Check("credential URL rejected", () => Throws<InvalidOperationException>(() => Settings(new() { ["Backend:ExecutionUrl"] = "http://name:secret@127.0.0.1:3102" })));
Check("non-loopback listener rejected", () => Throws<InvalidOperationException>(() => Settings(new() { ["Backend:ListenUrl"] = "http://0.0.0.0:3101" })));
Check("production public HTTP rejected", () => Throws<InvalidOperationException>(() => Settings(environment: Environments.Production)));
Check("production public HTTPS", () => _ = Settings(new() { ["Backend:PublicUrl"] = "https://game.example.invalid" }, Environments.Production));
Check("query in public origin rejected", () => Throws<InvalidOperationException>(() => Settings(new() { ["Backend:PublicUrl"] = "http://127.0.0.1:3000/?code=secret" })));
Check("invalid trusted proxy rejected", () => Throws<InvalidOperationException>(() => Settings(new() { ["Backend:TrustedProxies:0"] = "*" })));

Directory.CreateDirectory(Path.Combine(root, "artifacts"));
await File.WriteAllBytesAsync(Path.Combine(root, "artifacts/dotnet-engine-fixture.bin"), encoded);
await CheckAsync("snapshot wait returns immediately for a newer snapshot", async () =>
{
    var record = new CoinHunter.Execution.Host.Services.ExecutionRecord { Request = request, Fingerprint = "snapshot-test", Snapshot = new System.Text.Json.Nodes.JsonObject { ["sequence"] = 2 } };
    await record.WaitForSnapshot(1, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
});
await CheckAsync("snapshot signal wakes all subscribers without losing an update before await", async () =>
{
    var record = new CoinHunter.Execution.Host.Services.ExecutionRecord { Request = request, Fingerprint = "snapshot-test", Snapshot = new System.Text.Json.Nodes.JsonObject { ["sequence"] = 1 } };
    var first = record.WaitForSnapshot(1, CancellationToken.None);
    var second = record.WaitForSnapshot(1, CancellationToken.None);
    if (first.IsCompleted || second.IsCompleted) throw new Exception("Wait skipped unchanged snapshot.");
    lock (record.Gate) record.Snapshot!["sequence"] = 2;
    record.NotifySnapshotChanged();
    await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(2));
    await record.WaitForSnapshot(1, CancellationToken.None);
});
await CheckAsync("snapshot subscriber cancellation is isolated and idle wait is bounded", async () =>
{
    var record = new CoinHunter.Execution.Host.Services.ExecutionRecord { Request = request, Fingerprint = "snapshot-test" };
    using var cancellation = new CancellationTokenSource();
    var cancelled = record.WaitForSnapshot(-1, cancellation.Token);
    var remaining = record.WaitForSnapshot(-1, CancellationToken.None);
    cancellation.Cancel();
    try { await cancelled; throw new Exception("Expected cancellation."); } catch (OperationCanceledException) { }
    if (remaining.IsCompleted) throw new Exception("Another subscriber was cancelled.");
    await remaining.WaitAsync(TimeSpan.FromSeconds(2));
});
await CheckAsync("terminal execution wakes an unchanged-snapshot subscriber", async () =>
{
    var record = new CoinHunter.Execution.Host.Services.ExecutionRecord { Request = request, Fingerprint = "snapshot-test" };
    var waiting = record.WaitForSnapshot(-1, CancellationToken.None);
    record.Closed.TrySetResult(); record.NotifySnapshotChanged();
    await waiting.WaitAsync(TimeSpan.FromSeconds(2));
});
Console.WriteLine($"Backend contract checks passed: {checks}");
await BusinessChecks.Run(root);

sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes)
{
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
        base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);
}

sealed class TestEnvironment : IHostEnvironment
{
    public string EnvironmentName { get; set; } = Environments.Development;
    public string ApplicationName { get; set; } = "backend-checks";
    public string ContentRootPath { get; set; } = "";
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
