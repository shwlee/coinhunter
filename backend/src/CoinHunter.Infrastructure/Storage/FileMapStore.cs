using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CoinHunter.Infrastructure.Storage;

// Generated at build time from the existing JS rules, strategy templates and bundled maps.
public sealed class GameContent(StorageSettings settings)
{
    public JsonObject Value { get; } = JsonNode.Parse(File.ReadAllText(Path.Combine(settings.RepositoryRoot, "backend/contracts/generated/game-content.json")))!.AsObject();
    public JsonObject Defaults => Value["defaults"]!.CloneObject();
    public JsonObject Limits => Value["limits"]!.CloneObject();
    public JsonObject Contract => Value["contract"]!.CloneObject();
}

public static partial class MapRules
{
    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,63}$")]
    public static partial Regex IdPattern();
    public static void Validate(JsonObject map, GameContent content, bool published)
    {
        if (map.Int("schemaVersion") != 1 || !IdPattern().IsMatch(map.Text("id")) || map.Int("revision") < 1 ||
            string.IsNullOrWhiteSpace(map.Text("name")) || map.Text("name").Length > 100 || map.Text("description").Length > 2000)
            throw new ServiceFault(400, "맵 이름·설명을 확인하세요.");
        var columns = map.Int("columns"); var rows = map.Int("rows");
        if (columns is < 4 or > 40 || rows is < 4 or > 30 || map["tiles"] is not JsonArray tiles || tiles.Count != columns * rows)
            throw new ServiceFault(400, "잘못된 맵 크기입니다.");
        if (tiles.Any(tile => tile is not JsonValue value || !value.TryGetValue<int>(out _))) throw new ServiceFault(400, "타일은 정수만 사용할 수 있습니다.");
        var cells = tiles.Select(tile => tile!.GetValue<int>()).ToArray();
        if (cells.Any(tile => !new[] { -1, 0, 10, 30, 100, 200, 500 }.Contains(tile)) ||
            new[] { 0, columns - 1, columns * (rows - 1), cells.Length - 1 }.Any(i => cells[i] != 0))
            throw new ServiceFault(400, "타일과 빈 시작 위치를 확인하세요.");
        if (map["settings"] is not JsonObject settings || settings.Any(pair => !content.Limits.ContainsKey(pair.Key) && pair.Key != "hurryUpRemovalIntervalMs"))
            throw new ServiceFault(400, "지원하지 않는 맵 옵션입니다.");
        foreach (var (key, limits) in content.Limits)
        {
            var number = settings.Int(key, -1);
            if (number < limits![0]!.GetValue<int>() || number > limits[1]!.GetValue<int>())
                throw new ServiceFault(400, $"맵 옵션 범위를 확인하세요: {key}");
        }
        if (settings["hurryUpRemovalIntervalMs"] is JsonNode intervals)
        {
            if (intervals is not JsonObject obj || obj.Any(pair => !new[] { "10", "30", "100", "200", "500" }.Contains(pair.Key) || pair.Value is not JsonValue value || !value.TryGetValue<int>(out var interval) || interval is < 100 or > 60000))
                throw new ServiceFault(400, "코인 소멸 간격을 확인하세요.");
        }
        if (!published) return;
        for (var y = 0; y < rows; y++)
            for (var x = 0; x < columns; x++)
                if (cells[y * columns + x] != cells[y * columns + columns - x - 1] || cells[y * columns + x] != cells[(rows - y - 1) * columns + x])
                    throw new ServiceFault(400, "맵은 상하좌우 대칭이어야 합니다.");
        if (!cells.Any(cell => cell > 0)) throw new ServiceFault(400, "코인을 하나 이상 배치하세요.");
        var seen = new HashSet<int> { 0 }; var queue = new Queue<int>(); queue.Enqueue(0);
        while (queue.TryDequeue(out var i))
            foreach (var next in new[] { i % columns > 0 ? i - 1 : -1, i % columns + 1 < columns ? i + 1 : -1, i - columns, i + columns })
                if (next >= 0 && next < cells.Length && cells[next] != -1 && seen.Add(next)) queue.Enqueue(next);
        if (cells.Where((cell, i) => cell != -1 && !seen.Contains(i)).Any())
            throw new ServiceFault(400, "시작점과 모든 이동 가능 공간이 연결되어야 합니다.");
    }
}

