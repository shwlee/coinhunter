using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

// Dedicated OIDC transport boundary allows deterministic tests without Google credentials/network.
public interface IGoogleIdentityVerifier
{
    Task<JsonObject> Verify(string code, string verifier, string nonce, CancellationToken cancellationToken);
}

public sealed class GoogleIdentityVerifier(IConfiguration configuration, BackendSettings settings, IHttpClientFactory clients) : IGoogleIdentityVerifier
{
    private readonly SemaphoreSlim keysGate = new(1);
    private JsonArray? keys;
    private DateTimeOffset keysUntil;
    private static byte[] Decode(string value) => Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
    private static async Task<JsonObject> Bounded(HttpResponseMessage response, int limit, CancellationToken token)
    {
        if (!response.IsSuccessStatusCode) throw new ServiceFault(401, "Google 인증을 확인하지 못했습니다.");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        using var output = new MemoryStream(); var buffer = new byte[8192];
        while (true) { var read = await input.ReadAsync(buffer, token); if (read == 0) break; if (output.Length + read > limit) throw new ServiceFault(401, "Google 인증 응답을 확인하지 못했습니다."); output.Write(buffer, 0, read); }
        return JsonNode.Parse(output.ToArray())!.AsObject();
    }
    public async Task<JsonObject> Verify(string code, string verifier, string nonce, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var token = deadline.Token;
        try
        {
            var client = clients.CreateClient("google");
            using var exchange = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["code"] = code,
                    ["code_verifier"] = verifier,
                    ["client_id"] = configuration["GOOGLE_CLIENT_ID"]!,
                    ["client_secret"] = configuration["GOOGLE_CLIENT_SECRET"]!,
                    ["redirect_uri"] = new Uri(settings.PublicUrl, "/api/auth/google/callback").AbsoluteUri,
                    ["grant_type"] = "authorization_code"
                })
            };
            using var response = await client.SendAsync(exchange, HttpCompletionOption.ResponseHeadersRead, token);
            var tokens = await Bounded(response, 65536, token);
            var parts = tokens.Text("id_token").Split('.');
            if (parts.Length != 3) throw new InvalidDataException();
            var header = JsonNode.Parse(Decode(parts[0]))!.AsObject(); var claims = JsonNode.Parse(Decode(parts[1]))!.AsObject();
            if (header.Text("alg") != "RS256" || header.ContainsKey("crit") || string.IsNullOrEmpty(header.Text("kid"))) throw new InvalidDataException();
            await keysGate.WaitAsync(token);
            try
            {
                if (keys is null || keysUntil <= DateTimeOffset.UtcNow || !keys.OfType<JsonObject>().Any(key => key.Text("kid") == header.Text("kid")))
                {
                    using var keysResponse = await client.GetAsync("https://www.googleapis.com/oauth2/v3/certs", HttpCompletionOption.ResponseHeadersRead, token);
                    keys = (await Bounded(keysResponse, 131072, token))["keys"]!.AsArray(); keysUntil = DateTimeOffset.UtcNow.AddMinutes(10);
                }
                var key = keys.OfType<JsonObject>().SingleOrDefault(key => key.Text("kid") == header.Text("kid") && key.Text("kty") == "RSA") ?? throw new InvalidDataException();
                using var rsa = RSA.Create(); rsa.ImportParameters(new RSAParameters { Modulus = Decode(key.Text("n")), Exponent = Decode(key.Text("e")) });
                if (!rsa.VerifyData(Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]), Decode(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new InvalidDataException();
            }
            finally { keysGate.Release(); }
            ValidateClaims(claims, configuration["GOOGLE_CLIENT_ID"]!, nonce, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            return claims;
        }
        catch (Exception error) when (error is not ServiceFault && error is not OutOfMemoryException)
        {
            // Provider errors may contain authorization codes/tokens; never propagate SDK/HTTP text.
            throw new ServiceFault(401, "Google 인증을 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
        }
    }
    public static void ValidateClaims(JsonObject claims, string clientId, string nonce, long now)
    {
        if (claims.Text("iss") is not ("https://accounts.google.com" or "accounts.google.com") || claims.Text("aud") != clientId ||
            (claims.ContainsKey("azp") && claims.Text("azp") != clientId) || claims["exp"]?.GetValue<long>() <= now || claims["exp"] is null ||
            claims["iat"] is null || claims["iat"]!.GetValue<long>() > now + 300 || claims.Text("nonce") != nonce || !claims.Bool("email_verified") ||
            string.IsNullOrWhiteSpace(claims.Text("sub")) || claims.Text("sub").Length > 255 || claims.Text("email").Length > 320 || !System.Net.Mail.MailAddress.TryCreate(claims.Text("email"), out _))
            throw new ServiceFault(401, "Google 인증 정보를 확인할 수 없습니다.");
    }
}

