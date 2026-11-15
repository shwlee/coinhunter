using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public sealed class RequestInput(StorageSettings settings)
{
    private readonly SemaphoreSlim uploads = new(4);
    public static bool IsSource(HttpRequest request) => request.ContentType?.Split(';')[0].Trim() == "text/plain";
    public static async Task<JsonObject> Json(HttpRequest request, int limit = 65536)
    {
        if (request.ContentType?.Split(';')[0].Trim() != "application/json") throw new ServiceFault(415, "JSON 요청이 필요합니다.");
        if (request.ContentLength > limit) throw new ServiceFault(413, "JSON 요청 크기가 허용 범위를 넘었습니다.");
        using var buffer = new MemoryStream(); var bytes = new byte[16384];
        while (true) { var read = await request.Body.ReadAsync(bytes, request.HttpContext.RequestAborted); if (read == 0) break; if (buffer.Length + read > limit) throw new ServiceFault(413, "JSON 요청 크기가 허용 범위를 넘었습니다."); buffer.Write(bytes, 0, read); }
        return JsonNode.Parse(buffer.ToArray()) as JsonObject ?? throw new ServiceFault(400, "JSON 객체가 필요합니다.");
    }
    public async Task<SourceReference> Upload(HttpRequest request, ISourceStore? destination = null)
    {
        if (!IsSource(request)) throw new ServiceFault(415, "JavaScript 코드 파일이 필요합니다.");
        if (!await uploads.WaitAsync(0, request.HttpContext.RequestAborted)) throw new ServiceFault(429, "동시 코드 업로드 한도입니다.");
        try { return await (destination ?? new FileSourceStore(settings.ExchangeRoot)).Put(request.Body, request.HttpContext.RequestAborted); }
        finally { uploads.Release(); }
    }
    public static async Task<SourceReference> Inline(JsonObject input, ISourceStore store)
    {
        if (input["source"] is not JsonValue source || !source.TryGetValue<string>(out var text)) throw new ServiceFault(400, "알고리즘 코드가 필요합니다.");
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(text)); return await store.Put(stream);
    }
}
