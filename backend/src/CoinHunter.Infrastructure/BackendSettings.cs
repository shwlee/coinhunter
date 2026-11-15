using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace CoinHunter.Infrastructure;

public sealed class BackendSettings
{
    public required string Service { get; init; }
    public required Uri ListenUrl { get; init; }
    public required Uri PublicUrl { get; init; }
    public required Uri ExecutionUrl { get; init; }
    public required string InternalServiceKey { get; init; }
    public required IPAddress[] TrustedProxies { get; init; }
    public bool UseStdinControl { get; init; }

    public static BackendSettings Read(IConfiguration configuration, IHostEnvironment environment, string service)
    {
        var listen = Url(configuration["Backend:ListenUrl"], "Backend:ListenUrl");
        var publicUrl = Url(configuration["Backend:PublicUrl"], "Backend:PublicUrl");
        var execution = Url(configuration["Backend:ExecutionUrl"], "Backend:ExecutionUrl");
        // Local split implementation. Deployment bindings/TLS are a separate rollout scope.
        if (listen.Scheme != "http" || !listen.IsLoopback || execution.Scheme != "http" || !execution.IsLoopback)
            throw new InvalidOperationException("Local backend listen/execution URLs must use loopback HTTP.");
        if (publicUrl.Scheme != "https" && !(environment.IsDevelopment() && publicUrl.IsLoopback))
            throw new InvalidOperationException("Backend:PublicUrl requires HTTPS outside local Development.");
        var key = configuration["COINHUNTER_INTERNAL_KEY"];
        if (key is null || key.Length is < 32 or > 256 ||
            key.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
            throw new InvalidOperationException("COINHUNTER_INTERNAL_KEY requires 32-256 base64url characters.");
        var proxyValues = configuration.GetSection("Backend:TrustedProxies").Get<string[]>() ?? [];
        var proxies = new List<IPAddress>();
        foreach (var value in proxyValues)
        {
            if (!IPAddress.TryParse(value, out var address))
                throw new InvalidOperationException("Backend:TrustedProxies must contain explicit IP addresses.");
            proxies.Add(address);
        }
        if (service == CoinHunter.Contracts.Protocol.ExecutionService && proxies.Count > 0)
            throw new InvalidOperationException("Execution host does not accept public forwarded headers.");
        return new BackendSettings
        {
            Service = service,
            ListenUrl = listen,
            PublicUrl = publicUrl,
            ExecutionUrl = execution,
            InternalServiceKey = key,
            TrustedProxies = [.. proxies],
            UseStdinControl = configuration.GetValue<bool>("Backend:UseStdinControl")
        };
    }

    private static Uri Url(string? value, string setting)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/" || uri.Port <= 0)
            throw new InvalidOperationException($"{setting} must be an HTTP(S) origin without path, query or credentials.");
        return uri;
    }
}
