using System.Text.Json.Nodes;
using CoinHunter.Contracts;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class MatchesController(SessionService sessions, MatchService matches, RequestInput input, StorageSettings settings, ExecutionClient execution, StreamAdmission streams) : ControllerBase
{
    private async Task<ExecutionScope> Scope()
    {
        var user = await sessions.Current(HttpContext);
        return new ExecutionScope { Kind = user is null ? "guest" : "user", SubjectId = Guid.Parse(user?.Text("id") ?? sessions.Guest(HttpContext)) };
    }
    [HttpPost("/api/matches")]
    public async Task<IActionResult> Create()
    {
        var scope = await Scope(); JsonObject options; SourceReference? source = null;
        if (RequestInput.IsSource(Request))
        {
            var header = Request.Headers["X-Coinhunter-Options"];
            if (header.Count != 1 || header[0]!.Length > 4096) throw new ServiceFault(400, "경기 설정을 확인하세요.");
            options = JsonNode.Parse(header[0]!) as JsonObject ?? throw new ServiceFault(400, "경기 설정이 필요합니다.");
            if (options.ContainsKey("source") || options.ContainsKey("algorithmId")) throw new ServiceFault(400, "코드 파일 하나만 선택하세요.");
            source = await input.Upload(Request);
        }
        else
        {
            options = await RequestInput.Json(Request, 2 * 1024 * 1024);
            if (options.ContainsKey("source")) source = await RequestInput.Inline(options, new FileSourceStore(settings.ExchangeRoot));
        }
        var key = Request.Headers["Idempotency-Key"];
        if (key.Count > 1) throw new ServiceFault(400, "요청 ID는 하나만 지정하세요.");
        return StatusCode(201, new { id = await matches.Create(scope, options, source, key.Count == 0 ? null : key[0]) });
    }
    [HttpGet("/api/matches/{id:guid}")]
    public async Task<IActionResult> Get(Guid id) => Ok(await matches.View(id.ToString(), await Scope()));
    [HttpDelete("/api/matches/{id:guid}")]
    public async Task<IActionResult> Stop(Guid id) { await matches.Stop(id.ToString(), await Scope()); return Ok(new { ok = true }); }
    [HttpGet("/api/matches/{id:guid}/events")]
    public async Task Events(Guid id)
    {
        var scope = await Scope(); await matches.Owned(id.ToString(), scope);
        using var streamLease = streams.Enter(scope.Kind + scope.SubjectId);
        Response.ContentType = "text/event-stream"; Response.Headers["X-Accel-Buffering"] = "no";
        var sequence = -1; var heartbeat = DateTimeOffset.UtcNow;
        try
        {
            while (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                if (scope.Kind == "user" && (await sessions.Current(HttpContext))?.Text("id") != scope.SubjectId.ToString()) break;
                var snapshot = await matches.View(id.ToString(), scope);
                if (snapshot.Int("sequence") != sequence)
                {
                    sequence = snapshot.Int("sequence");
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(HttpContext.RequestAborted); deadline.CancelAfter(TimeSpan.FromSeconds(3));
                    await Response.WriteAsync($"id: {sequence}\nevent: snapshot\ndata: {snapshot.ToJsonString()}\n\n", deadline.Token); await Response.Body.FlushAsync(deadline.Token);
                    heartbeat = DateTimeOffset.UtcNow;
                    if (snapshot["game"]?.Text("status") == "finished") break;
                }
                else if (DateTimeOffset.UtcNow - heartbeat >= TimeSpan.FromSeconds(15))
                {
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(HttpContext.RequestAborted); deadline.CancelAfter(TimeSpan.FromSeconds(3));
                    await Response.WriteAsync(": heartbeat\n\n", deadline.Token); await Response.Body.FlushAsync(deadline.Token); heartbeat = DateTimeOffset.UtcNow;
                }
                await Task.Delay(60, HttpContext.RequestAborted);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or IOException) { HttpContext.Abort(); }
    }
    [HttpGet("/api/matches/{id:guid}/recording")]
    public async Task Recording(Guid id)
    {
        await matches.Owned(id.ToString(), await Scope());
        await execution.CopyRecording(Guid.Parse(id.ToString()), Response, HttpContext.RequestAborted);
    }
}
