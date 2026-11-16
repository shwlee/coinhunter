using CoinHunter.Contracts;
using CoinHunter.Execution.Host.Services;
using CoinHunter.Infrastructure.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Execution.Host.Controllers;

[ApiController]
[Route("internal/v1")]
[RequestSizeLimit(Protocol.MaxFrameBytes)]
public sealed class InternalController(ExecutionManager manager, StorageSettings settings) : ControllerBase
{
    [HttpGet("status")]
    public IActionResult Status() => Ok(new ExecutionServiceStatus(Protocol.ExecutionService, Protocol.Version, Protocol.Stage, true, ["health", "contracts", "matches", "validations", "recordings"]));
    [HttpGet("contracts")]
    public IActionResult Contracts() => Ok(new { contractVersion = Protocol.Version, routes = ApiCatalog.Internal });
    [HttpGet("resources")]
    public IActionResult Resources() => Ok(manager.ResourceStatus);
    [HttpPost("matches")]
    public async Task<IActionResult> Accept([FromBody] ExecutionRequest request) => StatusCode(202, manager.View(await manager.Accept(request, HttpContext.RequestAborted)));
    [HttpGet("matches/{id:guid}")]
    public async Task<IActionResult> Get(Guid id, [FromQuery] int? afterSequence = null)
    {
        var record = manager.Get(id);
        if (afterSequence < -1) throw new ServiceFault(400, "Snapshot sequence is invalid.");
        if (afterSequence.HasValue) await record.WaitForSnapshot(afterSequence.Value, HttpContext.RequestAborted);
        if (record.Snapshot?["game"]?.Text("status") == "finished" && !record.Closed.Task.IsCompleted)
            await record.Closed.Task.WaitAsync(TimeSpan.FromSeconds(10), HttpContext.RequestAborted);
        return Ok(manager.View(record));
    }
    [HttpPost("matches/{id:guid}/start")]
    public async Task<IActionResult> Start(Guid id, [FromBody] StartPayload request)
    {
        if (request.RequestId == Guid.Empty) throw new ServiceFault(400, "요청 ID가 필요합니다.");
        await manager.Start(manager.Get(id)); return Ok(new { state = "running" });
    }
    [HttpPost("matches/{id:guid}/stop")]
    public async Task<IActionResult> Stop(Guid id, [FromBody] ExecutionStop request)
    {
        if (request.RequestId == Guid.Empty || !new[] { "user-stopped", "account-ended", "server-shutdown", "prepare-failed", "start-failed" }.Contains(request.Reason)) throw new ServiceFault(400, "종료 요청을 확인하세요.");
        await manager.Stop(manager.Get(id), request.Reason); return Ok(new { ok = true });
    }
    [HttpPost("validations")]
    public async Task<IActionResult> Validate([FromBody] ValidationRequest request) => Ok(await manager.Validate(request, HttpContext.RequestAborted));
    [HttpPost("results/{id:guid}/ack")]
    public async Task<IActionResult> Ack(Guid id, [FromBody] ResultAcknowledgement request) { await manager.Acknowledge(id, request); return Ok(new { ok = true }); }
    [HttpGet("matches/{id:guid}/events")]
    public async Task Events(Guid id)
    {
        var record = manager.Get(id); Response.ContentType = "text/event-stream"; var previous = "";
        while (!HttpContext.RequestAborted.IsCancellationRequested)
        {
            var value = manager.View(record).ToJsonString();
            if (value != previous)
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(HttpContext.RequestAborted); deadline.CancelAfter(TimeSpan.FromSeconds(3));
                await Response.WriteAsync("event: execution\ndata: " + value + "\n\n", deadline.Token); await Response.Body.FlushAsync(deadline.Token); previous = value;
            }
            if (record.Closed.Task.IsCompleted) break;
            await Task.Delay(100, HttpContext.RequestAborted);
        }
    }
    [HttpGet("matches/{id:guid}/recording")]
    public IActionResult Recording(Guid id)
    {
        var record = manager.Get(id); if (!record.Closed.Task.IsCompleted) throw new ServiceFault(409, "실행 기록이 아직 완결되지 않았습니다.");
        var path = Path.Combine(settings.ExecutionRoot, "journals", id + ".jsonl");
        if (!System.IO.File.Exists(path)) path = Path.Combine(settings.ExecutionRoot, "journals", id + ".partial.jsonl");
        if (!System.IO.File.Exists(path)) throw new ServiceFault(404, "실행 기록이 없습니다.");
        return File(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous), "application/x-ndjson");
    }
}
