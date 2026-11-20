using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;

namespace CoinHunter.Execution.Host.Services;

// Immutable internal experiment, captured at admission; never a browser option.
internal sealed record CSharpGcGameLaunch(ResourceProfile Member, CSharpGcGameAdmission Admission,bool EntryCollection)
{
    internal static CSharpGcGameLaunch? Create(IConfiguration configuration, ExecutionRequest request, IExecutionResourceGroup scope, ResourceProfile game)
    {
        if (!configuration.GetValue("Backend:CSharpGameCandidate:ExperimentalGcWindow", false)) return null;
        long Bytes(string key,int fallback,int minimum)
        {
            int value=configuration.GetValue("Backend:CSharpGameCandidate:"+key,fallback);
            if(value<minimum||value>4096)throw new InvalidOperationException("Invalid experimental C# game resource setting: "+key);
            return value*1024L*1024;
        }
        var member=new ResourceProfile("csharp-gc-game-member-v1",Bytes("GcMemberMemoryMiB",768,384),OperatingSystem.IsWindows()?1:128,10000);
        // All Node/QuickJS workers belong to this engine scope, including JS opponents.
        var engine=new ResourceProfile("csharp-gc-engine-v1",Bytes("GcEngineMemoryMiB",512,128),checked((OperatingSystem.IsWindows()?1:128)*(1+request.Participants.Count(p=>p.Language=="javascript"))),10000);
        return new(member,CSharpGcGameAdmission.Create(scope,game,engine,request.Participants.Where(p=>p.Language=="csharp").Select(_=>member).ToArray()),configuration.GetValue("Backend:CSharpGameCandidate:GcEntryCollection",false));
    }
}
