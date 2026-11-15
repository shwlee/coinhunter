using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class MapsController(SessionService sessions, IMapStore maps, GameContent content) : ControllerBase
{
    private async Task<JsonObject> Entry(string id) => (await maps.Registry()).OfType<JsonObject>().SingleOrDefault(entry => entry.Text("id") == id) ?? throw new ServiceFault(404, "맵을 찾을 수 없습니다.");
    [HttpGet("/api/maps")]
    public async Task<IActionResult> Published()
    {
        var list = new JsonArray();
        foreach (var entry in (await maps.Registry()).OfType<JsonObject>().Where(entry => entry.Bool("enabled") && entry["publishedRevision"] is not null)) list.Add(await maps.Get(entry.Text("id"), published: true));
        return Ok(new { maps = list });
    }
    [HttpGet("/api/admin/maps")]
    public async Task<IActionResult> List()
    {
        await sessions.Require(HttpContext, true); var list = new JsonArray();
        foreach (var entry in (await maps.Registry()).OfType<JsonObject>().Where(entry => entry.Text("source") == "custom" || Request.Query["includeSamples"] == "1"))
        {
            var map = await maps.Get(entry.Text("id")); var item = entry.CloneObject(); var tiles = map["tiles"]!.AsArray().Select(tile => tile!.GetValue<int>()).ToArray();
            foreach (var key in new[] { "name", "description", "columns", "rows" }) item[key] = map[key]!.DeepClone();
            item["coins"] = tiles.Count(tile => tile > 0); item["score"] = tiles.Sum(tile => Math.Max(0, tile)); item["walls"] = tiles.Count(tile => tile == -1); list.Add(item);
        }
        return Ok(new { maps = list });
    }
    [HttpGet("/api/admin/maps/default-settings")]
    public async Task<IActionResult> Defaults() { await sessions.Require(HttpContext, true); return Ok(new { settings = content.Defaults, limits = content.Limits }); }
    [HttpPost("/api/admin/maps/validate-json")]
    [HttpPost("/api/admin/maps/validate-array")]
    public async Task<IActionResult> Validate()
    {
        await sessions.Require(HttpContext, true); var input = await RequestInput.Json(Request);
        if (Request.Path.Value!.EndsWith("validate-array", StringComparison.Ordinal))
        {
            if (input.Any(pair => !new[] { "source", "columns", "rows" }.Contains(pair.Key))) throw new ServiceFault(400, "맵 배열과 열·행을 확인하세요.");
            var text = input.Text("source").Trim().TrimStart('\uFEFF');
            var match = Regex.Match(text, @"^\[([\s\S]*)\]\s*;?$|^(?:int\s*\[\s*\]\s+[A-Za-z_]\w*\s*=\s*)?(?:new\s+int\s*\[\s*\]\s*)?\{([\s\S]*)\}\s*;?$");
            if (!match.Success) throw new ServiceFault(400, "배열 하나를 입력하세요: [ ... ] 또는 new int[] { ... }");
            var body = (match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value).Trim();
            if (body.EndsWith(',')) body = body[..^1].TrimEnd();
            var cells = body.Split(',').Select(token => Regex.IsMatch(token.Trim(), @"^[+-]?\d+$") && int.TryParse(token.Trim(), out var number) ? number : throw new ServiceFault(400, "배열은 정수만 허용됩니다.")).ToArray();
            input = new JsonObject { ["schemaVersion"] = 1, ["id"] = "array-import", ["revision"] = 1, ["name"] = "가져온 배열 맵", ["description"] = "", ["columns"] = input.Int("columns"), ["rows"] = input.Int("rows"), ["tiles"] = new JsonArray(cells.Select(cell => (JsonNode)JsonValue.Create(cell)!).ToArray()), ["settings"] = content.Defaults };
            MapRules.Validate(input, content, false); input.Remove("id"); input.Remove("revision"); input.Remove("schemaVersion");
        }
        else MapRules.Validate(input, content, false);
        return Ok(new { map = input });
    }
    [HttpPost("/api/admin/maps")]
    [HttpPut("/api/admin/maps/{id}/draft")]
    public async Task<IActionResult> Save(string? id = null)
    {
        await sessions.Require(HttpContext, true); var input = await RequestInput.Json(Request); var expected = id is null ? 0 : input.Int("expectedRevision", -1);
        if (id is not null && expected < 1) throw new ServiceFault(400, "이전 맵 버전을 확인하세요.");
        var original = id is null ? null : await maps.Get(id); var document = new JsonObject { ["id"] = id ?? "map-" + Guid.NewGuid(), ["name"] = input.Text("name").Trim(), ["description"] = input.Text("description"), ["columns"] = input.Int("columns"), ["rows"] = input.Int("rows"), ["tiles"] = input["tiles"]?.DeepClone(), ["settings"] = input["settings"]?.DeepClone() ?? original?["settings"]?.DeepClone() ?? content.Defaults };
        var map = await maps.Save(document, expected); return StatusCode(id is null ? 201 : 200, new { map, state = await Entry(map.Text("id")) });
    }
    [HttpGet("/api/admin/maps/{id}/draft")]
    public async Task<IActionResult> Draft(string id) { await sessions.Require(HttpContext, true); var state = await Entry(id); if (state.Text("source") != "custom") throw new ServiceFault(404, "관리자 맵을 선택하세요."); return Ok(new { map = await maps.Get(id), state }); }
    [HttpGet("/api/admin/maps/{id}/preview")]
    public async Task<IActionResult> Preview(string id)
    {
        await sessions.Require(HttpContext, true); var state = await Entry(id);
        if (!int.TryParse(Request.Query["revision"], out var revision) || revision < 1 || revision > state.Int("draftRevision", state.Int("publishedRevision"))) throw new ServiceFault(400, "미리보기 버전을 확인하세요.");
        return Ok(new { map = await maps.Get(id, revision) });
    }
    [HttpGet("/api/admin/maps/{id}/settings")]
    [HttpPut("/api/admin/maps/{id}/settings")]
    public async Task<IActionResult> Settings(string id)
    {
        await sessions.Require(HttpContext, true); var map = await maps.Get(id);
        if (Request.Method == "PUT") { var input = await RequestInput.Json(Request); if (input.Int("expectedRevision") < 1) throw new ServiceFault(400, "이전 맵 버전을 확인하세요."); map["settings"] = input["settings"]?.DeepClone(); map = await maps.Save(map, input.Int("expectedRevision")); }
        var defaults = content.Defaults["hurryUpRemovalIntervalMs"]!.CloneObject();
        if (map["settings"]?["hurryUpRemovalIntervalMs"] is JsonObject overrides) foreach (var pair in overrides) defaults[pair.Key] = pair.Value!.DeepClone();
        map["settings"]!["hurryUpRemovalIntervalMs"] = defaults;
        return Ok(new { map = new { id, name = map.Text("name"), revision = map.Int("revision"), settings = map["settings"] }, state = await Entry(id), limits = content.Limits });
    }
    [HttpPost("/api/admin/maps/{id}/publish")]
    [HttpPut("/api/admin/maps/{id}/visibility")]
    public async Task<IActionResult> State(string id)
    {
        await sessions.Require(HttpContext, true); var input = await RequestInput.Json(Request);
        if (input["expected"] is not JsonObject expected) throw new ServiceFault(400, "이전 맵 상태가 필요합니다.");
        var publish = Request.Path.Value!.EndsWith("/publish", StringComparison.Ordinal);
        return Ok(new { state = await maps.SetState(id, expected, publish ? input.Int("revision") : null, publish ? null : input["enabled"]?.GetValue<bool>()) });
    }
    [HttpPut("/api/admin/maps/order")]
    public async Task<IActionResult> Order()
    {
        await sessions.Require(HttpContext, true); var input = await RequestInput.Json(Request);
        if (input["ids"] is not JsonArray ids || input["expectedIds"] is not JsonArray previous) throw new ServiceFault(400, "전체 맵 순서를 확인하세요.");
        await maps.Reorder(ids.Select(value => value!.GetValue<string>()).ToArray(), previous.Select(value => value!.GetValue<string>()).ToArray()); return Ok(new { ok = true });
    }
    // Serializes duplicate-name check + save across HTTP requests for this sole writer host.
    private static readonly SemaphoreSlim CopyGate = new(1);
    [HttpPost("/api/admin/maps/{id}/copy")]
    public async Task<IActionResult> Copy(string id)
    {
        await sessions.Require(HttpContext, true); var input = await RequestInput.Json(Request); await CopyGate.WaitAsync(HttpContext.RequestAborted);
        try
        {
            var original = await maps.Get(id); if (original.Int("revision") != input.Int("sourceRevision")) throw new ServiceFault(409, "원본 맵이 변경되었습니다.");
            var name = input.Text("name").Trim(); if (string.IsNullOrWhiteSpace(name) || name.Length > 100) throw new ServiceFault(400, "새 이름을 확인하세요.");
            foreach (var entry in (await maps.Registry()).OfType<JsonObject>())
                foreach (var revision in new[] { entry.Int("draftRevision"), entry.Int("publishedRevision") }.Where(value => value > 0).Distinct())
                    if ((await maps.Get(entry.Text("id"), revision)).Text("name").Trim().Normalize().Equals(name.Normalize(), StringComparison.OrdinalIgnoreCase)) throw new ServiceFault(409, "이미 사용 중인 맵 이름입니다.");
            original["id"] = "map-" + Guid.NewGuid(); original["name"] = name;
            var map = await maps.Save(original, 0); return StatusCode(201, new { map, state = await Entry(map.Text("id")) });
        }
        finally { CopyGate.Release(); }
    }
}
