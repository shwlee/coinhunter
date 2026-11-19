namespace CoinHunter.CSharp.Analysis;

internal sealed class OperationLimitException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

// Host-owned candidate profile. Bounds constrain indivisible BCL operations;
// they do not promise that allocation/GC can be preempted at an exact deadline.
public static class CheckedOperations
{
    public const int MaxCollectionCount = 65536;
    public const int MaxArrayElements = 1048576;
    private static void Poll(int line,int column)=>BudgetGuard.Poll(line,column);
    private static int Capacity(int value,int line,int column)
    {
        Poll(line,column);
        if(value>MaxCollectionCount)throw BudgetGuard.Limit("collection-capacity",line,column);
        return value;
    }
    private static void Grow(int count,int line,int column)
    {
        Poll(line,column);
        if(count>=MaxCollectionCount)throw BudgetGuard.Limit("collection-count",line,column);
    }
    public static int ArrayLength(int length,int __line,int __column)
    {
        Poll(__line,__column);
        if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);
        return length;
    }
    public static long ArrayLength(long length,int __line,int __column)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);return length;}
    public static uint ArrayLength(uint length,int __line,int __column)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);return length;}
    public static ulong ArrayLength(ulong length,int __line,int __column)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);return length;}
    public static List<int> CreateList(int __line,int __column)=>CreateList(0,__line,__column);
    public static List<int> CreateList(int capacity,int __line,int __column)=>new(Capacity(capacity,__line,__column));
    public static Queue<int> CreateQueue(int __line,int __column)=>CreateQueue(0,__line,__column);
    public static Queue<int> CreateQueue(int capacity,int __line,int __column)=>new(Capacity(capacity,__line,__column));
    public static HashSet<int> CreateHashSet(int __line,int __column)=>CreateHashSet(0,__line,__column);
    public static HashSet<int> CreateHashSet(int capacity,int __line,int __column)=>new(Capacity(capacity,__line,__column));
    public static Dictionary<int,int> CreateDictionary(int __line,int __column)=>CreateDictionary(0,__line,__column);
    public static Dictionary<int,int> CreateDictionary(int capacity,int __line,int __column)=>new(Capacity(capacity,__line,__column));
    public static PriorityQueue<int,int> CreatePriorityQueue(int __line,int __column)=>CreatePriorityQueue(0,__line,__column);
    public static PriorityQueue<int,int> CreatePriorityQueue(int initialCapacity,int __line,int __column)=>new(Capacity(initialCapacity,__line,__column));
    public static void ListAdd(List<int> __collection,int item,int __line,int __column)
    {Grow(__collection.Count,__line,__column);__collection.Add(item);Poll(__line,__column);}
    public static void QueueEnqueue(Queue<int> __collection,int item,int __line,int __column)
    {Grow(__collection.Count,__line,__column);__collection.Enqueue(item);Poll(__line,__column);}
    public static void PriorityQueueEnqueue(PriorityQueue<int,int> __collection,int element,int priority,int __line,int __column)
    {Grow(__collection.Count,__line,__column);__collection.Enqueue(element,priority);Poll(__line,__column);}
    public static bool HashSetAdd(HashSet<int> __collection,int item,int __line,int __column)
    {
        Poll(__line,__column);
        if(__collection.Count>=MaxCollectionCount&&!__collection.Contains(item))throw BudgetGuard.Limit("collection-count",__line,__column);
        var result=__collection.Add(item);Poll(__line,__column);return result;
    }
    public static void DictionaryAdd(Dictionary<int,int> __collection,int key,int value,int __line,int __column)
    {
        Poll(__line,__column);
        if(__collection.Count>=MaxCollectionCount&&!__collection.ContainsKey(key))throw BudgetGuard.Limit("collection-count",__line,__column);
        __collection.Add(key,value);Poll(__line,__column);
    }
    public static int ListIndexOf(List<int> __collection,int item,int __line,int __column)=>ListIndexOf(__collection,item,0,__collection.Count,__line,__column);
    public static int ListIndexOf(List<int> __collection,int item,int index,int __line,int __column)=>ListIndexOf(__collection,item,index,__collection.Count-index,__line,__column);
    public static int ListIndexOf(List<int> __collection,int item,int index,int count,int __line,int __column)
    {
        // Validate before traversing; no partial mutation occurs on interruption.
        Poll(__line,__column);
        if(index<0||index>__collection.Count)throw new ArgumentOutOfRangeException(nameof(index));
        if(count<0||count>__collection.Count-index)throw new ArgumentOutOfRangeException(nameof(count));
        for(int i=index;i<index+count;i++){if((i&255)==0)Poll(__line,__column);if(__collection[i]==item)return i;}
        Poll(__line,__column);return -1;
    }
    public static bool ListContains(List<int> __collection,int item,int __line,int __column)=>ListIndexOf(__collection,item,__line,__column)>=0;
    public static bool QueueContains(Queue<int> __collection,int item,int __line,int __column)
    {
        Poll(__line,__column);int i=0;
        foreach(var value in __collection){if((i++&255)==0)Poll(__line,__column);if(value==item)return true;}
        Poll(__line,__column);return false;
    }
    public static bool ListRemove(List<int> __collection,int item,int __line,int __column)
    {
        int index=ListIndexOf(__collection,item,__line,__column);if(index<0)return false;
        ListRemoveAt(__collection,index,__line,__column);return true;
    }
    public static void ListRemoveAt(List<int> __collection,int index,int __line,int __column)
    {Poll(__line,__column);__collection.RemoveAt(index);Poll(__line,__column);}
}
