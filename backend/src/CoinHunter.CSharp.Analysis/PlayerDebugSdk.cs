using Microsoft.CodeAnalysis.CSharp;

namespace CoinHunter.CSharp.Analysis;

// Compile-time signatures only. User source cannot reference the host assembly;
// resolved calls to this exact tree are rewritten to the host-owned log sink.
internal static class PlayerDebugSdk
{
    internal static readonly Microsoft.CodeAnalysis.SyntaxTree Tree=CSharpSyntaxTree.ParseText("""
        public static class Debug {
          public static void Print(string value) {} public static void Print(int value) {}
          public static void Print(long value) {} public static void Print(double value) {}
          public static void Print(bool value) {} public static void Print(char value) {}
        }
        """,new CSharpParseOptions(Microsoft.CodeAnalysis.CSharp.LanguageVersion.CSharp12));
    internal static bool IsPrint(Microsoft.CodeAnalysis.IMethodSymbol method)=>method.ContainingType.Name=="Debug"&&method.Name=="Print"&&method.Locations.Any(l=>l.SourceTree==Tree);
}
