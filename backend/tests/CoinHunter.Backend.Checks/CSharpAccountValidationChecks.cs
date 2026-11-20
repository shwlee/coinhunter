using System.Net;
using System.Diagnostics;
using System.Net.Sockets;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Execution;
using CoinHunter.Infrastructure.Resources;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.Extensions.Configuration;

internal static class CSharpAccountValidationChecks
{
    public static async Task Run(string root)
    {
        int checks = 0; void Assert(bool ok, string message) { if (!ok) throw new Exception(message); checks++; }
        async Task Fault(Func<Task> action, int status) { try { await action(); } catch (ServiceFault e) when (e.Status == status) { checks++; return; } throw new Exception("Expected status " + status); }
        var dir = Path.Combine(root, "artifacts", "c4c-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var output = Path.GetDirectoryName(typeof(CSharpAccountValidationChecks).Assembly.Location)!; var bin = Directory.GetParent(Directory.GetParent(output)!.FullName)!.FullName;
        var host = Path.Combine(bin, "CoinHunter.CSharp.Host/debug/CoinHunter.CSharp.Host.dll"); if (!File.Exists(host)) host = Path.Combine(root, "backend/src/CoinHunter.CSharp.Host/bin/Debug/net10.0/CoinHunter.CSharp.Host.dll");
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Backend:RepositoryRoot"] = root,
            ["Backend:DataRoot"] = Path.Combine(dir, "operations"),
            ["Backend:ExchangeRoot"] = Path.Combine(dir, "exchange"),
            ["Backend:ExecutionRoot"] = Path.Combine(dir, "execution"),
            ["Backend:ListenUrl"] = "http://127.0.0.1:3101",
            ["Backend:ExecutionUrl"] = "http://127.0.0.1:3102",
            ["Backend:PublicUrl"] = "http://127.0.0.1:3000",
            ["COINHUNTER_INTERNAL_KEY"] = "test-" + new string('a', 40),
            ["Backend:CSharpValidation:Enabled"] = "true",
            ["Backend:CSharpValidation:HostAssembly"] = host
        }).Build();
        var settings = new StorageSettings(config); var content = new GameContent(settings); var backend = BackendSettings.Read(config, new LocalEnvironment(), Protocol.OperationsService);
        using var accountsStore = new FileAccountStore(settings); var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources")); var accounts = new AccountService(accountsStore, sources);
        var user = await accounts.Login("c4c@company.test"); var owner = user.Text("id"); var scope = new ExecutionScope { Kind = "user", SubjectId = Guid.Parse(owner) };
        var resourceSettings = new ExecutionResourceSettings(config); var resources = new ExecutionResources(resourceSettings); var hostManager = new CSharpHostManager(resources); await hostManager.StartAsync(default);
        await using var candidate = new CSharpValidationService(settings, content, resources, hostManager, config);
        using var execution = new ExecutionManager(settings, content, resources, resourceSettings, candidate); await execution.StartAsync(default); await candidate.StartAsync(default);
        using var transport = new LocalValidationTransport(execution); var client = new ExecutionClient(transport, backend);
        using var validation = new AlgorithmValidationService(accounts, settings, content, client); await validation.StartAsync(default);
        string Code(string body) => "public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"account\";}public int MoveNext(int[] map,int p,int[] items){" + body + "}}";
        async Task<(JsonObject Item, SourceReference Source)> Save(string source, string name, string language = "csharp")
        { var reference = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes(source))); return (await accounts.Save(owner, null, name, 0, reference.SourceKey, reference.Sha256, language), reference); }
        async Task<JsonObject> Wait(JsonObject item)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            while (true)
            {
                var current = await accounts.Algorithm(owner, item.Text("id")); if (current["validation"]?.Text("state") != "pending") return current;
                await Task.Delay(10, deadline.Token);
            }
        }
        async Task Queue(JsonObject item, Guid key, AlgorithmValidationService? target = null)
        {
            target ??= validation;
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (true)
            {
                await target.Queue(owner, item, key);
                if (item["validation"]?.Text("message") != "저장됨 · 이전 코드 검사가 진행 중입니다. 완료 후 다시 검사하세요.") return;
                await Task.Delay(1, deadline.Token);
            }
        }
        try
        {
            var good = await Save(await File.ReadAllTextAsync(Path.Combine(root, "backend/examples/csharp/nearest-coin.cs")), "bfs");
            await Queue(good.Item, good.Source.SourceKey); var saved = await Wait(good.Item); var receipt = saved["validation"]!;
            Assert(receipt.Text("state") == "passed" && !receipt.Bool("executionAllowed"), "Real C# report not applied as candidate-only pass.");
            Assert(receipt["artifact"]?.Text("sourceHash") == good.Source.Sha256 && receipt["artifact"]?.Text("fixtureHash") == content.PreflightHash, "Artifact/source/fixture identity missing.");
            Assert(transport.LastLanguage == "csharp" && transport.LastClient == "execution-candidate-validation", "Language or preparation timeout transport not selected.");
            Assert(!saved.ContainsKey("source") && File.Exists(sources.PathFor(good.Source.SourceKey)), "Account metadata contains code or original lost.");
            var key = receipt["artifact"]!.Text("key");
            var reportFiles = Directory.GetFiles(Path.Combine(settings.ExecutionRoot, "csharp", "reports"), "*.json", SearchOption.AllDirectories);
            Assert(reportFiles.Length == 1, "Execution-owned report not persisted.");
            var onDisk = JsonSerializer.Deserialize<CSharpPreflightReport>(await File.ReadAllTextAsync(reportFiles[0]))!;
            Assert(onDisk.Owner == scope.SubjectId && onDisk.CheckedCalls == 36 && onDisk.Key == key, "Execution report differs from account metadata.");
            var maps = new FileMapStore(settings, content, accountsStore); using var matches = new MatchService(accountsStore, accounts, maps, content, settings, client, validation);
            var map = (await maps.Registry()).OfType<JsonObject>().First();
            await Fault(() => matches.Create(scope, new JsonObject { ["mode"] = "practice", ["dummyCount"] = 0, ["startSlot"] = 0, ["characterId"] = "pengko", ["blackMatter"] = false, ["destroyWalls"] = false, ["mapId"] = map.Text("id"), ["algorithmId"] = good.Item.Text("id") }, null, null), 503);
            await Fault(() => validation.Check(scope with { Kind = "guest" }, good.Source, language: "csharp"), 400);
            await Fault(() => execution.Validate(new ValidationRequest(Guid.NewGuid(), scope, good.Source, "python"), default), 400);
            await using (var disabled = new CSharpValidationService(settings, content, resources, hostManager, new ConfigurationBuilder().Build()))
            { await disabled.StartAsync(default); await Fault(() => disabled.Validate(scope, good.Source, "unused", default), 503); }

            var bad = await Save(Code("try{return 0;}catch{return -1;}"), "static failure");
            await Queue(bad.Item, bad.Source.SourceKey); var failed = await Wait(bad.Item);
            Assert(failed["validation"]?.Text("state") == "failed" && failed["validation"]?["diagnostic"]?.Text("stage") == "compile", "Static failure lost at account boundary.");
            Assert(failed["validation"]?["artifact"] is null && File.Exists(sources.PathFor(bad.Source.SourceKey)), "Static failure discarded source or published artifact.");
            var slow = await Save(Code("while(true){}"), "timeout");
            await Queue(slow.Item, slow.Source.SourceKey); var timeout = await Wait(slow.Item);
            Assert(timeout["validation"]?.Text("state") == "failed" && timeout["validation"]?["diagnostic"]?.Text("code") == "AR012", "Runtime timeout lost at account boundary.");
            Assert(timeout["validation"]?["artifact"] is JsonObject && !timeout["validation"]!.Bool("executionAllowed"), "Failed prepared code should retain an artifact reference, never permission.");

            // Same bytes in another language must not inherit this language's report.
            var same = await accounts.Save(owner, null, "same bytes, JS", 0, good.Source.SourceKey, good.Source.Sha256, "javascript");
            var exchange = new FileSourceStore(settings.ExchangeRoot); var copied = await sources.Copy(good.Source.SourceKey, exchange);
            var callsBefore = transport.Calls;
            var pass = await validation.Check(scope, copied, language: "csharp");
            Assert((await accounts.Algorithm(owner, same.Text("id")))["validation"]?.Text("state") == "unverified", "C# result crossed a language boundary.");
            Assert(pass.Bool("ok") && transport.Calls == callsBefore + 1, "Manual C# recheck did not execute.");
            foreach (var mutate in new Action<JsonObject>[]
            {
                r=>r["report"]!["owner"]=Guid.NewGuid().ToString(),
                r=>r["sourceHash"]=new string('a',64),
                r=>r["report"]!["toolchainKey"]=new string('b',64),
                r=>r["fixtureHash"]=new string('c',64),
                r=>r["report"]!["checkedCalls"]=0,
                r=>r["executionAllowed"]=true,
                r=>r["report"]!["executionAllowed"]=true,
                r=>r["calls"]=0
            })
            {
                transport.Replay = pass.CloneObject(); mutate(transport.Replay);
                await validation.Check(scope, copied, language: "csharp"); var invalid = (await accounts.Algorithm(owner, good.Item.Text("id")))["validation"]!;
                Assert(invalid.Text("state") == "unverified" && invalid["artifact"] is null && !invalid.Bool("executionAllowed"), "Unbound/forged result applied.");
            }
            transport.Replay = null; await exchange.Delete(copied.SourceKey);

            var tampered = await accounts.Save(owner, null, "hash mismatch", 0, good.Source.SourceKey, new string('d', 64), "csharp"); callsBefore = transport.Calls;
            await Queue(tampered, good.Source.SourceKey); var mismatch = await Wait(tampered);
            Assert(mismatch["validation"]?.Text("state") == "unverified" && transport.Calls == callsBefore, "Changed file dispatched or passed.");

            var race = await Save(Code("return -1;"), "stale revision"); transport.Pause();
            await Queue(race.Item, race.Source.SourceKey); await transport.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var replacement = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes(Code("return 0;"))));
            var current = await accounts.Save(owner, race.Item.Text("id"), "replacement", 1, replacement.SourceKey, replacement.Sha256, "csharp");
            transport.Release.TrySetResult(); await transport.Completed.Task.WaitAsync(TimeSpan.FromSeconds(45));
            // Stop drains the job's final account CAS before inspecting the replacement.
            await validation.StopAsync(default); transport.Resume();
            current = await accounts.Algorithm(owner, current.Text("id"));
            Assert(current.Int("revision") == 2 && current["validation"]?.Text("state") == "unverified" && current["validation"]?["artifact"] is null, "Old job blessed replacement revision.");
            Assert(!await accounts.SetValidation(owner, current.Text("id"), 2, replacement.SourceKey, new JsonObject { ["state"] = "passed" }, "javascript", replacement.Sha256), "Wrong-language CAS accepted.");
            Assert(!await accounts.SetValidation(owner, current.Text("id"), 2, replacement.SourceKey, new JsonObject { ["state"] = "passed" }, "csharp", good.Source.Sha256), "Wrong-hash CAS accepted.");
            Assert(!await accounts.SetValidation(Guid.NewGuid().ToString(), current.Text("id"), 2, replacement.SourceKey, new JsonObject { ["state"] = "passed" }, "csharp", replacement.Sha256), "Foreign owner CAS accepted.");

            using (var restarted = new AlgorithmValidationService(accounts, settings, content, client))
            {
                callsBefore = transport.Calls; await restarted.StartAsync(default);
                Assert((await accounts.Algorithm(owner, slow.Item.Text("id")))["validation"]?.Text("state") == "stale" && transport.Calls == callsBefore, "Restart silently reused candidate report.");
                var reload = await accounts.Algorithm(owner, good.Item.Text("id")); await restarted.Queue(owner, reload, good.Source.SourceKey); var restored = await Wait(good.Item);
                Assert(restored["validation"]?.Text("state") == "passed" && restored["validation"]?["artifact"]?.Text("key") == key, "Explicit recheck did not reuse immutable artifact.");
                transport.Pause(); var cancel = await accounts.Algorithm(owner, slow.Item.Text("id"));
                await Queue(cancel, slow.Source.SourceKey, restarted); await transport.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await restarted.StopAsync(default);
                var cancelled = (await accounts.Algorithm(owner, slow.Item.Text("id")))["validation"]!;
                Assert(cancelled.Text("state") == "unverified" && !cancelled.Bool("executionAllowed"), "Shutdown turned cancelled candidate check into a failure or permission."); transport.Resume();
            }
            Assert(!Directory.EnumerateFiles(settings.ExchangeRoot, "*.js").Any(), "Account validation snapshot leaked.");
            Assert(hostManager.ManagedCount == 0 && JsonSerializer.SerializeToNode(resources.Status)!["reservedProcesses"]!.GetValue<int>() == 0, "C# account check leaked a host/reservation.");
            if (OperatingSystem.IsWindows()) checks += await HttpCheck(root, bin, dir, host, resources);
        }
        finally { transport.Release.TrySetResult(); await validation.StopAsync(default); await candidate.StopAsync(default); await execution.StopAsync(default); await hostManager.StopAsync(default); }
        await File.WriteAllTextAsync(Path.Combine(root, "artifacts/csharp-c4c-report.json"), JsonSerializer.Serialize(new { date = DateTimeOffset.UtcNow, checks, executionAllowed = false, resources = resources.Status }));
        Console.WriteLine($"C# C4-C account validation checks: {checks} passed; real preparation/preflight, language/hash/revision CAS, report binding and disabled gameplay.");
    }
    private static async Task<int> HttpCheck(string root, string bin, string directory, string host, ExecutionResources resources)
    {
        int checks = 0; void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }
        var portProbe = new TcpListener(IPAddress.Loopback, 0); portProbe.Start(); int port = ((IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
        var url = "http://127.0.0.1:" + port; var data = Path.Combine(directory, "http"); var exchange = new FileSourceStore(Path.Combine(data, "exchange"));
        var source = await exchange.Put(new MemoryStream(Encoding.UTF8.GetBytes("public class Player{public void Initialize(int n,int c,int r){}public string GetName(){return \"http\";}public int MoveNext(int[] map,int p,int[] items){return -1;}}")));
        using var group = resources.Reserve(new ResourceProfile("c4c-http-tree", 2L * 1024 * 1024 * 1024, 6, 10000));
        using var process = new Process { StartInfo = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true } };
        CSharpHostSession.RestrictEnvironment(process.StartInfo); process.StartInfo.ArgumentList.Add(Path.Combine(bin, "CoinHunter.Execution.Host/debug/CoinHunter.Execution.Host.dll"));
        foreach (var pair in new Dictionary<string, string>
        {
            ["DOTNET_ENVIRONMENT"] = "Development",
            ["COINHUNTER_INTERNAL_KEY"] = "test-" + new string('h', 40),
            ["Backend__ListenUrl"] = url,
            ["Backend__ExecutionUrl"] = url,
            ["Backend__PublicUrl"] = "http://127.0.0.1:3000",
            ["Backend__RepositoryRoot"] = root,
            ["Backend__DataRoot"] = Path.Combine(data, "operations"),
            ["Backend__ExchangeRoot"] = exchange.Root,
            ["Backend__ExecutionRoot"] = Path.Combine(data, "execution"),
            ["Backend__UseStdinControl"] = "true",
            ["Backend__CSharpValidation__Enabled"] = "true",
            ["Backend__CSharpValidation__HostAssembly"] = host
        }) process.StartInfo.Environment[pair.Key] = pair.Value;
        process.Start(); var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
        try
        {
            group.Assign(process); using var client = new HttpClient { BaseAddress = new Uri(url), Timeout = TimeSpan.FromSeconds(60) };
            using var readyDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (true)
            {
                if (process.HasExited) throw new Exception("Candidate HTTP host startup failed: " + await errors);
                try { using var ready = await client.GetAsync("/health/ready", readyDeadline.Token); if (ready.IsSuccessStatusCode) break; } catch (HttpRequestException) { }
                await Task.Delay(25, readyDeadline.Token);
            }
            var owner = Guid.NewGuid(); var request = new ValidationRequest(Guid.NewGuid(), new ExecutionScope { Kind = "user", SubjectId = owner }, source, "csharp");
            using (var denied = await client.PostAsJsonAsync("/internal/v1/validations", request, Protocol.JsonOptions)) Assert(denied.StatusCode == HttpStatusCode.Unauthorized, "C# internal HTTP route accepted missing bearer.");
            using(var denied=await client.GetAsync("/internal/v1/candidates/csharp/readiness"))Assert(denied.StatusCode==HttpStatusCode.Unauthorized,"Readiness exposed private policy without service auth.");
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "test-" + new string('h', 40));
            using(var ready=await client.GetAsync("/internal/v1/candidates/csharp/readiness"))
            {
                var value=JsonNode.Parse(await ready.Content.ReadAsStringAsync())!;
                Assert(ready.IsSuccessStatusCode&&!value.Bool("publicEnabled")&&value.Int("algorithmBudgetMs")==500&&value["pendingAcceptance"]!.AsArray().Count>0,"Readiness incorrectly activated public C# or hid pending gates.");
            }
            using(var missing=await client.PostAsJsonAsync("/internal/v1/candidates/csharp/cache/maintenance",new{}))Assert(missing.StatusCode==HttpStatusCode.BadRequest,"Cache trim allowed omitted dryRun.");
            using(var preview=await client.PostAsJsonAsync("/internal/v1/candidates/csharp/cache/maintenance",new{dryRun=true}))Assert(preview.IsSuccessStatusCode,"Cache maintenance dry-run failed.");
            using (var response = await client.PostAsJsonAsync("/internal/v1/validations", request, Protocol.JsonOptions))
            {
                var result = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
                Assert(response.IsSuccessStatusCode && result.Bool("ok") && result.Int("calls") == 36 && !result.Bool("executionAllowed"), "Actual HTTP candidate validation failed: " + result.ToJsonString());
                Assert(result["report"]?.Text("owner") == owner.ToString() && result["report"]?.Text("sourceHash") == source.Sha256, "Actual HTTP response lost source/owner binding.");
            }
            using (var guest = await client.PostAsJsonAsync("/internal/v1/validations", request with { RequestId = Guid.NewGuid(), Scope = request.Scope with { Kind = "guest" } }, Protocol.JsonOptions)) Assert(guest.StatusCode == HttpStatusCode.ServiceUnavailable, "Candidate HTTP guest check was accepted.");
            Assert(File.Exists(exchange.PathFor(source.SourceKey)), "Internal HTTP validation removed caller-owned source.");
            await process.StandardInput.WriteLineAsync("shutdown"); process.StandardInput.Close(); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert(process.ExitCode == 0, "Enabled candidate host failed to stop cleanly.");
        }
        finally { await group.TerminateAndDrain().WaitAsync(TimeSpan.FromSeconds(10)); await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); await output; await errors; }
        return checks;
    }
    private sealed class LocalValidationTransport(ExecutionManager manager) : HttpMessageHandler, IHttpClientFactory
    {
        public JsonObject? Replay;
        public string? LastLanguage, LastClient;
        public int Calls;
        private bool paused;
        public TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously), Completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Pause() { paused = true; Entered = new(TaskCreationOptions.RunContinuationsAsynchronously); Release = new(TaskCreationOptions.RunContinuationsAsynchronously); Completed = new(TaskCreationOptions.RunContinuationsAsynchronously); }
        public void Resume() => paused = false;
        public HttpClient CreateClient(string name) { LastClient = name; return new(this, false); }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var validation = JsonSerializer.Deserialize<ValidationRequest>(await request.Content!.ReadAsStringAsync(token), Protocol.JsonOptions)!; LastLanguage = validation.Language; Calls++;
            Entered.TrySetResult(); if (paused) await Release.Task.WaitAsync(token);
            var result = Replay?.CloneObject() ?? await manager.Validate(validation, token); Completed.TrySetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(result.ToJsonString()) };
        }
    }
}
