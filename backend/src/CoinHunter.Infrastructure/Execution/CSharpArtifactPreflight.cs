using System.Text.Json;
using CoinHunter.Contracts;

namespace CoinHunter.Infrastructure.Execution;

public sealed record CSharpPreflightDiagnostic(string Code,string Phase,string Status,string Scenario,int Player,int? Turn,long? CallId,double? ElapsedMs,double? LimitMs,int? Line,int? Column);
public sealed record CSharpPreflightReport(Guid Owner,string Key,string SourceHash,string ToolchainKey,string Profile,string FixtureVersion,string FixtureHash,string Status,int CheckedCalls,CSharpPreflightDiagnostic? Diagnostic)
{
    // Passing finite fixtures is not the C5 language activation gate.
    public bool ExecutionAllowed=>false;
}
public sealed class CSharpArtifactPreflight(CSharpPreparationStore store,CSharpHostManager manager)
{
    public const string Profile="csharp-artifact-preflight-v1";
    private sealed record Fixture(string Scenario,int Columns,int Rows,int[] Tiles,int[] Players,bool AbsentItems);
    private sealed record Fixtures(string Version,Fixture[] Scenarios);
    public async Task<CSharpPreflightReport> CheckAsync(CSharpPreparedLaunch launch,string fixturePath,CancellationToken token=default)
    {
        if(new FileInfo(fixturePath).Length>1024*1024)throw new InvalidDataException("Fixture document too large.");
        var bytes=await File.ReadAllBytesAsync(fixturePath,token);
        var fixtures=JsonSerializer.Deserialize<Fixtures>(bytes,new JsonSerializerOptions{PropertyNameCaseInsensitive=true})??throw new InvalidDataException("Missing fixtures.");
        if(fixtures.Version!="2.0.0"||fixtures.Scenarios is null||fixtures.Scenarios.Length!=6||fixtures.Scenarios.Any(f=>f is null||string.IsNullOrWhiteSpace(f.Scenario)||f.Columns is <2 or >40||f.Rows is <2 or >30||f.Tiles is null||f.Tiles.Length!=f.Columns*f.Rows||f.Players is null||f.Players.Length is <1 or >4||f.Players.Any(p=>p is <0 or >3)||f.Players.Distinct().Count()!=f.Players.Length)||fixtures.Scenarios.Sum(f=>f.Players.Length)!=12||fixtures.Scenarios.Select(f=>f.Scenario).Distinct(StringComparer.Ordinal).Count()!=6)throw new InvalidDataException("Unsupported fixture set.");
        using var lease=await store.AcquireAsync(launch.Owner,launch.Key,token);
        var manifest=lease.Manifest;int calls=0;CSharpPreflightDiagnostic? diagnostic=null;string status="passed";
        foreach(var fixture in fixtures.Scenarios)
        {
            foreach(int player in fixture.Players)
            {
                var failure=await CheckScenario(fixture,player);
                if(failure is not null){diagnostic=failure;status=failure.Code=="AX004"?"unverified":"failed";break;}
            }
            if(diagnostic is not null)break;
        }
        return new(launch.Owner,launch.Key,manifest.SourceHash,manifest.Toolchain.Key,Profile,fixtures.Version,CSharpArtifactKeys.Hash(bytes),status,calls,diagnostic);

        async Task<CSharpPreflightDiagnostic?> CheckScenario(Fixture fixture,int player)
        {
            CSharpHostSession? session=null;CSharpPreflightDiagnostic? failure=null;int? turn=null;
            try
            {
                token.ThrowIfCancellationRequested();
                session=await manager.CreatePreparedAsync(store,launch with{PlayerNumber=player,Columns=fixture.Columns,Rows=fixture.Rows},token);
                int[] starts=[0,fixture.Columns-1,fixture.Columns*(fixture.Rows-1),fixture.Tiles.Length-1];int position=starts[player];var tiles=(int[])fixture.Tiles.Clone();
                for(int t=0;t<3;t++)
                {
                    turn=t+1;if(t==2)for(int i=0;i<tiles.Length;i++)if(tiles[i]>0)tiles[i]=0;
                    var items=t==1&&!fixture.AbsentItems?(int[])starts.Clone():[-1,-1,-1,-1];
                    var result=await session.MoveNextAsync(tiles,position,items,token);
                    if(result.Status!="ok")
                    {
                        failure=FromStatus("moveNext",result.Status,result.CallId,result.ElapsedMs,result.BudgetMs,result.Line,result.Column);break;
                    }
                    calls++;int direction=result.Direction!.Value;
                    if(direction!=-1)
                    {
                        int next=position+new[]{-1,-fixture.Columns,1,fixture.Columns}[direction];
                        if(next>=0&&next<tiles.Length&&tiles[next]!=-1&&!(direction==0&&position%fixture.Columns==0)&&!(direction==2&&position%fixture.Columns==fixture.Columns-1)){position=next;tiles[position]=0;}
                    }
                }
            }
            catch(CSharpHostFailure e)when(e.CleanupConfirmed&&e.Fault is {Status:"timeout" or "exception" or "invalid-result" or "operation-limit"})
            {var f=e.Fault!;failure=FromStatus(f.Phase,f.Status,null,f.ElapsedMs,f.BudgetMs,f.Line,f.Column);}
            catch(OperationCanceledException){failure=new("AX004","infrastructure","cancelled",fixture.Scenario,player,turn,null,null,null,null,null);}
            catch(Exception e)when(e is IOException or InvalidOperationException or UnauthorizedAccessException or Storage.ServiceFault)
            {failure=new("AX004","infrastructure",e is CSharpHostFailure hostFailure?hostFailure.Reason:"host-unavailable",fixture.Scenario,player,turn,null,null,null,null,null);}
            finally
            {
                if(session is not null)
                {
                    var close=await session.StopAsync("preflight-complete");
                    if(!close.CleanupConfirmed)failure=new("AX004","cleanup","cleanup-unconfirmed",fixture.Scenario,player,turn,null,null,null,null,null);
                }
            }
            return failure;
            CSharpPreflightDiagnostic FromStatus(string phase,string callStatus,long? id,double elapsed,double budget,int? line,int? column)
            {
                var code=callStatus switch{"timeout"=>"AR012","invalid-result"=>"AR013","operation-limit"=>"AX003","exception"=>"AX002",_=>"AX004"};
                return new(code,phase,callStatus,fixture.Scenario,player,turn,id,elapsed,budget,line,column);
            }
        }
    }
}

