using System.Runtime.InteropServices;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using CoinHunter.Contracts;

namespace CoinHunter.CSharp.Analysis;

public sealed record CandidateImage(AnalysisResult Analysis,CSharpToolchain Toolchain,string Key,byte[] Dll,CSharpGuardSite[] GuardSites);
public static class CandidateCompiler
{
    public static CSharpToolchain Describe()
    {
        var references=new SortedDictionary<string,string>(StringComparer.Ordinal);
        var entry=Assembly.GetEntryAssembly()!.Location;
        var paths=PlayerAnalyzer.References.Value.Select(r=>r.Display!).Concat(new[]{typeof(CSharpCandidate).Assembly.Location,typeof(CSharpArtifactKeys).Assembly.Location,typeof(Compilation).Assembly.Location,typeof(CSharpCompilation).Assembly.Location,entry,Path.ChangeExtension(entry,"deps.json"),Path.ChangeExtension(entry,"runtimeconfig.json")}).Where(File.Exists);
        foreach(var path in paths.Distinct()) {using var file=File.OpenRead(path);references[Path.GetFileName(path)]=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(file)).ToLowerInvariant();}
        var descriptor=new CSharpToolchain("","authoring-policy-v1",PlayerAnalyzer.Profile,"c1-3",CSharpCandidate.GuardVersion,typeof(CSharpCompilation).Assembly.GetName().Version!.ToString(),Environment.Version.ToString(),RuntimeInformation.OSDescription,RuntimeInformation.ProcessArchitecture.ToString(),references);
        return descriptor with{Key=CSharpArtifactKeys.Toolchain(descriptor)};
    }
    public static CandidateImage Compile(string source,CancellationToken token=default)
    {
        var analysis=PlayerAnalyzer.Analyze(source,token);
        if(!analysis.StaticPassed)throw new ArgumentException("Source did not pass the candidate policy.");
        var toolchain=Describe();var key=CSharpArtifactKeys.Build(analysis.SourceHash,toolchain.Key);
        var tree=CSharpSyntaxTree.ParseText(source,new CSharpParseOptions(LanguageVersion.CSharp12),cancellationToken:token);
        var original=CSharpCompilation.Create("Original",[tree],PlayerAnalyzer.References.Value,new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var rewriter=new BudgetRewriter(original.GetSemanticModel(tree));var rewritten=rewriter.Visit(tree.GetRoot(token))!;
        var output=CSharpSyntaxTree.Create((Microsoft.CodeAnalysis.CSharp.Syntax.CompilationUnitSyntax)rewritten,(CSharpParseOptions)tree.Options);
        var references=PlayerAnalyzer.References.Value.Append(MetadataReference.CreateFromFile(typeof(BudgetGuard).Assembly.Location));
        var compilation=CSharpCompilation.Create("Guarded_"+key,[output],references,new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,optimizationLevel:OptimizationLevel.Release,allowUnsafe:false,deterministic:true));
        using var image=new MemoryStream();var emitted=compilation.Emit(image,cancellationToken:token);
        if(!emitted.Success)throw new InvalidOperationException("Generated compilation failed: "+string.Join("; ",emitted.Diagnostics.Where(d=>d.Severity==DiagnosticSeverity.Error).Select(d=>d.Id)));
        return new(analysis,toolchain,key,image.ToArray(),rewriter.Sites.Select(s=>new CSharpGuardSite(s.Kind,s.Line,s.Column)).ToArray());
    }
}
