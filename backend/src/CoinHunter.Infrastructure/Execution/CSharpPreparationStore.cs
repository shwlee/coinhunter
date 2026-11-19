using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Resources;

namespace CoinHunter.Infrastructure.Execution;

public sealed record CSharpPreparationLimits(ResourceProfile Resources,TimeSpan Timeout,long MaxDllBytes,long MaxManifestBytes,long MaxCacheBytes);
public sealed record CSharpPreparationResult(string Status,bool CacheHit,string? Key,CSharpPrepareDiagnostic[] Diagnostics);
public sealed record CSharpWorkRecovery(int Removed,int Retained);
public sealed class CSharpArtifactLease : IDisposable
{
    private readonly Action release;
    private readonly FileStream manifestFile,dllFile;
    private bool disposed;
    public CSharpArtifactManifest Manifest { get; }
    public string ManifestPath { get; }
    internal CSharpArtifactLease(string path,CSharpArtifactManifest manifest,Action release)
    {
        ManifestPath=path;Manifest=manifest;this.release=release;
        manifestFile=new(path,FileMode.Open,FileAccess.Read,FileShare.Read);
        try{dllFile=new(Path.Combine(Path.GetDirectoryName(path)!,"artifact.dll"),FileMode.Open,FileAccess.Read,FileShare.Read);}
        catch{manifestFile.Dispose();throw;}
    }
    public void Dispose(){lock(this){if(disposed)return;disposed=true;manifestFile.Dispose();dllFile.Dispose();release();}}
}

