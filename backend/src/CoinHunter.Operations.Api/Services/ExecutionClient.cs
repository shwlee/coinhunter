using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public sealed class ExecutionClient(IHttpClientFactory clients, BackendSettings settings)
{
    public async Task CopyRecording(Guid id, HttpResponse output, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(settings.ExecutionUrl, $"/internal/v1/matches/{id}/recording"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.InternalServiceKey);
        using var response = await clients.CreateClient("execution").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (!response.IsSuccessStatusCode) throw new ServiceFault((int)response.StatusCode, "실행 기록을 불러올 수 없습니다.");
        output.ContentType = "application/x-ndjson"; output.Headers.ContentDisposition = $"attachment; filename=\"{id}.jsonl\"";
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        await stream.CopyToAsync(output.Body, token);
    }
    public async Task<JsonObject> Call(HttpMethod method, string path, object? body = null, CancellationToken token = default)
    {
        using var request = new HttpRequestMessage(method, new Uri(settings.ExecutionUrl, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.InternalServiceKey);
        if (body is not null) request.Content = JsonContent.Create(body, options: Protocol.JsonOptions);
        try
        {
            using var response = await clients.CreateClient("execution").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(40));
            using var output = new MemoryStream(); var buffer = new byte[65536];
            while (true) { var read = await stream.ReadAsync(buffer, deadline.Token); if (read == 0) break; if (output.Length + read > Protocol.MaxFrameBytes) throw new IOException("Internal response too large."); output.Write(buffer, 0, read); }
            var value = JsonNode.Parse(output.ToArray())!.AsObject();
            if (!response.IsSuccessStatusCode) throw new ServiceFault((int)response.StatusCode, value.Text("error", "실행 서비스 요청을 처리하지 못했습니다."));
            return value;
        }
        catch (HttpRequestException) { throw new ServiceFault(503, "게임 실행 서비스에 연결할 수 없습니다."); }
    }
}
