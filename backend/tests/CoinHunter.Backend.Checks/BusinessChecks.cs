using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using CoinHunter.Execution.Host.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

internal static class BusinessChecks
{
    public static async Task Run(string root)
    {
        var directory = Path.Combine(root, "artifacts", "backend-checks-" + Guid.NewGuid()); Directory.CreateDirectory(directory);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Backend:RepositoryRoot"] = root,
            ["Backend:DataRoot"] = Path.Combine(directory, "operations"),
            ["Backend:ExchangeRoot"] = Path.Combine(directory, "exchange"),
            ["Backend:ExecutionRoot"] = Path.Combine(directory, "execution"),
            ["Backend:ListenUrl"] = "http://127.0.0.1:3101",
            ["Backend:ExecutionUrl"] = "http://127.0.0.1:3102",
            ["Backend:PublicUrl"] = "http://127.0.0.1:3000",
            ["COINHUNTER_INTERNAL_KEY"] = "test-" + new string('a', 40),
            ["AUTH_MODE"] = "google",
            ["GOOGLE_CLIENT_ID"] = "test-client",
            ["GOOGLE_CLIENT_SECRET"] = "synthetic-only-secret"
        }).Build();
        var settings = new StorageSettings(configuration); var backend = BackendSettings.Read(configuration, new LocalEnvironment(), "coinhunter-operations");
        var checks = 0;
        async Task Check(string name, Func<Task> action) { await action(); checks++; Console.WriteLine("PASS " + name); }
        void Require(bool condition) { if (!condition) throw new Exception("Business assertion failed."); }
        async Task Fault(Func<Task> action, int status)
        {
            try { await action(); } catch (ServiceFault error) when (error.Status == status) { return; }
            throw new Exception("Expected fault " + status);
        }
        try
        {
            using var store = new FileAccountStore(settings); var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources")); var accounts = new AccountService(store, sources);
            await Check("single operations writer lease excludes competing host/maintenance", () =>
            {
                try { using var second = new FileAccountStore(settings); } catch (IOException) { return Task.CompletedTask; }
                throw new Exception("Second writer was admitted.");
            });
            var mock = await accounts.Login("duplicate@company.test"); var google = await accounts.Login("duplicate@company.test", "google-subject");
            await Check("validation receipts are revision/source/owner bound and failed code remains saved", async () =>
            {
                var first = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("invalid source")));
                var item = await accounts.Save(mock.Text("id"), null, "invalid draft", 0, first.SourceKey, first.Sha256);
                var failed = new JsonObject { ["state"] = "failed", ["version"] = "test" };
                Require(await accounts.SetValidation(mock.Text("id"), item.Text("id"), 1, first.SourceKey, failed));
                failed["state"] = "passed";
                Require((await accounts.Algorithm(mock.Text("id"), item.Text("id")))["validation"].Text("state") == "failed");
                Require(!await accounts.SetValidation(google.Text("id"), item.Text("id"), 1, first.SourceKey, failed));
                var second = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("new draft")));
                await accounts.Save(mock.Text("id"), item.Text("id"), "draft", 1, second.SourceKey, second.Sha256);
                Require(!await accounts.SetValidation(mock.Text("id"), item.Text("id"), 1, first.SourceKey, failed));
                Require(!await accounts.SetValidation(mock.Text("id"), item.Text("id"), 2, first.SourceKey, failed));
                Require(await accounts.SetValidation(mock.Text("id"), item.Text("id"), 2, second.SourceKey, new JsonObject { ["state"] = "pending", ["version"] = "test" }));
                await accounts.RecoverValidations("test");
                Require((await accounts.Algorithm(mock.Text("id"), item.Text("id")))["validation"].Text("state") == "unverified");
                Require((await accounts.ValidationTargets(mock.Text("id"), second.Sha256)).Length == 1);
                Require((await accounts.ValidationTargets(google.Text("id"), second.Sha256)).Length == 0);
            });
            await Check("Google subject identity is unique and never merges by email", async () =>
            {
                Require(mock.Text("id") != google.Text("id"));
                var repeat = await accounts.Login("changed@company.test", "google-subject"); Require(repeat.Text("id") == google.Text("id"));
                Require((await accounts.Login("duplicate@company.test")).Text("id") == mock.Text("id"));
            });
            await Check("immutable source read survives overwrite and revision CAS", async () =>
            {
                var first = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("first"))); var item = await accounts.Save(mock.Text("id"), null, "sample", 0, first.SourceKey);
                await using var read = sources.Open(first.SourceKey);
                var second = await sources.Put(new MemoryStream(Encoding.UTF8.GetBytes("second"))); await accounts.Save(mock.Text("id"), item.Text("id"), "sample", 1, second.SourceKey);
                using var reader = new StreamReader(read); Require(await reader.ReadToEndAsync() == "first");
                await Fault(() => accounts.Save(mock.Text("id"), item.Text("id"), "sample", 1, first.SourceKey), 409);
                await Fault(() => accounts.Algorithm(google.Text("id"), item.Text("id")), 404);
                var described = await sources.Describe(second.SourceKey); Require(described.ByteLength == 6 && described.Sha256.Length == 64);
            });
            var content = new GameContent(settings); var maps = new FileMapStore(settings, content, store);
            await Check("bundled maps and current rules validate in C#", async () =>
            {
                foreach (var entry in (await maps.Registry()).OfType<JsonObject>()) MapRules.Validate(await maps.Get(entry.Text("id"), published: true), content, true);
                Require(content.Contract.Text("contentVersion").StartsWith("sha256:", StringComparison.Ordinal));
            });
            var sessions = new SessionService(accounts, backend, configuration, new LocalEnvironment()); var fake = new DeferredVerifier(); var auth = new GoogleAuthentication(configuration, backend, sessions, accounts, fake);
            DefaultHttpContext Context(string? cookie = null)
            {
                var context = new DefaultHttpContext(); context.Request.Host = new HostString("127.0.0.1", 3000); context.Request.Scheme = "http"; context.Connection.RemoteIpAddress = IPAddress.Loopback;
                if (cookie is not null) context.Request.Headers.Cookie = cookie;
                return context;
            }
            (DefaultHttpContext Callback, string Browser, string State) Begin(string? browser = null)
            {
                var start = Context(browser is null ? null : "coinhunter-oauth=" + browser); var url = new Uri(auth.Begin(start, "/editor"));
                var cookie = start.Response.Headers.SetCookie.ToString().Split(';')[0].Split('=')[1]; var state = QueryHelpers.ParseQuery(url.Query)["state"].ToString();
                var callback = Context("coinhunter-oauth=" + cookie); callback.Request.QueryString = new QueryString("?state=" + state + "&code=synthetic-code");
                return (callback, cookie, state);
            }
            await Check("OIDC browser binding rejects stolen state before token exchange", async () =>
            {
                var flow = Begin(); flow.Callback.Request.Headers.Cookie = "coinhunter-oauth=other-browser";
                Require((await auth.Callback(flow.Callback)).Contains("authError=failed", StringComparison.Ordinal)); Require(fake.Calls == 0);
            });
            await Check("OAuth retry supersedes in-flight callback and logout cancels it", async () =>
            {
                var flow = Begin(); var callback = auth.Callback(flow.Callback); await fake.Started.Task;
                var next = Begin(flow.Browser); fake.Finish(); Require((await callback).Contains("authError=failed", StringComparison.Ordinal)); Require(flow.Callback.Response.Headers.SetCookie.Count == 0);
                fake.Reset(); var later = auth.Callback(next.Callback); await fake.Started.Task; auth.Cancel(Context("coinhunter-oauth=" + next.Browser)); fake.Finish(); Require((await later).Contains("authError=failed", StringComparison.Ordinal));
                fake.Reset(); var valid = Begin(); var final = auth.Callback(valid.Callback); await fake.Started.Task; fake.Finish(); Require(await final == "/editor");
                var cookie = valid.Callback.Response.Headers.SetCookie.ToString().Split(';')[0]; Require(await sessions.Current(Context(cookie)) is not null);
                var replay = Context("coinhunter-oauth=" + valid.Browser); replay.Request.QueryString = new QueryString("?state=" + valid.State + "&code=again"); Require((await auth.Callback(replay)).Contains("authError=failed", StringComparison.Ordinal));
            });
            await Check("OIDC verifies RSA signature, nonce, issuer, audience and lifetime", async () =>
            {
                using var rsa = RSA.Create(2048); var claims = new JsonObject { ["iss"] = "https://accounts.google.com", ["aud"] = "test-client", ["sub"] = "signed-test-subject", ["email"] = "test@company.test", ["email_verified"] = true, ["nonce"] = "nonce", ["iat"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), ["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds() };
                var transport = new SignedGoogleClient(rsa, claims); var verifier = new GoogleIdentityVerifier(configuration, backend, transport);
                Require((await verifier.Verify("code", "verifier", "nonce", default)).Text("sub") == "signed-test-subject");
                await Fault(() => verifier.Verify("code", "verifier", "wrong-nonce", default), 401);
                claims["aud"] = "different-client"; await Fault(() => verifier.Verify("code", "verifier", "nonce", default), 401);
                claims["aud"] = "test-client"; claims["exp"] = 1; await Fault(() => verifier.Verify("code", "verifier", "nonce", default), 401);
                claims["exp"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds(); transport.CorruptSignature = true; await Fault(() => verifier.Verify("code", "verifier", "nonce", default), 401);
            });
            await Check("OAuth request quotas remain bounded by client address", async () =>
            {
                var separate = new GoogleAuthentication(configuration, backend, sessions, accounts, fake);
                for (var i = 0; i < 50; i++) separate.Begin(Context(), "/");
                await Fault(() => Task.FromResult(separate.Begin(Context(), "/")), 429);
            });
            await Check("blocked account invalidates active session and login by subject", async () =>
            {
                var subject = await accounts.Login("blocked@company.test", "blocked-subject"); var context = Context(); sessions.Issue(context, subject.Text("id")); var cookie = context.Response.Headers.SetCookie.ToString().Split(';')[0];
                await accounts.UpdateUser(subject.Text("id"), new JsonObject { ["active"] = false, ["role"] = "user" }, mock.Text("id"));
                Require(await sessions.Current(Context(cookie)) is null); await Fault(() => accounts.Login("blocked@company.test", "blocked-subject"), 403);
            });
            await Check("partial JSONL truncates only incomplete tail and reports durable prefix", async () =>
            {
                var id = Guid.NewGuid(); var logs = Path.Combine(settings.ExecutionRoot, "journals"); Directory.CreateDirectory(logs); var path = Path.Combine(logs, id + ".partial.jsonl");
                await File.WriteAllTextAsync(path, "{\"seq\":1}\n{\"seq\":2}\n{\"seq\":"); var receipt = await JournalRecovery.Recover(settings.ExecutionRoot, id);
                Require(receipt["durableThroughSeq"]!.GetValue<long>() == 2 && receipt.Text("status") == "partial"); Require((await File.ReadAllTextAsync(path)).EndsWith("{\"seq\":2}\n", StringComparison.Ordinal));
            });
            await Check("offline migration dry-run and apply preserve IDs, subjects and file references", async () =>
            {
                var export = Path.Combine(directory, "export"); Directory.CreateDirectory(Path.Combine(export, "accounts/sources"));
                var snapshot = await store.Read(data => data.CloneObject()); snapshot.Remove("matches");
                await AtomicFile.Json(Path.Combine(export, "accounts/store.json"), snapshot);
                foreach (var path in Directory.EnumerateFiles(sources.Root, "*.js")) File.Copy(path, Path.Combine(export, "accounts/sources", Path.GetFileName(path)));
                var importedRoot = Path.Combine(directory, "imported");
                var importConfig = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Backend:RepositoryRoot"] = root,
                    ["Backend:DataRoot"] = importedRoot,
                    ["Backend:ExchangeRoot"] = Path.Combine(directory, "import-exchange"),
                    ["Backend:ExecutionRoot"] = Path.Combine(directory, "import-execution")
                }).Build();
                var importSettings = new StorageSettings(importConfig);
                await LegacyMigration.Run(["migrate", export], importSettings); Require(!Directory.Exists(importedRoot));
                await LegacyMigration.Run(["migrate", export, "--apply"], importSettings);
                using var imported = new FileAccountStore(importSettings);
                var restored = await imported.Read(data => data.CloneObject());
                Require(JsonNode.DeepEquals(snapshot["users"], restored["users"])); Require(JsonNode.DeepEquals(snapshot["identities"], restored["identities"])); Require(JsonNode.DeepEquals(snapshot["algorithms"], restored["algorithms"]));
                foreach (var item in restored["algorithms"]!.AsArray().OfType<JsonObject>()) Require(File.Exists(Path.Combine(importedRoot, "accounts/sources", item.Text("sourceKey") + ".js")));
                Require(restored["matches"]!.AsArray().Count == 0);
            });
            await Check("last administrator and stale expected user state are protected", async () =>
            {
                await store.Change(data => { JsonData.Find(data, "users", mock.Text("id"))["role"] = "admin"; return Task.FromResult(true); });
                await Fault(() => accounts.UpdateUser(mock.Text("id"), new JsonObject { ["active"] = false, ["role"] = "user" }, "different-actor"), 409);
                await Fault(() => accounts.UpdateUser(mock.Text("id"), new JsonObject { ["active"] = true, ["role"] = "admin", ["expectedActive"] = false, ["expectedRole"] = "admin" }, "different-actor"), 409);
            });
            await Check("applied but unacknowledged result never recreates a lost execution", async () =>
            {
                var id = Guid.NewGuid().ToString();
                await store.Change(data => { JsonData.Array(data, "matches").Add(new JsonObject { ["id"] = id, ["completed"] = true, ["acknowledged"] = false }); return Task.FromResult(true); });
                var transport = new MissingExecutionClient();
                var executionClient = new ExecutionClient(transport, backend);
                using var validation = new AlgorithmValidationService(accounts, settings, content, executionClient);
                using var service = new MatchService(store, accounts, maps, content, settings, executionClient, validation);
                await service.Refresh();
                Require(transport.Paths.Count == 1 && transport.Paths[0] == $"/internal/v1/results/{id}/ack");
            });
            checks += await ValidationChecks.Run(accounts, settings, content, backend);
            Console.WriteLine($"Backend business checks: {checks} passed.");
        }
        finally { if (Path.GetFullPath(directory).StartsWith(Path.Combine(root, "artifacts") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) Directory.Delete(directory, true); }
    }
}

