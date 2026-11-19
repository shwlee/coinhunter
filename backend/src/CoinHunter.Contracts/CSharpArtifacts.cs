using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CoinHunter.Contracts;

public sealed record CSharpToolchain(string Key,string Policy,string Profile,string Analyzer,string Guard,string Compiler,string Runtime,string Platform,string Architecture,SortedDictionary<string,string> References);
public sealed record CSharpGuardSite(string Kind,int Line,int Column);
public sealed record CSharpArtifactManifest(int Schema,Guid Owner,string Key,string SourceHash,string DllHash,long DllBytes,CSharpToolchain Toolchain,CSharpGuardSite[] GuardSites);
public sealed record CSharpPrepareDiagnostic(string Code,string Message,int? Line,int? Column);
public sealed record CSharpPrepareResponse(string Status,CSharpToolchain Toolchain,CSharpPrepareDiagnostic[] Diagnostics);
public static class CSharpArtifactKeys
{
    public static bool Valid(string? value)=>value is {Length:64}&&value.All(c=>c is >= '0' and <= '9' or >= 'a' and <= 'f');
    public static string Hash(ReadOnlySpan<byte> bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    public static string Build(string sourceHash,string toolchain)=>Hash(Encoding.UTF8.GetBytes(sourceHash+"\n"+toolchain));
    public static string Toolchain(CSharpToolchain value)=>Hash(JsonSerializer.SerializeToUtf8Bytes(value with{Key="",References=new SortedDictionary<string,string>(value.References,StringComparer.Ordinal)}));
}
