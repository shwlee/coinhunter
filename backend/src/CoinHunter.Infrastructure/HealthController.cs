using CoinHunter.Contracts;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Hosting;

namespace CoinHunter.Infrastructure;

[ApiController]
[Route("health")]
public sealed class HealthController(
    BackendSettings settings, IReadinessProbe probe, IHostApplicationLifetime lifetime) : ControllerBase
{
    [HttpGet("live")]
    public IActionResult Live() => Ok(new { service = settings.Service, status = "alive", stage = Protocol.Stage });

    [HttpGet("ready")]
    public async Task<IActionResult> Ready(CancellationToken cancellationToken)
    {
        var dependencies = await probe.CheckAsync(cancellationToken);
        var ready = !lifetime.ApplicationStopping.IsCancellationRequested && dependencies.Values.All(value => value == "ready");
        return StatusCode(ready ? 200 : 503, new ReadinessReport(
            settings.Service, ready ? "ready" : "not-ready", "business", ready, Protocol.Version, dependencies));
    }
}
