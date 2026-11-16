using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using CoinHunter.Contracts;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class AlgorithmsController(SessionService sessions, AccountService accounts, RequestInput input, GameContent content, StorageSettings storage, MatchService matches, AlgorithmValidationService validation) : ControllerBase
{
    [HttpGet("/api/algorithm-assistant/contract")]
    public async Task<IActionResult> Contract() { await sessions.Require(HttpContext); return Ok(content.Contract); }
    [HttpGet("/api/algorithms")]
    public async Task<IActionResult> List() { var user = await sessions.Require(HttpContext); return Ok(new { algorithms = await accounts.Algorithms(user.Text("id")) }); }
    [HttpPost("/api/algorithms")]
    [HttpPut("/api/algorithms/{id:guid}")]
    public async Task<IActionResult> Save(Guid? id = null)
    {
        var user = await sessions.Require(HttpContext); string name; int revision; SourceReference source;
        if (RequestInput.IsSource(Request))
        {
            name = Request.Query["name"].ToString(); revision = int.TryParse(Request.Query["revision"], out var version) ? version : 0;
            source = await input.Upload(Request, accounts.Sources);
        }
        else
        {
            var json = await RequestInput.Json(Request, 2 * 1024 * 1024); name = json.Text("name"); revision = json.Int("revision"); source = await RequestInput.Inline(json, accounts.Sources);
        }
        JsonObject result;
        try
        {
            result = await accounts.Save(user.Text("id"), id?.ToString(), name, revision, source.SourceKey, source.Sha256);
        }
        catch { await accounts.Sources.Delete(source.SourceKey); throw; }
        await validation.Queue(user.Text("id"), result, source.SourceKey);
        return StatusCode(id.HasValue ? 200 : 201, result);
    }
    [HttpGet("/api/algorithms/{id:guid}")]
    public async Task<IActionResult> Get(Guid id)
    {
        var user = await sessions.Require(HttpContext); var item = await accounts.Algorithm(user.Text("id"), id.ToString()); var metadata = JsonData.Metadata(item);
        if (Request.Query["metadata"] != "1")
        {
            await using var file = accounts.Sources.Open(Guid.Parse(item.Text("sourceKey")));
            if (file.Length > 2 * 1024 * 1024) throw new ServiceFault(413, "큰 코드는 코드 파일 다운로드 경로를 사용하세요.");
            using var reader = new StreamReader(file); metadata["source"] = await reader.ReadToEndAsync(HttpContext.RequestAborted);
        }
        return Ok(metadata);
    }
    [HttpPost("/api/algorithms/{id:guid}/validate")]
    public async Task<IActionResult> Recheck(Guid id)
    {
        var user = await sessions.Require(HttpContext);
        var item = await accounts.Algorithm(user.Text("id"), id.ToString());
        await validation.Queue(user.Text("id"), item, Guid.Parse(item.Text("sourceKey")));
        return Ok(JsonData.Metadata(item));
    }
    [HttpGet("/api/algorithms/{id:guid}/source")]
    public async Task<IActionResult> Source(Guid id)
    {
        var user = await sessions.Require(HttpContext); var item = await accounts.Algorithm(user.Text("id"), id.ToString());
        var metadata = JsonData.Metadata(item);
        // Debug logs/diagnostics belong in the JSON endpoint, never in HTTP headers.
        if (metadata["validation"] is JsonObject state) state.Remove("diagnostic");
        Response.Headers["X-Coinhunter-Metadata"] = Uri.EscapeDataString(metadata.ToJsonString());
        return File(accounts.Sources.Open(Guid.Parse(item.Text("sourceKey"))), "text/plain; charset=utf-8");
    }
    [HttpPost("/api/algorithms/validate")]
    [HttpPost("/api/game/validate")]
    public async Task<IActionResult> Validate()
    {
        var user = Request.Path.Value == "/api/algorithms/validate" ? await sessions.Require(HttpContext) : await sessions.Current(HttpContext);
        var scope = new ExecutionScope { Kind = user is null ? "guest" : "user", SubjectId = Guid.Parse(user?.Text("id") ?? sessions.Guest(HttpContext)) };
        var exchange = new FileSourceStore(storage.ExchangeRoot);
        var reference = RequestInput.IsSource(Request) ? await input.Upload(Request) : await RequestInput.Inline(await RequestInput.Json(Request, 2 * 1024 * 1024), exchange);
        try
        {
            var result = await validation.Check(scope, reference, HttpContext.RequestAborted);
            return StatusCode(result.Bool("ok") ? 200 : 400, result);
        }
        finally { System.IO.File.Delete(exchange.PathFor(reference.SourceKey)); }
    }
    [HttpGet("/api/history")]
    public async Task<IActionResult> History()
    {
        var user = await sessions.Require(HttpContext);
        try { await matches.Refresh(); } catch (ServiceFault fault) when (fault.Status is 429 or 503) { }
        return Ok(new { history = await accounts.History(user.Text("id")) });
    }
    [HttpGet("/api/example")]
    public IActionResult Example() => File(System.Text.Encoding.UTF8.GetBytes(content.Value.Text("example")), "text/plain; charset=utf-8", "nearest-coin.js");
}
