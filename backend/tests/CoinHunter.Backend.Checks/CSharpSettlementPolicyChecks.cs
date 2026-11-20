using System.Text;
using System.Text.Json;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpSettlementPolicyChecks
{
    internal static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var dir=Path.Combine(root,"artifacts","late-fatal-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var config=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:RepositoryRoot"]=root,["Backend:ExecutionRoot"]=dir}).Build();
        var resources=new ExecutionResources(new ExecutionResourceSettings(config));var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpSettlementPolicyChecks).Assembly.Location)!)!.FullName)!.FullName;
        string source="public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"late-fatal\";}public int MoveNext(int[] map,int p,int[] items){return -1;}}";
        string path=Path.Combine(dir,"player.cs");await File.WriteAllTextAsync(path,source);var rows=new List<object>();
        try
        {
            foreach(int probe in new[]{-8,-9})
            {
                var launch=new CSharpHostLaunch(Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"),path,CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(source)),0,1,1,new("late-fatal",768L*1024*1024,OperatingSystem.IsWindows()?1:128,10000),CSharpRuntimePolicy.Read(config).Watchdogs){ProbeStall=probe};
                await using var host=await manager.CreateAsync(launch);
                var result=await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                Assert(result.DeadlineReached&&result.ElapsedMs>=500&&result.ExecutionSettled&&result.Direction is null&&result.Status==(probe==-8?"operation-limit":"exception"),"Parent lost fatal judgement after deadline.");
                try{await host.MoveNextAsync([0],0,[-1,-1,-1,-1]);throw new Exception("Fatal actor accepted another call.");}catch(InvalidOperationException){checks++;}
                var close=await host.StopAsync();Assert(close.CleanupConfirmed,"Late fatal actor cleanup unconfirmed.");rows.Add(new{probe,result,close});
            }
            var final=JsonSerializer.SerializeToNode(resources.Status)!;Assert(manager.ManagedCount==0&&final["reservedMemoryBytes"]!.GetValue<long>()==0,"Late fatal host leak.");
        }
        finally{await manager.StopAsync(default);}
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-settlement-policy-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,rows,resources=resources.Status}));
        Console.WriteLine($"C# settlement policy checks: {checks} passed; late fatal errors remain terminal across actual host IPC.");
    }
}
