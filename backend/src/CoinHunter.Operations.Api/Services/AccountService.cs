using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public sealed class AccountService(IAccountStore store, ISourceStore sources)
{
    public Task<JsonObject?> User(string id) => store.Read(data => JsonData.Array(data, "users").OfType<JsonObject>().SingleOrDefault(user => user.Text("id") == id && user.Bool("active"))?.CloneObject());
    public Task<JsonArray> Users() => store.Read(data => new JsonArray(JsonData.Array(data, "users").OfType<JsonObject>().Select(user =>
    {
        var result = user.CloneObject();
        var providers = JsonData.Array(data, "identities").OfType<JsonObject>().Where(link => link.Text("userId") == user.Text("id")).Select(link => link.Text("provider")).Distinct().ToArray();
        result["authProviders"] = new JsonArray((providers.Length == 0 ? ["mock"] : providers).Select(value => (JsonNode)JsonValue.Create(value)!).ToArray());
        return (JsonNode)result;
    }).ToArray()));
    public Task<JsonObject> Login(string email, string? subject = null) => store.Change(data =>
    {
        email = email.Trim().ToLowerInvariant();
        if (email.Length > 320 || !System.Net.Mail.MailAddress.TryCreate(email, out var address) || address.Address != email)
            throw new ServiceFault(400, "이메일을 확인하세요.");
        var users = JsonData.Array(data, "users"); var identities = JsonData.Array(data, "identities");
        JsonObject? user;
        if (subject is null)
            user = users.OfType<JsonObject>().SingleOrDefault(user => user.Text("email") == email && !identities.OfType<JsonObject>().Any(link => link.Text("userId") == user.Text("id")));
        else
        {
            var links = identities.OfType<JsonObject>().Where(link => link.Text("provider") == "google" && link.Text("subject") == subject).ToArray();
            if (links.Length > 1) throw new ServiceFault(503, "중복된 인증 신원을 확인하세요.");
            user = links.Length == 0 ? null : users.OfType<JsonObject>().SingleOrDefault(user => user.Text("id") == links[0].Text("userId")) ?? throw new ServiceFault(503, "연결된 계정이 없습니다.");
        }
        if (user is null)
        {
            user = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["email"] = email, ["role"] = "user", ["active"] = true };
            users.Add(user);
            if (subject is not null) identities.Add(new JsonObject { ["provider"] = "google", ["subject"] = subject, ["userId"] = user.Text("id"), ["createdAt"] = DateTimeOffset.UtcNow.ToString("O") });
        }
        if (!user.Bool("active")) throw new ServiceFault(403, "이용이 중지된 계정입니다.");
        user["email"] = email;
        return Task.FromResult(user.CloneObject());
    });
    public Task<JsonObject> UpdateUser(string id, JsonObject input, string actor) => store.Change(data =>
    {
        var user = JsonData.Find(data, "users", id); var active = input.Bool("active"); var role = input.Text("role");
        if (input["active"] is null || role is not ("user" or "admin")) throw new ServiceFault(400, "사용자 설정을 확인하세요.");
        if (input.ContainsKey("expectedActive") || input.ContainsKey("expectedRole"))
            if (input["expectedActive"] is null || input.Text("expectedRole") != user.Text("role") || input.Bool("expectedActive") != user.Bool("active"))
                throw new ServiceFault(409, "사용자 설정이 변경되었습니다.");
        if (user.Bool("active") && user.Text("role") == "admin" && (!active || role != "admin") &&
            (id == actor || JsonData.Array(data, "users").OfType<JsonObject>().Count(item => item.Bool("active") && item.Text("role") == "admin") <= 1))
            throw new ServiceFault(409, "본인 또는 마지막 활성 관리자는 중지·강등할 수 없습니다.");
        user["active"] = active; user["role"] = role;
        return Task.FromResult(user.CloneObject());
    });
    public Task<JsonArray> Algorithms(string owner) => store.Read(data => new JsonArray(JsonData.Array(data, "algorithms").OfType<JsonObject>().Where(item => item.Text("ownerId") == owner).Select(item => (JsonNode)JsonData.Metadata(item)).ToArray()));
    public Task<JsonObject> Algorithm(string owner, string id, bool history = false) => store.Read(data =>
    {
        var item = JsonData.Find(data, history ? "history" : "algorithms", id);
        if (item.Text("ownerId") != owner) throw new ServiceFault(404, "알고리즘을 찾을 수 없습니다.");
        return item.CloneObject();
    });
    public Task<JsonObject> Save(string owner, string? id, string name, int revision, Guid sourceKey) => store.Change(data =>
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 80) throw new ServiceFault(400, "이름은 1~80자로 입력하세요.");
        var now = DateTimeOffset.UtcNow.ToString("O"); JsonObject item;
        if (id is not null)
        {
            item = JsonData.Find(data, "algorithms", id);
            if (item.Text("ownerId") != owner) throw new ServiceFault(404, "알고리즘을 찾을 수 없습니다.");
            if (item.Int("revision") != revision) throw new ServiceFault(409, "다른 창에서 저장했습니다. 다시 불러오거나 새 이름으로 저장하세요.");
        }
        else
        {
            item = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["ownerId"] = owner, ["language"] = "javascript", ["revision"] = 0, ["createdAt"] = now };
            JsonData.Array(data, "algorithms").Add(item);
        }
        item["name"] = name.Trim(); item["sourceKey"] = sourceKey.ToString(); item["revision"] = item.Int("revision") + 1; item["updatedAt"] = now;
        return Task.FromResult(JsonData.Metadata(item));
    });
    public Task<JsonArray> History(string owner) => store.Read(data => new JsonArray(JsonData.Array(data, "history").OfType<JsonObject>().Where(item => item.Text("ownerId") == owner).OrderByDescending(item => item.Text("playedAt")).Select(item => { var value = JsonData.Metadata(item); value.Remove("ownerId"); return (JsonNode)value; }).ToArray()));
    public ISourceStore Sources => sources;
}
