using System.Net;
using CoinHunter.Infrastructure.Storage;
using CoinHunter.Operations.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace CoinHunter.Operations.Api.Controllers;

[ApiController]
public sealed class AuthenticationController(SessionService sessions, GoogleAuthentication google, AccountService accounts, MatchService matches) : ControllerBase
{
    [HttpGet("/api/session")]
    public async Task<IActionResult> Session() => Ok(new { user = await sessions.Current(HttpContext), mock = sessions.Mode == "mock", google = sessions.Mode == "google", identities = await sessions.MockIdentities() });
    [HttpPost("/api/auth/mock")]
    public async Task<IActionResult> Mock()
    {
        if (sessions.Mode != "mock" || HttpContext.Connection.RemoteIpAddress is not IPAddress peer || !IPAddress.IsLoopback(peer)) throw new ServiceFault(403, "로컬 개발에서만 목업 로그인이 가능합니다.");
        var input = await RequestInput.Json(Request); var email = input.Text("email");
        if (!(await sessions.MockIdentities()).Contains(email)) throw new ServiceFault(403, "등록된 개발 계정을 선택하세요.");
        var user = await accounts.Login(email); sessions.Issue(HttpContext, user.Text("id")); return Ok(new { user });
    }
    [HttpGet("/api/auth/google/start")]
    public IActionResult GoogleStart() => Redirect(google.Begin(HttpContext, Request.Query["next"]));
    [HttpGet("/api/auth/google/callback")]
    public async Task<IActionResult> GoogleCallback() { Response.StatusCode = 303; Response.Headers.Location = await google.Callback(HttpContext); return new EmptyResult(); }
    [HttpPost("/api/auth/logout")]
    public async Task<IActionResult> Logout()
    {
        var user = await sessions.Current(HttpContext); google.Cancel(HttpContext); sessions.Logout(HttpContext);
        if (user is not null) await matches.StopOwner(user.Text("id")); return Ok(new { ok = true });
    }
    [HttpGet("/api/admin/users")]
    public async Task<IActionResult> Users() { await sessions.Require(HttpContext, true); return Ok(new { users = await accounts.Users() }); }
    [HttpPut("/api/admin/users/{id:guid}")]
    public async Task<IActionResult> UpdateUser(Guid id)
    {
        var actor = await sessions.Require(HttpContext, true);
        var user = await accounts.UpdateUser(id.ToString(), await RequestInput.Json(Request), actor.Text("id"));
        if (!user.Bool("active")) { sessions.Revoke(id.ToString()); await matches.StopOwner(id.ToString()); }
        return Ok(user);
    }
}
