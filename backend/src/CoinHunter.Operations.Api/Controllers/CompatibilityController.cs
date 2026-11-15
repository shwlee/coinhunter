using CoinHunter.Contracts;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class CompatibilityController : ControllerBase
{
    [Route("api/{**path}")]
    [AcceptVerbs("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD")]
    public IActionResult Pending(string? path)
    {
        if (path == "ai" || path?.StartsWith("ai/", StringComparison.Ordinal) == true)
            return StatusCode(410, new ApiError("Direct AI connections are no longer provided.", "ai_removed"));
        return NotFound(new ApiError("Endpoint not found.", "not_found"));
    }
}
