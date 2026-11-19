using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;

namespace CoinHunter.Execution.Host.Services;

// One game/player/run-bound private channel. Never exposed through an HTTP move API.
internal sealed class CSharpCandidatePlayer
{
    private sealed record Command(int Version, Guid Id, string Method, Guid GameId, int PlayerId, Guid RunId, Guid ArtifactId, string Token, JsonElement Input);
    private readonly ExecutionRequest game;
    private readonly ParticipantRequest player;
    private readonly CSharpArtifactLease lease;
    private readonly CSharpPreparationStore store;
    private readonly CSharpHostManager manager;
    private readonly CSharpPreparedLaunch launch;
    private readonly CancellationTokenSource stopping = new();
    private readonly NamedPipeServerStream pipe;
    private readonly Guid artifactId = Guid.NewGuid();
    private readonly string secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private readonly SemaphoreSlim writes = new(1);
    private readonly Task serving;
    private CSharpHostSession? session;
    private int busy;
    private long lastCall;
    private bool released;
    private bool cleanupUnknown;
    private readonly JsonObject artifact;
    public JsonObject Descriptor { get; }
    public CSharpCandidatePlayer(ExecutionRequest game, ParticipantRequest player, CSharpArtifactLease lease, CSharpPreparationStore store, CSharpHostManager manager, CSharpPreparedLaunch launch)
    {
        this.game = game; this.player = player; this.lease = lease; this.store = store; this.manager = manager; this.launch = launch;
        var name = "coinhunter-csharp-" + Guid.NewGuid().ToString("N");
        pipe = new(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var manifest = lease.Manifest;
        artifact = new JsonObject
        {
            ["contractVersion"] = 1,
            ["artifactId"] = artifactId.ToString(),
            ["language"] = "csharp",
            ["source"] = JsonSerializer.SerializeToNode(player.Source, Protocol.JsonOptions),
            ["content"] = new JsonObject { ["artifactKey"] = artifactId.ToString(), ["sha256"] = manifest.DllHash, ["byteLength"] = manifest.DllBytes },
            ["format"] = "dotnet-assembly",
            ["profileId"] = manifest.Toolchain.Profile,
            ["toolchain"] = new JsonObject { ["name"] = "roslyn", ["version"] = manifest.Toolchain.Key },
            ["runtime"] = new JsonObject { ["name"] = "dotnet-csharp-restricted", ["version"] = manifest.Toolchain.Runtime },
            ["adapterVersion"] = "csharp-pipe-v1",
            ["target"] = new JsonObject { ["os"] = OperatingSystem.IsWindows() ? "win32" : "linux", ["architecture"] = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() },
            ["optionsHash"] = manifest.Toolchain.Key
        };
        Descriptor = new JsonObject
        {
            ["gameId"] = game.MatchId.ToString(),
            ["playerId"] = player.PlayerId,
            ["runId"] = player.RunId.ToString(),
            ["artifact"] = artifact.DeepClone(),
            ["buildKey"] = manifest.Key,
            ["endpoint"] = OperatingSystem.IsWindows() ? @"\\.\pipe\" + name : Path.Combine(Path.GetTempPath(), "CoreFxPipe_" + name),
            ["token"] = secret
        };
        serving = Serve();
    }
    private async Task Serve()
    {
        var queue = Channel.CreateBounded<Command>(1); var ids = new HashSet<Guid>(); Command? close = null; Task worker = Task.CompletedTask; bool confirmed = false;
        try
        {
            await pipe.WaitForConnectionAsync(stopping.Token);
            worker = Task.Run(async () =>
            {
                try
                {
                    await foreach (var command in queue.Reader.ReadAllAsync(stopping.Token))
                    {
                        object result;
                        if (command.Method == "initialize")
                        {
                            if (session is not null || command.Input.GetProperty("playerNumber").GetInt32() != player.PlayerId || command.Input.GetProperty("columns").GetInt32() != game.Map.Columns || command.Input.GetProperty("rows").GetInt32() != game.Map.Rows) throw new InvalidDataException("Invalid initialization binding.");
                            session = await manager.CreatePreparedAsync(store, launch, stopping.Token); var identity = session.Identity!;
                            result = new { contractVersion = 1, gameId = game.MatchId, playerId = player.PlayerId, runId = player.RunId, instanceId = identity.InstanceId, hostId = identity.Generation, language = "csharp", name = session.Name, runtime = artifact["runtime"]!.DeepClone(), adapterVersion = "csharp-pipe-v1" };
                        }
                        else if (command.Method == "move")
                        {
                            if (session is null) throw new InvalidDataException("Not initialized.");
                            var input = command.Input; var call = input.GetProperty("callId").GetInt64();
                            if (call != lastCall + 1 || input.GetProperty("gameId").GetGuid() != game.MatchId || input.GetProperty("playerId").GetInt32() != player.PlayerId || input.GetProperty("runId").GetGuid() != player.RunId || input.GetProperty("contractVersion").GetInt32() != 1) throw new InvalidDataException("Invalid call binding.");
                            var map = input.GetProperty("map").Deserialize<int[]>(Protocol.JsonOptions)!; var items = input.GetProperty("items").Deserialize<int[]>(Protocol.JsonOptions)!;
                            if (map.Length != game.Map.Columns * game.Map.Rows) throw new InvalidDataException("Invalid map dimensions.");
                            var judgement = await session.MoveNextAsync(map, input.GetProperty("myPosition").GetInt32(), items, stopping.Token); lastCall = call;
                            if (judgement.Status is "operation-limit" or "exception" or "cancelled")
                            {
                                await Send(new { version = 1, id = command.Id, ok = false, error = new { status = judgement.Status } });
                                throw new IOException("Candidate host cannot be reused.");
                            }
                            result = new { status = judgement.Status, direction = judgement.Direction ?? -1, instanceId = judgement.InstanceId, hostId = judgement.Generation, executionMs = judgement.ElapsedMs, executionSettled = judgement.ExecutionSettled };
                        }
                        else throw new InvalidDataException("Unknown command.");
                        Interlocked.Exchange(ref busy, 0); await Send(new { version = 1, id = command.Id, ok = true, result });
                    }
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
                catch (CSharpHostFailure error) when (!error.CleanupConfirmed) { cleanupUnknown = true; stopping.Cancel(); throw; }
                catch { stopping.Cancel(); throw; }
            });
            while (!stopping.IsCancellationRequested)
            {
                var bytes = await Read(stopping.Token); if (bytes is null) break;
                var command = JsonSerializer.Deserialize<Command>(bytes, Protocol.JsonOptions) ?? throw new InvalidDataException("Missing bridge command.");
                if (command.Version != 1 || command.Id == Guid.Empty || ids.Count >= 10000 || !ids.Add(command.Id) || command.GameId != game.MatchId || command.PlayerId != player.PlayerId || command.RunId != player.RunId || command.ArtifactId != artifactId || command.Token is null || command.Token.Length != secret.Length || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(command.Token), System.Text.Encoding.UTF8.GetBytes(secret))) throw new InvalidDataException("Invalid private channel binding.");
                if (command.Method == "close") { close = command; break; }
                if (command.Method is not ("initialize" or "move") || Interlocked.CompareExchange(ref busy, 1, 0) != 0 || !queue.Writer.TryWrite(command)) throw new InvalidDataException("Overlapping command.");
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (IOException) { } // Disconnect/protocol failures still reclaim the actual host below.
        finally
        {
            stopping.Cancel(); queue.Writer.TryComplete(); try { await worker; } catch { }
            confirmed = !cleanupUnknown && (session is null || (await session.StopAsync("game-channel-closed")).CleanupConfirmed);
            if (confirmed)
            {
                if (close is not null) try { await Send(new { version = 1, id = close.Id, ok = true, result = new { contractVersion = 1, runId = player.RunId, resourcesReleased = true } }); } catch { }
                lease.Dispose(); released = true;
            }
            pipe.Dispose();
        }
        if (!confirmed) throw new IOException("C# game cleanup unconfirmed; artifact lease retained.");
    }
    private async Task<byte[]?> Read(CancellationToken token)
    {
        var length = new byte[4]; int first = await pipe.ReadAsync(length.AsMemory(0, 1), token); if (first == 0) return null;
        await pipe.ReadExactlyAsync(length.AsMemory(1), token); int size = BinaryPrimitives.ReadInt32LittleEndian(length); if (size is < 1 or > 1048576) throw new InvalidDataException("Bridge frame limit.");
        var bytes = new byte[size]; await pipe.ReadExactlyAsync(bytes, token); return bytes;
    }
    private async Task Send(object value)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2)); await writes.WaitAsync(deadline.Token);
        try { var bytes = JsonSerializer.SerializeToUtf8Bytes(value, Protocol.JsonOptions); var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length); await pipe.WriteAsync(header, deadline.Token); await pipe.WriteAsync(bytes, deadline.Token); await pipe.FlushAsync(deadline.Token); }
        finally { writes.Release(); }
    }
    public async Task Close()
    {
        stopping.Cancel(); try { await serving; } catch when (released) { }
        if (!released) throw new IOException("C# game resources/lease not released.");
    }
}
