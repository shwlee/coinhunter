using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading.Channels;
using System.Text;
using System.Text.Json.Serialization;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Contracts;

if(args.Length>0&&args[0]=="--prepare"){await PreparationMode.Run(args.Skip(1).ToArray());return;}
bool experimentalGc=args.Length>0&&args[0]=="--gc-window-probe";
if(experimentalGc)args=args.Skip(1).ToArray();
bool experimentalGcEntryCollection=experimentalGc&&args.Length>0&&args[0]=="--gc-entry-collection";
if(experimentalGcEntryCollection)args=args.Skip(1).ToArray();
bool direct=args.Length>0&&args[0]=="--game-channel";
if(direct)args=args.Skip(1).ToArray();
bool prepared=args.Length>0&&args[0]=="--artifact";
if(prepared)args=args.Skip(1).ToArray();

// C3 developer host: private parent-owned pipes and source path; no public listener.
if (args.Length is not (2 or 3 or 6)) throw new ArgumentException("source path and private control pipe required");
using var commandReader=new StreamReader(Console.OpenStandardInput(),Encoding.UTF8);
if (await commandReader.ReadLineAsync() != "authorize") throw new InvalidOperationException("Resource authorization required.");
var directBinding=direct?JsonSerializer.Deserialize<CSharpGameChannel>(await commandReader.ReadLineAsync()??throw new IOException("Missing direct binding.")):null;
var sourcePath = Path.GetFullPath(args[0]); var generation = Guid.NewGuid();
var jsonOptions = new JsonSerializerOptions { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
var probeStall = args.Length >= 3 ? int.Parse(args[2]) : 0;
if (probeStall is < -9 or > 2000) throw new ArgumentOutOfRangeException(nameof(probeStall));
int playerNumber=args.Length==6?int.Parse(args[3]):0, columns=args.Length==6?int.Parse(args[4]):3, rows=args.Length==6?int.Parse(args[5]):3;
if(playerNumber is <0 or >3||columns<=0||rows<=0)throw new ArgumentException("Invalid initialization.");
using var control = new NamedPipeServerStream(args[1], PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
await control.WaitForConnectionAsync();
var output = Channel.CreateBounded<object>(new BoundedChannelOptions(256) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
var writer = Task.Run(async () => { await foreach (var message in output.Reader.ReadAllAsync()) await Console.Out.WriteLineAsync(JsonSerializer.Serialize(message)); });
using var commands = new BlockingCollection<HostCommand>(1);
var stateGate = new object(); var active = (BudgetScope?)null; long activeCall = 0; string? activeRequest = null;
bool stopping = false, busy = true, ready = false; var requestIds = new HashSet<string>(StringComparer.Ordinal);
var stopAcknowledged = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); int controlStop = 0;
void Send(object value) { if (!output.Writer.TryWrite(value)) Environment.Exit(72); }
object Event(string kind, string? request = null, object? data = null) => new { kind, generation=probeStall==-3&&request is not null?Guid.NewGuid():generation, request, ticks = Stopwatch.GetTimestamp(), data };
void Stop()
{
    lock (stateGate) { stopping = true; active?.RequestStop(); commands.CompleteAdding(); }
}
var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using var directChannel=directBinding is null?null:new DirectGameChannel(directBinding,generation);
var worker = new Thread(() =>
{
    try
    {
        if(probeStall==-5)Thread.Sleep(Timeout.Infinite); // Preparation watchdog probe.
        using var candidate = prepared
            ? CSharpCandidate.LoadPrepared(JsonSerializer.Deserialize<CSharpArtifactManifest>(File.ReadAllText(sourcePath))!,File.ReadAllBytes(Path.Combine(Path.GetDirectoryName(sourcePath)!,"artifact.dll")))
            : CSharpCandidate.Prepare(File.ReadAllText(sourcePath));
        candidate.CallStarted = (call, scope) =>
        {
            lock (stateGate) { active = scope; activeCall = call; if (stopping) scope.RequestStop(); }
            Send(Event("execution-started", activeRequest, new { call, candidate.InstanceId, scope.StartedTicks, budgetMs = scope.Budget.TotalMilliseconds }));
            // Used to prove that control/deadline supervision does not depend on worker progress.
            if (activeRequest is not null && probeStall is not (0 or -2 or -3 or -4 or -5 or -6 or -7 or -8 or -9)) Thread.Sleep(probeStall == -1 ? Timeout.Infinite : probeStall);
            if(activeRequest is not null&&probeStall==-7)while(scope.ElapsedMs<499)Thread.SpinWait(20);
            if(activeRequest is not null&&probeStall is -8 or -9)
            {
                while(scope.ElapsedMs<501)Thread.SpinWait(20);
                if(probeStall==-8)throw new OperationLimitException("call-allocation-bytes");
                throw new IndexOutOfRangeException();
            }
        };
        void Publish(CandidateCall result, bool release = false)
        {
            string? request;
            lock (stateGate)
            {
                request = activeRequest; active = null;
                if (release) { busy = false; activeRequest = null; }
                Send(Event("execution-settled", request, result));
            }
            directChannel?.Complete(request,result);
        }
        var constructed = candidate.Construct(); Publish(constructed);
        if (constructed.Status != "ok") throw new InvalidOperationException("Construction failed.");
        var initialized = candidate.Initialize(playerNumber, columns, rows); Publish(initialized);
        if (initialized.Status != "ok") throw new InvalidOperationException("Initialization failed.");
        var name = candidate.GetName();
        if(probeStall==-6)name=name with{Value=null}; // Trusted malformed/old-host contract probe.
        Publish(name);
        if (name.Status != "ok") throw new InvalidOperationException("Name failed.");
        lock (stateGate) { ready = true; busy = false; }
        Send(Event("ready", data: new { candidate.InstanceId, pid = Environment.ProcessId, frequency = Stopwatch.Frequency, candidate.Analysis.SourceHash, candidate.Analysis.Profile, guardVersion=CSharpCandidate.GuardVersion,experimentalGc,experimentalGcEntryCollection }));
        foreach (var command in commands.GetConsumingEnumerable())
        {
            lock (stateGate) { if (stopping) { busy = false; break; } activeRequest = command.Id; }
            if (probeStall == -2) Thread.Sleep(Timeout.Infinite); // Missing start notification probe.
            CandidateCall result;
            if(experimentalGc)
            {
                var policy=CSharpGcWindowPolicy.Probe with{AllowEntryCollection=experimentalGcEntryCollection};
                var window=CSharpGcWindowCandidate.Run(candidate,()=>candidate.MoveNext(command.Map!,command.Position,command.Items!),policy);
                if(window.Status!="completed")throw new CSharpGcWindowFailure(window.Status){Entry=window.Entry};
                result=window.Call! with{ExperimentalMemory=new(window.Status,policy.TotalBytes,policy.WorkerAllocationBytes,window.WorkerAllocatedBytes,window.EntryMs,window.ExitMs,window.CollectionDeltas,window.RegionIntact){ProcessAllocationLimitBytes=policy.ProcessAllocationBytes,ProcessAllocatedBytes=window.ProcessAllocatedBytes,Entry=window.Entry}};
            }
            else result=candidate.MoveNext(command.Map!, command.Position, command.Items!);
            Publish(result, release: true);
        }
    }
    catch (Exception error) { Send(Event("host-failed", activeRequest, new { error = error.GetType().Name,memoryFailure=(error as CSharpGcWindowFailure)?.Status,entry=(error as CSharpGcWindowFailure)?.Entry })); }
    finally { Stop(); Send(Event("closed", data: new { executionSettled = true })); finished.TrySetResult(); }
}) { IsBackground = true, Name = "CSharp player worker" };
worker.Start();
void DispatchDirect(HostCommand command)
{
    lock(stateGate)
    {
        if(!ready||busy||stopping)throw new IOException("Host not ready for direct call.");
        Send(Event("execution-queued",command.Id));busy=true;commands.Add(command);
    }
}
var directServing=directChannel?.Serve(columns,rows,DispatchDirect,Stop);
var deadlineMonitor = Task.Run(async () =>
{
    long notified = -1;
    while (!finished.Task.IsCompleted)
    {
        lock (stateGate)
        {
            if (active is not null && !active.Completed && activeCall != notified && active.DeadlineReached())
            { notified = activeCall; Send(Event("deadline-reached", activeRequest, new { call = activeCall, active.StartedTicks, executionSettled = false })); }
        }
        await Task.Delay(1);
    }
});
var controlReader = new StreamReader(control, leaveOpen: true); var controlWriter = new StreamWriter(control, leaveOpen: true) { AutoFlush = true };
var controlTask = Task.Run(async () =>
{
    try
    {
        await foreach (var line in Frames.Read(controlReader, 64))
        {
            if (finished.Task.IsCompleted) break;
            if (line == "ping")
            {
                if(probeStall==-4)await Task.Delay(Timeout.Infinite); // Independent control watchdog probe.
                object status;
                lock (stateGate) status = new { kind = "pong", generation, ticks = Stopwatch.GetTimestamp(), frequency = Stopwatch.Frequency, busy, stopping, activeCall = active is null ? (long?)null : activeCall };
                await controlWriter.WriteLineAsync(JsonSerializer.Serialize(status));
            }
            else if (line == "stop")
            {
                Interlocked.Exchange(ref controlStop, 1);
                try { Stop(); await controlWriter.WriteLineAsync("{\"kind\":\"stop-requested\",\"executionSettled\":false}"); }
                finally { stopAcknowledged.TrySetResult(); }
                break;
            }
            else throw new InvalidOperationException("Unknown control command.");
        }
        Stop();
    }
    catch (Exception) { Stop(); }
});
var input = Task.Run(async () =>
{
    try
    {
        await foreach (var line in Frames.Read(commandReader, 1048576))
        {
            if(direct)throw new InvalidDataException("Game host stdin is lifecycle-only.");
            if (finished.Task.IsCompleted) break;
            var command = JsonSerializer.Deserialize<HostCommand>(line, jsonOptions) ?? throw new InvalidOperationException("Missing command.");
            lock (stateGate)
            {
                if (string.IsNullOrWhiteSpace(command.Id) || command.Id.Length > 64 || command.Map is null || command.Items?.Length != 4 || command.Map.Length == 0 || command.Position < 0 || command.Position >= command.Map.Length)
                    throw new InvalidOperationException("Invalid command.");
                if (!ready || busy || stopping || requestIds.Contains(command.Id)) { Send(Event("rejected", command.Id)); continue; }
                if (requestIds.Count >= 10000) throw new InvalidOperationException("Command lifetime limit.");
                requestIds.Add(command.Id); busy = true; commands.Add(command);
            }
        }
        Stop();
    }
    catch (Exception) { Stop(); }
});
await finished.Task;
directChannel?.Dispose();
if(directServing is not null)try{await directServing;}catch(ObjectDisposedException){}
if (Volatile.Read(ref controlStop) != 0) await stopAcknowledged.Task.WaitAsync(TimeSpan.FromSeconds(3));
await deadlineMonitor;
output.Writer.TryComplete(); await writer;
// Closing private pipe/stdin readers does not wait on a blocked worker. No claim
// that a stop acknowledgement settled it: only the worker can publish closed.
record HostCommand(string? Id, int[]? Map, int Position, int[]? Items);
static class Frames
{
    public static async IAsyncEnumerable<string> Read(TextReader reader, int max)
    {
        var buffer = new char[1024]; var frame = new StringBuilder();
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory())) != 0)
            for (var i=0;i<count;i++)
            {
                if (buffer[i]=='\n') { yield return frame.ToString().TrimEnd('\r'); frame.Clear(); }
                else { if(frame.Length==max) throw new IOException("Frame too large."); frame.Append(buffer[i]); }
            }
        if(frame.Length!=0) throw new IOException("Truncated frame.");
    }
}
