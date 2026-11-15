using System.Net;
using System.Security.Cryptography;
using System.Text;
using CoinHunter.Contracts;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Infrastructure;

public static class BackendFoundation
{
    public static void AddBackendFoundation(this WebApplicationBuilder builder, BackendSettings settings)
    {
        builder.WebHost.UseSetting("urls", settings.ListenUrl.GetLeftPart(UriPartial.Authority));
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = null);
        builder.Services.AddSingleton(settings);
        builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(15));
        builder.Services.AddControllers().AddApplicationPart(typeof(HealthController).Assembly).AddJsonOptions(options =>
        {
            options.JsonSerializerOptions.PropertyNameCaseInsensitive = false;
            options.JsonSerializerOptions.UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow;
            options.JsonSerializerOptions.MaxDepth = 64;
        }).ConfigureApiBehaviorOptions(options => options.InvalidModelStateResponseFactory = _ =>
            new Microsoft.AspNetCore.Mvc.BadRequestObjectResult(new ApiError("요청 형식과 필수 값을 확인하세요.", "invalid_request")));
        builder.Services.AddProblemDetails();
        builder.Logging.ClearProviders();
        builder.Logging.AddSimpleConsole(options => options.SingleLine = true);
        // Default request diagnostics include query strings; OAuth/code requests must not reach access logs.
        builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
        builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
        builder.Services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedHost | ForwardedHeaders.XForwardedProto;
            options.ForwardLimit = 1;
            options.RequireHeaderSymmetry = true;
            options.KnownProxies.Clear();
            options.KnownIPNetworks.Clear();
            foreach (var address in settings.TrustedProxies) options.KnownProxies.Add(address);
        });
        if (settings.UseStdinControl) builder.Services.AddHostedService<StdinLifetime>();
    }

    public static void UseBackendFoundation(this WebApplication app, BackendSettings settings)
    {
        var expectedKey = SHA256.HashData(Encoding.UTF8.GetBytes(settings.InternalServiceKey));
        app.Use(async (context, next) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            var hasForwarded = context.Request.Headers.Keys.Any(key =>
                key.Equals("Forwarded", StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith("X-Original-", StringComparison.OrdinalIgnoreCase));
            var peer = context.Connection.RemoteIpAddress;
            var trusted = peer is not null && settings.TrustedProxies.Any(address =>
                address.Equals(peer) || address.MapToIPv6().Equals(peer.MapToIPv6()));
            if (hasForwarded && (!trusted || context.Request.Headers.ContainsKey("Forwarded") ||
                context.Request.Headers.Keys.Any(key => key.StartsWith("X-Original-", StringComparison.OrdinalIgnoreCase))))
            {
                await Error(context, 403, "Untrusted forwarding headers.", "untrusted_proxy");
                return;
            }
            if (hasForwarded)
            {
                var expectedHeaders = new[] { "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto" };
                if (expectedHeaders.Any(name => !context.Request.Headers.TryGetValue(name, out var values) ||
                    values.Count != 1 || string.IsNullOrWhiteSpace(values[0]) || values[0]!.Contains(',')) ||
                    context.Request.Headers.Keys.Any(name => name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase) &&
                        !expectedHeaders.Contains(name, StringComparer.OrdinalIgnoreCase)) ||
                    !IPAddress.TryParse(context.Request.Headers["X-Forwarded-For"], out _))
                {
                    await Error(context, 403, "A single complete forwarding hop is required.", "invalid_proxy_headers");
                    return;
                }
            }
            await next(context);
        });
        app.UseForwardedHeaders();
        app.Use(async (context, next) =>
        {
            var authority = context.Request.Host.Value ?? "";
            var own = settings.ListenUrl.Authority;
            var publiclyAddressed = authority.Equals(settings.PublicUrl.Authority, StringComparison.OrdinalIgnoreCase) &&
                context.Request.Scheme == settings.PublicUrl.Scheme;
            if (!(authority.Equals(own, StringComparison.OrdinalIgnoreCase) && context.Request.Scheme == settings.ListenUrl.Scheme) &&
                !publiclyAddressed)
            {
                await Error(context, 403, "Host or scheme is not allowed.", "invalid_host");
                return;
            }
            if (context.Request.Headers.TryGetValue("Origin", out var origins) &&
                (settings.Service == Protocol.ExecutionService || origins.Count != 1 ||
                 !string.Equals(origins[0], settings.PublicUrl.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase)))
            {
                await Error(context, 403, "Origin is not allowed.", "invalid_origin");
                return;
            }
            if (context.Request.Path.StartsWithSegments("/internal"))
            {
                var authorization = context.Request.Headers.Authorization;
                var supplied = authorization.Count == 1 && authorization[0]?.StartsWith("Bearer ", StringComparison.Ordinal) == true
                    ? authorization[0]![7..] : "";
                if (supplied.Length is < 32 or > 256 ||
                    !CryptographicOperations.FixedTimeEquals(expectedKey, SHA256.HashData(Encoding.UTF8.GetBytes(supplied))))
                {
                    context.Response.Headers.WWWAuthenticate = "Bearer";
                    await Error(context, 401, "Internal service authentication is required.", "service_auth_required");
                    return;
                }
            }
            await next(context);
        });
        app.Use(async (context, next) =>
        {
            try { await next(context); }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { context.Abort(); }
            catch (Exception failure)
            {
                if (context.Response.HasStarted) { context.Abort(); return; }
                var task = failure switch
                {
                    ServiceFault fault => Error(context, fault.Status, fault.Message, "request_failed"),
                    System.Text.Json.JsonException or InvalidDataException or FormatException or ArgumentException => Error(context, 400, "요청 형식과 값을 확인하세요.", "invalid_request"),
                    TimeoutException or OperationCanceledException => Error(context, 503, "처리 대기 시간을 초과했습니다. 다시 시도하세요.", "service_timeout"),
                    _ => Error(context, 500, "요청을 완료하지 못했습니다.", "internal_error")
                };
                if (failure is not ServiceFault) app.Logger.LogWarning("Request failed: {ErrorType}", failure.GetType().Name);
                await task;
            }
        });
        app.MapControllers();
        app.MapFallback("{**path}", context => Error(context, 404, "Endpoint not found.", "not_found"));
    }

    public static Task Error(HttpContext context, int status, string message, string code)
    {
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(new ApiError(message, code), cancellationToken: context.RequestAborted);
    }
}

// Optional parent-only shutdown channel. No HTTP shutdown endpoint is exposed.
internal sealed class StdinLifetime(IHostApplicationLifetime lifetime) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var line = await Task.Run(Console.ReadLine, CancellationToken.None).WaitAsync(stoppingToken);
                if (line is null || line == "shutdown")
                {
                    lifetime.StopApplication();
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
