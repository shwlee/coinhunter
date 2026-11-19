using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CoinHunter.CSharp.Analysis;

public sealed record PolicyDiagnostic(string Code, string Message, int Line, int Column);
public sealed record AnalysisResult(string SourceHash, string Profile, bool StaticPassed, bool ExecutionAllowed, IReadOnlyList<PolicyDiagnostic> Diagnostics)
{
    public string PolicyVersion => "authoring-policy-v1";
    public string AnalyzerVersion => "c1-2";
    public string RuntimeVersion => Environment.Version.ToString();
    public string RoslynVersion => typeof(CSharpCompilation).Assembly.GetName().Version!.ToString();
}

// Candidate profile only. No user assembly is emitted, loaded or executed here.
public static class PlayerAnalyzer
{
    public const string Profile = "csharp-restricted-c1-v2";
    private static readonly HashSet<string> Syntax = new(StringComparer.Ordinal)
    {
        "CompilationUnit", "UsingDirective", "NameEquals", "QualifiedName", "AliasQualifiedName", "IdentifierName", "GenericName", "TypeArgumentList",
        "ClassDeclaration", "FieldDeclaration", "VariableDeclaration", "VariableDeclarator", "EqualsValueClause", "MethodDeclaration", "ArrowExpressionClause",
        "ParameterList", "Parameter", "PredefinedType", "ArrayType", "ArrayRankSpecifier", "OmittedArraySizeExpression",
        "Block", "LocalDeclarationStatement", "ExpressionStatement", "ReturnStatement", "IfStatement", "ElseClause", "ForStatement", "WhileStatement", "DoStatement",
        "BreakStatement", "ContinueStatement", "EmptyStatement", "ForEachStatement", "SwitchStatement", "SwitchSection", "CaseSwitchLabel", "DefaultSwitchLabel",
        "NumericLiteralExpression", "StringLiteralExpression", "CharacterLiteralExpression", "TrueLiteralExpression", "FalseLiteralExpression", "NullLiteralExpression",
        "ParenthesizedExpression", "ThisExpression", "InvocationExpression", "ArgumentList", "Argument", "NameColon", "SimpleMemberAccessExpression",
        "ElementAccessExpression", "BracketedArgumentList", "ObjectCreationExpression", "ArrayCreationExpression", "ImplicitArrayCreationExpression", "ArrayInitializerExpression",
        "AddExpression", "SubtractExpression", "MultiplyExpression", "DivideExpression", "ModuloExpression", "LeftShiftExpression", "RightShiftExpression",
        "BitwiseAndExpression", "BitwiseOrExpression", "ExclusiveOrExpression", "LogicalAndExpression", "LogicalOrExpression", "EqualsExpression", "NotEqualsExpression",
        "LessThanExpression", "LessThanOrEqualExpression", "GreaterThanExpression", "GreaterThanOrEqualExpression", "ConditionalExpression", "CoalesceExpression",
        "SimpleAssignmentExpression", "AddAssignmentExpression", "SubtractAssignmentExpression", "MultiplyAssignmentExpression", "DivideAssignmentExpression", "ModuloAssignmentExpression",
        "PreIncrementExpression", "PreDecrementExpression", "PostIncrementExpression", "PostDecrementExpression", "UnaryPlusExpression", "UnaryMinusExpression", "LogicalNotExpression", "BitwiseNotExpression", "CastExpression"
    };
    internal static readonly Lazy<MetadataReference[]> References = new(() =>
    {
        // Only the host runtime's fixed core/collection metadata. No submitted paths or dependencies.
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var names = new[] { "System.Private.CoreLib.dll", "System.Runtime.dll", "System.Collections.dll" };
        return names.Select(name => MetadataReference.CreateFromFile(Path.Combine(runtimeDirectory, name))).ToArray();
    });
    private static bool Scalar(ITypeSymbol type) => type.SpecialType is SpecialType.System_Int32 or SpecialType.System_Int64 or SpecialType.System_Double or SpecialType.System_Boolean or SpecialType.System_Char or SpecialType.System_String or SpecialType.System_Void;
    private static bool Collection(ITypeSymbol type) => type is INamedTypeSymbol n && n.ContainingNamespace.ToDisplayString() == "System.Collections.Generic" &&
        n.Name is "Queue" or "List" or "HashSet" or "Dictionary" or "PriorityQueue" && n.TypeArguments.All(t => t.SpecialType == SpecialType.System_Int32);
    private static bool AllowedType(ITypeSymbol type) => Scalar(type) || type is IArrayTypeSymbol a && a.Rank == 1 && Scalar(a.ElementType) || Collection(type);
    private static bool Api(IMethodSymbol method)
    {
        var type = method.ContainingType;
        if (type.ToDisplayString() == "System.Math") return method.Name is "Abs" or "Min" or "Max" or "Clamp" or "Sqrt" or "Pow" or "Floor" or "Ceiling" && method.Parameters.All(p => Scalar(p.Type));
        if (!Collection(type)) return false;
        if (method.MethodKind == MethodKind.Constructor) return method.Parameters.Length == 0 || method.Parameters.Length == 1 && method.Parameters[0].Type.SpecialType == SpecialType.System_Int32;
        if (method.Parameters.Any(p => p.RefKind != RefKind.None || !Scalar(p.Type))) return false;
        return (type.Name, method.Name) switch
        {
            ("Queue", "Enqueue" or "Dequeue" or "Peek" or "Clear" or "Contains") => true,
            ("List", "Add" or "Remove" or "RemoveAt" or "Clear" or "Contains" or "IndexOf") => true,
            ("HashSet", "Add" or "Remove" or "Clear" or "Contains") => true,
            ("Dictionary", "Add" or "Remove" or "Clear" or "ContainsKey") => true,
            ("PriorityQueue", "Enqueue" or "Dequeue" or "Peek" or "Clear") => true,
            _ => false
        };
    }
    public static AnalysisResult Analyze(string source, CancellationToken cancellationToken = default)
    {
        var diagnostics = new List<PolicyDiagnostic>();
        void Add(string code, string message, Location location)
        {
            var p = location.GetLineSpan().StartLinePosition;
            diagnostics.Add(new(code, message, p.Line + 1, p.Character + 1));
        }
        AnalysisResult Result() => new(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))).ToLowerInvariant(), Profile,
            diagnostics.Count == 0, false, diagnostics.Distinct().OrderBy(d => d.Line).ThenBy(d => d.Column).ThenBy(d => d.Code).ToArray());
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12), cancellationToken: cancellationToken);
        foreach (var error in tree.GetDiagnostics(cancellationToken).Where(d => d.Severity == DiagnosticSeverity.Error)) Add("AX001", error.GetMessage(), error.Location);
        if (diagnostics.Count != 0) return Result();
        var root = tree.GetRoot(cancellationToken);
        foreach (var trivia in root.DescendantTrivia().Where(t => t.IsDirective)) Add("AP001", "전처리 지시문은 지원하지 않습니다.", trivia.GetLocation());
        foreach (var node in root.DescendantNodesAndSelf())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var code = node switch { TryStatementSyntax => "AR011", GotoStatementSyntax => "AR010", AwaitExpressionSyntax => "AR004", _ => "AP001" };
            if (!Syntax.Contains(node.Kind().ToString())) Add(code, "허용 프로필에 없는 구문: " + node.Kind(), node.GetLocation());
            foreach (var token in node.ChildTokens())
                if (token.IsKind(SyntaxKind.StaticKeyword) && node is not UsingDirectiveSyntax) Add("AR003", "사용자 static 선언은 금지됩니다.", token.GetLocation());
                else if (token.IsKind(SyntaxKind.AsyncKeyword)) Add("AR004", "비동기 실행은 금지됩니다.", token.GetLocation());
                else if (token.Kind() is SyntaxKind.VirtualKeyword or SyntaxKind.OverrideKeyword or SyntaxKind.AbstractKeyword or SyntaxKind.UnsafeKeyword or SyntaxKind.ExternKeyword or SyntaxKind.PartialKeyword or SyntaxKind.RefKeyword or SyntaxKind.OutKeyword || token.IsKind(SyntaxKind.InKeyword) && node is ParameterSyntax)
                    Add("AP001", "허용 프로필에 없는 선언 한정자입니다.", token.GetLocation());
        }
        var classes = root.DescendantNodes().OfType<ClassDeclarationSyntax>().ToArray();
        if (classes.Length != 1 || classes[0].Identifier.ValueText != "Player" || classes[0].Parent != root || classes[0].TypeParameterList is not null || classes[0].BaseList is not null)
            Add("AR013", "전역 Player 클래스 하나가 필요하며 상속/제네릭 클래스는 지원하지 않습니다.", root.GetLocation());
        if (diagnostics.Count != 0) return Result();
        var compilation = CSharpCompilation.Create("Candidate", [tree], References.Value, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: false));
        foreach (var error in compilation.GetDiagnostics(cancellationToken).Where(d => d.Severity == DiagnosticSeverity.Error)) Add("AX001", error.GetMessage(), error.Location);
        if (diagnostics.Count != 0) return Result();
        var model = compilation.GetSemanticModel(tree);
        var player = (INamedTypeSymbol)model.GetDeclaredSymbol(classes[0], cancellationToken)!;
        if (player.DeclaredAccessibility != Accessibility.Public) Add("AR013", "Player 클래스는 public이어야 합니다.", classes[0].GetLocation());
        bool Own(ISymbol s) => SymbolEqualityComparer.Default.Equals(s.ContainingType, player);
        var methods = classes[0].Members.OfType<MethodDeclarationSyntax>().Select(m => (Syntax: m, Symbol: model.GetDeclaredSymbol(m, cancellationToken)!)).ToArray();
        foreach (var (name, returns, parameters) in new[] { ("Initialize", "void", new[] { "int", "int", "int" }), ("GetName", "string", Array.Empty<string>()), ("MoveNext", "int", new[] { "int[]", "int", "int[]" }) })
        {
            var matches = methods.Where(m => m.Symbol.Name == name).ToArray();
            if (matches.Length != 1 || matches[0].Symbol.DeclaredAccessibility != Accessibility.Public || matches[0].Symbol.IsStatic || matches[0].Symbol.ReturnType.ToDisplayString() != returns || !matches[0].Symbol.Parameters.Select(p => p.Type.ToDisplayString()).SequenceEqual(parameters))
                Add("AR013", "필수 서명을 확인하세요: " + name, classes[0].GetLocation());
        }
        var edges = new Dictionary<ISymbol, HashSet<ISymbol>>(SymbolEqualityComparer.Default);
        foreach (var m in methods) edges[m.Symbol] = new(SymbolEqualityComparer.Default);
        foreach (var node in root.DescendantNodes())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if(node is ArrayCreationExpressionSyntax or ImplicitArrayCreationExpressionSyntax)
            {
                if(model.GetTypeInfo(node,cancellationToken).Type is not IArrayTypeSymbol a || a.Rank!=1 || !Scalar(a.ElementType)) Add("AP001","허용된 1차원 값 배열만 생성할 수 있습니다.",node.GetLocation());
                var initializer=node is ArrayCreationExpressionSyntax ac ? ac.Initializer : ((ImplicitArrayCreationExpressionSyntax)node).Initializer;
                if(initializer?.Expressions.Count>CheckedOperations.MaxArrayElements) Add("AP001","배열 초기화 요소 한도를 넘었습니다.",node.GetLocation());
                if(node is ArrayCreationExpressionSyntax sized)
                    foreach(var size in sized.Type.RankSpecifiers.SelectMany(r=>r.Sizes))
                        if(model.GetConstantValue(size,cancellationToken) is {HasValue:true,Value:{ } n} && n is int or long or uint or ulong && Convert.ToDecimal(n)>CheckedOperations.MaxArrayElements)Add("AP001","단일 배열 요소 한도는 "+CheckedOperations.MaxArrayElements+"개입니다.",size.GetLocation());
            }
            if(node is ElementAccessExpressionSyntax element && model.GetSymbolInfo(element,cancellationToken).Symbol is IPropertySymbol prop && prop.ContainingType.Name=="Dictionary")
            {
                SyntaxNode target=element;while(target.Parent is ParenthesizedExpressionSyntax)target=target.Parent;
                if(target.Parent is AssignmentExpressionSyntax assignment && assignment.Left==target || target.Parent?.Kind() is SyntaxKind.PreIncrementExpression or SyntaxKind.PreDecrementExpression or SyntaxKind.PostIncrementExpression or SyntaxKind.PostDecrementExpression)
                    Add("AP001","사전 인덱서 변경은 미지원입니다. 추가는 Add 메서드를 사용하세요.",element.GetLocation());
            }
            if (node is VariableDeclarationSyntax variable && model.GetTypeInfo(variable.Type, cancellationToken).Type is { } variableType && !AllowedType(variableType)) Add("AR002", "허용되지 않은 변수/필드 타입입니다.", node.GetLocation());
            if (node is ParameterSyntax parameter && parameter.Type is { } pt && model.GetTypeInfo(pt, cancellationToken).Type is { } parameterType && !AllowedType(parameterType)) Add("AR002", "허용되지 않은 매개변수 타입입니다.", node.GetLocation());
            if (node is MethodDeclarationSyntax declaration && !AllowedType(model.GetDeclaredSymbol(declaration, cancellationToken)!.ReturnType)) Add("AR002", "허용되지 않은 반환 타입입니다.", node.GetLocation());
            if (node is ForEachStatementSyntax loop && model.GetTypeInfo(loop.Expression, cancellationToken).Type is not IArrayTypeSymbol) Add("AP001", "foreach는 배열에만 허용됩니다.", node.GetLocation());
            if (node is InvocationExpressionSyntax or ObjectCreationExpressionSyntax)
            {
                var target = model.GetSymbolInfo(node, cancellationToken).Symbol as IMethodSymbol;
                if (target is null) { Add("AP001", "호출 대상을 확정할 수 없습니다.", node.GetLocation()); continue; }
                if(node is ObjectCreationExpressionSyntax created && Collection(target.ContainingType) && created.ArgumentList?.Arguments.Count==1 && model.GetConstantValue(created.ArgumentList.Arguments[0].Expression,cancellationToken) is {HasValue:true,Value:int capacity} && capacity>CheckedOperations.MaxCollectionCount)
                    Add("AP001","컬렉션 용량 한도는 "+CheckedOperations.MaxCollectionCount+"개입니다.",created.GetLocation());
                if (Own(target) && target.MethodKind == MethodKind.Ordinary)
                {
                    var ownerSyntax = node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault();
                    if (ownerSyntax is null) Add("AP001", "필드 초기화에서 사용자 메서드 호출은 지원하지 않습니다.", node.GetLocation());
                    else edges[model.GetDeclaredSymbol(ownerSyntax, cancellationToken)!].Add(target.OriginalDefinition);
                }
                else if (!Api(target)) Add("AR002", "승인되지 않은 메서드/생성자: " + target.Name, node.GetLocation());
            }
            if (node is SimpleNameSyntax simple && model.GetSymbolInfo(simple, cancellationToken).Symbol is { } symbol)
            {
                if (symbol is IPropertySymbol property && !(Collection(property.ContainingType) && property.Name is "Count" or "Item") && !(property.ContainingType.SpecialType == SpecialType.System_Array && property.Name == "Length") && !(property.ContainingType.SpecialType == SpecialType.System_String && property.Name == "Length")) Add("AR002", "승인되지 않은 속성입니다.", node.GetLocation());
                if (symbol is IFieldSymbol field && !Own(field) && !(field.IsConst && Scalar(field.ContainingType))) Add("AR002", "승인되지 않은 필드입니다.", node.GetLocation());
            }
        }
        foreach (var start in edges.Keys)
        {
            var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default); var queue = new Queue<ISymbol>(edges[start]);
            while (queue.TryDequeue(out var next))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (SymbolEqualityComparer.Default.Equals(start, next)) { Add("AR009", "직접/상호 재귀 호출은 금지됩니다.", start.Locations[0]); break; }
                if (seen.Add(next) && edges.TryGetValue(next, out var children)) foreach (var child in children) queue.Enqueue(child);
            }
        }
        return Result();
    }
}
