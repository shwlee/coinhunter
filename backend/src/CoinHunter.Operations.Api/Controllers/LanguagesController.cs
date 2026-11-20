using CoinHunter.Infrastructure;
using CoinHunter.Operations.Api.Services;
using CoinHunter.Infrastructure.Storage;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class LanguagesController(AlgorithmLanguages languages, ExecutionClient execution) : ControllerBase
{
    [HttpGet("/api/languages")]
    public async Task<IActionResult> Get()
    {
        bool ready = false;
        if (languages.CSharpEnabled)
            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(HttpContext.RequestAborted);
                deadline.CancelAfter(TimeSpan.FromSeconds(2));
                var status = await execution.Call(HttpMethod.Get, "/internal/v1/languages", token: deadline.Token);
                ready = status["languages"]!.AsArray().Any(item => item!.Text("id") == "csharp" && item.Bool("enabled"));
            }
            catch (Exception error) when (error is ServiceFault or IOException or InvalidOperationException or System.Text.Json.JsonException || error is OperationCanceledException && !HttpContext.RequestAborted.IsCancellationRequested) { /* Fail closed without taking JavaScript offline. */ }
        return Ok(languages.Describe(ready));
    }
}
