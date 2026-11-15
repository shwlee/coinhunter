using System.Text.Json.Nodes;
using CoinHunter.Contracts;

namespace CoinHunter.Infrastructure.Storage;

public sealed class ServiceFault(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public interface IAccountStore
{
    Task<T> Read<T>(Func<JsonObject, T> read);
    Task<T> Change<T>(Func<JsonObject, Task<T>> change);
}

public interface ISourceStore
{
    Task<SourceReference> Put(Stream input, CancellationToken cancellationToken = default);
    FileStream Open(Guid key);
    Task<SourceReference> Describe(Guid key);
    Task<SourceReference> Copy(Guid key, ISourceStore destination);
    Task Delete(Guid key);
}

public interface IMapStore
{
    Task<JsonArray> Registry();
    Task<JsonObject> Get(string id, int? revision = null, bool published = false);
    Task<JsonObject> Save(JsonObject document, int expectedRevision);
    Task<JsonObject> SetState(string id, JsonObject expected, int? publishRevision, bool? enabled);
    Task Reorder(string[] ids, string[] expectedIds);
}

public static class JsonData
{
    private static T Read<T>(JsonNode? node, string key, T fallback)
    {
        if (node is null) return fallback;
        if (node is not JsonObject obj) throw new ServiceFault(400, "객체 형식이 필요합니다.");
        if (obj[key] is null) return fallback;
        return obj[key] is JsonValue value && value.TryGetValue<T>(out var result) ? result : throw new ServiceFault(400, $"값의 형식을 확인하세요: {key}");
    }
    public static string Text(this JsonNode? node, string key, string fallback = "") => Read(node, key, fallback);
    public static int Int(this JsonNode? node, string key, int fallback = 0) => Read(node, key, fallback);
    public static bool Bool(this JsonNode? node, string key, bool fallback = false) => Read(node, key, fallback);
    public static JsonObject CloneObject(this JsonNode node) => (JsonObject)node.DeepClone();
    public static JsonObject Metadata(JsonObject node)
    {
        var result = node.CloneObject();
        result.Remove("sourceKey");
        result.Remove("source");
        return result;
    }
    public static JsonArray Array(JsonObject data, string key) => (JsonArray)(data[key] ??= new JsonArray());
    public static JsonObject Find(JsonObject data, string collection, string id) =>
        Array(data, collection).OfType<JsonObject>().SingleOrDefault(item => item.Text("id") == id)
        ?? throw new ServiceFault(404, "대상을 찾을 수 없습니다.");
}
