using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Infrastructure.Execution;

// Experimental-only, immutable whole-game plan. Each player launch is consumed
// once for the game lifetime; a stopped/failed actor is never silently replaced.
internal sealed class CSharpGcGameAdmission
{
    internal const long RequestedGcBytes=256L*1024*1024;
    internal const long RuntimeHeadroomBytes=128L*1024*1024;
    private readonly IExecutionResourceGroup parent;
    private readonly ResourceProfile engine;
    private readonly ResourceProfile[] members;
    private readonly bool[] claimed;
    private readonly object gate=new();
    private bool engineCreated;
    internal long RequiredMemoryBytes { get; }
    internal int RequiredProcesses { get; }
    private CSharpGcGameAdmission(IExecutionResourceGroup parent,ResourceProfile engine,ResourceProfile[] members,long memory,int processes)
    {this.parent=parent;this.engine=engine;this.members=members;claimed=new bool[members.Length];RequiredMemoryBytes=memory;RequiredProcesses=processes;}
    internal static void ValidateMember(ResourceProfile profile)
    {
        profile.Validate();
        if(profile.MemoryBytes<RequestedGcBytes+RuntimeHeadroomBytes)throw new ArgumentException("Experimental GC host requires reservation plus runtime headroom.");
    }
    internal static CSharpGcGameAdmission Create(IExecutionResourceGroup parent,ResourceProfile game,ResourceProfile engine,IReadOnlyList<ResourceProfile> members)
    {
        game.Validate();engine.Validate();if(members.Count is <1 or >4)throw new ArgumentException("One to four GC members required.");
        foreach(var profile in members)ValidateMember(profile);
        var observed=parent.Observe();
        if(observed.MemoryLimitBytes!=game.MemoryBytes||observed.ProcessLimit!=game.ProcessCount||observed.CpuRate!=game.CpuRate)throw new ArgumentException("GC admission profile must match the actual parent scope.");
        long memory=checked(engine.MemoryBytes+members.Sum(p=>p.MemoryBytes));
        int processes=checked(engine.ProcessCount+members.Sum(p=>p.ProcessCount));
        if(memory>game.MemoryBytes||processes>game.ProcessCount)throw new ServiceFault(429,"GC 시험 게임의 실행기·엔진 합산 자원 예산이 부족합니다.");
        return new(parent,engine,members.ToArray(),memory,processes);
    }
    internal IExecutionResourceGroup CreateEngineScope()
    {
        lock(gate){if(engineCreated)throw new InvalidOperationException("Engine scope already claimed.");engineCreated=true;return parent.CreateChild(engine);}
    }
    internal CSharpGcPlayerAdmission Player(int index)
    {if(index<0||index>=members.Length)throw new ArgumentOutOfRangeException(nameof(index));return new(this,index);}
    internal void Claim(int index,IExecutionResourceGroup actualParent,ResourceProfile actualProfile)
    {
        lock(gate)
        {
            if(!engineCreated)throw new InvalidOperationException("Engine scope must be claimed before player hosts.");
            var expected=members[index];
            if(!ReferenceEquals(parent,actualParent)||expected.MemoryBytes!=actualProfile.MemoryBytes||expected.ProcessCount!=actualProfile.ProcessCount||expected.CpuRate!=actualProfile.CpuRate)throw new ArgumentException("GC launch does not match its game admission.");
            if(claimed[index])throw new InvalidOperationException("GC player launch already consumed; no in-game restart.");
            claimed[index]=true;
        }
    }
}
internal sealed class CSharpGcPlayerAdmission(CSharpGcGameAdmission plan,int index)
{internal void Claim(IExecutionResourceGroup parent,ResourceProfile member)=>plan.Claim(index,parent,member);}
