using System.Net.Http.Headers;
using System.Net.Http.Json;
using CoinHunter.Contracts;

namespace CoinHunter.Infrastructure;

public interface IReadinessProbe
{
    Task<IReadOnlyDictionary<string, string>> CheckAsync(CancellationToken cancellationToken);
}

public sealed class ExecutionBootstrapProbe : IReadinessProbe
{
    public Task<IReadOnlyDictionary<string, string>> CheckAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyDictionary<string, string>>(new Dictionary<string, string>());
}

public sealed class ExecutionDependencyProbe(HttpClient client, BackendSettings settings) : IReadinessProbe
{
    public async Task<IReadOnlyDictionary<string, string>> CheckAsync(CancellationToken cancellationToken)
    {
        var status = "unavailable";
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(1));
        var probeToken = deadline.Token;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(settings.ExecutionUrl, "internal/v1/status"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.InternalServiceKey);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, probeToken);
            if (response.IsSuccessStatusCode)
            {
                // Bounded response: never allow a misconfigured peer to allocate an unbounded status body.
                await using var body = await response.Content.ReadAsStreamAsync(probeToken);
                var bytes = new byte[8193];
                var used = 0;
                while (used < bytes.Length)
                {
                    var read = await body.ReadAsync(bytes.AsMemory(used), probeToken);
                    if (read == 0) break;
                    used += read;
                }
                if (used <= 8192)
                {
                    var result = System.Text.Json.JsonSerializer.Deserialize<ExecutionServiceStatus>(bytes.AsSpan(0, used), Protocol.JsonOptions);
                    if (result?.Service == Protocol.ExecutionService && result.ContractVersion == Protocol.Version &&
                        result.Stage == Protocol.Stage && result.BusinessReady && result.Capabilities is not null &&
                        new[] { "matches", "validations", "recordings" }.All(result.Capabilities.Contains))
                        status = "ready";
                }
            }
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or System.Text.Json.JsonException or IOException)
        {
            if (cancellationToken.IsCancellationRequested) cancellationToken.ThrowIfCancellationRequested();
        }
        return new Dictionary<string, string> { [Protocol.ExecutionService] = status };
    }
}
