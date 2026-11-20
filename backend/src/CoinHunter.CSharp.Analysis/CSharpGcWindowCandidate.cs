using System.Diagnostics;
using System.Runtime;
using CoinHunter.Contracts;

namespace CoinHunter.CSharp.Analysis;

internal sealed record CSharpGcWindowPolicy(long TotalBytes,long LargeObjectBytes,long WorkerAllocationBytes)
{
    internal long ProcessAllocationBytes=>Math.Min(64L*1024*1024,Math.Min(LargeObjectBytes,TotalBytes-LargeObjectBytes)-16L*1024*1024);
    internal static CSharpGcWindowPolicy Probe { get; }=new(256L*1024*1024,128L*1024*1024,32L*1024*1024);
    internal bool AllowEntryCollection { get; init; }
    internal void Validate()
    {
        // Keep at least one maximum array operation plus host/runtime margin in
        // both heaps. This is a probe bound, not proof for all implicit allocs.
        const long margin=16L*1024*1024;
        if(TotalBytes<=0||TotalBytes>512L*1024*1024||LargeObjectBytes<=0||LargeObjectBytes>=TotalBytes||WorkerAllocationBytes<=0||WorkerAllocationBytes>TotalBytes||LargeObjectBytes<WorkerAllocationBytes+margin||TotalBytes-LargeObjectBytes<WorkerAllocationBytes+margin||WorkerAllocationBytes>ProcessAllocationBytes-margin)throw new ArgumentException("Invalid experimental GC reservation.");
    }
}
internal sealed record CSharpGcWindowResult(string Status,bool Invoked,CandidateCall? Call,double EntryMs,double ExitMs,double RoundTripMs,long WorkerAllocatedBytes,int[] CollectionDeltas,bool RegionIntact,string? FailureType)
{ public long ProcessAllocatedBytes { get; init; } public CSharpGcEntryObservation? Entry { get; init; } }
internal sealed class CSharpGcWindowFailure(string status):Exception("Experimental GC environment unavailable.")
{ internal string Status { get; }=status; internal CSharpGcEntryObservation? Entry { get; init; } }

// Only the explicit opt-in candidate host calls this; default game/preflight do not.
// The process must own one Player; NoGCRegion is process-wide, not per thread.
internal static class CSharpGcWindowCandidate
{
    internal static CSharpGcWindowResult Run(CSharpCandidate candidate,Func<CandidateCall> action,CSharpGcWindowPolicy policy,Func<long,long,bool,bool>? startProbe=null,Action? endProbe=null)
    {
        policy.Validate();var clock=Stopwatch.StartNew();double entry=0,exit=0;CandidateCall? call=null;bool invoked=false,started=false,intact=false;string? failure=null;string status="gc-reservation-unavailable";
        long beforeAllocation=0,allocated=0,beforeProcessAllocation=0,processAllocated=0;var before=new int[3];var deltas=new int[3];
        var originalLimit=candidate.ExperimentalAllocationBudgetBytes;
        var originalProcessLimit=candidate.ExperimentalProcessAllocationBudgetBytes;
        int attempts=0;int[] entryBefore=[GC.CollectionCount(0),GC.CollectionCount(1),GC.CollectionCount(2)];
        var entryDeltas=new int[3];CSharpGcHeapSnapshot? heapBefore=null,heapAfter=null;
        try
        {
            // Reserve before invoking guest code. An explicit alternative may
            // request one recovery on entry; its cost remains in entry/roundtrip
            // and real game progress, never in an artificial time correction.
            if(GCSettings.LatencyMode==GCLatencyMode.NoGCRegion){status="gc-state-conflict";return Finish();}
            attempts=1;
            started=(startProbe??GC.TryStartNoGCRegion)(policy.TotalBytes,policy.LargeObjectBytes,true);
            if(!started&&policy.AllowEntryCollection)
            {
                if(GCSettings.LatencyMode==GCLatencyMode.NoGCRegion){status="gc-state-conflict";return Finish();}
                heapBefore=Snapshot();attempts=2;
                // An ordinary full collection can leave committed empty regions
                // at the GC hard limit. Explicitly request compaction/decommit
                // once, outside guest execution; never retry the guest call.
                GC.Collect(GC.MaxGeneration,GCCollectionMode.Aggressive,blocking:true,compacting:true);
                started=(startProbe??GC.TryStartNoGCRegion)(policy.TotalBytes,policy.LargeObjectBytes,true);
                heapAfter=Snapshot();
            }
            entry=clock.Elapsed.TotalMilliseconds;
            for(int i=0;i<3;i++)entryDeltas[i]=GC.CollectionCount(i)-entryBefore[i];
            if(!started)return Finish();
            for(int i=0;i<3;i++)before[i]=GC.CollectionCount(i);
            beforeAllocation=GC.GetAllocatedBytesForCurrentThread();beforeProcessAllocation=GC.GetTotalAllocatedBytes(precise:true);
            candidate.ExperimentalAllocationBudgetBytes=policy.WorkerAllocationBytes;candidate.ExperimentalProcessAllocationBudgetBytes=policy.ProcessAllocationBytes;
            invoked=true;call=action();allocated=Math.Max(0,GC.GetAllocatedBytesForCurrentThread()-beforeAllocation);
            status="completed";
        }
        catch(CSharpGcWindowFailure error){if(!invoked)entry=clock.Elapsed.TotalMilliseconds;failure=error.GetType().Name;status=error.Status;}
        catch(Exception error){if(!invoked)entry=clock.Elapsed.TotalMilliseconds;failure=error.GetType().Name;status="gc-call-environment-failure";}
        finally
        {
            candidate.ExperimentalAllocationBudgetBytes=originalLimit;
            candidate.ExperimentalProcessAllocationBudgetBytes=originalProcessLimit;
            if(started)
            {
                if(invoked)
                {
                    allocated=Math.Max(0,GC.GetAllocatedBytesForCurrentThread()-beforeAllocation);processAllocated=Math.Max(0,GC.GetTotalAllocatedBytes(precise:true)-beforeProcessAllocation);
                    if(status=="completed"&&processAllocated>policy.ProcessAllocationBytes)status="gc-host-allocation-budget";
                }
                var exiting=Stopwatch.GetTimestamp();
                for(int i=0;i<3;i++)deltas[i]=GC.CollectionCount(i)-before[i];
                try
                {
                    intact=GCSettings.LatencyMode==GCLatencyMode.NoGCRegion&&deltas.All(n=>n==0);
                    // A successful start can still be followed by auto-exit.
                    // End only a region that is currently active.
                    if(intact)(endProbe??GC.EndNoGCRegion)();
                    else intact=false;
                }
                catch(Exception error){failure=error.GetType().Name;intact=false;}
                exit=Stopwatch.GetElapsedTime(exiting).TotalMilliseconds;
                if(!intact)status="gc-window-lost";
            }
            if(status!="completed")candidate.InvalidateAfterEnvironmentFailure();
        }
        return Finish();

        CSharpGcWindowResult Finish()=>new(status,invoked,call,entry,exit,clock.Elapsed.TotalMilliseconds,allocated,deltas,intact,failure){ProcessAllocatedBytes=processAllocated,Entry=new(policy.AllowEntryCollection?"decommit-once-v2":"fail-fast-v1",attempts,entryDeltas,heapBefore,heapAfter)};
    }
    private static CSharpGcHeapSnapshot Snapshot(){var info=GC.GetGCMemoryInfo();return new(GC.GetTotalMemory(false),info.HeapSizeBytes,info.FragmentedBytes,info.TotalCommittedBytes,info.TotalAvailableMemoryBytes);}
}
