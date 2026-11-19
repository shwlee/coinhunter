using System.Text.Json;
using CoinHunter.CSharp.Analysis;
using CoinHunter.Contracts;

internal static class PreparationMode
{
    public static async Task Run(string[] args)
    {
        if(await Console.In.ReadLineAsync()!="authorize")throw new InvalidOperationException("Resource authorization required.");
        var toolchain=CandidateCompiler.Describe();
        if(args.Length==1&&args[0]=="describe") {Console.WriteLine(JsonSerializer.Serialize(new CSharpPrepareResponse("described",toolchain,[])));return;}
        if(args.Length!=7||args[0]!="compile")throw new ArgumentException("Invalid preparation request.");
        using var activeLease=new FileStream(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!,"active.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
        var source=await File.ReadAllTextAsync(args[1]);var output=Path.GetFullPath(args[2]);var owner=Guid.Parse(args[3]);var hash=args[4];
        var maxDll=long.Parse(args[5]);var maxManifest=long.Parse(args[6]);
        if(owner==Guid.Empty||maxDll<=0||maxManifest<=0||!CSharpArtifactKeys.Valid(hash))throw new ArgumentException("Invalid preparation limits.");
        var analysis=PlayerAnalyzer.Analyze(source);
        CSharpPrepareResponse response;
        if(analysis.SourceHash!=hash)response=new("source-changed",toolchain,[]);
        else if(!analysis.StaticPassed)response=new("failed",toolchain,analysis.Diagnostics.Take(20).Select(d=>new CSharpPrepareDiagnostic(d.Code,d.Message[..Math.Min(256,d.Message.Length)],d.Line,d.Column)).ToArray());
        else
        {
            var image=CandidateCompiler.Compile(source);
            var manifest=new CSharpArtifactManifest(1,owner,image.Key,hash,CSharpArtifactKeys.Hash(image.Dll),image.Dll.LongLength,image.Toolchain,image.GuardSites);
            var metadata=JsonSerializer.SerializeToUtf8Bytes(manifest);
            if(image.Dll.LongLength>maxDll||metadata.LongLength>maxManifest)response=new("output-limit",toolchain,[]);
            else
            {
                Directory.CreateDirectory(output);
                await using(var file=new FileStream(Path.Combine(output,"artifact.dll"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){await file.WriteAsync(image.Dll);file.Flush(true);}
                await using(var file=new FileStream(Path.Combine(output,"manifest.json"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){await file.WriteAsync(metadata);file.Flush(true);}
                response=new("compiled",toolchain,[]);
            }
        }
        Console.WriteLine(JsonSerializer.Serialize(response));
    }
}
