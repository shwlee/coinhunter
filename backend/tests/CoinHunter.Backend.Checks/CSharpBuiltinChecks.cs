using System.Diagnostics;
using System.Text.Json;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpBuiltinChecks
{
    public sealed record Sample(string Operation, int Size, double[] Milliseconds, double NearDeadlineElapsedMs, string Verdict);
    public static async Task Run(string root)
    {
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build()));
        using var group=resources.Reserve(new ResourceProfile("builtin-probe",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000));
        var info=new ProcessStartInfo(Environment.ProcessPath!){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        CSharpHostChecks.RestrictEnvironment(info);
        if(Path.GetFileNameWithoutExtension(Environment.ProcessPath)=="dotnet")info.ArgumentList.Add(typeof(CSharpBuiltinChecks).Assembly.Location);
        info.ArgumentList.Add(root);info.ArgumentList.Add("csharp-builtins-child");
        using var process=new Process{StartInfo=info};process.Start();
        try
        {
            group.Assign(process);var output=process.StandardOutput.ReadToEndAsync();var errors=process.StandardError.ReadToEndAsync();
            await process.StandardInput.WriteLineAsync("go");process.StandardInput.Close();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90));
            if(process.ExitCode!=0)throw new Exception(await errors);
            var report=await output;
            if(JsonDocument.Parse(report).RootElement.GetArrayLength()<12)throw new Exception("Incomplete builtin measurements.");
            await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-builtins-report.json"),report);
            Console.WriteLine("C# builtin measurements: raw operations, boundary calls and allocation/GC samples recorded in an OS-limited process.");
        }
        finally{using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(10));await group.TerminateAndDrain(limit.Token);}
    }
    public static void Child()
    {
        var samples=new List<Sample>();
        void Measure(string operation,int size,Func<Action> prepare)
        {
            var values=new double[5];
            for(int i=0;i<values.Length;i++)
            {
                var action=prepare();var measured=BudgetInvocation.Run(()=>{action();return 0;},TimeSpan.FromMilliseconds(500));
                if(measured.Status!="ok")throw new Exception("Unexpected standalone operation failure: "+operation+" "+measured.Status);
                values[i]=measured.Scope.ElapsedMs;
            }
            var boundary=prepare();
            var outcome=BudgetInvocation.Run(()=>
            {
                var clock=Stopwatch.StartNew();while(clock.Elapsed.TotalMilliseconds<499)Thread.SpinWait(20);
                boundary();return 0;
            },TimeSpan.FromMilliseconds(500));
            samples.Add(new(operation,size,values,outcome.Scope.ElapsedMs,outcome.Status));
            GC.Collect();GC.WaitForPendingFinalizers();GC.Collect();
        }
        foreach(var size in new[]{65536,1048576,8388608})
        {
            Measure("array-allocate-touch",size,()=>()=>{var array=new int[size];for(int i=0;i<size;i+=1024)array[i]=1;GC.KeepAlive(array);});
            Measure("list-contains",size,()=>{var list=new List<int>(new int[size]);return()=>GC.KeepAlive(list.Contains(-1));});
            Measure("list-remove-first",size,()=>{var list=new List<int>(new int[size]);return()=>list.RemoveAt(0);});
            Measure("list-grow",size,()=>{var list=new List<int>(new int[size]);return()=>list.Add(1);});
            Measure("queue-grow",size,()=>{var q=new Queue<int>(size);for(int i=0;i<size;i++)q.Enqueue(i);return()=>q.Enqueue(-1);});
        }
        foreach(var size in new[]{65536,1048576})
        {
            Measure("dictionary-rehash",size,()=>{var d=new Dictionary<int,int>(size);int capacity=d.EnsureCapacity(0);for(int i=0;i<capacity;i++)d.Add(i,i);return()=>d.Add(-1,0);});
            Measure("hashset-rehash",size,()=>{var s=new HashSet<int>(size);int capacity=s.EnsureCapacity(0);for(int i=0;i<capacity;i++)s.Add(i);return()=>s.Add(-1);});
        }
        Measure("array-allocation-gc-churn",1048576,()=>()=>{for(int i=0;i<64;i++){var array=new int[1048576];array[0]=i;GC.KeepAlive(array);}});
        Measure("checked-list-search",65536,()=>{var list=new List<int>(new int[65536]);return()=>GC.KeepAlive(CheckedOperations.ListContains(list,-1,1,1));});
        Measure("checked-list-grow",32768,()=>{var list=new List<int>(new int[32768]);return()=>CheckedOperations.ListAdd(list,1,1,1);});
        Measure("checked-queue-grow",32768,()=>{var q=new Queue<int>(32768);for(int i=0;i<32768;i++)q.Enqueue(i);return()=>CheckedOperations.QueueEnqueue(q,-1,1,1);});
        Measure("checked-dictionary-grow",32768,()=>{var d=new Dictionary<int,int>(32768);int capacity=d.EnsureCapacity(0);for(int i=0;i<capacity;i++)d.Add(i,i);return()=>CheckedOperations.DictionaryAdd(d,-1,0,1,1);});
        Measure("checked-array-allocate-touch",1048576,()=>()=>{var a=new int[CheckedOperations.ArrayLength(1048576,1,1)];for(int i=0;i<a.Length;i+=1024)a[i]=1;GC.KeepAlive(a);});
        Measure("checked-array-allocation-gc-churn",1048576,()=>()=>{for(int i=0;i<64;i++){var a=new int[CheckedOperations.ArrayLength(1048576,1,1)];a[0]=i;GC.KeepAlive(a);}});
        Measure("checked-string-concat",65536,()=>{var a=new string('a',32768);var b=new string('b',32768);return()=>GC.KeepAlive(CheckedOperations.StringConcat(a,b,1,1));});
        Measure("bounded-string-equality",65536,()=>{var a=new string('a',65536);var b=new string('a',65535)+"b";return()=>GC.KeepAlive(a==b);});
        Measure("checked-string-concat-retained-pressure",65536,()=>{var pressure=new byte[128*1024*1024];for(int i=0;i<pressure.Length;i+=4096)pressure[i]=1;var a=new string('a',32768);return()=>{GC.KeepAlive(CheckedOperations.StringConcat(a,a,1,1));GC.KeepAlive(pressure);};});
        Measure("checked-allocation-retained-pressure",1048576,()=>{var pressure=new byte[128*1024*1024];for(int i=0;i<pressure.Length;i+=4096)pressure[i]=1;return()=>{for(int i=0;i<64;i++){var a=new int[CheckedOperations.ArrayLength(1048576,1,1)];a[0]=i;GC.KeepAlive(a);}GC.KeepAlive(pressure);};});
        Console.Write(JsonSerializer.Serialize(samples));
    }
}
