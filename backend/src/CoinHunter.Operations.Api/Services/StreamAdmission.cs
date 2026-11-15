using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public sealed class StreamAdmission
{
    private readonly object gate = new();
    private readonly Dictionary<string, int> active = new();
    private int count;
    public IDisposable Enter(string owner)
    {
        lock (gate)
        {
            if (count >= 32 || active.GetValueOrDefault(owner) >= 4) throw new ServiceFault(429, "게임 화면 연결 한도입니다. 다른 탭을 닫아 주세요.");
            count++; active[owner] = active.GetValueOrDefault(owner) + 1;
            return new Lease(() => { lock (gate) { count--; if (--active[owner] == 0) active.Remove(owner); } });
        }
    }
    private sealed class Lease(Action release) : IDisposable
    {
        private Action? cleanup = release;
        public void Dispose() => Interlocked.Exchange(ref cleanup, null)?.Invoke();
    }
}