internal sealed class LocalEnvironment : IHostEnvironment
{
    public string EnvironmentName { get; set; } = "Development";
    public string ApplicationName { get; set; } = "Checks";
    public string ContentRootPath { get; set; } = ".";
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
internal sealed class DeferredVerifier : IGoogleIdentityVerifier
{
    public int Calls { get; private set; }
    public TaskCompletionSource Started { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TaskCompletionSource done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public void Finish() => done.TrySetResult();
    public void Reset() { Started = new(TaskCreationOptions.RunContinuationsAsynchronously); done = new(TaskCreationOptions.RunContinuationsAsynchronously); }
    public async Task<JsonObject> Verify(string code, string verifier, string nonce, CancellationToken cancellationToken) { Calls++; Started.TrySetResult(); await done.Task; return new JsonObject { ["email"] = "flow@company.test", ["sub"] = "flow-subject" }; }
}
internal sealed class SignedGoogleClient(RSA rsa, JsonObject claims) : HttpMessageHandler, IHttpClientFactory
{
    public bool CorruptSignature { get; set; }
    public HttpClient CreateClient(string name) => new(this, false);
    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        JsonObject body;
        if (request.RequestUri!.AbsolutePath == "/token")
        {
            var prefix = Encode(Encoding.UTF8.GetBytes("{\"alg\":\"RS256\",\"kid\":\"test-key\"}")) + "." + Encode(Encoding.UTF8.GetBytes(claims.ToJsonString()));
            var signature = rsa.SignData(Encoding.ASCII.GetBytes(prefix), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1); if (CorruptSignature) signature[0] ^= 1;
            body = new JsonObject { ["id_token"] = prefix + "." + Encode(signature) };
        }
        else
        {
            var key = rsa.ExportParameters(false); body = new JsonObject { ["keys"] = new JsonArray(new JsonObject { ["kid"] = "test-key", ["kty"] = "RSA", ["n"] = Encode(key.Modulus!), ["e"] = Encode(key.Exponent!) }) };
        }
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body.ToJsonString()) });
    }
}

internal sealed class MissingExecutionClient : HttpMessageHandler, IHttpClientFactory
{
    public List<string> Paths { get; } = [];
    public HttpClient CreateClient(string name) => new(this, false);
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Paths.Add(request.RequestUri!.AbsolutePath);
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{\"error\":\"Execution unavailable\"}") });
    }
}
