using CoinHunter.Execution.Host.Services;
using Microsoft.Extensions.Configuration;

internal static class CSharpRuntimePolicyChecks
{
    public static int Run()
    {
        int checks=0;
        var defaults=CSharpRuntimePolicy.Read(new ConfigurationBuilder().Build());
        if(defaults.Watchdogs.UnsettledExecution.TotalMilliseconds!=2000||defaults.MinimumFreeDiskBytes!=256L*1024*1024||defaults.ArtifactRetention.TotalDays!=7)throw new Exception("Invalid runtime defaults.");checks++;
        foreach(var (key,value) in new[]{("UnsettledExecutionMs","500"),("PreparationMs","0"),("StopGraceMs","300001"),("MinimumFreeDiskMiB","63"),("ArtifactRetentionDays","0")})
        {
            try{CSharpRuntimePolicy.Read(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:CSharpRuntime:"+key]=value}).Build());throw new Exception("Unsafe C# runtime policy accepted.");}
            catch(InvalidOperationException){checks++;}
        }
        var configured=CSharpRuntimePolicy.Read(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:CSharpRuntime:UnsettledExecutionMs"]="1500",["Backend:CSharpRuntime:ArtifactRetentionDays"]="3"}).Build());
        if(configured.Watchdogs.UnsettledExecution.TotalMilliseconds!=1500||configured.ArtifactRetention.TotalDays!=3)throw new Exception("C# runtime overrides ignored.");checks++;
        Console.WriteLine($"C# runtime policy checks: {checks} passed.");return checks;
    }
}
