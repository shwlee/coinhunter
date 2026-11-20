using CoinHunter.Infrastructure.Execution;

namespace CoinHunter.Execution.Host.Services;

// Operational supervision is independently configurable; the user budget stays
// exactly 500ms. Exceeding a watchdog is a host fault, never a normal timeout.
public sealed record CSharpRuntimePolicy(CSharpWatchdogs Watchdogs, long MinimumFreeDiskBytes,TimeSpan ArtifactRetention)
{
    public static CSharpRuntimePolicy Read(IConfiguration configuration)
    {
        TimeSpan Milliseconds(string name,int fallback)
        {
            int value=configuration.GetValue("Backend:CSharpRuntime:"+name,fallback);
            if(value<=0||value>300000)throw new InvalidOperationException("Invalid C# watchdog: "+name);
            return TimeSpan.FromMilliseconds(value);
        }
        var watchdogs=new CSharpWatchdogs(Milliseconds("PreparationMs",15000),Milliseconds("StartNotificationMs",1000),Milliseconds("UnsettledExecutionMs",2000),Milliseconds("HeartbeatIntervalMs",100),Milliseconds("HeartbeatResponseMs",1000),Milliseconds("StopGraceMs",1000),Milliseconds("CleanupMs",5000));
        if(watchdogs.UnsettledExecution<=TimeSpan.FromMilliseconds(500))throw new InvalidOperationException("Unsettled watchdog must exceed the algorithm budget.");
        long free=configuration.GetValue("Backend:CSharpRuntime:MinimumFreeDiskMiB",256);
        if(free<64||free>1048576)throw new InvalidOperationException("C# minimum free disk setting is invalid.");
        int retention=configuration.GetValue("Backend:CSharpRuntime:ArtifactRetentionDays",7);
        if(retention is <1 or >3650)throw new InvalidOperationException("Invalid C# artifact retention.");
        return new(watchdogs,checked(free*1024*1024),TimeSpan.FromDays(retention));
    }
    public void EnsureDiskSpace(string path)
    {
        if(new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace<MinimumFreeDiskBytes)throw new CoinHunter.Infrastructure.Storage.ServiceFault(507,"C# 실행 준비를 위한 디스크 여유가 부족합니다.");
    }
    public object Readiness(bool candidateEnabled,object? hostStatistics=null,bool experimentalGcWindow=false,bool gcEntryCollection=false)=>new
    {
        language="csharp",publicEnabled=false,candidateEnabled,profile="csharp-restricted-c1-v4",algorithmBudgetMs=500,
        transport="node-direct-player-pipe-v2",watchdogs=Watchdogs,minimumFreeDiskBytes=MinimumFreeDiskBytes,artifactRetentionDays=ArtifactRetention.TotalDays,
        automaticRestartAfterTimeout=false,forcedStopIsInfrastructureFailure=true,
        experimentalGcWindowEnabled=candidateEnabled&&experimentalGcWindow,
        experimentalGcEntryCollectionEnabled=candidateEnabled&&experimentalGcWindow&&gcEntryCollection,
        hosts=hostStatistics,
        pendingAcceptance=new[]{"native-gc-pressure-boundaries","linux-cgroup-and-sandbox","production-load-and-cache-retention","public-operations-history-ui"}
    };
}
