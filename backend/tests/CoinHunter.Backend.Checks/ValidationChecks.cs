using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;

internal static class ValidationChecks
{
    public static async Task<int> Run(AccountService accounts, StorageSettings settings, GameContent content, BackendSettings backend)
    {
        void Require(bool condition) { if (!condition) throw new Exception("Validation lifecycle assertion failed."); }
        var exchange = new FileSourceStore(settings.ExchangeRoot);
        var reservedKey = Guid.NewGuid();
        await exchange.PutReserved(new MemoryStream(Encoding.UTF8.GetBytes("original")), reservedKey);
        try { await exchange.PutReserved(new MemoryStream(Encoding.UTF8.GetBytes("replacement")), reservedKey); throw new Exception("Reserved key overwrite was admitted."); }
        catch (IOException) { }
        Require(await File.ReadAllTextAsync(exchange.PathFor(reservedKey)) == "original");
        await exchange.Delete(reservedKey);
        var collisionKey = Guid.NewGuid(); var temporary = exchange.PathFor(collisionKey) + ".tmp";
        await File.WriteAllTextAsync(temporary, "other-writer");
        try { await exchange.PutReserved(new MemoryStream([1, 2, 3]), collisionKey); throw new Exception("Temporary collision was admitted."); }
        catch (IOException) { }
        Require(await File.ReadAllTextAsync(temporary) == "other-writer"); File.Delete(temporary);
        Console.WriteLine("PASS reserved snapshot collisions preserve existing source and foreign temporary bytes");
        using var transport = new HeldValidationTransport();
        using var service = new AlgorithmValidationService(accounts, settings, content, new ExecutionClient(transport, backend));
        var records = new List<(string Owner, JsonObject Item, SourceReference Source)>();
        for (var i = 0; i < 21; i++)
        {
            var user = await accounts.Login($"validation-{i}@company.test");
            var source = await accounts.Sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("trusted-fixture-" + i)));
            var saved = await accounts.Save(user.Text("id"), null, "queue fixture", 0, source.SourceKey, source.Sha256);
            records.Add((user.Text("id"), saved, source));
        }
        await service.StartAsync(CancellationToken.None);
        try
        {
            var first = records[0];
            await service.Queue(first.Owner, first.Item, first.Source.SourceKey);
            await transport.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            foreach (var entry in records.Skip(1)) await service.Queue(entry.Owner, entry.Item, entry.Source.SourceKey);
            var states = await Task.WhenAll(records.Select(async entry => (await accounts.Algorithm(entry.Owner, entry.Item.Text("id")))["validation"].Text("state")));
            Require(states.Count(state => state == "pending") == 17); // one active, 16 queued
            Require(states.Count(state => state == "unverified") == 4);
            foreach (var entry in records) { await using var preserved = accounts.Sources.Open(entry.Source.SourceKey); Require(preserved.Length > 0); }
            Console.WriteLine("PASS bounded validation queue preserves all sources on overflow");

            var scope = new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(first.Owner) };
            using var waitCancellation = new CancellationTokenSource();
            var waiting = Enumerable.Range(0, 3).Select(_ => service.Check(scope, first.Source, waitCancellation.Token)).ToArray();
            try { await service.Check(scope, first.Source); throw new Exception("Per-owner gate overflow was admitted."); }
            catch (ServiceFault error) when (error.Status == 429) { }
            waitCancellation.Cancel();
            foreach (var task in waiting) { try { await task; throw new Exception("Cancelled waiter executed."); } catch (OperationCanceledException) { } }
            Require(transport.Calls == 1);
            Console.WriteLine("PASS per-owner waiters are bounded and cancellation never executes abandoned checks");

            await service.StopAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
            foreach (var entry in records)
                Require((await accounts.Algorithm(entry.Owner, entry.Item.Text("id")))["validation"].Text("state") == "unverified");
            Require(!Directory.EnumerateFiles(settings.ExchangeRoot, "*.js").Any());
            Console.WriteLine("PASS validation shutdown cancels active work, drains queued receipts and reclaims snapshots");
        }
        finally { await service.StopAsync(CancellationToken.None); }

        var recovery = records[0];
        Require(await accounts.BeginValidation(recovery.Owner, recovery.Item.Text("id"), 1, recovery.Source.SourceKey, new JsonObject { ["state"] = "pending", ["version"] = service.Version }, "javascript", recovery.Source.Sha256, Guid.NewGuid()));
        var partialKey = Guid.NewGuid();
        var partialLease = Path.Combine(settings.DataRoot, "validation-leases", partialKey + ".json");
        await AtomicFile.Json(partialLease, new JsonObject { ["sourceKey"] = partialKey.ToString() });
        await File.WriteAllTextAsync(exchange.PathFor(partialKey) + ".tmp", "interrupted-copy");
        var unrelated = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("retained-match-snapshot")));
        using var nextTransport = new HeldValidationTransport(); nextTransport.Release.TrySetResult();
        using var restarted = new AlgorithmValidationService(accounts, settings, content, new ExecutionClient(nextTransport, backend));
        await restarted.StartAsync(CancellationToken.None);
        Require(!File.Exists(partialLease) && !File.Exists(exchange.PathFor(partialKey) + ".tmp"));
        Require(File.Exists(exchange.PathFor(unrelated.SourceKey)));
        try
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while ((await accounts.Algorithm(recovery.Owner, recovery.Item.Text("id")))["validation"].Text("state") == "pending")
            { if (DateTime.UtcNow > until) throw new Exception("Orphan receipt did not recover."); await Task.Delay(10); }
            Require(nextTransport.Calls == 0); // recovery must not replay an unbounded queue
            var saved = await accounts.Algorithm(recovery.Owner, recovery.Item.Text("id"));
            await restarted.Queue(recovery.Owner, saved, recovery.Source.SourceKey);
            while ((await accounts.Algorithm(recovery.Owner, recovery.Item.Text("id")))["validation"].Text("state") != "passed")
            { if (DateTime.UtcNow > until) throw new Exception("Recovered source could not be rechecked."); await Task.Delay(10); }
            Console.WriteLine("PASS recovered pending receipts need explicit recheck and can pass afterwards");
        }
        finally { await restarted.StopAsync(CancellationToken.None); await exchange.Delete(unrelated.SourceKey); }
        return 5;
    }
}

internal sealed class HeldValidationTransport : HttpMessageHandler, IHttpClientFactory
{
    public readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int calls;
    public int Calls => Volatile.Read(ref calls);
    public HttpClient CreateClient(string name) => new(this, false);
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        Interlocked.Increment(ref calls); Entered.TrySetResult();
        await Release.Task.WaitAsync(token);
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"calls\":36,\"profileVersion\":\"javascript-preflight-v2\",\"fixtureVersion\":\"2.0.0\"}") };
    }
}
