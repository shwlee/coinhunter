using System.Diagnostics;
using System.Text;
using System.Text.Json;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpGcRecoveryChecks
{
    internal static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var dir=Path.Combine(root,"artifacts","gc-recovery-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
        var config=new ConfigurationBuilder().AddEnvironmentVariables().AddInMemoryCollection(new Dictionary<string,string?>{["Backend:RepositoryRoot"]=root,["Backend:ExecutionRoot"]=dir}).Build();
        var resources=new ExecutionResources(new ExecutionResourceSettings(config));var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var bin=Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(typeof(CSharpGcRecoveryChecks).Assembly.Location)!)!.FullName)!.FullName;
        string host=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");
        var profile=new ResourceProfile("gc-recovery",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000);
        await using var store=new CSharpPreparationStore(Path.Combine(dir,"cache"),host,resources,new(profile,TimeSpan.FromSeconds(30),16L*1024*1024,1024*1024,64L*1024*1024));
        string fields=string.Concat(Enumerable.Range(0,16).Select(i=>"long[] m"+i+";"));
        string initialize=string.Concat(Enumerable.Range(0,16).Select(i=>"m"+i+"=new long[1048576];for(int j=0;j<m"+i+".Length;j+=512)m"+i+"[j]=1;"));
        string code="public class Player{int turn;int[] scratch;"+fields+"public void Initialize(int n,int c,int r){"+initialize+"}public string GetName(){return \"gc-recovery\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1){while(true){}}scratch=new int[16384];scratch[0]=turn;return turn%4;}}";
        string path=Path.Combine(dir,"player.cs");await File.WriteAllTextAsync(path,code);var owner=Guid.NewGuid();
        var prepared=await store.PrepareAsync(owner,path,CSharpArtifactKeys.Hash(Encoding.UTF8.GetBytes(code)));Assert(prepared.Status=="prepared","Recovery source rejected.");
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(2),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        var launch=new CSharpPreparedLaunch(host,owner,prepared.Key!,0,40,30,profile,watchdogs){ExperimentalGcWindow=true};
        var rows=new List<object>();bool completed=false;
        try
        {
            foreach(bool recovery in new[]{false,true})
            {
                await using var actor=await manager.CreatePreparedAsync(store,launch with{ExperimentalGcEntryCollection=recovery});
                var observations=new List<object>();int turns=0,recovered=0,successful=0;string? failure=null;var total=Stopwatch.StartNew();
                for(int i=0;i<10000;i++)
                {
                    bool slow=recovery&&i is 1 or 5000;var clock=Stopwatch.StartNew();
                    try
                    {
                        var result=await actor.MoveNextAsync(new int[1200],slow?1:0,[-1,-1,-1,-1]);turns++;
                        Assert(result.InstanceId==actor.Identity!.InstanceId&&result.Status==(slow?"timeout":"ok")&&result.Direction==(slow?null:turns%4),"Recovery replayed/reset Player or changed turn result.");
                        var memory=result.ExperimentalMemory!;Assert(memory.Entry?.Valid(recovery)==true&&memory.RegionIntact&&memory.CollectionDeltas.All(n=>n==0),"Collection entered guest call or entry binding changed.");
                        if(memory.Entry!.Attempts==2){Assert(clock.Elapsed.TotalMilliseconds>=memory.EntryMs+memory.ExitMs,"Recovery cost hidden from roundtrip.");recovered++;observations.Add(new{call=i,result,roundTripMs=clock.Elapsed.TotalMilliseconds});}
                        else if(i%250==0||slow)observations.Add(new{call=i,result,roundTripMs=clock.Elapsed.TotalMilliseconds});
                        successful++;
                    }
                    catch(CSharpHostFailure e)when(e.CleanupConfirmed&&e.Reason.StartsWith("gc-",StringComparison.Ordinal))
                    {failure=e.Reason;observations.Add(new{call=i,failure,entry=actor.FailedGcEntry,roundTripMs=clock.Elapsed.TotalMilliseconds});break;}
                }
                var close=await actor.StopAsync("recovery-probe-complete");Assert(close.CleanupConfirmed,"Recovery cleanup unconfirmed.");
                rows.Add(new{recovery,successful,recovered,failure,elapsedMs=total.Elapsed.TotalMilliseconds,observations,close});
                if(recovery)Assert(successful==10000&&failure is null&&recovered>0,"Recovery did not sustain repeated allocations or never exercised recovery.");
                else Assert(failure=="gc-reservation-unavailable"&&actor.FailedGcEntry?.Attempts==1,"Control did not reproduce reservation exhaustion.");
            }
            completed=true;
        }
        finally
        {
            await manager.StopAsync(default);
            await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-gc-recovery-report.json"),JsonSerializer.Serialize(new{date=DateTimeOffset.UtcNow,checks,completed,preparationCompilations=store.CompilationStarts,artifactKey=prepared.Key,memberMemoryMiB=768,rows,resources=resources.Status}));
        }
        Console.WriteLine($"GC recovery checks: {checks} passed; actual prepared DLL control/recovery, entry collections, timeout state reuse and cleanup.");
    }
}
