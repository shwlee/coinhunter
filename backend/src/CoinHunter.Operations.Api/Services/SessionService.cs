using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public sealed class SessionService(AccountService accounts, BackendSettings settings, IConfiguration configuration, IHostEnvironment environment)
{
    private sealed record Session(string UserId, DateTimeOffset Expires);
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    public string Mode { get; } = ReadMode(configuration, environment);
    public static string Token() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static string ReadMode(IConfiguration configuration, IHostEnvironment environment)
    {
        var mode = configuration["AUTH_MODE"] ?? (environment.IsDevelopment() ? "mock" : "disabled");
        if (mode is not ("mock" or "google" or "disabled") || (mode == "mock" && !environment.IsDevelopment())) throw new InvalidOperationException("Invalid AUTH_MODE for environment.");
        return mode;
    }
    private CookieOptions Cookie(int age = 43200) => new() { HttpOnly = true, Secure = settings.PublicUrl.Scheme == "https", SameSite = Mode == "google" ? SameSiteMode.Lax : SameSiteMode.Strict, Path = "/", MaxAge = TimeSpan.FromSeconds(age), IsEssential = true };
    public async Task<JsonObject?> Current(HttpContext context)
    {
        if (!context.Request.Cookies.TryGetValue("coinhunter-session", out var token) || !sessions.TryGetValue(token, out var session)) return null;
        if (session.Expires <= DateTimeOffset.UtcNow) { sessions.TryRemove(token, out _); return null; }
        var user = await accounts.User(session.UserId);
        if (user is null) Revoke(session.UserId);
        return user;
    }
    public async Task<JsonObject> Require(HttpContext context, bool admin = false)
    {
        var user = await Current(context) ?? throw new ServiceFault(401, "로그인이 필요합니다.");
        if (admin && user.Text("role") != "admin") throw new ServiceFault(403, "관리자 권한이 필요합니다.");
        return user;
    }
    public void Issue(HttpContext context, string id)
    {
        foreach (var item in sessions) if (item.Value.Expires <= DateTimeOffset.UtcNow) sessions.TryRemove(item.Key, out _);
        if (sessions.Count >= 10000) throw new ServiceFault(429, "로그인 세션 한도입니다. 잠시 후 다시 시도하세요.");
        if (context.Request.Cookies.TryGetValue("coinhunter-session", out var previous)) sessions.TryRemove(previous, out _);
        var token = Token(); sessions[token] = new Session(id, DateTimeOffset.UtcNow.AddHours(12));
        context.Response.Cookies.Append("coinhunter-session", token, Cookie());
    }
    public void Logout(HttpContext context)
    {
        if (context.Request.Cookies.TryGetValue("coinhunter-session", out var token)) sessions.TryRemove(token, out _);
        context.Response.Cookies.Delete("coinhunter-session", Cookie(0));
    }
    public void Revoke(string id) { foreach (var pair in sessions) if (pair.Value.UserId == id) sessions.TryRemove(pair.Key, out _); }
    public string Guest(HttpContext context)
    {
        if (context.Request.Cookies.TryGetValue("coinhunter", out var value) && Guid.TryParseExact(value, "D", out var id)) return id.ToString();
        var guest = Guid.NewGuid().ToString(); context.Response.Cookies.Append("coinhunter", guest, Cookie()); return guest;
    }
    public async Task<string[]> MockIdentities()
    {
        if (Mode != "mock") return [];
        var domain = configuration["MOCK_COMPANY_DOMAIN"] ?? "company.test";
        return (await accounts.Users()).OfType<JsonObject>().Where(user => user.Bool("active") && user.Text("role") == "admin" && user["authProviders"]!.AsArray().Any(value => value!.GetValue<string>() == "mock"))
            .Select(user => user.Text("email")).Concat(new[] { "developer@" + domain, "tester@" + domain }).Distinct().ToArray();
    }
}