public interface ICSharpPreflightReportStore
{
    Task WriteAsync(CSharpPreflightReport report,CancellationToken token=default);
    Task<CSharpPreflightReport?> ReadAsync(Guid owner,string key,string fixtureHash,CancellationToken token=default);
}
// Metadata-only adapter; source and DLL remain in their file stores. The account
// revision/state CAS adapter will consume this contract in a later integration.
public sealed class FileCSharpPreflightReportStore(string root) : ICSharpPreflightReportStore
{
    private readonly string directory=Path.GetFullPath(root);
    private string PathFor(Guid owner,string key,string fixture)
    {if(owner==Guid.Empty||!CSharpArtifactKeys.Valid(key)||!CSharpArtifactKeys.Valid(fixture))throw new ArgumentException("Invalid report identity.");return Path.Combine(directory,owner.ToString("N"),key,fixture+".json");}
    public async Task WriteAsync(CSharpPreflightReport report,CancellationToken token=default)
    {
        if(!Valid(report))throw new ArgumentException("Invalid report metadata.");
        token.ThrowIfCancellationRequested();var path=PathFor(report.Owner,report.Key,report.FixtureHash);
        await Storage.AtomicFile.Json(path,JsonSerializer.SerializeToNode(report)!.AsObject());
    }
    public async Task<CSharpPreflightReport?> ReadAsync(Guid owner,string key,string fixtureHash,CancellationToken token=default)
    {
        var path=PathFor(owner,key,fixtureHash);if(!File.Exists(path))return null;
        if(new FileInfo(path).Length>65536)throw new InvalidDataException("Preflight report too large.");
        await using var file=File.OpenRead(path);var report=await JsonSerializer.DeserializeAsync<CSharpPreflightReport>(file,cancellationToken:token)??throw new InvalidDataException("Missing preflight report.");
        if(report.Owner!=owner||report.Key!=key||report.FixtureHash!=fixtureHash||!Valid(report))throw new InvalidDataException("Preflight report identity mismatch.");
        return report;
    }
    private static bool Valid(CSharpPreflightReport report)=>report.Profile==CSharpArtifactPreflight.Profile&&report.FixtureVersion=="2.0.0"&&!report.ExecutionAllowed&&CSharpArtifactKeys.Valid(report.SourceHash)&&CSharpArtifactKeys.Valid(report.ToolchainKey)&&report.Key==CSharpArtifactKeys.Build(report.SourceHash,report.ToolchainKey)&&report.Status is "passed" or "failed" or "unverified"&&report.CheckedCalls is >=0 and <=36&&(report.Status=="passed"?report.CheckedCalls==36&&report.Diagnostic is null:report.Diagnostic is not null);
}