// Private server-owned cache, single writer for its lifetime. No client-supplied
// DLL/manifest publication API; only the resource-gated compiler creates objects.
public sealed class CSharpPreparationStore : IAsyncDisposable
{
    private readonly string root,host;
    private readonly ExecutionResources resources;
    private readonly CSharpPreparationLimits limits;
    private readonly FileStream writer;
    private readonly SemaphoreSlim gate=new(1);
    private readonly CancellationTokenSource stopping=new();
    private readonly object leasesGate=new();
    private readonly Dictionary<string,int> leases=[];
    private CSharpToolchain? toolchain;
    private int waiting;
    private bool disposed;
    private bool cleanupUnconfirmed;
    private int compilationStarts;
    private bool recovered;
    public int CompilationStarts=>Volatile.Read(ref compilationStarts);
    public CSharpPreparationStore(string root,string hostAssembly,ExecutionResources resources,CSharpPreparationLimits limits)
    {
        limits.Resources.Validate();
        if(limits.Timeout<=TimeSpan.Zero||limits.Timeout>TimeSpan.FromMinutes(5)||limits.MaxDllBytes<=0||limits.MaxDllBytes>128L*1024*1024||limits.MaxManifestBytes<=0||limits.MaxManifestBytes>8L*1024*1024||limits.MaxCacheBytes<limits.MaxDllBytes+limits.MaxManifestBytes)throw new ArgumentException("Explicit bounded preparation limits required.");
        this.root=Path.GetFullPath(root);host=Path.GetFullPath(hostAssembly);this.resources=resources;this.limits=limits;
        if(!File.Exists(host))throw new FileNotFoundException("Preparation host unavailable.");
        Directory.CreateDirectory(this.root);writer=new(Path.Combine(this.root,".writer.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
    }
    private string ObjectPath(Guid owner,string key)
    {if(owner==Guid.Empty||!CSharpArtifactKeys.Valid(key))throw new ArgumentException("Owner and artifact key required.");return Path.Combine(root,"objects",owner.ToString("N"),key);}
    public async Task<CSharpPreparationResult> PrepareAsync(Guid owner,string sourcePath,string expectedHash,CancellationToken token=default)
    {
        if(owner==Guid.Empty||!Path.IsPathFullyQualified(sourcePath)||!CSharpArtifactKeys.Valid(expectedHash))throw new ArgumentException("Trusted owner/source/hash required.");
        if(Interlocked.Increment(ref waiting)>8){Interlocked.Decrement(ref waiting);throw new Storage.ServiceFault(429,"컴파일 대기 한도입니다.");}
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(token,stopping.Token);deadline.CancelAfter(limits.Timeout);
        bool entered=false;string? work=null;bool safeToRemove=true;
        try
        {
            await gate.WaitAsync(deadline.Token);entered=true;ObjectDisposedException.ThrowIf(disposed,this);
            if(cleanupUnconfirmed)throw new IOException("Unconfirmed preparation cleanup requires recovery before new builds.");
            await EnsureRecovered(deadline.Token);
            toolchain??=(await RunCompiler(["describe"],deadline.Token)).Toolchain;
            var key=CSharpArtifactKeys.Build(expectedHash,toolchain.Key);var target=ObjectPath(owner,key);
            work=Path.Combine(root,"work",Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
            await using(var ownership=new FileStream(Path.Combine(work,"ownership.json"),FileMode.CreateNew,FileAccess.Write,FileShare.None))
            {
                await JsonSerializer.SerializeAsync(ownership,new{protocol="c4-work-v2",owner,sourceHash=expectedHash,artifactKey=key,created=DateTimeOffset.UtcNow},cancellationToken:deadline.Token);
                await ownership.FlushAsync(deadline.Token);ownership.Flush(true);
            }
            var snapshot=Path.Combine(work,"source.cs");
            // Streaming canonical UTF-8 snapshot: no new source byte limit and no
            // large source string is loaded into the parent service's memory.
            await using(var input=new FileStream(sourcePath,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous))
            using(var reader=new StreamReader(input,Encoding.UTF8,detectEncodingFromByteOrderMarks:true))
            await using(var output=new StreamWriter(new FileStream(snapshot,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,FileOptions.Asynchronous),new UTF8Encoding(false)))
            {
                var chars=new char[32768];int count;
                while((count=await reader.ReadAsync(chars.AsMemory(),deadline.Token))!=0)await output.WriteAsync(chars.AsMemory(0,count),deadline.Token);
                await output.FlushAsync(deadline.Token);
            }
            await using(var file=File.OpenRead(snapshot))
                if(Convert.ToHexString(await SHA256.HashDataAsync(file,deadline.Token)).ToLowerInvariant()!=expectedHash)return new("source-changed",false,null,[]);
            if(Directory.Exists(target)){await Validate(target,owner,key,toolchain,deadline.Token);return new("prepared",true,key,[]);}
            var outputPath=Path.Combine(work,"output");
            CSharpPrepareResponse response;
            try{response=await RunCompiler(["compile",snapshot,outputPath,owner.ToString(),expectedHash,limits.MaxDllBytes.ToString(),limits.MaxManifestBytes.ToString()],deadline.Token);}
            catch(CSharpHostFailure e)when(!e.CleanupConfirmed){safeToRemove=false;cleanupUnconfirmed=true;throw;}
            if(response.Toolchain.Key!=toolchain.Key)throw new IOException("Preparation toolchain changed; restart required.");
            if(response.Status!="compiled")return new(response.Status,false,null,response.Diagnostics);
            await Validate(outputPath,owner,key,toolchain,deadline.Token);
            long used=Directory.Exists(Path.Combine(root,"objects"))?Directory.EnumerateFiles(Path.Combine(root,"objects"),"*",SearchOption.AllDirectories).Sum(p=>new FileInfo(p).Length):0;
            var bytes=Directory.EnumerateFiles(outputPath).Sum(p=>new FileInfo(p).Length);
            if(bytes>limits.MaxCacheBytes-used)return new("cache-full",false,null,[]);
            deadline.Token.ThrowIfCancellationRequested();Directory.CreateDirectory(Path.GetDirectoryName(target)!);Directory.Move(outputPath,target);
            return new("prepared",false,key,[]);
        }
        catch(CSharpHostFailure e)when(!e.CleanupConfirmed){cleanupUnconfirmed=true;throw;}
        finally
        {
            try{if(work is not null&&safeToRemove)DeleteOwned(work,"work");}
            finally{if(entered)gate.Release();Interlocked.Decrement(ref waiting);}
        }
    }
    public async Task<CSharpArtifactLease> AcquireAsync(Guid owner,string key,CancellationToken token=default)
    {
        await gate.WaitAsync(token);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);stopping.Token.ThrowIfCancellationRequested();
            await EnsureRecovered(token);
            toolchain??=(await RunCompiler(["describe"],token)).Toolchain;
            var path=ObjectPath(owner,key);var manifest=await Validate(path,owner,key,toolchain,token);
            var lease=new CSharpArtifactLease(Path.Combine(path,"manifest.json"),manifest,()=>{lock(leasesGate){if(--leases[path]==0)leases.Remove(path);}});
            lock(leasesGate)leases[path]=leases.GetValueOrDefault(path)+1;
            return lease;
        }
        finally{gate.Release();}
    }
    public async Task<bool> EvictAsync(Guid owner,string key,CancellationToken token=default)
    {
        await gate.WaitAsync(token);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);var path=ObjectPath(owner,key);
            lock(leasesGate){if(leases.GetValueOrDefault(path)!=0)return false;}
            if(Directory.Exists(path))DeleteOwned(path,"objects");return true;
        }
        finally{gate.Release();}
    }
    private async Task<CSharpArtifactManifest> Validate(string directory,Guid owner,string key,CSharpToolchain current,CancellationToken token)
    {
        var manifestPath=Path.Combine(directory,"manifest.json");var dllPath=Path.Combine(directory,"artifact.dll");
        if(!File.Exists(manifestPath)||!File.Exists(dllPath)||new FileInfo(manifestPath).Length>limits.MaxManifestBytes||new FileInfo(dllPath).Length>limits.MaxDllBytes)throw new InvalidDataException("Incomplete/oversized artifact.");
        await using var metadata=File.OpenRead(manifestPath);var manifest=await JsonSerializer.DeserializeAsync<CSharpArtifactManifest>(metadata,cancellationToken:token)??throw new InvalidDataException("Missing artifact manifest.");
        if(manifest.Schema!=1||manifest.Owner!=owner||manifest.Key!=key||!CSharpArtifactKeys.Valid(manifest.SourceHash)||manifest.Toolchain is null||manifest.Toolchain.References is null||manifest.GuardSites is null||manifest.Toolchain.Key!=current.Key||CSharpArtifactKeys.Toolchain(manifest.Toolchain)!=current.Key||manifest.Key!=CSharpArtifactKeys.Build(manifest.SourceHash,current.Key)||!CSharpArtifactKeys.Valid(manifest.DllHash)||manifest.DllBytes!=new FileInfo(dllPath).Length||manifest.GuardSites.Any(s=>s.Line<1||s.Column<1))throw new InvalidDataException("Artifact identity mismatch.");
        await using var dll=File.OpenRead(dllPath);if(Convert.ToHexString(await SHA256.HashDataAsync(dll,token)).ToLowerInvariant()!=manifest.DllHash)throw new InvalidDataException("Artifact content mismatch.");
        return manifest;
    }
    private async Task<CSharpPrepareResponse> RunCompiler(string[] args,CancellationToken token)
    {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token,stopping.Token);timeout.CancelAfter(limits.Timeout);
        var group=resources.Reserve(limits.Resources);using var process=new Process{StartInfo=new ProcessStartInfo("dotnet"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true}};
        process.StartInfo.ArgumentList.Add(host);process.StartInfo.ArgumentList.Add("--prepare");foreach(var arg in args)process.StartInfo.ArgumentList.Add(arg);
        CSharpHostSession.RestrictEnvironment(process.StartInfo);
        bool started=false,assigned=false,cleaned=false;
        try
        {
            started=process.Start();if(!started)throw new IOException("Preparation process did not start.");group.Assign(process);assigned=true;
            if(args[0]=="compile")
            {
                var work=Path.GetDirectoryName(args[1])!;
                await Storage.AtomicFile.Json(Path.Combine(work,"process.json"),new System.Text.Json.Nodes.JsonObject{["pid"]=process.Id,["startedUtcTicks"]=process.StartTime.ToUniversalTime().Ticks,["job"]=Path.GetFileName(work)});
            }
            if(args[0]=="compile")Interlocked.Increment(ref compilationStarts);
            var errors=Discard(process.StandardError,timeout.Token);
            _=errors.ContinueWith(t=>{_=t.Exception;},TaskContinuationOptions.OnlyOnFaulted);
            await process.StandardInput.WriteLineAsync("authorize".AsMemory(),timeout.Token);process.StandardInput.Close();
            var text=await ReadBounded(process.StandardOutput,65536,timeout.Token);
            await process.WaitForExitAsync(timeout.Token);await errors;
            if(process.ExitCode!=0)throw new IOException("Preparation host failed.");
            var response=JsonSerializer.Deserialize<CSharpPrepareResponse>(text)??throw new InvalidDataException("Missing compiler response.");
            if(response.Toolchain is null||response.Toolchain.References is null||!CSharpArtifactKeys.Valid(response.Toolchain.Key)||CSharpArtifactKeys.Toolchain(response.Toolchain)!=response.Toolchain.Key)throw new InvalidDataException("Invalid toolchain descriptor.");
            return response;
        }
        finally
        {
            try
            {
                if(started&&!assigned&&!process.HasExited){process.Kill(true);await process.WaitForExitAsync().WaitAsync(limits.Timeout);}
                using var cleanup=new CancellationTokenSource(TimeSpan.FromSeconds(10));await group.TerminateAndDrain(cleanup.Token);group.Dispose();cleaned=true;
            }
            finally{if(!cleaned){cleanupUnconfirmed=true;throw new CSharpHostFailure("preparation-cleanup-unconfirmed",false);}}
        }
    }
    private static async Task<string> ReadBounded(TextReader reader,int max,CancellationToken token)
    {var output=new StringBuilder();var buffer=new char[1024];int count;while((count=await reader.ReadAsync(buffer.AsMemory(),token))!=0){if(output.Length+count>max)throw new IOException("Compiler response too large.");output.Append(buffer,0,count);}return output.ToString();}
    private static async Task Discard(TextReader reader,CancellationToken token)
    {var buffer=new char[1024];while(await reader.ReadAsync(buffer.AsMemory(),token)!=0){}}
    public async Task<CSharpWorkRecovery> RecoverAsync(CancellationToken token=default)
    {
        await gate.WaitAsync(token);
        try{ObjectDisposedException.ThrowIf(disposed,this);var result=await RecoverCore(token);recovered=result.Retained==0;return result;}
        finally{gate.Release();}
    }
    private async Task EnsureRecovered(CancellationToken token)
    {
        if(recovered)return;
        var result=await RecoverCore(token);recovered=result.Retained==0;
        if(!recovered)throw new IOException("Preparation work has live/unverified ownership; recovery required.");
    }
    private async Task<CSharpWorkRecovery> RecoverCore(CancellationToken token)
    {
        int removed=0,retained=0;var workRoot=Path.Combine(root,"work");
        if(!Directory.Exists(workRoot))return new(0,0);
        foreach(var directory in Directory.EnumerateDirectories(workRoot))
        {
            token.ThrowIfCancellationRequested();
            if(!Guid.TryParseExact(Path.GetFileName(directory),"N",out _)||(File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0){retained++;continue;}
            try
            {
                if(!SafeWorkTree(directory)){retained++;continue;}
                var ownerFile=Path.Combine(directory,"ownership.json");
                if(!File.Exists(ownerFile)||new FileInfo(ownerFile).Length>4096){retained++;continue;}
                var owner=System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(ownerFile,token))!;
                if((string?)owner["protocol"]!="c4-work-v2"||!Guid.TryParse((string?)owner["owner"],out var id)||id==Guid.Empty||!CSharpArtifactKeys.Valid((string?)owner["sourceHash"])||!CSharpArtifactKeys.Valid((string?)owner["artifactKey"])) {retained++;continue;}
                var processFile=Path.Combine(directory,"process.json");
                if(File.Exists(processFile))
                {
                    if(new FileInfo(processFile).Length>4096){retained++;continue;}
                    var receipt=System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(processFile,token))!;
                    if((string?)receipt["job"]!=Path.GetFileName(directory)||receipt["pid"]!.GetValue<int>()<=0||receipt["startedUtcTicks"]!.GetValue<long>()<=0){retained++;continue;}
                    try
                    {
                        using var old=Process.GetProcessById(receipt["pid"]!.GetValue<int>());
                        if(!old.HasExited&&old.StartTime.ToUniversalTime().Ticks==receipt["startedUtcTicks"]!.GetValue<long>()){retained++;continue;}
                    }
                    catch(ArgumentException){} // No process with this PID. Never kill a reused PID.
                }
                // Child holds this exclusive lease from authorization through exit.
                // Missing process receipt means authorization was never sent.
                using(var exclusive=new FileStream(Path.Combine(directory,"active.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){}
                DeleteOwned(directory,"work");removed++;
            }
            catch(OperationCanceledException){throw;}
            catch{retained++;}
        }
        return new(removed,retained);
    }
    private static bool SafeWorkTree(string directory)
    {
        foreach(var path in Directory.EnumerateFileSystemEntries(directory))
        {
            var attributes=File.GetAttributes(path);var name=Path.GetFileName(path);
            if((attributes&FileAttributes.ReparsePoint)!=0)return false;
            if((attributes&FileAttributes.Directory)!=0)
            {
                if(name!="output")return false;
                foreach(var child in Directory.EnumerateFileSystemEntries(path))
                    if((File.GetAttributes(child)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0||Path.GetFileName(child) is not ("artifact.dll" or "manifest.json"))return false;
            }
            else if(name is not ("ownership.json" or "source.cs" or "process.json" or "active.lock") && !(name.StartsWith("process.json.",StringComparison.Ordinal)&&name.EndsWith(".tmp",StringComparison.Ordinal)))return false;
        }
        return true;
    }
    private void DeleteOwned(string path,string scope)
    {
        var absolute=Path.GetFullPath(path);var parent=Path.GetFullPath(Path.Combine(root,scope))+Path.DirectorySeparatorChar;
        if(!absolute.StartsWith(parent,OperatingSystem.IsWindows()?StringComparison.OrdinalIgnoreCase:StringComparison.Ordinal))throw new IOException("Cleanup outside private workspace refused.");
        if(Directory.Exists(absolute))Directory.Delete(absolute,true);
    }
    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();await gate.WaitAsync();
        try{if(disposed)return;if(cleanupUnconfirmed)throw new IOException("Preparation cleanup unconfirmed; writer lease retained.");lock(leasesGate){if(leases.Count!=0)throw new InvalidOperationException("Running artifact leases must close first.");}disposed=true;writer.Dispose();}
        finally{gate.Release();}
    }
}
