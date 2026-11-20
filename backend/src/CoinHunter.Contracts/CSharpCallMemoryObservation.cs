namespace CoinHunter.Contracts;

// Development-only GC window observation. It is not a public language capability.
public sealed record CSharpCallMemoryObservation(string Status,long RequestedReservationBytes,long WorkerAllocationLimitBytes,long WorkerAllocatedBytes,double EntryMs,double ExitMs,int[] CollectionDeltas,bool RegionIntact)
{ public long ProcessAllocationLimitBytes { get; init; } public long ProcessAllocatedBytes { get; init; } public CSharpGcEntryObservation? Entry { get; init; } }

// Snapshots describe managed memory; heap statistics are from the latest GC.
public sealed record CSharpGcHeapSnapshot(long ManagedBytes,long HeapSizeBytes,long FragmentedBytes,long CommittedBytes,long AvailableBytes);
public sealed record CSharpGcEntryObservation(string Policy,int Attempts,int[] CollectionDeltas,CSharpGcHeapSnapshot? Before,CSharpGcHeapSnapshot? After)
{
    public bool Valid(bool collectionAllowed,bool failure=false)=>Policy==(collectionAllowed?"decommit-once-v2":"fail-fast-v1")&&Attempts>=(failure?0:1)&&Attempts<=(collectionAllowed?2:1)&&CollectionDeltas is {Length:3}&&CollectionDeltas.All(n=>n>=0)&&(Attempts==2?Before is not null&&ValidHeap(Before)&&(After is not null?ValidHeap(After):failure):Before is null&&After is null);
    private static bool ValidHeap(CSharpGcHeapSnapshot value)=>value.ManagedBytes>=0&&value.HeapSizeBytes>=0&&value.FragmentedBytes>=0&&value.CommittedBytes>=0&&value.AvailableBytes>=0;
}
