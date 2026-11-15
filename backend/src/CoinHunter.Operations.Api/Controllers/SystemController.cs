using CoinHunter.Contracts;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
[Route("api/system")]
public sealed class SystemController(IHostEnvironment environment) : ControllerBase
{
    [HttpGet("contracts")]
    public IActionResult Contracts() => environment.IsDevelopment()
        ? Ok(new { contractVersion = Protocol.Version, stage = Protocol.Stage, businessReady = true, routes = ApiCatalog.Public })
        : NotFound(new ApiError("Endpoint not found.", "not_found"));
}
