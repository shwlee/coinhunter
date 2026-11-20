using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Contracts;

// One transport hop from the Node engine to the actual persistent Player host.
// Lifecycle/resource ownership and independent supervision stay with the parent.
internal sealed class DirectGameChannel : IDisposable
{
    private sealed record Command(int Version, Guid Id, string Method, Guid GameId, int PlayerId, Guid RunId, Guid ArtifactId, string Token, JsonElement Input);
    private readonly CSharpGameChannel binding;
    private readonly Guid generation;
    private readonly NamedPipeServerStream pipe;
    private readonly CancellationTokenSource stopping = new();
    private TaskCompletionSource<CandidateCall>? pending;
    private string? pendingId;
    private readonly object gate = new();
    public DirectGameChannel(CSharpGameChannel binding, Guid generation)
    {
        if(binding.PipeName.Length is <1 or >100 || binding.PipeName.Any(c=>!char.IsAsciiLetterOrDigit(c)&&c!='-') || binding.Token.Length!=64 || !binding.Token.All(Uri.IsHexDigit) || binding.GameId==Guid.Empty || binding.RunId==Guid.Empty || binding.ArtifactId==Guid.Empty || binding.PlayerId is <0 or >3)throw new InvalidDataException("Invalid direct binding.");
        this.binding=binding;this.generation=generation;
        pipe=new(binding.PipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
    }
    public void Complete(string? id,CandidateCall result)
    {
        TaskCompletionSource<CandidateCall>? completion;
        lock(gate){completion=id==pendingId?pending:null;}
        // The settled worker may encode/write an already-bounded response
        // inline, outside both the user budget and all state locks. Avoid an
        // extra thread-pool dispatch after every short algorithm call.
        completion?.TrySetResult(result);
    }
    public async Task Serve(int columns,int rows,Action<HostCommand> dispatch,Action stop)
    {
        try
        {
            await pipe.WaitForConnectionAsync(stopping.Token);
            long last=0;var ids=new HashSet<Guid>();var recentIds=new Queue<Guid>();
            while(!stopping.IsCancellationRequested)
            {
                var bytes=await Read();if(bytes is null)break;
                var before=Stopwatch.GetTimestamp();
                var command=JsonSerializer.Deserialize<Command>(bytes,Protocol.JsonOptions)??throw new InvalidDataException();
                if(command.Version!=1||command.Id==Guid.Empty||!ids.Add(command.Id)||command.Method!="move"||command.GameId!=binding.GameId||command.PlayerId!=binding.PlayerId||command.RunId!=binding.RunId||command.ArtifactId!=binding.ArtifactId||command.Token is null||command.Token.Length!=binding.Token.Length||!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(command.Token),Encoding.UTF8.GetBytes(binding.Token)))throw new InvalidDataException("Invalid direct command.");
                // Monotonic call IDs reject replays for the entire game. Keep
                // only a bounded UUID window instead of ending long games at
                // 10,000 calls or retaining an ever-growing request-id set.
                recentIds.Enqueue(command.Id);if(recentIds.Count>256)ids.Remove(recentIds.Dequeue());
                var input=command.Input;var call=input.GetProperty("callId").GetInt64();
                if(input.GetProperty("contractVersion").GetInt32()!=1||input.GetProperty("gameId").GetGuid()!=binding.GameId||input.GetProperty("playerId").GetInt32()!=binding.PlayerId||input.GetProperty("runId").GetGuid()!=binding.RunId||call!=last+1)throw new InvalidDataException("Invalid direct call binding.");
                var map=input.GetProperty("map").Deserialize<int[]>(Protocol.JsonOptions)!;var items=input.GetProperty("items").Deserialize<int[]>(Protocol.JsonOptions)!;var position=input.GetProperty("myPosition").GetInt32();
                if(map.Length!=columns*rows||position<0||position>=map.Length||items.Length!=4||items.Any(i=>i< -1||i>=map.Length))throw new InvalidDataException("Invalid direct snapshot.");
                var completion=new TaskCompletionSource<CandidateCall>();
                var id=command.Id.ToString("N");lock(gate){pending=completion;pendingId=id;}
                dispatch(new(id,map,position,items));
                var inputMs=Stopwatch.GetElapsedTime(before).TotalMilliseconds;
                var result=await completion.Task.WaitAsync(stopping.Token);last=call;
                lock(gate){pending=null;pendingId=null;}
                object response=result.Status is "exception" or "operation-limit" or "cancelled"
                    ? new{version=1,id=command.Id,ok=false,error=(object)new{status=result.Status,code=result.LimitCode??result.ErrorType,line=result.Line,column=result.Column}}
                    : new{version=1,id=command.Id,ok=true,result=(object)new{status=result.Status,direction=result.Value is int direction?direction:-1,instanceId=result.InstanceId,hostId=generation,executionMs=result.ElapsedMs,executionSettled=result.ExecutionSettled,inputPreparationMs=inputMs+result.InputPreparationMs,logs=result.Logs,droppedLogs=result.DroppedLogs,experimentalMemory=result.ExperimentalMemory}};
                var output=JsonSerializer.SerializeToUtf8Bytes(response,Protocol.JsonOptions);if(output.Length>262144)throw new IOException("Direct response limit.");
                var header=new byte[4];BinaryPrimitives.WriteInt32LittleEndian(header,output.Length);
                using var send=CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);send.CancelAfter(TimeSpan.FromSeconds(2));
                await pipe.WriteAsync(header,send.Token);await pipe.WriteAsync(output,send.Token);await pipe.FlushAsync(send.Token);
                if(result.Status is "exception" or "operation-limit" or "cancelled")break;
            }
        }
        catch(OperationCanceledException)when(stopping.IsCancellationRequested){}
        catch(IOException){}
        catch(JsonException){}
        catch(InvalidOperationException){}
        catch(KeyNotFoundException){}
        finally{stop();}
    }
    private async Task<byte[]?> Read()
    {
        var header=new byte[4];if(await pipe.ReadAsync(header.AsMemory(0,1),stopping.Token)==0)return null;
        await pipe.ReadExactlyAsync(header.AsMemory(1),stopping.Token);int size=BinaryPrimitives.ReadInt32LittleEndian(header);
        if(size is <1 or >1048576)throw new InvalidDataException("Direct frame limit.");
        var bytes=new byte[size];await pipe.ReadExactlyAsync(bytes,stopping.Token);return bytes;
    }
    public void Dispose(){stopping.Cancel();pipe.Dispose();}
}