public sealed class GoogleAuthentication
{
    private sealed class Flow
    {
        public required string State { get; init; }
        public required string Browser { get; init; }
        public required string Address { get; init; }
        public required string Nonce { get; init; }
        public required string Verifier { get; init; }
        public required string Next { get; init; }
        public DateTimeOffset Expires { get; } = DateTimeOffset.UtcNow.AddMinutes(10);
        public bool Running { get; set; }
    }
    private readonly object gate = new();
    private readonly Dictionary<string, Flow> pending = new();
    private readonly Dictionary<string, Flow> latest = new();
    private readonly HashSet<Flow> slots = new();
    private readonly Dictionary<string, (int Count, DateTimeOffset Until)> rates = new();
    private readonly IConfiguration configuration;
    private readonly BackendSettings settings;
    private readonly SessionService sessions;
    private readonly AccountService accounts;
    private readonly IGoogleIdentityVerifier verifier;
    private readonly int startsPerMinute = 60;
    private readonly int flowsPerAddress = 50;
    private static readonly string[] Destinations = ["/", "/editor", "/game", "/admin", "/admin/maps", "/admin/maps/editor"];
    public GoogleAuthentication(IConfiguration configuration, BackendSettings settings, SessionService sessions, AccountService accounts, IGoogleIdentityVerifier verifier)
    {
        this.configuration = configuration; this.settings = settings; this.sessions = sessions; this.accounts = accounts; this.verifier = verifier;
        if (sessions.Mode != "google") return;
        startsPerMinute = Limit("GOOGLE_AUTH_STARTS_PER_MINUTE", 60, 10000);
        flowsPerAddress = Limit("GOOGLE_AUTH_FLOWS_PER_ADDRESS", 50, 999);
        if (string.IsNullOrWhiteSpace(configuration["GOOGLE_CLIENT_ID"]) || string.IsNullOrWhiteSpace(configuration["GOOGLE_CLIENT_SECRET"])) throw new InvalidOperationException("Google client configuration is required.");
        if (configuration["GOOGLE_REDIRECT_URI"] is string callback && callback != new Uri(settings.PublicUrl, "/api/auth/google/callback").AbsoluteUri) throw new InvalidOperationException("Google callback must match Backend:PublicUrl.");
        if (settings.PublicUrl.Scheme == "https" && !List("GOOGLE_ALLOWED_DOMAINS").Any() && !List("GOOGLE_ALLOWED_EMAILS").Any()) throw new InvalidOperationException("Configure allowed Google domains or emails for deployment.");
    }
    private string[] List(string key) => (configuration[key] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(value => value.ToLowerInvariant()).ToArray();
    private int Limit(string key, int fallback, int maximum)
    {
        var text = configuration[key]; if (string.IsNullOrWhiteSpace(text)) return fallback;
        if (!int.TryParse(text, out var number) || number < 1 || number > maximum) throw new InvalidOperationException("Invalid Google authentication admission limit.");
        return number;
    }
    private CookieOptions Cookie() => new() { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = settings.PublicUrl.Scheme == "https", Path = "/api/auth", MaxAge = TimeSpan.FromMinutes(10), IsEssential = true };
    private void Enabled() { if (sessions.Mode != "google") throw new ServiceFault(403, "Google 인증이 활성화되지 않았습니다."); }
    private void Prune()
    {
        foreach (var flow in pending.Values.Where(flow => flow.Expires <= DateTimeOffset.UtcNow).ToArray()) { pending.Remove(flow.State); if (!flow.Running) slots.Remove(flow); }
        foreach (var pair in latest.Where(pair => pair.Value.Expires <= DateTimeOffset.UtcNow).ToArray()) latest.Remove(pair.Key);
        foreach (var pair in rates.Where(pair => pair.Value.Until <= DateTimeOffset.UtcNow).ToArray()) rates.Remove(pair.Key);
    }
    public string Begin(HttpContext context, string? next)
    {
        Enabled();
        var target = Destinations.Contains(next) ? next! : "/";
        if (!string.Equals(context.Request.Host.Value, settings.PublicUrl.Authority, StringComparison.OrdinalIgnoreCase))
            return new Uri(settings.PublicUrl, "/api/auth/google/start?next=" + Uri.EscapeDataString(target)).AbsoluteUri;
        lock (gate)
        {
            Prune(); var address = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            var bucket = rates.GetValueOrDefault(address, (Count: 0, Until: DateTimeOffset.UtcNow.AddMinutes(1)));
            if (bucket.Count >= startsPerMinute || rates.Count >= 4096 && !rates.ContainsKey(address)) { context.Response.Headers.RetryAfter = "60"; throw new ServiceFault(429, "로그인 요청이 많습니다. 잠시 후 다시 시도하세요."); }
            rates[address] = (bucket.Count + 1, bucket.Until);
            var browser = context.Request.Cookies["coinhunter-oauth"];
            if (browser is null || browser.Length != 43) browser = SessionService.Token();
            var old = latest.GetValueOrDefault(browser);
            if (slots.Count(flow => flow.Address == address && (flow != old || flow.Running)) >= flowsPerAddress || slots.Count >= 1000 && (old is null || old.Running)) throw new ServiceFault(429, "로그인 요청이 많습니다.");
            if (old is not null) { pending.Remove(old.State); if (!old.Running) slots.Remove(old); }
            var flow = new Flow { State = SessionService.Token(), Browser = browser, Address = address, Nonce = SessionService.Token(), Verifier = SessionService.Token(), Next = target };
            pending.Add(flow.State, flow); latest[browser] = flow; slots.Add(flow);
            context.Response.Cookies.Append("coinhunter-oauth", browser, Cookie());
            var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(flow.Verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var values = new Dictionary<string, string> { ["client_id"] = configuration["GOOGLE_CLIENT_ID"]!, ["redirect_uri"] = new Uri(settings.PublicUrl, "/api/auth/google/callback").AbsoluteUri, ["response_type"] = "code", ["scope"] = "openid email profile", ["state"] = flow.State, ["nonce"] = flow.Nonce, ["code_challenge"] = challenge, ["code_challenge_method"] = "S256" };
            return "https://accounts.google.com/o/oauth2/v2/auth?" + string.Join('&', values.Select(pair => Uri.EscapeDataString(pair.Key) + "=" + Uri.EscapeDataString(pair.Value)));
        }
    }
    public void Cancel(HttpContext context)
    {
        lock (gate)
        {
            if (context.Request.Cookies["coinhunter-oauth"] is string browser && latest.Remove(browser, out var flow)) { pending.Remove(flow.State); if (!flow.Running) slots.Remove(flow); }
            context.Response.Cookies.Delete("coinhunter-oauth", Cookie());
        }
    }
    public async Task<string> Callback(HttpContext context)
    {
        Enabled(); Flow? flow = null;
        try
        {
            lock (gate)
            {
                Prune(); var states = context.Request.Query["state"];
                if (states.Count != 1 || !pending.TryGetValue(states[0]!, out flow) || context.Request.Cookies["coinhunter-oauth"] != flow.Browser) throw new ServiceFault(401, "로그인 요청이 일치하지 않습니다.");
                pending.Remove(flow.State); flow.Running = true;
            }
            var codes = context.Request.Query["code"];
            if (context.Request.Query.ContainsKey("error") || codes.Count != 1 || string.IsNullOrWhiteSpace(codes[0]) || codes[0]!.Length > 4096) throw new ServiceFault(401, "로그인이 취소되었습니다.");
            var claims = await verifier.Verify(codes[0]!, flow.Verifier, flow.Nonce, context.RequestAborted);
            var email = claims.Text("email").ToLowerInvariant(); var domains = List("GOOGLE_ALLOWED_DOMAINS"); var emails = List("GOOGLE_ALLOWED_EMAILS");
            if ((domains.Length > 0 || emails.Length > 0) && !emails.Contains(email) && !domains.Contains(claims.Text("hd").ToLowerInvariant())) throw new ServiceFault(403, "허용된 회사 계정으로 로그인하세요.");
            lock (gate) AssertCurrent(flow);
            var user = await accounts.Login(email, claims.Text("sub"));
            lock (gate) { AssertCurrent(flow); sessions.Issue(context, user.Text("id")); }
            return flow.Next.StartsWith("/admin", StringComparison.Ordinal) && user.Text("role") != "admin" ? "/" : flow.Next;
        }
        catch (ServiceFault fault) { return "/signin?next=" + Uri.EscapeDataString(flow?.Next ?? "/") + "&authError=" + (fault.Status == 403 ? "denied" : "failed"); }
        finally
        {
            if (flow is not null) lock (gate) { slots.Remove(flow); if (latest.GetValueOrDefault(flow.Browser) == flow) latest.Remove(flow.Browser); }
        }
    }
    private void AssertCurrent(Flow flow) { if (latest.GetValueOrDefault(flow.Browser) != flow || flow.Expires <= DateTimeOffset.UtcNow) throw new ServiceFault(409, "새 로그인 요청으로 대체되었습니다."); }
}