public sealed class FileMapStore(StorageSettings settings, GameContent content, IAccountStore writerLease) : IMapStore
{
    private readonly SemaphoreSlim gate = new(1);
    private string RegistryPath => Path.Combine(settings.DataRoot, "maps/registry.json");
    private Task<JsonObject> Custom() => AtomicFile.Read(RegistryPath, new JsonObject { ["schemaVersion"] = 1, ["maps"] = new JsonArray() });
    private async Task<JsonArray> Entries()
    {
        _ = writerLease; // Same process owns the only operations writer lease.
        var custom = await Custom();
        var values = content.Value["samples"]!.AsArray().Select(sample => sample!["entry"]!.CloneObject())
            .Concat(custom["maps"]!.AsArray().OfType<JsonObject>().Select(entry => { var value = entry.CloneObject(); value["source"] = "custom"; return value; }))
            .OrderBy(entry => entry.Int("order")).ThenBy(entry => entry.Text("id")).ToList();
        if (values.Select(entry => entry.Text("id")).Distinct().Count() != values.Count) throw new InvalidDataException("Duplicate map id.");
        if (custom["displayOrder"] is JsonArray order)
        {
            values = values.OrderBy(entry => { var index = order.ToList().FindIndex(id => id!.GetValue<string>() == entry.Text("id")); return index < 0 ? int.MaxValue : index; }).ToList();
            for (var i = 0; i < values.Count; i++) values[i]["order"] = i + 1;
        }
        return new JsonArray(values.Select(value => (JsonNode)value).ToArray());
    }
    public async Task<JsonArray> Registry() { await gate.WaitAsync(); try { return await Entries(); } finally { gate.Release(); } }
    private async Task<JsonObject> Read(JsonObject entry, int revision)
    {
        var id = entry.Text("id");
        if (!MapRules.IdPattern().IsMatch(id) || revision < 1) throw new ServiceFault(400, "맵 참조를 확인하세요.");
        var map = entry.Text("source") == "sample"
            ? content.Value["samples"]!.AsArray().Single(sample => sample!["entry"]!.Text("id") == id)!["document"]!.CloneObject()
            : await AtomicFile.Read(Path.Combine(settings.DataRoot, "maps", id, revision + ".json"), new JsonObject());
        if (map.Text("id") != id || map.Int("revision") != revision) throw new ServiceFault(404, "맵 버전을 찾을 수 없습니다.");
        MapRules.Validate(map, content, false);
        return map;
    }
    public async Task<JsonObject> Get(string id, int? revision = null, bool published = false)
    {
        await gate.WaitAsync();
        try
        {
            var entry = (await Entries()).OfType<JsonObject>().SingleOrDefault(entry => entry.Text("id") == id) ?? throw new ServiceFault(404, "맵을 찾을 수 없습니다.");
            if (published && (!entry.Bool("enabled") || entry["publishedRevision"] is null)) throw new ServiceFault(404, "게시된 맵을 찾을 수 없습니다.");
            var version = revision ?? (published ? entry.Int("publishedRevision") : entry.Int("draftRevision", entry.Int("publishedRevision")));
            return await Read(entry, version);
        }
        finally { gate.Release(); }
    }
    public async Task<JsonObject> Save(JsonObject document, int expectedRevision)
    {
        await gate.WaitAsync();
        try
        {
            var id = document.Text("id"); var entries = await Entries();
            var current = entries.OfType<JsonObject>().SingleOrDefault(entry => entry.Text("id") == id);
            if (current?.Text("source") == "sample") throw new ServiceFault(403, "기본 샘플은 읽기 전용입니다.");
            if ((current?.Int("draftRevision") ?? 0) != expectedRevision) throw new ServiceFault(409, "맵이 변경되었습니다. 최신 버전을 다시 불러오세요.");
            var saved = document.CloneObject(); saved["schemaVersion"] = 1; saved["revision"] = expectedRevision + 1;
            MapRules.Validate(saved, content, false);
            var registry = await Custom(); var list = registry["maps"]!.AsArray();
            var entry = list.OfType<JsonObject>().SingleOrDefault(entry => entry.Text("id") == id);
            if (entry is null)
            {
                entry = new JsonObject { ["id"] = id, ["publishedRevision"] = null, ["enabled"] = false, ["order"] = entries.Count + 1 };
                list.Add(entry);
            }
            entry["draftRevision"] = expectedRevision + 1;
            await AtomicFile.Json(Path.Combine(settings.DataRoot, "maps", id, $"{expectedRevision + 1}.json"), saved);
            await AtomicFile.Json(RegistryPath, registry);
            return saved;
        }
        finally { gate.Release(); }
    }
    public async Task<JsonObject> SetState(string id, JsonObject expected, int? publishRevision, bool? enabled)
    {
        await gate.WaitAsync();
        try
        {
            var registry = await Custom();
            var entry = registry["maps"]!.AsArray().OfType<JsonObject>().SingleOrDefault(entry => entry.Text("id") == id) ?? throw new ServiceFault(403, "관리자 맵을 선택하세요.");
            if (expected.Int("draftRevision") < 1 || expected["publishedRevision"] is not null && expected.Int("publishedRevision") < 1 || expected["enabled"] is null) throw new ServiceFault(400, "이전 맵 상태를 확인하세요.");
            _ = expected.Bool("enabled");
            foreach (var key in new[] { "draftRevision", "publishedRevision", "enabled" })
                if (!expected.ContainsKey(key) || !JsonNode.DeepEquals(entry[key], expected[key])) throw new ServiceFault(409, "맵 상태가 변경되었습니다. 최신 목록을 확인하세요.");
            if (publishRevision is int revision)
            {
                if (entry.Int("draftRevision") != revision) throw new ServiceFault(409, "최신 저장 버전만 게시할 수 있습니다.");
                var readEntry = entry.CloneObject(); readEntry["source"] = "custom";
                MapRules.Validate(await Read(readEntry, revision), content, true);
                if (entry["publishedRevision"] is null) entry["enabled"] = true;
                entry["publishedRevision"] = revision;
            }
            else
            {
                if (entry["publishedRevision"] is null || enabled is null) throw new ServiceFault(400, "게시된 맵과 표시 설정을 확인하세요.");
                entry["enabled"] = enabled;
            }
            await AtomicFile.Json(RegistryPath, registry);
            var result = entry.CloneObject(); result["source"] = "custom"; return result;
        }
        finally { gate.Release(); }
    }
    public async Task Reorder(string[] ids, string[] expectedIds)
    {
        await gate.WaitAsync();
        try
        {
            var current = (await Entries()).Select(entry => entry!.Text("id")).ToArray();
            if (!expectedIds.SequenceEqual(current)) throw new ServiceFault(409, "맵 순서가 변경되었습니다.");
            if (ids.Length != current.Length || ids.Distinct().Count() != ids.Length || ids.Except(current).Any()) throw new ServiceFault(400, "전체 맵을 중복 없이 지정하세요.");
            var registry = await Custom(); registry["displayOrder"] = new JsonArray(ids.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray());
            await AtomicFile.Json(RegistryPath, registry);
        }
        finally { gate.Release(); }
    }
}
