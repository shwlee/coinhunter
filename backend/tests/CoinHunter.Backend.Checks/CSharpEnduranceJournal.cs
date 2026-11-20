using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure.Storage;

internal sealed record EnduranceJournalSummary(Guid MatchId,long Bytes,long Events,long Results,long CSharpResults,long Observations,long Recoveries,long Timeouts,long UnscheduledTimeouts,long LateResults,long RuntimeFailures,double MaxEntryMs,double MaxExecutionMs,string Recording);

// Validate the complete event stream without retaining a long game's events in RAM.
internal static class CSharpEnduranceJournal
{
    internal static async Task<EnduranceJournalSummary> Validate(string executionRoot,ExecutionRecord game,CancellationToken token)
    {
        string recording=game.Result!["recording"]!.Text("status");
        string file=Path.Combine(executionRoot,"journals",game.Request.MatchId+(recording=="complete"?".jsonl":".partial.jsonl"));
        long events=0,results=0,csharp=0,observations=0,recoveries=0,timeouts=0,unscheduled=0,late=0,failures=0;
        double maxEntry=0,maxExecution=0;
        int count=game.Request.Participants.Length;
        var calls=new long[count];var instances=new string?[count];var counters=new int[count];var silent=new int[count];var observed=new long[count];
        await foreach(string line in Lines(file,token))
        {
            using var document=JsonDocument.Parse(line);var value=document.RootElement;
            if(value.GetProperty("schemaVersion").GetInt32()!=1)throw new InvalidDataException("Unsupported journal schema.");
            if(value.GetProperty("seq").GetInt64()!=++events)throw new InvalidDataException("Journal sequence gap.");
            string type=value.GetProperty("type").GetString()!;var payload=value.GetProperty("payload");
            if(type=="late-result")late++;
            if(type=="runtime-failure")failures++;
            if(type=="algorithm-result")
            {
                int player=payload.GetProperty("player").GetInt32();var result=payload.GetProperty("result");
                long call=result.GetProperty("callId").GetInt64();string instance=result.GetProperty("instanceId").GetString()!;
                if(result.GetProperty("gameId").GetGuid()!=game.Request.MatchId||result.GetProperty("playerId").GetInt32()!=player||result.GetProperty("runId").GetGuid()!=game.Request.Participants[player].RunId)throw new InvalidDataException("Result belongs to another game/player/run.");
                if(call!=calls[player]+1||instances[player] is {} old&&old!=instance)throw new InvalidDataException("Call sequence or instance changed.");
                calls[player]=call;instances[player]=instance;results++;
                string status=result.GetProperty("status").GetString()!;var logs=result.GetProperty("logs");
                double elapsed=result.GetProperty("timings").GetProperty("executionMs").GetDouble();maxExecution=Math.Max(maxExecution,elapsed);
                if(status=="timeout"){timeouts++;if(elapsed<500)throw new InvalidDataException("Premature timeout.");}
                else if(elapsed>500)throw new InvalidDataException("Late result was accepted.");
                if(game.Request.Participants[player].Language!="csharp")continue;
                csharp++;
                if(logs.GetArrayLength()==0&&status=="timeout"){silent[player]++;continue;}
                if(logs.GetArrayLength()!=1||!int.TryParse(logs[0].GetString(),NumberStyles.None,CultureInfo.InvariantCulture,out int turn)||turn<=counters[player]||turn>counters[player]+silent[player]+1)throw new InvalidDataException("Player field state was reset or replayed.");
                counters[player]=turn;silent[player]=0;
                if(status=="timeout"){if(turn%257!=6)unscheduled++;}
                else if(status!=(turn%509==4?"invalid-result":"ok")||result.GetProperty("direction").GetInt32()!=-1)throw new InvalidDataException("Unexpected judgement/direction.");
                if(turn%257==6&&status!="timeout")throw new InvalidDataException("Infinite call was not interrupted.");
            }
            if(type=="runtime-observation")
            {
                int player=payload.GetProperty("player").GetInt32();long call=payload.GetProperty("callId").GetInt64();
                if(call!=calls[player]||observed[player]>=call||payload.GetProperty("instanceId").GetString()!=instances[player]||payload.GetProperty("policy").GetString()!="csharp-gc-window-v2")throw new InvalidDataException("GC observation does not bind its result.");
                observed[player]=call;observations++;
                var memory=payload.GetProperty("memory").Deserialize<CSharpCallMemoryObservation>(Protocol.JsonOptions)!;
                if(!memory.RegionIntact||memory.CollectionDeltas is not [0,0,0]||memory.Entry?.Valid(true)!=true)throw new InvalidDataException("Invalid protected call.");
                maxEntry=Math.Max(maxEntry,memory.EntryMs);if(memory.Entry.Attempts==2)recoveries++;
            }
        }
        if(events!=game.Result!["recording"]!["durableThroughSeq"]!.GetValue<long>())throw new InvalidDataException("Durable recording count differs from journal.");
        if(recording=="complete")
        {
            if(csharp!=observations)throw new InvalidDataException("Complete journal lost GC observations.");
            var receipt=await AtomicFile.Read(Path.Combine(executionRoot,"journals",game.Request.MatchId+".result.json"),new());
            if(!JsonNode.DeepEquals(receipt["payload"],game.Result))throw new InvalidDataException("Final receipt/result disagree.");
        }
        return new(game.Request.MatchId,new FileInfo(file).Length,events,results,csharp,observations,recoveries,timeouts,unscheduled,late,failures,maxEntry,maxExecution,recording);
    }
    private static async IAsyncEnumerable<string> Lines(string file,[EnumeratorCancellation]CancellationToken token)
    {
        using var reader=new StreamReader(new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.SequentialScan),new UTF8Encoding(false,true));
        var chars=new char[65536];var line=new StringBuilder();int count;
        while((count=await reader.ReadAsync(chars.AsMemory(),token))>0)
        {
            int offset=0;
            while(offset<count)
            {
                int end=Array.IndexOf(chars,'\n',offset,count-offset);int length=(end<0?count:end)-offset;
                if(line.Length+length>Protocol.MaxFrameBytes)throw new InvalidDataException("Journal event exceeds bound.");
                line.Append(chars,offset,length);offset=end<0?count:end+1;
                if(end>=0){string value=line.ToString().TrimEnd('\r');line.Clear();yield return value;}
            }
        }
        if(line.Length!=0)throw new InvalidDataException("Journal has an unterminated event.");
    }
}
