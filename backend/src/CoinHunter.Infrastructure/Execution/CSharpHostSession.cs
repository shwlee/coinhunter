using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Resources;

namespace CoinHunter.Infrastructure.Execution;

public sealed class CSharpHostSession : IAsyncDisposable
{
    private readonly CSharpHostLaunch launch;
    private readonly Process process;
    private readonly int processId;
    private readonly IExecutionResourceGroup resources;
    private readonly NamedPipeClientStream control;
    private StreamReader? controlReader;
    private StreamWriter? controlWriter;
    private readonly SemaphoreSlim controlGate=new(1);
    private readonly object gate=new();
    private readonly CancellationTokenSource lifetime=new();
    private readonly CancellationTokenSource monitoring=new();
    private readonly TaskCompletionSource activated=new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<CSharpHostReady> ready=new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Action<CSharpHostSession> released;
    private Task dataTask=Task.CompletedTask, errorsTask=Task.CompletedTask, exitTask=Task.CompletedTask, heartbeatTask=Task.CompletedTask;
    private Task<CSharpHostClosure>? closing;
    private Guid? generation,instance;
    private long lastCall;
    private long? preparationCall;
    private bool nameVerified;
    public string? Name { get; private set; }
    private CSharpPreparationFault? preparationFault;
    private string state="preparing";
    private Pending? pending;
    private sealed class Pending
    {
        public Pending(string? id=null){Id=id??Guid.NewGuid().ToString("N");ObserveFault(Started.Task);ObserveFault(Settled.Task);}
        public string Id { get; }
        public TaskCompletionSource Started { get; }=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<CSharpParentCall> Settled { get; }=new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long? Call;
        public long StartedTicks;
        public long ReceivedTicks;
    }
    public string State { get { lock(gate)return state; } }
    public CSharpHostReady? Identity { get; private set; }
    public CSharpHostClosure? Closure { get; private set; }
    public CoinHunter.Contracts.CSharpGcEntryObservation? FailedGcEntry { get; private set; }
    private readonly TaskCompletionSource<string> termination=new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task<string> Termination=>termination.Task;
    public int ProcessId=>processId;
    private static void ObserveFault(Task task)=>_ = task.ContinueWith(t=>{_ = t.Exception;},CancellationToken.None,TaskContinuationOptions.OnlyOnFaulted|TaskContinuationOptions.ExecuteSynchronously,TaskScheduler.Default);
    internal CSharpHostSession(CSharpHostLaunch launch,ExecutionResources ledger,Action<CSharpHostSession> released)
    {
        launch.Watchdogs.Validate();launch.Resources.Validate();
        if(!Path.IsPathFullyQualified(launch.HostAssembly)||!File.Exists(launch.HostAssembly)||!Path.IsPathFullyQualified(launch.SourcePath)||!File.Exists(launch.SourcePath)||
            launch.SourceHash.Length!=64||!launch.SourceHash.All(Uri.IsHexDigit)||launch.PlayerNumber is <0 or >3||launch.Columns<=0||launch.Rows<=0)
            throw new ArgumentException("Trusted host/source paths, SHA-256 and initialization values required.");
        this.launch=launch;this.released=released;
        if(launch.ExperimentalGcEntryCollection&&!launch.ExperimentalGcWindow)throw new ArgumentException("Entry collection requires the experimental GC policy.");
        if(launch.ExperimentalGcWindow)
        {
            CSharpGcGameAdmission.ValidateMember(launch.Resources);
            if(launch.ParentResources is not null)(launch.ExperimentalGcAdmission??throw new ArgumentException("Whole-game GC admission is required.")).Claim(launch.ParentResources,launch.Resources);
            else if(launch.ExperimentalGcAdmission is not null)throw new ArgumentException("GC admission requires its parent scope.");
        }
        else if(launch.ExperimentalGcAdmission is not null)throw new ArgumentException("GC admission supplied without the experimental GC policy.");
        ObserveFault(ready.Task);
        var pipe="coinhunter-managed-"+Guid.NewGuid().ToString("N");
        control=new NamedPipeClientStream(".",pipe,PipeDirection.InOut,PipeOptions.Asynchronous);
        var info=new ProcessStartInfo("dotnet"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        RestrictEnvironment(info);
        info.ArgumentList.Add(launch.HostAssembly);
        if(launch.ExperimentalGcWindow)info.ArgumentList.Add("--gc-window-probe");
        if(launch.ExperimentalGcEntryCollection)info.ArgumentList.Add("--gc-entry-collection");
        if(launch.GameChannel is not null)info.ArgumentList.Add("--game-channel");
        if(launch.PreparedArtifact)info.ArgumentList.Add("--artifact");
        foreach(var arg in new[]{launch.SourcePath,pipe,launch.ProbeStall.ToString(System.Globalization.CultureInfo.InvariantCulture),launch.PlayerNumber.ToString(),launch.Columns.ToString(),launch.Rows.ToString()})info.ArgumentList.Add(arg);
        resources=launch.ParentResources?.CreateChild(launch.Resources)??ledger.Reserve(launch.Resources);process=new Process{StartInfo=info};
        try { if(!process.Start())throw new IOException("Host start failed.");processId=process.Id;resources.Assign(process); }
        catch
        {
            try{if(!process.HasExited){process.Kill(true);process.WaitForExit(10000);}}catch(InvalidOperationException){}
            resources.Dispose();control.Dispose();process.Dispose();throw;
        }
    }
    public static void RestrictEnvironment(ProcessStartInfo info)
    {
        var allowed=new HashSet<string>(StringComparer.OrdinalIgnoreCase){"PATH","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","DOTNET_ROOT","DOTNET_ROOT_X64","DOTNET_CLI_HOME","DOTNET_CLI_TELEMETRY_OPTOUT","DOTNET_NOLOGO"};
        foreach(var key in info.Environment.Keys.ToArray())if(!allowed.Contains(key))info.Environment.Remove(key);
    }
    internal async Task ActivateAsync(CancellationToken token)
    {
        dataTask=Task.Run(ReadDataAsync);errorsTask=Task.Run(DiscardErrors);exitTask=Task.Run(ObserveExit);
        activated.TrySetResult();
        using var cancellation=token.Register(()=>{_ = StopAsync("caller-cancelled");});
        try
        {
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token,token);timeout.CancelAfter(launch.Watchdogs.Preparation);
            await process.StandardInput.WriteLineAsync("authorize".AsMemory(),timeout.Token);
            if(launch.GameChannel is not null)await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(launch.GameChannel).AsMemory(),timeout.Token);
            await control.ConnectAsync(timeout.Token);
            controlReader=new StreamReader(control,leaveOpen:true);controlWriter=new StreamWriter(control,leaveOpen:true){AutoFlush=true};
            Identity=await ready.Task.WaitAsync(timeout.Token);
            lock(gate)
            {
                if(closing is not null)throw new IOException("Host closed during preparation.");
                state="ready";heartbeatTask=Task.Run(Heartbeat);
            }
        }
        catch
        {
            var closed=await CloseAsync(token.IsCancellationRequested?"caller-cancelled":"preparation-failed",true);
            if(!closed.CleanupConfirmed)throw new CSharpHostFailure(closed.Reason,false,preparationFault);
            token.ThrowIfCancellationRequested();throw new CSharpHostFailure(closed.Reason,closed.CleanupConfirmed,preparationFault);
        }
    }
    public async Task<CSharpParentCall> MoveNextAsync(int[] map,int position,int[] items,CancellationToken token=default)
    {
        if(launch.GameChannel is not null)throw new InvalidOperationException("Game calls use the direct host channel.");
        token.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(map);ArgumentNullException.ThrowIfNull(items);
        if(map.Length==0||position<0||position>=map.Length||items.Length!=4)throw new ArgumentException("Invalid judgement snapshot.");
        // Even single-digit values require almost two bytes per element. Reject
        // definite overflow before cloning; the bounded writer handles the rest.
        if(map.Length>1048576/2)throw new ArgumentException("Judgement frame too large.",nameof(map));
        Pending call;
        string json;
        lock(gate)
        {
            if(state!="ready"||closing is not null)throw new InvalidOperationException("Host is not ready for another call.");
            call=new Pending();
            var snapshot=(int[])map.Clone();var itemSnapshot=(int[])items.Clone();
            using(var frame=new JudgementFrame())
            {
                using(var writer=new Utf8JsonWriter(frame))JsonSerializer.Serialize(writer,new{Id=call.Id,Map=snapshot,Position=position,Items=itemSnapshot});
                json=frame.GetText();
            }
            token.ThrowIfCancellationRequested();
            pending=call;state="computing";
        }
        using var cancellation=token.Register(()=>{_ = StopAsync("caller-cancelled");});
        try
        {
            using(var dispatch=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                dispatch.CancelAfter(launch.Watchdogs.StartNotification);
                await process.StandardInput.WriteLineAsync(json.AsMemory(),dispatch.Token);
                await call.Started.Task.WaitAsync(dispatch.Token);
            }
            var result=await call.Settled.Task.WaitAsync(launch.Watchdogs.UnsettledExecution);
            if(token.IsCancellationRequested){var stopped=await StopAsync("caller-cancelled");if(!stopped.CleanupConfirmed)throw new CSharpHostFailure(stopped.Reason,false);token.ThrowIfCancellationRequested();}
            return result;
        }
        catch(Exception error)
        {
            if(error is CSharpHostFailure failure){if(token.IsCancellationRequested&&failure.CleanupConfirmed)token.ThrowIfCancellationRequested();throw;}
            string reason=token.IsCancellationRequested?"caller-cancelled":!call.Started.Task.IsCompletedSuccessfully?"start-notification-missing":"execution-unsettled";
            var closed=await CloseAsync(reason,true);
            if(!closed.CleanupConfirmed)throw new CSharpHostFailure(closed.Reason,false);
            token.ThrowIfCancellationRequested();throw new CSharpHostFailure(closed.Reason,closed.CleanupConfirmed);
        }
    }
    private async Task ReadDataAsync()
    {
        try
        {
            await foreach(var text in ReadFrames(process.StandardOutput,262144,lifetime.Token))
            {
                var value=JsonNode.Parse(text,documentOptions:new JsonDocumentOptions{MaxDepth=16})!.AsObject();
                Accept(value);
            }
            lock(gate){if(closing is not null)return;}
            _=CloseAsync("data-disconnected",true);
        }
        catch(OperationCanceledException)when(lifetime.IsCancellationRequested){}
        catch{_=CloseAsync("protocol-failure",true);}
    }
    private void Accept(JsonObject message)
    {
        lock(gate)
        {
            var gen=Guid.Parse(message["generation"]!.GetValue<string>());
            if(gen==Guid.Empty)throw new IOException("Empty generation.");
            if(generation is { } old&&gen!=old)throw new IOException("Generation mismatch.");
            generation=gen;
            var data=message["data"];
            var request=(string?)message["request"];
            var kind=message["kind"]!.GetValue<string>();
            var ticks=message["ticks"]!.GetValue<long>();if(ticks<=0)throw new IOException("Invalid clock.");
            if(kind=="execution-queued")
            {
                if(launch.GameChannel is null||!ready.Task.IsCompletedSuccessfully||state!="ready"||pending is not null||request is null||request.Length!=32||!Guid.TryParseExact(request,"N",out _))throw new IOException("Invalid direct dispatch.");
                var queued=new Pending(request);pending=queued;state="computing";
                _=SuperviseDirect(queued);
                return;
            }
            if(kind=="ready")
            {
                if(ready.Task.IsCompleted||request is not null)throw new IOException("Duplicate readiness.");
                var identity=Guid.Parse(data!["InstanceId"]!.GetValue<string>());
                if(instance!=identity||preparationCall is not null||lastCall!=3||!nameVerified||data["pid"]!.GetValue<int>()!=process.Id||data["frequency"]!.GetValue<long>()<=0||
                    ((bool?)data["experimentalGc"]??false)!=launch.ExperimentalGcWindow||
                    ((bool?)data["experimentalGcEntryCollection"]??false)!=launch.ExperimentalGcEntryCollection||
                    !string.Equals((string?)data["SourceHash"],launch.SourceHash,StringComparison.OrdinalIgnoreCase)||
                    (string?)data["Profile"]!="csharp-restricted-c1-v4"||(string?)data["guardVersion"]!="c2-poll-bounded-v4")throw new IOException("Readiness identity/profile mismatch.");
                ready.TrySetResult(new(gen,identity,process.Id,data["frequency"]!.GetValue<long>(),(string)data["SourceHash"]!, (string)data["Profile"]!, (string)data["guardVersion"]!));return;
            }
            if(kind is "host-failed" or "rejected")
            {
                string? memoryFailure=(string?)data?["memoryFailure"];
                var reason=launch.ExperimentalGcWindow&&memoryFailure is ("gc-reservation-unavailable" or "gc-state-conflict" or "gc-window-lost" or "gc-call-environment-failure" or "gc-host-allocation-budget")?memoryFailure:kind;
                if(reason==memoryFailure)
                {
                    FailedGcEntry=data?["entry"]?.Deserialize<CoinHunter.Contracts.CSharpGcEntryObservation>();
                    if(FailedGcEntry?.Valid(launch.ExperimentalGcEntryCollection,true)!=true)throw new IOException("Invalid GC entry failure observation.");
                }
                _=CloseAsync(reason,true);return;
            }
            if(kind=="closed"){if(closing is null)_=CloseAsync("unexpected-host-close",true);return;}
            if(kind is not ("execution-started" or "deadline-reached" or "execution-settled"))throw new IOException("Unknown host event.");
            if(request is null)
            {
                if(ready.Task.IsCompleted)throw new IOException("Unbound event after preparation.");
                if(kind=="execution-started")
                {
                    var identity=Guid.Parse(data!["InstanceId"]!.GetValue<string>());var id=data["call"]!.GetValue<long>();
                    if(identity==Guid.Empty||instance is { } prior&&prior!=identity||preparationCall is not null||id!=lastCall+1||data["budgetMs"]!.GetValue<double>()!=500)throw new IOException("Invalid preparation call.");
                    instance=identity;preparationCall=id;
                }
                else if(kind=="execution-settled")
                {
                    var id=data!["CallId"]!.GetValue<long>();
                    if(preparationCall!=id||Guid.Parse(data["InstanceId"]!.GetValue<string>())!=instance||data["ProcessId"]!.GetValue<int>()!=process.Id||!data["ExecutionSettled"]!.GetValue<bool>())throw new IOException("Invalid preparation settlement.");
                    lastCall=id;preparationCall=null;
                    if((string?)data["Status"]!="ok")
                        preparationFault=new(id==1?"construct":id==2?"initialize":"getName",(string)data["Status"]!,data["ElapsedMs"]!.GetValue<double>(),data["BudgetMs"]!.GetValue<double>(),(string?)data["DiagnosticCode"],(int?)data["Line"],(int?)data["Column"]);
                    if(id==3)
                    {
                        if((string?)data["Status"]=="ok")
                        {
                            nameVerified=data["Value"] is JsonValue named && named.TryGetValue<string>(out var name) && name is not null && name.Length<=40;
                            if(nameVerified)Name=data["Value"]!.GetValue<string>();
                            if(!nameVerified){preparationFault=new("getName","invalid-result",data["ElapsedMs"]!.GetValue<double>(),500,"AR013",null,null);_=CloseAsync("invalid-name",true);}
                        }
                        else if((string?)data["Status"]=="invalid-result" && (string?)data["DiagnosticCode"]=="AR013")_=CloseAsync("invalid-name",true);
                    }
                }
                return;
            }
            if(pending is null||pending.Id!=request)throw new IOException("Request mismatch.");
            if(kind=="execution-started")
            {
                if(pending.Call is not null||Guid.Parse(data!["InstanceId"]!.GetValue<string>())!=instance||data["budgetMs"]!.GetValue<double>()!=500)throw new IOException("Invalid start.");
                var id=data["call"]!.GetValue<long>();if(id<=lastCall)throw new IOException("Call sequence mismatch.");
                pending.Call=id;pending.StartedTicks=data["StartedTicks"]!.GetValue<long>();pending.ReceivedTicks=Stopwatch.GetTimestamp();
                if(pending.StartedTicks<=0||pending.StartedTicks>ticks)throw new IOException("Start clock mismatch.");
                pending.Started.TrySetResult();return;
            }
            if(kind=="deadline-reached")
            {
                if(pending.Call!=data!["call"]!.GetValue<long>()||data["StartedTicks"]!.GetValue<long>()!=pending.StartedTicks||data["executionSettled"]!.GetValue<bool>())throw new IOException("Invalid deadline.");
                // Keep busy until actual settlement or independent parent cleanup.
                return;
            }
            var call=data!["CallId"]!.GetValue<long>();
            var identityId=Guid.Parse(data["InstanceId"]!.GetValue<string>());
            var elapsed=data["ElapsedMs"]!.GetValue<double>();var expired=data["DeadlineReached"]!.GetValue<bool>();var status=data["Status"]!.GetValue<string>();
            if(pending.Call!=call||identityId!=instance||data["ProcessId"]!.GetValue<int>()!=process.Id||!data["ExecutionSettled"]!.GetValue<bool>()||
                data["BudgetMs"]!.GetValue<double>()!=500||!double.IsFinite(elapsed)||elapsed<0||ticks<pending.StartedTicks||expired!=(elapsed>=500)||
                status is not ("ok" or "timeout" or "cancelled" or "exception" or "invalid-result" or "operation-limit")||status=="timeout"&&!expired||status=="ok"&&expired)throw new IOException("Invalid settlement.");
            var direction=(int?)data["Value"];
            if(status=="ok"&&(direction is null or <-1 or >3)||status!="ok"&&direction is not null)throw new IOException("Invalid direction.");
            var memory=data["ExperimentalMemory"]?.Deserialize<CoinHunter.Contracts.CSharpCallMemoryObservation>();
            if(launch.ExperimentalGcWindow)
            {
                if(memory?.Entry?.Valid(launch.ExperimentalGcEntryCollection)!=true)throw new IOException("Invalid GC entry observation.");
                if(memory is null||memory.Status!="completed"||!memory.RegionIntact||memory.RequestedReservationBytes!=256L*1024*1024||memory.WorkerAllocationLimitBytes!=32L*1024*1024||memory.WorkerAllocatedBytes<0||memory.ProcessAllocationLimitBytes!=64L*1024*1024||memory.ProcessAllocatedBytes<0||!double.IsFinite(memory.EntryMs)||memory.EntryMs<0||!double.IsFinite(memory.ExitMs)||memory.ExitMs<0||memory.CollectionDeltas is not [0,0,0])throw new IOException("Invalid experimental memory window.");
            }
            else if(memory is not null)throw new IOException("Unexpected memory policy.");
            var result=new CSharpParentCall(gen,identityId,call,process.Id,status,direction,expired,true,500,elapsed,(string?)data["LimitCode"],(int?)data["Line"],(int?)data["Column"]){ExperimentalMemory=memory};
            var completed=pending;pending=null;lastCall=call;if(closing is null)state=status is "exception" or "operation-limit"?"failed":"ready";
            completed.Settled.TrySetResult(result);
            // In direct mode the host first writes the typed failure to Node,
            // then stops. Killing it on this one-way observer event could race
            // that response and erase the actual user diagnostic.
            if(launch.GameChannel is null && status is ("exception" or "operation-limit"))_=CloseAsync("candidate-failed",false);
        }
    }
    private async Task SuperviseDirect(Pending call)
    {
        try
        {
            await call.Started.Task.WaitAsync(launch.Watchdogs.StartNotification,lifetime.Token);
            await call.Settled.Task.WaitAsync(launch.Watchdogs.UnsettledExecution,lifetime.Token);
        }
        catch(OperationCanceledException)when(lifetime.IsCancellationRequested){}
        catch{await CloseAsync(call.Started.Task.IsCompletedSuccessfully?"execution-unsettled":"start-notification-missing",true);}
    }
    private async Task Heartbeat()
    {
        try
        {
            while(true)
            {
                await Task.Delay(launch.Watchdogs.HeartbeatInterval,monitoring.Token);
                var pong=await ControlAsync("ping");
                if((string?)pong["kind"]!="pong"||Guid.Parse(pong["generation"]!.GetValue<string>())!=Identity!.Generation||pong["frequency"]!.GetValue<long>()!=Identity.Frequency)throw new IOException("Control identity mismatch.");
            }
        }
        catch(OperationCanceledException)when(monitoring.IsCancellationRequested){}
        catch{_=CloseAsync("control-unresponsive",true);}
    }
    private async Task<JsonObject> ControlAsync(string command)
    {
        using var timeout=new CancellationTokenSource(launch.Watchdogs.HeartbeatResponse);
        await controlGate.WaitAsync(timeout.Token);
        try
        {
            await controlWriter!.WriteLineAsync(command.AsMemory(),timeout.Token);
            // One bounded frame per serialized control request; timeout poisons the session.
            await foreach(var line in ReadFrames(controlReader!,4096,timeout.Token))return JsonNode.Parse(line)!.AsObject();
            throw new IOException("Control disconnected.");
        }
        finally{controlGate.Release();}
    }
    private async Task ObserveExit()
    {
        await process.WaitForExitAsync();
        lock(gate){if(closing is not null)return;}
        // A process can exit after flushing a typed host-failed frame but before
        // the reader has dispatched it. Give the bounded reader a chance to
        // preserve that authoritative reason instead of racing it with exit.
        try{await dataTask.WaitAsync(launch.Watchdogs.StartNotification);}catch(TimeoutException){}
        lock(gate){if(closing is not null)return;}
        _=CloseAsync("process-exited",true);
    }
    private async Task DiscardErrors()
    {var buffer=new char[1024];try{while(await process.StandardError.ReadAsync(buffer.AsMemory(),lifetime.Token)!=0){}}catch(OperationCanceledException)when(lifetime.IsCancellationRequested){}}
    public Task<CSharpHostClosure> StopAsync(string reason="stopped")=>CloseAsync(reason,false);
    private Task<CSharpHostClosure> CloseAsync(string reason,bool force)
    {
        lock(gate)
        {
            if(closing is not null)return closing;
            state="closing";termination.TrySetResult(reason);closing=Task.Run(()=>CloseCore(reason,force));return closing;
        }
    }
    private async Task<CSharpHostClosure> CloseCore(string reason,bool forced)
    {
        await activated.Task;monitoring.Cancel();
        bool confirmed=false;
        try
        {
            if(!forced&&!process.HasExited)
            {
                try
                {
                    var ack=await ControlAsync("stop");if((string?)ack["kind"]!="stop-requested"||(bool?)ack["executionSettled"]!=false)throw new IOException("Stop not acknowledged.");
                    await process.WaitForExitAsync().WaitAsync(launch.Watchdogs.StopGrace);
                }
                catch{forced=true;reason="stop-unsettled";}
            }
            using var deadline=new CancellationTokenSource(launch.Watchdogs.Cleanup);
            await resources.TerminateAndDrain(deadline.Token);await process.WaitForExitAsync(deadline.Token);resources.Dispose();confirmed=true;
        }
        catch{reason="cleanup-unconfirmed";}
        if(confirmed)
        {
            lifetime.Cancel();control.Dispose();
            try{await Task.WhenAll(dataTask,errorsTask,exitTask,heartbeatTask).WaitAsync(launch.Watchdogs.Cleanup);}catch{}
        }
        var failure=new CSharpHostFailure(reason,confirmed,preparationFault);
        lock(gate)
        {
            state=confirmed?"closed":"cleanup-unconfirmed";
            ready.TrySetException(failure);pending?.Started.TrySetException(failure);pending?.Settled.TrySetException(failure);pending=null;
        }
        var closure=new CSharpHostClosure(reason,forced,confirmed);Closure=closure;
        if(confirmed){process.Dispose();released(this);}
        return closure;
    }
    public async ValueTask DisposeAsync()
    {var closed=await StopAsync();if(!closed.CleanupConfirmed)throw new CSharpHostFailure(closed.Reason,false);}
    private sealed class JudgementFrame : Stream
    {
        private readonly MemoryStream bytes=new();
        public string GetText()=>Encoding.UTF8.GetString(bytes.GetBuffer(),0,(int)bytes.Length);
        public override void Write(ReadOnlySpan<byte> buffer)
        {if(bytes.Length+buffer.Length>1048576)throw new ArgumentException("Judgement frame too large.","map");bytes.Write(buffer);}
        public override void Write(byte[] buffer,int offset,int count)=>Write(buffer.AsSpan(offset,count));
        public override bool CanRead=>false;public override bool CanSeek=>false;public override bool CanWrite=>true;
        public override long Length=>bytes.Length;public override long Position{get=>bytes.Position;set=>throw new NotSupportedException();}
        public override void Flush(){}public override int Read(byte[] buffer,int offset,int count)=>throw new NotSupportedException();
        public override long Seek(long offset,SeekOrigin origin)=>throw new NotSupportedException();public override void SetLength(long value)=>throw new NotSupportedException();
        protected override void Dispose(bool disposing){if(disposing)bytes.Dispose();base.Dispose(disposing);}
    }
    private static async IAsyncEnumerable<string> ReadFrames(TextReader reader,int limit,[System.Runtime.CompilerServices.EnumeratorCancellation]CancellationToken token)
    {
        var buffer=new char[1024];var frame=new StringBuilder();int count;
        while((count=await reader.ReadAsync(buffer.AsMemory(),token))!=0)
            for(int i=0;i<count;i++)
                if(buffer[i]=='\n'){yield return frame.ToString().TrimEnd('\r');frame.Clear();}
                else{if(frame.Length>=limit)throw new IOException("Frame too large.");frame.Append(buffer[i]);}
        if(frame.Length!=0)throw new IOException("Truncated frame.");
    }
}
