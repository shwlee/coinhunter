using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CoinHunter.CSharp.Analysis;

public sealed record GuardSite(string Kind, int Line, int Column);

internal sealed class BudgetRewriter(SemanticModel model) : CSharpSyntaxRewriter
{
    public List<GuardSite> Sites { get; } = [];
    private ExpressionSyntax Checked(SyntaxNode node,string name,IEnumerable<ArgumentSyntax> args,IEnumerable<TypeSyntax>? types=null)
    {
        var p=node.GetLocation().GetLineSpan().StartLinePosition;
        Sites.Add(new("checked-"+name,p.Line+1,p.Character+1));
        var method=name+(types is null?"":"<"+string.Join(",",types.Select(t=>t.ToString()))+">");
        return SyntaxFactory.InvocationExpression(SyntaxFactory.ParseExpression("global::CoinHunter.CSharp.Analysis.CheckedOperations."+method),
            SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(args.Concat(new[]{
                SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(SyntaxKind.NumericLiteralExpression,SyntaxFactory.Literal(p.Line+1))).WithNameColon(SyntaxFactory.NameColon("__line")),
                SyntaxFactory.Argument(SyntaxFactory.LiteralExpression(SyntaxKind.NumericLiteralExpression,SyntaxFactory.Literal(p.Character+1))).WithNameColon(SyntaxFactory.NameColon("__column"))}))));
    }
    public override SyntaxNode? VisitArrayCreationExpression(ArrayCreationExpressionSyntax node)
    {
        var rewritten=(ArrayCreationExpressionSyntax)base.VisitArrayCreationExpression(node)!;
        var type=(IArrayTypeSymbol)model.GetTypeInfo(node).Type!;
        if(rewritten.Initializer is not null)return WrapInitializer(node,rewritten,rewritten.Initializer.Expressions.Count,type.ElementType);
        if(rewritten.Type.RankSpecifiers[0].Sizes[0] is OmittedArraySizeExpressionSyntax)return rewritten;
        var rank=rewritten.Type.RankSpecifiers[0];
        return rewritten.WithType(rewritten.Type.WithRankSpecifiers(SyntaxFactory.SingletonList(rank.WithSizes(SyntaxFactory.SingletonSeparatedList(Checked(node,"ArrayLength",[SyntaxFactory.Argument(rank.Sizes[0]),SyntaxFactory.Argument(Number(ElementBytes(type.ElementType))).WithNameColon(SyntaxFactory.NameColon("__elementBytes"))]))))));
    }
    private static LiteralExpressionSyntax Number(int value)=>SyntaxFactory.LiteralExpression(SyntaxKind.NumericLiteralExpression,SyntaxFactory.Literal(value));
    private static int ElementBytes(ITypeSymbol type)=>type.SpecialType switch{SpecialType.System_Boolean=>1,SpecialType.System_Char=>2,SpecialType.System_Int32=>4,_=>8};
    private ExpressionSyntax WrapInitializer(SyntaxNode node,ExpressionSyntax array,int count,ITypeSymbol element)=>SyntaxFactory.ParenthesizedExpression(SyntaxFactory.ConditionalExpression(Checked(node,"AllowArrayAllocation",[SyntaxFactory.Argument(Number(count)),SyntaxFactory.Argument(Number(ElementBytes(element)))]),array,SyntaxFactory.LiteralExpression(SyntaxKind.NullLiteralExpression)));
    public override SyntaxNode? VisitImplicitArrayCreationExpression(ImplicitArrayCreationExpressionSyntax node)
    {
        var rewritten=(ImplicitArrayCreationExpressionSyntax)base.VisitImplicitArrayCreationExpression(node)!;
        return WrapInitializer(node,rewritten,rewritten.Initializer.Expressions.Count,((IArrayTypeSymbol)model.GetTypeInfo(node).Type!).ElementType);
    }
    public override SyntaxNode? VisitInitializerExpression(InitializerExpressionSyntax node)
    {
        var rewritten=(InitializerExpressionSyntax)base.VisitInitializerExpression(node)!;
        if(!node.IsKind(SyntaxKind.ArrayInitializerExpression)||node.Parent is not EqualsValueClauseSyntax)return rewritten;
        var info=model.GetTypeInfo(node);var type=(IArrayTypeSymbol)(info.ConvertedType??info.Type)!;
        var array=SyntaxFactory.ArrayCreationExpression((ArrayTypeSyntax)SyntaxFactory.ParseTypeName(type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)),rewritten);
        return WrapInitializer(node,array,rewritten.Expressions.Count,type.ElementType);
    }
    public override SyntaxNode? VisitObjectCreationExpression(ObjectCreationExpressionSyntax node)
    {
        var rewritten=(ObjectCreationExpressionSyntax)base.VisitObjectCreationExpression(node)!;
        var method=(IMethodSymbol)model.GetSymbolInfo(node).Symbol!;
        var type=method.ContainingType;
        return type.ContainingNamespace.ToDisplayString()=="System.Collections.Generic"
            ? Checked(node,"Create"+type.Name,rewritten.ArgumentList!.Arguments) : rewritten;
    }
    public override SyntaxNode? VisitInvocationExpression(InvocationExpressionSyntax node)
    {
        var rewritten=(InvocationExpressionSyntax)base.VisitInvocationExpression(node)!;
        var method=(IMethodSymbol)model.GetSymbolInfo(node).Symbol!;
        var type=method.ContainingType;
        if(PlayerDebugSdk.IsPrint(method))return Checked(node,"DebugPrint",rewritten.ArgumentList.Arguments,[SyntaxFactory.ParseTypeName(method.Parameters[0].Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat))]);
        if(type.ContainingNamespace.ToDisplayString()!="System.Collections.Generic")return rewritten;
        var key=type.Name+method.Name;
        if(key is not ("ListAdd" or "ListContains" or "ListIndexOf" or "ListRemove" or "ListRemoveAt" or "QueueEnqueue" or "QueueContains" or "HashSetAdd" or "DictionaryAdd" or "PriorityQueueEnqueue"))return rewritten;
        var member=(MemberAccessExpressionSyntax)rewritten.Expression;
        return Checked(node,key,new[]{SyntaxFactory.Argument(member.Expression)}.Concat(rewritten.ArgumentList.Arguments));
    }
    public override SyntaxNode? VisitBinaryExpression(BinaryExpressionSyntax node)
    {
        var rewritten=(BinaryExpressionSyntax)base.VisitBinaryExpression(node)!;
        if(model.GetConstantValue(node).HasValue)return rewritten;
        return node.IsKind(SyntaxKind.AddExpression)&&model.GetTypeInfo(node).Type?.SpecialType==SpecialType.System_String
            ? Checked(node,"StringConcat",[SyntaxFactory.Argument(rewritten.Left),SyntaxFactory.Argument(rewritten.Right)],new[]{node.Left,node.Right}.Select(e=>SyntaxFactory.ParseTypeName((model.GetTypeInfo(e).Type?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat))??"string"))) : rewritten;
    }
    private BlockSyntax Guard(SyntaxNode original, StatementSyntax statement)
    {
        var p = original.GetLocation().GetLineSpan().StartLinePosition;
        Sites.Add(new(original.Kind().ToString(), p.Line + 1, p.Character + 1));
        var check = SyntaxFactory.ParseStatement($"global::CoinHunter.CSharp.Analysis.BudgetGuard.Poll({p.Line + 1},{p.Character + 1});");
        return statement is BlockSyntax block ? block.WithStatements(block.Statements.Insert(0, check)) : SyntaxFactory.Block(check, statement);
    }
    public override SyntaxNode? VisitMethodDeclaration(MethodDeclarationSyntax node)
    {
        var rewritten = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node)!;
        var body = rewritten.Body;
        if (body is null)
        {
            var expression = rewritten.ExpressionBody!.Expression;
            StatementSyntax statement = rewritten.ReturnType is PredefinedTypeSyntax t && t.Keyword.IsKind(SyntaxKind.VoidKeyword)
                ? SyntaxFactory.ExpressionStatement(expression) : SyntaxFactory.ReturnStatement(expression);
            body = SyntaxFactory.Block(statement);
        }
        return rewritten.WithBody(Guard(node, body)).WithExpressionBody(null).WithSemicolonToken(default);
    }
    public override SyntaxNode? VisitWhileStatement(WhileStatementSyntax node)
    {
        var r = (WhileStatementSyntax)base.VisitWhileStatement(node)!;
        return r.WithStatement(Guard(node, r.Statement));
    }
    public override SyntaxNode? VisitForStatement(ForStatementSyntax node)
    {
        var r = (ForStatementSyntax)base.VisitForStatement(node)!;
        return r.WithStatement(Guard(node, r.Statement));
    }
    public override SyntaxNode? VisitDoStatement(DoStatementSyntax node)
    {
        var r = (DoStatementSyntax)base.VisitDoStatement(node)!;
        return r.WithStatement(Guard(node, r.Statement));
    }
    public override SyntaxNode? VisitForEachStatement(ForEachStatementSyntax node)
    {
        var r = (ForEachStatementSyntax)base.VisitForEachStatement(node)!;
        return r.WithStatement(Guard(node, r.Statement));
    }
}
