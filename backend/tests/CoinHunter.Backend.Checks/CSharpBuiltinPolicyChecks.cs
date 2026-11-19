using CoinHunter.CSharp.Analysis;

internal static class CSharpBuiltinPolicyChecks
{
    public static int Run()
    {
        int checks=0;
        void Assert(bool condition,string message){if(!condition)throw new Exception(message);checks++;}
        string Source(string body,string extra="")=>"public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"bounds\";}public int MoveNext(int[] map,int position,int[] items){"+body+"}"+extra+"}";
        CandidateCall Execute(string source,int value=0)
        {
            using var player=CSharpCandidate.Prepare(source);
            Assert(player.Construct().Status=="ok"&&player.Initialize(0,3,3).Status=="ok","Bounded setup failed.");
            return player.MoveNext([value],0,[-1,-1,-1,-1]);
        }
        void Value(string body,int expected,string extra="")
        {
            var call=Execute(Source(body,extra));Assert(call.Status=="ok"&&(int?)call.Value==expected,"Rewritten semantics changed: "+call);
        }
        Value("int[] a=new int[3]{0,1,2};return a[2];",2);
        Value("var a=new[]{0,1,2};return a[1];",1);
        Value("int[] a=new int[map[0]+3];return a.Length;",3);
        Value("long n=3;return new int[n].Length;",3);
        Value("return new int[(uint)3].Length;",3);
        Value("return new int[(ulong)3].Length;",3);
        Value("var a=new System.Collections.Generic.List<int>(capacity:3);a.Add(item:7);a.Add(8);return a.IndexOf(count:1,index:1,item:8);",1);
        Value("var a=new System.Collections.Generic.List<int>();a.Add(7);a.Add(8);a.Add(7);return a.IndexOf(7,1);",2);
        Value("var a=new System.Collections.Generic.List<int>();a.Add(7);a.Add(8);a.RemoveAt(index:0);return a.Contains(8)&&a.Remove(8)&&a.Count==0?3:0;",3);
        Value("var a=new System.Collections.Generic.Queue<int>(capacity:2);a.Enqueue(item:7);return a.Contains(item:7)&&!a.Contains(-1)?2:0;",2);
        Value("var a=new System.Collections.Generic.Dictionary<int,int>(capacity:2);a.Add(value:7,key:9);return a[9]%4;",3);
        Value("var a=new System.Collections.Generic.HashSet<int>(capacity:2);return a.Add(item:7)&&!a.Add(7)?1:0;",1);
        Value("var a=new System.Collections.Generic.PriorityQueue<int,int>(initialCapacity:2);a.Enqueue(priority:2,element:3);a.Enqueue(1,0);return a.Dequeue();",1);
        Value("Get().Add(Next());return state==2&&buffer[0]==1?3:0;",3,"int state;System.Collections.Generic.List<int> buffer=new System.Collections.Generic.List<int>();System.Collections.Generic.List<int> Get(){state++;return buffer;}int Next(){return state++;}");
        foreach(var expression in new[]{"new int[1048577].Length","new System.Collections.Generic.List<int>(65537).Count"})
            Assert(!PlayerAnalyzer.Analyze(Source("return "+expression+";")).StaticPassed,"Constant limit bypass.");
        foreach(var operation in new[]{"d[0]=1;","d[0]++;","d[0]+=1;","((d[0]))=1;"})
            Assert(PlayerAnalyzer.Analyze(Source("var d=new System.Collections.Generic.Dictionary<int,int>();"+operation+"return 0;")).Diagnostics.Any(d=>d.Code=="AP001"),"Dictionary growth bypass.");
        foreach(var (body,value,code) in new[]{
            ("int[] a=new int[map[0]];return 0;",1048577,"array-elements"),
            ("var a=new System.Collections.Generic.List<int>(map[0]);return 0;",65537,"collection-capacity"),
            ("var a=new System.Collections.Generic.Queue<int>(map[0]);return 0;",65537,"collection-capacity"),
            ("var a=new System.Collections.Generic.HashSet<int>(map[0]);return 0;",65537,"collection-capacity"),
            ("var a=new System.Collections.Generic.Dictionary<int,int>(map[0]);return 0;",65537,"collection-capacity"),
            ("var a=new System.Collections.Generic.PriorityQueue<int,int>(map[0]);return 0;",65537,"collection-capacity")})
        {
            var result=Execute(Source(body),value);
            Assert(result.Status=="operation-limit"&&result.LimitCode==code&&!result.DeadlineReached&&result.Line is >0,"Runtime limit classification failed.");
        }
        foreach(var setup in new[]{
            "var a=new System.Collections.Generic.List<int>();for(int i=0;i<=65536;i++)a.Add(i);",
            "var a=new System.Collections.Generic.Queue<int>();for(int i=0;i<=65536;i++)a.Enqueue(i);",
            "var a=new System.Collections.Generic.HashSet<int>();for(int i=0;i<=65536;i++)a.Add(i);",
            "var a=new System.Collections.Generic.Dictionary<int,int>();for(int i=0;i<=65536;i++)a.Add(i,i);",
            "var a=new System.Collections.Generic.PriorityQueue<int,int>();for(int i=0;i<=65536;i++)a.Enqueue(i,i);"})
        {
            var result=Execute(Source(setup+"return 0;"));
            Assert(result.Status=="operation-limit"&&result.LimitCode=="collection-count","Growth limit bypass: "+result);
        }
        Value("var a=new System.Collections.Generic.HashSet<int>();for(int i=0;i<65536;i++)a.Add(i);return a.Add(0)?1:0;",0);
        Value("var a=new System.Collections.Generic.List<int>();a.Add(7);return a.IndexOf(7,1,0);",-1);
        // Trusted fixture intentionally exceeds guest bounds to make mid-search
        // cancellation reproducible without changing the admitted profile.
        var large=new List<int>(new int[16777216]);
        var search=BudgetInvocation.Run(()=>CheckedOperations.ListContains(large,-1,77,9),TimeSpan.FromMilliseconds(1));
        Assert(search.Status=="timeout"&&search.Scope.Line==77&&large.Count==16777216,"Checked search did not interrupt safely.");
        var queue=new Queue<int>(large);
        var queueSearch=BudgetInvocation.Run(()=>CheckedOperations.QueueContains(queue,-1,78,9),TimeSpan.FromMilliseconds(1));
        Assert(queueSearch.Status=="timeout"&&queueSearch.Scope.Line==78&&queue.Count==large.Count,"Queue search did not interrupt safely.");
        return checks;
    }
}
