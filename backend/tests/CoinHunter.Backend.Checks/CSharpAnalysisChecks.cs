using CoinHunter.CSharp.Analysis;

internal static class CSharpAnalysisChecks
{
    public static int Run(string root)
    {
        string Source(string body, string extra = "", string imports = "") => imports + "public class Player { int column; public void Initialize(int number,int columns,int rows){column=columns;} public string GetName(){return \"test\";} public int MoveNext(int[] map,int position,int[] items){" + body + "} " + extra + "}";
        var count = 0;
        void Check(string source, string? code)
        {
            var result = PlayerAnalyzer.Analyze(source);
            if (result.ExecutionAllowed || result.SourceHash.Length != 64 || result.Profile != PlayerAnalyzer.Profile) throw new Exception("C# candidate result contract failed.");
            if (code is null ? !result.StaticPassed : result.StaticPassed || !result.Diagnostics.Any(d => d.Code == code))
                throw new Exception("C# policy expected " + (code ?? "pass") + ": " + System.Text.Json.JsonSerializer.Serialize(result.Diagnostics));
            if (result.Diagnostics.Any(d => d.Line < 1 || d.Column < 1)) throw new Exception("Missing original location.");
            count++;
        }
        Check(Source("return -1;"), null);
        Check(Source("Debug.Print(1);Debug.Print(\"코인\");return -1;"),null);
        Check(Source("Print(1);return -1;",imports:"using static Debug;"),null);
        Check(Source("string s=\"a\";s+=\"b\";return -1;"),"AP001");
        Check(Source("string s=\"a\"+map;return -1;"),"AP001");
        Check(File.ReadAllText(Path.Combine(root, "backend/examples/csharp/nearest-coin.cs")), null);
        Check(Source("return Abs(-1);", imports: "using static System.Math;"), null);
        Check(Source("return F();", "int F()=>F();"), "AR009");
        Check(Source("return global::System.Math.Min(1,2);"), null);
        Check(Source("return 0;", "public async System.Threading.Tasks.Task F(){await System.Threading.Tasks.Task.Delay(1);}"), "AR004");
        Check(Source("return 0;", "int F(ref int x){return x;}"), "AP001");
        Check(Source("var q=new System.Collections.Generic.Dictionary<int,int>(System.Collections.Generic.EqualityComparer<int>.Default);return 0;"), "AR002");
        Check(Source("return F(1);", "int F(int x){return F();} int F(){return F(1);}"), "AR009");
        Check(Source("return F(1);", "int F(int x){return F();} int F(){return 0;}"), null);
        Check(Source("int[] seen=new int[map.Length]; for(int i=0;i<map.Length;i++){if(map[i]>0){return i%4;}} return -1;"), null);
        Check(Source("return Helper(position);", "int Helper(int x){return System.Math.Min(x,3);}"), null);
        Check(Source("var q=new Q(); q.Enqueue(position); while(q.Count>0){int p=q.Dequeue(); if(map[p]>0)return 0;} return -1;", imports: "using Q=System.Collections.Generic.Queue<int>;"), null);
        Check(Source("var d=new System.Collections.Generic.Dictionary<int,int>();d.Add(position,1);return d[position];"), null);
        Check(Source("var s=new System.Collections.Generic.HashSet<int>();s.Add(position);return s.Contains(position)?0:-1;"), null);
        Check(Source("var q=new System.Collections.Generic.PriorityQueue<int,int>();q.Enqueue(position,1);return q.Dequeue()%4;"), null);
        Check(Source("var q=new System.Collections.Generic.List<int>();q.Add(position);return q[0]%4;"), null);
        Check(Source("foreach(int x in map){if(x>0)return 0;}return -1;"), null);
        Check(Source("const int n=3; return n;", "const int Value=1;"), null);
        Check(Source("while(true){}"), null); // Termination is C2/runtime, not a false static proof.
        Check(Source("try{return 0;}catch{return -1;}"), "AR011");
        Check(Source("try{return 0;}finally{}"), "AR011");
        Check(Source("goto done; done:return 0;"), "AR010");
        Check(Source("return N;", "static int N;"), "AR003");
        Check(Source("return F();", "static int F(){return 0;}"), "AR003");
        Check(Source("return MoveNext(map,position,items);"), "AR009");
        Check(Source("return A();", "int A(){return B();} int B(){return A();}"), "AR009");
        Check(Source("return this.A();", "int A(){return this.A();}"), "AR009");
        Check(Source("System.Threading.Thread.Sleep(1);return 0;"), "AR002");
        Check(Source("System.Environment.Exit(0);return 0;"), "AR002");
        Check(Source("E.Exit(0);return 0;", imports: "using E=System.Environment;"), "AR002");
        Check(Source("System.IO.File.ReadAllText(\"x\");return 0;"), "AR002");
        Check(Source("object x=position;return 0;"), "AR002");
        Check(Source("dynamic x=position;return 0;"), "AR002");
        Check(Source("var d=new System.Collections.Generic.Dictionary<int,int>();((dynamic)d)[0]=1;return 0;"),"AP001");
        Check(Source("var a=new System.Collections.Generic.List<int>();((dynamic)a).Capacity=1048576;return 0;"),"AP001");
        Check(Source("foreach(object x in map){return x==null?0:1;}return -1;"),"AR002");
        Check(Source("foreach(dynamic x in map){return 0;}return -1;"),"AP001");
        Check(Source("foreach(O x in map){return 0;}return -1;",imports:"using O=System.Object;"),"AR002");
        Check(Source("return ((object)map)==null?0:1;"),"AR002");
        Check(Source("foreach(var x in map){return x;}return -1;"),null);
        Check(Source("long x=(long)position;return (int)x;"),null);
        Check(Source("return new int[(uint)3].Length;"),null);
        Check(Source("return new int[(ulong)3].Length;"),null);
        Check(Source("var x=typeof(Player);return 0;"), "AP001");
        Check(Source("return GetType().GetHashCode();"), "AR002");
        Check(Source("var p=new Player();return 0;"), "AR002");
        Check(Source("return 0;", "virtual int F(){return 0;}"), "AP001");
        Check(Source("return 0;", "public int X {get{return X;}}"), "AP001");
        Check(Source("System.Func<int> f=()=>0;return f();"), "AP001");
        Check(Source("return F();int F(){return F();}"), "AP001");
        Check(Source("using(var x=new System.IO.MemoryStream()){}return 0;"), "AP001");
        Check(Source("var q=new System.Collections.Generic.List<int>();q.Sort();return 0;"), "AR002");
        Check(Source("var q=new System.Collections.Generic.List<int>();foreach(int x in q){}return 0;"), "AP001");
        Check(Source("var q=new System.Collections.Generic.Queue<string>();return 0;"), "AR002");
        Check(Source("return Unknown;"), "AX001");
        Check(Source("return ;;; ㅂㅈㄷ"), "AX001");
        Check(Source("return 0;").Replace("MoveNext", "moveNext"), "AR013");
        Check(Source("return 0;").Replace("public int MoveNext", "private int MoveNext"), "AR013");
        Check(Source("return 0;") + " class Helper{}", "AR013");
        Check("#line 123\n" + Source("return 0;"), "AP001");
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        try { PlayerAnalyzer.Analyze(Source("return 0;"), cancelled.Token); throw new Exception("Cancelled analysis accepted."); }
        catch (OperationCanceledException) { count++; }
        return count;
    }
}
