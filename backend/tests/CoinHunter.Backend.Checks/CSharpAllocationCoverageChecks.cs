using System.Reflection;
using CoinHunter.CSharp.Analysis;

internal static class CSharpAllocationCoverageChecks
{
    internal static int Run()
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        string Source(string body,string extra="")=>"public class Player{int state;public void Initialize(int n,int c,int r){}public string GetName(){return \"allocation\";}public int MoveNext(int[] m,int p,int[] items){"+body+"}"+extra+"}";
        CSharpCandidate Ready(string code){var candidate=CSharpCandidate.Prepare(code);Assert(candidate.Construct().Status=="ok"&&candidate.Initialize(0,4,4).Status=="ok"&&candidate.GetName().Status=="ok","Allocation fixture initialization.");return candidate;}
        var observations=new List<object>();
        string values=string.Join(',',Enumerable.Repeat("Tick()",256));
        foreach(var expression in new[]{"new int[256]{"+values+"}","new[]{"+values+"}"})
        {
            using var candidate=Ready(Source("return ("+expression+").Length;","int Tick(){state++;return 1;}"));candidate.ExperimentalAllocationBudgetBytes=1024;
            var result=candidate.MoveNext([0],0,[-1,-1,-1,-1]);
            var player=typeof(CSharpCandidate).GetField("player",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(candidate)!;
            Assert(result.Status=="operation-limit"&&result.LimitCode=="call-allocation-bytes"&&result.Line>0,"Initialized array bypassed pre-allocation budget.");
            Assert((int)player.GetType().GetField("state",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(player)! == 0,"Initializer expressions ran before array reservation rejection.");observations.Add(result);
        }
        using(var candidate=Ready(Source("int[] a={"+string.Join(',',Enumerable.Repeat("0",256))+"};return a.Length;")))
        {candidate.ExperimentalAllocationBudgetBytes=1024;var result=candidate.MoveNext([0],0,[-1,-1,-1,-1]);Assert(result.Status=="operation-limit"&&result.LimitCode=="call-allocation-bytes","Direct declaration initializer bypassed allocation guard.");}
        foreach(var body in new[]{"return new int[256].Length;","return new long[256].Length;","return new string[256].Length;","Debug.Print(42);return 0;","string x=\"a\"+p;return 0;"})
        {using var candidate=Ready(Source(body));candidate.ExperimentalAllocationBudgetBytes=256;var result=candidate.MoveNext([0],0,[-1,-1,-1,-1]);Assert(result.Status=="operation-limit"&&result.LimitCode=="call-allocation-bytes","Allocation boundary skipped: "+body);}
        foreach(var (body,value) in new[]{("int[] a={1,2,3};return a[2];",3),("return new int[]{1,2,3}.Length;",3),("return new[]{Tick(),Tick()}[1];",2),("string s=null;return (s+p)==\"0\"?1:0;",1),("string s=\"v\"+Tick();Debug.Print(value:s);return state;",1),("return new[]{true,false}.Length;",2),("return new[]{'a','b'}.Length;",2),("return new[]{1.0,2.0}.Length;",2),("return new[]{\"a\",\"b\"}.Length;",2)})
        {using var candidate=Ready(Source(body,"int Tick(){return ++state;}"));var result=candidate.MoveNext([0],0,[-1,-1,-1,-1]);Assert(result.Status=="ok"&&(int?)result.Value==value,"Allocation rewrite changed expression/evaluation semantics: "+body);}
        foreach(var collection in new[]{"List","Queue","HashSet","Dictionary","PriorityQueue"})
        {
            string type=collection is "Dictionary" or "PriorityQueue"?collection+"<int,int>":collection+"<int>";
            using var candidate=Ready(Source("var c=new System.Collections.Generic."+type+"(256);return 0;"));candidate.ExperimentalAllocationBudgetBytes=1024;
            Assert(candidate.MoveNext([0],0,[-1,-1,-1,-1]).LimitCode=="call-allocation-bytes","Collection factory bypassed pre-allocation guard.");
        }
        var list=new List<int>();var queued=new Queue<int>();var set=new HashSet<int>();var dictionary=new Dictionary<int,int>();var priority=new PriorityQueue<int,int>();
        foreach(var grow in new Action[]{()=>CheckedOperations.ListAdd(list,1,1,1),()=>CheckedOperations.QueueEnqueue(queued,1,1,1),()=>CheckedOperations.HashSetAdd(set,1,1,1),()=>CheckedOperations.DictionaryAdd(dictionary,1,1,1,1),()=>CheckedOperations.PriorityQueueEnqueue(priority,1,1,1,1)})
        {
            var result=BudgetInvocation.Run(()=>{grow();return 0;},TimeSpan.FromMilliseconds(500),scope=>scope.SetExperimentalAllocationBudget(1024));
            Assert(result.Status=="operation-limit","Collection growth was not checked before native allocation.");
        }
        Assert(list.Count+queued.Count+set.Count+dictionary.Count+priority.Count==0,"Rejected growth mutated collection state.");
        using(var candidate=Ready(Source("return 0;")))
        {
            candidate.ExperimentalAllocationBudgetBytes=16L*1024*1024;candidate.ExperimentalProcessAllocationBudgetBytes=1024*1024;
            candidate.CallStarted=(_,_)=>{var thread=new Thread(()=>GC.KeepAlive(new byte[4*1024*1024])){IsBackground=true};thread.Start();if(!thread.Join(5000))throw new IOException("Host allocation fixture stalled.");};
            try{candidate.MoveNext([0],0,[-1,-1,-1,-1]);throw new Exception("Other-host-thread allocation not detected.");}
            catch(CSharpGcWindowFailure failure){Assert(failure.Status=="gc-host-allocation-budget","Host allocation charged to guest instead of environment.");}
        }
        Console.Error.WriteLine($"C# allocation coverage checks: {checks} passed.");return checks;
    }
}
