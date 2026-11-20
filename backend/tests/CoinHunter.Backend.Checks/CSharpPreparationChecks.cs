using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using Microsoft.Extensions.Configuration;

internal static class CSharpPreparationChecks
{
    public static async Task Run(string root)
    {
        int checks=0;void Assert(bool value,string message){if(!value)throw new Exception(message);checks++;}
        var resources=new ExecutionResources(new ExecutionResourceSettings(new ConfigurationBuilder().AddEnvironmentVariables().Build()));
        var manager=new CSharpHostManager(resources);await manager.StartAsync(default);
        var directory=Path.Combine(root,"artifacts","c4-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        string code="public class Player{int turn;public void Initialize(int n,int c,int r){}public string GetName(){return \"cached\";}public int MoveNext(int[] map,int p,int[] items){turn++;if(p==1)while(true){}return turn%4;}}";
        string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
        var source=Path.Combine(directory,"source.cs");await File.WriteAllTextAsync(source,code);var owner=Guid.NewGuid();
        var tests=Path.GetDirectoryName(typeof(CSharpPreparationChecks).Assembly.Location)!;
        var bin=Directory.GetParent(Directory.GetParent(tests)!.FullName)!.FullName;
        var host=Path.Combine(bin,"CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll");if(!File.Exists(host))host=Path.Combine(root,"backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var limits=new CSharpPreparationLimits(new ResourceProfile("c4-prepare",768L*1024*1024,OperatingSystem.IsWindows()?2:128,10000),TimeSpan.FromSeconds(30),16*1024*1024,1024*1024,64*1024*1024);
        var cache=Path.Combine(directory,"cache");var store=new CSharpPreparationStore(cache,host,resources,limits);
        var watchdogs=new CSharpWatchdogs(TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(2),TimeSpan.FromMilliseconds(100),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(1),TimeSpan.FromSeconds(5));
        string key;
        try
        {
            try{await using var duplicate=new CSharpPreparationStore(cache,host,resources,limits);throw new Exception("Second cache writer accepted.");}catch(IOException){checks++;}
            var pair=await Task.WhenAll(store.PrepareAsync(owner,source,Hash(code)),store.PrepareAsync(owner,source,Hash(code)));
            Assert(pair.All(r=>r.Status=="prepared")&&pair.Count(r=>r.CacheHit)==1&&store.CompilationStarts==1,"Concurrent preparation compiled twice.");key=pair[0].Key!;
            Assert((await store.PrepareAsync(owner,source,new string('0',64))).Status=="source-changed"&&File.Exists(source),"Hash mismatch changed source.");
            try{using var foreign=await store.AcquireAsync(Guid.NewGuid(),key);throw new Exception("Another owner acquired code.");}catch(InvalidDataException){checks++;}
            string manifestPath,originalDllHash;
            using(var lease=await store.AcquireAsync(owner,key))
            {
                manifestPath=lease.ManifestPath;
                originalDllHash=lease.Manifest.DllHash;
                Assert(lease.Manifest.SourceHash==Hash(code)&&lease.Manifest.Owner==owner&&lease.Manifest.GuardSites.Length>0,"Manifest/source mapping missing.");
                Assert(!await store.EvictAsync(owner,key),"Evicted pinned artifact.");
            }
            File.Move(source,source+".retired"); // Only this synthetic file is moved.
            var launch=new CSharpPreparedLaunch(host,owner,key,0,3,3,limits.Resources,watchdogs);
            await using(var first=await manager.CreatePreparedAsync(store,launch))
            await using(var second=await manager.CreatePreparedAsync(store,launch))
            {
                var a=await first.MoveNextAsync([0],0,[-1,-1,-1,-1]);var b=await second.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                Assert(a.Direction==1&&b.Direction==1&&a.InstanceId!=b.InstanceId&&a.ProcessId!=b.ProcessId,"Cached DLL shared mutable player state.");
                var expired=await first.MoveNextAsync([0,0],1,[-1,-1,-1,-1]);var next=await first.MoveNextAsync([0],0,[-1,-1,-1,-1]);
                Assert(expired.Status=="timeout"&&next.Direction==3&&expired.InstanceId==next.InstanceId,"Prepared runner did not reuse timeout state.");
                Assert(store.CompilationStarts==1&&!File.Exists(source),"Execution recompiled/reloaded original source.");
                Assert(!await store.EvictAsync(owner,key),"Runtime lease did not pin cache.");
                await first.StopAsync();Assert(!await store.EvictAsync(owner,key),"One host released another host's lease.");
            }
            File.Move(source+".retired",source);
            Assert((await store.PrepareAsync(owner,source,Hash(code))).CacheHit&&store.CompilationStarts==1,"Warm cache compiled again.");
            var dllPath=Path.Combine(Path.GetDirectoryName(manifestPath)!,"artifact.dll");
            using(var changed=new FileStream(dllPath,FileMode.Open,FileAccess.ReadWrite,FileShare.None)){int first=changed.ReadByte();changed.Position=0;changed.WriteByte((byte)(first^255));}
            try{using var corrupted=await store.AcquireAsync(owner,key);throw new Exception("Corrupt DLL accepted.");}catch(InvalidDataException){checks++;}
            Assert(await store.EvictAsync(owner,key),"Unpinned corrupt cache not removable.");
            var repaired=await store.PrepareAsync(owner,source,Hash(code));Assert(repaired.Status=="prepared"&&!repaired.CacheHit&&repaired.Key==key,"Deterministic key/rebuild failed.");
            using(var current=await store.AcquireAsync(owner,key))
            {
                Assert(current.Manifest.GuardSites.All(s=>s.Line>0&&s.Column>0),"Invalid source guard locations.");
                Assert(current.Manifest.DllHash==originalDllHash,"Deterministic recompilation changed DLL bytes.");
            }
            var metadata=await File.ReadAllTextAsync(manifestPath);var stale=JsonNode.Parse(metadata)!;stale["Toolchain"]!["Guard"]="old-guard";await File.WriteAllTextAsync(manifestPath,stale.ToJsonString());
            try{using var wrongVersion=await store.AcquireAsync(owner,key);throw new Exception("Altered toolchain accepted.");}catch(InvalidDataException){checks++;}
            await File.WriteAllTextAsync(manifestPath,metadata);
            var changedCode=code.Replace("cached","changed");var changedSource=Path.Combine(directory,"changed.cs");await File.WriteAllTextAsync(changedSource,changedCode);
            var changedBuild=await store.PrepareAsync(owner,changedSource,Hash(changedCode));Assert(changedBuild.Status=="prepared"&&changedBuild.Key!=key&&!changedBuild.CacheHit,"Source revision reused old artifact.");
            var endless=code.Replace("Initialize(int n,int c,int r){}","Initialize(int n,int c,int r){while(true){}}");var endlessSource=Path.Combine(directory,"endless.cs");await File.WriteAllTextAsync(endlessSource,endless);
            Assert((await store.PrepareAsync(owner,endlessSource,Hash(endless))).Status=="prepared","Compiler executed user initialization.");
            await store.DisposeAsync();
            store=new CSharpPreparationStore(cache,host,resources,limits);
            Assert((await store.PrepareAsync(owner,source,Hash(code))).CacheHit&&store.CompilationStarts==0,"Restart did not reuse valid artifact.");
            var bad=Path.Combine(directory,"bad.cs");var badCode=code.Replace("turn++;","try{turn++;}catch{} ");await File.WriteAllTextAsync(bad,badCode);
            var failed=await store.PrepareAsync(owner,bad,Hash(badCode));Assert(failed.Status=="failed"&&failed.Diagnostics.Any(d=>d.Code=="AR011"&&d.Line>0)&&File.Exists(bad),"Failed code not preserved/diagnosed.");
            var nullCode=code.Replace("return \"cached\";","return null;");var nullPath=Path.Combine(directory,"null-name.cs");await File.WriteAllTextAsync(nullPath,nullCode);
            var nullBuild=await store.PrepareAsync(owner,nullPath,Hash(nullCode));Assert(nullBuild.Status=="prepared","Compile result confused with execution validation.");
            try{await manager.CreatePreparedAsync(store,launch with{Key=nullBuild.Key!});throw new Exception("Prepared null name became ready.");}
            catch(CSharpHostFailure failure){Assert(failure.Reason=="invalid-name"&&failure.CleanupConfirmed,"Prepared readiness failure lost diagnostic/cleanup.");}
            Assert(await store.EvictAsync(owner,nullBuild.Key!),"Failed prepared activation retained artifact lease.");
            using(var cancelled=new CancellationTokenSource())
            {
                cancelled.Cancel();try{await store.PrepareAsync(owner,source,Hash(code),cancelled.Token);throw new Exception("Cancelled preparation succeeded.");}catch(OperationCanceledException){checks++;}
            }
            var heavy=code.Insert(code.LastIndexOf('}'),string.Concat(Enumerable.Range(0,5000).Select(i=>"int Helper"+i+"(){return 0;}")));
            var heavyPath=Path.Combine(directory,"heavy.cs");await File.WriteAllTextAsync(heavyPath,heavy);
            using(var cancelled=new CancellationTokenSource())
            {
                int before=store.CompilationStarts;var preparing=store.PrepareAsync(owner,heavyPath,Hash(heavy),cancelled.Token);
                while(store.CompilationStarts==before&&!preparing.IsCompleted)await Task.Delay(1);
                var receipts=Directory.GetFiles(Path.Combine(cache,"work"),"ownership.json",SearchOption.AllDirectories);
                Assert(receipts.Length==1&&Guid.Parse((string)JsonNode.Parse(await File.ReadAllTextAsync(receipts[0]))!["owner"]!)==owner,"Temporary source lacks durable owner receipt.");
                cancelled.Cancel();try{await preparing;throw new Exception("Active compilation cancellation ignored.");}catch(OperationCanceledException){checks++;}
                Assert(File.Exists(heavyPath),"Cancellation removed original source.");
            }
            await using(var tiny=new CSharpPreparationStore(Path.Combine(directory,"tiny"),host,resources,limits with{MaxDllBytes=1}))
                Assert((await tiny.PrepareAsync(owner,source,Hash(code))).Status=="output-limit"&&File.Exists(source),"Output quota not enforced/source lost.");
            var filler=Path.Combine(cache,"objects","quota-test.bin");
            using(var file=new FileStream(filler,FileMode.CreateNew,FileAccess.Write,FileShare.None))file.SetLength(limits.MaxCacheBytes);
            var fullCode=code.Replace("cached","full-cache");var fullPath=Path.Combine(directory,"full.cs");await File.WriteAllTextAsync(fullPath,fullCode);
            try{Assert((await store.PrepareAsync(owner,fullPath,Hash(fullCode))).Status=="cache-full"&&File.Exists(fullPath),"Cache admission exceeded configured budget.");}
            finally{File.Delete(filler);}
            using(var pinned=await store.AcquireAsync(owner,key))
            {
                Directory.SetLastWriteTimeUtc(Path.GetDirectoryName(pinned.ManifestPath)!,DateTime.UtcNow-TimeSpan.FromDays(10));
                var retained=await store.MaintainAsync(TimeSpan.FromDays(7),false);
                Assert(retained.Removed==0&&retained.Retained>=1&&File.Exists(pinned.ManifestPath),"Maintenance deleted a running artifact.");
            }
            var proposal=await store.MaintainAsync(TimeSpan.FromDays(7),true);
            Assert(proposal.Removed==1&&proposal.DryRun&&File.Exists(manifestPath),"Cache dry-run mutated files or missed stale artifact.");
            var trimmed=await store.MaintainAsync(TimeSpan.FromDays(7),false);
            Assert(trimmed.Removed==1&&!trimmed.DryRun&&trimmed.RemovedBytes>0&&!File.Exists(manifestPath)&&File.Exists(source),"Cache retention removed original code or failed to remove only stale derived bytes.");
            Assert((await store.PrepareAsync(owner,source,Hash(code))).Status=="prepared","Evicted artifact could not be rebuilt from original code.");
            Assert(!Directory.EnumerateDirectories(Path.Combine(cache,"work")).Any(),"Temporary preparation directories leaked.");
            var status=System.Text.Json.JsonSerializer.SerializeToNode(resources.Status)!;
            Assert(status["reservedProcesses"]!.GetValue<int>()==0&&status["reservedMemoryBytes"]!.GetValue<long>()==0,"Preparation/runtime reservations leaked.");
        }
        finally{await manager.StopAsync(default);await store.DisposeAsync();}
        await File.WriteAllTextAsync(Path.Combine(root,"artifacts/csharp-c4-report.json"),new JsonObject{["date"]=DateTimeOffset.UtcNow.ToString("O"),["checks"]=checks,["buildKey"]=key,["sourceHash"]=Hash(code)}.ToJsonString());
        Console.WriteLine($"C# C4 preparation checks: {checks} passed; isolated deterministic compilation, private cache, leases, source-free load and timeout reuse.");
    }
}
