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
    public const int MaxStringCharacters = 65536;
    public static string StringConcat<TLeft,TRight>(TLeft left,TRight right,int __line,int __column)
    {
        BudgetGuard.BeforeAllocation(2048,__line,__column); // Formatting/boxing is after the guard.
        string Text<T>(T value)=>value is IFormattable f?f.ToString(null,System.Globalization.CultureInfo.InvariantCulture):value?.ToString()??"";
        var a=Text(left);var b=Text(right);
        if((long)a.Length+b.Length>MaxStringCharacters)throw BudgetGuard.Limit("string-characters",__line,__column);
        BudgetGuard.BeforeAllocation(64L+((long)a.Length+b.Length)*2,__line,__column);
        var result=string.Concat(a,b);Poll(__line,__column);return result;
    }
    public static void DebugPrint<T>(T value,int __line,int __column)
    {
        BudgetGuard.BeforeAllocation(8192,__line,__column);BudgetGuard.Print(value);Poll(__line,__column);
    }
    private static void ArrayAllocation(long length,int elementBytes,int line,int column)
    {
        if(elementBytes is <1 or >8)throw new ArgumentOutOfRangeException(nameof(elementBytes));
        if(length>=0)BudgetGuard.BeforeAllocation(64+length*elementBytes,line,column);
    }
    public static bool AllowArrayAllocation(int length,int elementBytes,int __line,int __column)
    {
        Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);
        ArrayAllocation(length,elementBytes,__line,__column);return true;
    }
    private static void Poll(int line,int column)=>BudgetGuard.Poll(line,column);
    private static int Capacity(int value,int line,int column)
    {
        Poll(line,column);
        if(value>MaxCollectionCount)throw BudgetGuard.Limit("collection-capacity",line,column);
        if(value>=0)BudgetGuard.BeforeAllocation(4096L+value*128L,line,column);
        return value;
    }
    private static void Grow(int count,int line,int column)
    {
        Poll(line,column);
        if(count>=MaxCollectionCount)throw BudgetGuard.Limit("collection-count",line,column);
    }
    public static int ArrayLength(int length,int __line,int __column,int __elementBytes=8)
    {
        Poll(__line,__column);
        if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);
        ArrayAllocation(length,__elementBytes,__line,__column);
        return length;
    }
    public static long ArrayLength(long length,int __line,int __column,int __elementBytes=8)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);ArrayAllocation(length,__elementBytes,__line,__column);return length;}
    public static uint ArrayLength(uint length,int __line,int __column,int __elementBytes=8)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);ArrayAllocation(length,__elementBytes,__line,__column);return length;}
    public static ulong ArrayLength(ulong length,int __line,int __column,int __elementBytes=8)
    {Poll(__line,__column);if(length>MaxArrayElements)throw BudgetGuard.Limit("array-elements",__line,__column);ArrayAllocation((long)length,__elementBytes,__line,__column);return length;}
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
    {Grow(__collection.Count,__line,__column);if(__collection.Count==__collection.Capacity)GrowthAllocation(__collection.Count,__line,__column);__collection.Add(item);Poll(__line,__column);}
    public static void QueueEnqueue(Queue<int> __collection,int item,int __line,int __column)
    {Grow(__collection.Count,__line,__column);if(__collection.Count==__collection.EnsureCapacity(0))GrowthAllocation(__collection.Count,__line,__column);__collection.Enqueue(item);Poll(__line,__column);}
    public static void PriorityQueueEnqueue(PriorityQueue<int,int> __collection,int element,int priority,int __line,int __column)
    {Grow(__collection.Count,__line,__column);if(__collection.Count==__collection.EnsureCapacity(0))GrowthAllocation(__collection.Count,__line,__column);__collection.Enqueue(element,priority);Poll(__line,__column);}
    private static void GrowthAllocation(int count,int line,int column)=>BudgetGuard.BeforeAllocation(4096L+Math.Max(4L,count*2L)*128L,line,column);
    public static bool HashSetAdd(HashSet<int> __collection,int item,int __line,int __column)
    {
        Poll(__line,__column);
        if(__collection.Count>=MaxCollectionCount&&!__collection.Contains(item))throw BudgetGuard.Limit("collection-count",__line,__column);
        if(__collection.Count==__collection.EnsureCapacity(0)&&!__collection.Contains(item))GrowthAllocation(__collection.Count,__line,__column);
        var result=__collection.Add(item);Poll(__line,__column);return result;
    }
    public static void DictionaryAdd(Dictionary<int,int> __collection,int key,int value,int __line,int __column)
    {
        Poll(__line,__column);
        if(__collection.Count>=MaxCollectionCount&&!__collection.ContainsKey(key))throw BudgetGuard.Limit("collection-count",__line,__column);
        if(__collection.Count==__collection.EnsureCapacity(0)&&!__collection.ContainsKey(key))GrowthAllocation(__collection.Count,__line,__column);
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
