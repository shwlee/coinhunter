using System.Diagnostics;
using System.Text.Json;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpBudgetChecks
{
    public static async Task Run(string root)
    {
        var settings = new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build());
        var resources = new ExecutionResources(settings);
        using var group = resources.Reserve(new ResourceProfile("c2-probe", 768L * 1024 * 1024, OperatingSystem.IsWindows() ? 2 : 128, 10000));
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        CSharpHostChecks.RestrictEnvironment(info);
        if (Path.GetFileNameWithoutExtension(Environment.ProcessPath) == "dotnet") info.ArgumentList.Add(typeof(CSharpBudgetChecks).Assembly.Location);
        info.ArgumentList.Add(root); info.ArgumentList.Add("csharp-budget-child");
        using var process = new Process { StartInfo = info };
        process.Start();
        try
        {
            group.Assign(process); // Authorize before Roslyn compilation or user assembly loading.
            var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
            await process.StandardInput.WriteLineAsync("go"); process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(60));
            var text = await output;
            if (process.ExitCode != 0) throw new Exception("C2 isolated probe failed: " + await errors + text);
            var result = JsonSerializer.Deserialize<ProbeReport>(text)!;
            if (result.Checks < 25 || result.Pid != process.Id) throw new Exception("Incomplete C2 probe report.");
            Console.WriteLine($"C# budget checks: {result.Checks} passed in OS-limited PID {result.Pid}; max deadline overshoot {result.MaxOvershootMs:F2}ms; retained delta {result.RetainedDeltaBytes} bytes.");
            var path = Path.Combine(root, "artifacts/csharp-c2-report.json");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!); await File.WriteAllTextAsync(path, text);
        }
        finally { using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10)); await group.TerminateAndDrain(deadline.Token); }
    }
    internal sealed record ProbeReport(int Checks, int Pid, double MaxOvershootMs, long RetainedDeltaBytes, List<CandidateCall> Timeouts);
    public static void Child(string root)
    {
        var checks = 0; var timeouts = new List<CandidateCall>();
        void Assert(bool valid, string message) { if (!valid) throw new Exception(message); checks++; }
        string Source(string body, string extra = "") => "public class Player{int turn;int state;public void Initialize(int n,int c,int r){} public string GetName(){return \"probe\";}public int MoveNext(int[] map,int position,int[] items){" + body + "}" + extra + "}";
        CSharpCandidate Ready(string source)
        {
            var candidate = CSharpCandidate.Prepare(source);
            Assert(candidate.Construct().Status == "ok" && candidate.Initialize(0, 3, 3).Status == "ok" && (string?)candidate.GetName().Value == "probe", "Lifecycle failed.");
            return candidate;
        }
        void Timeout(CandidateCall result, double budget)
        {
            Assert(result.Status == "timeout" && result.Value is null && result.DeadlineReached && result.ExecutionSettled && result.ElapsedMs >= budget && result.ElapsedMs < budget + 2000, "Not actually settled at deadline: " + JsonSerializer.Serialize(result));
            timeouts.Add(result);
        }
        foreach (var loop in new[] {
            "while(true){}", "for(;;);", "do {continue;} while(true);", "for(int i=0;i<100;i--){if(i%2==0)continue;state++;}",
            "while(true){foreach(int x in map){continue;}}", "for(;;){for(;;){continue;}}", "while(true) Tick();",
            "while(Check()){}", "for(long i=0;i<9223372036854775807;i++)state++;"
        })
        {
            using var candidate = Ready(Source("turn++;if(position==1){state=2;" + loop + "}return turn==2&&state==2?3:0;", "void Tick()=>state++;bool Check()=>true;"));
            var expired = candidate.MoveNext([0, 0, 0], 1, [-1, -1, -1, -1]); Timeout(expired, 500);
            var next = candidate.MoveNext([0, 0, 0], 0, [-1, -1, -1, -1]);
            Assert(next.Status == "ok" && next.InstanceId == expired.InstanceId && next.ProcessId == expired.ProcessId && next.CallId == expired.CallId + 1 && (int?)next.Value == (loop.Contains("state++") || loop.Contains("Tick") ? 0 : 3), "State/PID/instance not retained.");
            Assert(candidate.GuardSites.Any(s => s.Kind == "MethodDeclaration") && candidate.GuardSites.Count >= 5 && expired.Line is > 0, "Missing guard/source mapping.");
        }
        using (var candidate = Ready(Source("map[0]=9;items[0]=9;return 0;")))
        {
            int[] map = [0], items = [-1, -1, -1, -1];
            candidate.MoveNext(map, 0, items); Assert(map[0] == 0 && items[0] == -1, "Input ownership leaked.");
        }
        using (var candidate = Ready(Source("return 7;"))) Assert(candidate.MoveNext([0], 0, [-1,-1,-1,-1]).Status == "invalid-result", "Invalid direction accepted.");
        using (var candidate = Ready(Source("return map[100];")))
        {
            Assert(candidate.MoveNext([0], 0, [-1,-1,-1,-1]).Status == "exception", "User exception misclassified.");
            try { candidate.MoveNext([0], 0, [-1,-1,-1,-1]); throw new Exception("Faulted instance reused."); } catch (InvalidOperationException) { checks++; }
        }
        using (var candidate = Ready(Source("if(position==1)while(true){if(buffer.Count==65536)buffer.Clear();buffer.Add(++state);}return buffer.Count==0||buffer[buffer.Count-1]<=state?2:0;", "System.Collections.Generic.List<int> buffer=new System.Collections.Generic.List<int>();")))
        {
            Timeout(candidate.MoveNext([0],1,[-1,-1,-1,-1]),500);
            Assert((int?)candidate.MoveNext([0],0,[-1,-1,-1,-1]).Value == 2, "Collection invariant lost after poll interruption.");
        }
        using (var candidate = Ready(Source("if(position==1)while(true){int[] buffer=new int[1024*1024];state=buffer.Length;}return state==1024*1024?1:0;")))
        {
            Timeout(candidate.MoveNext([0],1,[-1,-1,-1,-1]),500);
            Assert((int?)candidate.MoveNext([0],0,[-1,-1,-1,-1]).Value == 1, "Allocation/GC recovery failed.");
        }
        using (var candidate = CSharpCandidate.Prepare(Source("return 0;").Replace("Initialize(int n,int c,int r){}", "Initialize(int n,int c,int r){while(true){}}")))
        {
            Assert(candidate.Construct().Status == "ok", "Constructor failed.");
            Timeout(candidate.Initialize(0,3,3),500);
            try { candidate.GetName(); throw new Exception("Failed initialization reused."); } catch(InvalidOperationException) { checks++; }
        }
        using (var candidate = CSharpCandidate.Prepare(Source("return 0;").Replace("return \"probe\";", "while(true){}")))
        {
            Assert(candidate.Construct().Status == "ok" && candidate.Initialize(0,3,3).Status == "ok", "Setup failed.");
            Timeout(candidate.GetName(),500);
        }
        // Trusted host fault injection. User catch/Dispose/comparer paths remain
        // rejected by C1; these prove classification does not depend on exception type.
        var late = BudgetInvocation.Run(() => { Thread.Sleep(30); return 2; }, TimeSpan.FromMilliseconds(10));
        Assert(late.Status == "timeout" && late.Value is null && late.Error is null, "Late successful return accepted.");
        foreach (var replace in new[] { false, true })
        {
            var wrapped = BudgetInvocation.Run(() =>
            {
                Thread.Sleep(30);
                try { BudgetGuard.Poll(7,9); }
                catch(Exception e) { if(replace) throw new ApplicationException("replaced"); throw new InvalidOperationException("wrapped",e); }
                return 2;
            }, TimeSpan.FromMilliseconds(10));
            Assert(wrapped.Status == "timeout" && wrapped.Scope.Line == 7 && wrapped.Error is not null, "Wrapped/replaced deadline lost.");
        }
        var fake = BudgetInvocation.Run(() => throw new BudgetExpiredException(), TimeSpan.FromMilliseconds(500));
        Assert(fake.Status == "exception" && !fake.Scope.Expired, "Exception type forged timeout.");
        Assert(BudgetInvocation.Run(()=>3,TimeSpan.FromMilliseconds(500)).Status == "ok", "Host guard context leaked.");
        using (var candidate = Ready(Source("if(position==1)while(true){}return ++turn%4;")))
        {
            var baseline = GC.GetTotalMemory(true);
            for (var i=0;i<40;i++) { Timeout(candidate.MoveNext([0], 1, [-1,-1,-1,-1], TimeSpan.FromMilliseconds(10)), 10); Assert(candidate.MoveNext([0], 0, [-1,-1,-1,-1]).Status == "ok", "Repeated timeout poisoned state."); }
            var delta = GC.GetTotalMemory(true) - baseline;
            Assert(delta < 8 * 1024 * 1024, "Retained memory grew during repeated timeout: " + delta);
            // Record bounded observed retention, not a general leak-freedom proof.
            Retained = delta;
        }
        using (var sample = CSharpCandidate.Prepare(File.ReadAllText(Path.Combine(root, "backend/examples/csharp/nearest-coin.cs"))))
        {
            Assert(sample.Construct().Status == "ok" && sample.Initialize(0,3,3).Status == "ok", "BFS lifecycle failed.");
            Assert((int?)sample.MoveNext([0,0,0,0,0,10,0,0,0], 4, [-1,-1,-1,-1]).Value == 2, "BFS changed direction mapping.");
        }
        foreach (var rejected in new[] { Source("try{return 0;}catch{return -1;}"), Source("return 0;", "int P{get{return P;}}"), Source("return A();", "int A()=>A();"), Source("using(var s=new System.IO.MemoryStream()){}return 0;"), Source("return CoinHunter.CSharp.Analysis.BudgetGuard.GetHashCode();"), Source("var q=new System.Collections.Generic.List<int>();q.Sort();return 0;") })
        { try { using var candidate=CSharpCandidate.Prepare(rejected); throw new Exception("Unsafe source compiled."); } catch(ArgumentException) { checks++; } }
        checks+=CSharpBuiltinPolicyChecks.Run();
        foreach(var (expression,expected) in new[]{("null",(string?)null),("\"\"",""),("\"   \"","   "),("\"코인 사냥꾼\"","코인 사냥꾼"),("\""+new string('가',41)+"\"",new string('가',40)),("\""+new string('가',39)+"😀끝\"",new string('가',39))})
        {
            using var named=CSharpCandidate.Prepare(Source("return 0;").Replace("return \"probe\";","return "+expression+";"));
            Assert(named.Construct().Status=="ok"&&named.Initialize(0,3,3).Status=="ok","Name setup failed.");
            var value=named.GetName();
            Assert(expected is null ? value.Status=="invalid-result"&&value.DiagnosticCode=="AR013"&&value.Value is null : value.Status=="ok"&&(string?)value.Value==expected,"Name contract/normalization failed.");
        }
        Console.Write(JsonSerializer.Serialize(new ProbeReport(checks, Environment.ProcessId, timeouts.Max(t=>t.ElapsedMs-t.BudgetMs), Retained, timeouts)));
    }
    private static long Retained;
}
