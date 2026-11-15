using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public static class Maintenance
{
    public static async Task Run(string[] args, StorageSettings settings)
    {
        if (args.Length == 0) throw new InvalidOperationException("Use maintenance bootstrap <email> [mock|google], grant <user-id>, inspect, reconcile [--apply]. Stop Operations first.");
        if (args[0] == "migrate") { await LegacyMigration.Run(args, settings); return; }
        using var store = new FileAccountStore(settings);
        var sources = new FileSourceStore(Path.Combine(settings.DataRoot, "accounts/sources"));
        if (args[0] == "bootstrap" && args.Length is 2 or 3)
        {
            var email = args[1].Trim().ToLowerInvariant(); var provider = args.Length == 3 ? args[2] : "google";
            if (provider is not ("mock" or "google") || !System.Net.Mail.MailAddress.TryCreate(email, out _)) throw new ServiceFault(400, "이메일·인증 방식을 확인하세요.");
            await store.Change(data =>
            {
                var users = JsonData.Array(data, "users"); var links = JsonData.Array(data, "identities");
                var matching = users.OfType<JsonObject>().Where(user => user.Text("email") == email &&
                    (provider == "mock" ? !links.OfType<JsonObject>().Any(link => link.Text("userId") == user.Text("id")) : links.OfType<JsonObject>().Any(link => link.Text("userId") == user.Text("id") && link.Text("provider") == "google"))).ToArray();
                if (matching.Length > 1) throw new ServiceFault(409, "계정 ID를 선택하여 grant를 사용하세요.");
                var user = matching.SingleOrDefault();
                if (users.OfType<JsonObject>().Any(value => value.Bool("active") && value.Text("role") == "admin" && value != user)) throw new ServiceFault(409, "활성 관리자가 이미 있습니다. grant를 사용하세요.");
                if (user is null)
                {
                    if (provider == "google") throw new ServiceFault(404, "먼저 Google 로그인하여 신원을 등록하세요. 이메일 자동 연결은 하지 않습니다.");
                    user = new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["email"] = email }; users.Add(user);
                }
                user["role"] = "admin"; user["active"] = true;
                return Task.FromResult(true);
            });
            Console.WriteLine("Administrator bootstrap completed. Identity/email was not written to source configuration."); return;
        }
        if (args[0] == "grant" && args.Length == 2 && Guid.TryParseExact(args[1], "D", out var id))
        {
            await store.Change(data => { var user = JsonData.Find(data, "users", id.ToString()); if (!user.Bool("active")) throw new ServiceFault(409, "이용 중지 계정입니다."); user["role"] = "admin"; return Task.FromResult(true); });
            Console.WriteLine("Administrator role granted."); return;
        }
        if (args[0] is "inspect" or "reconcile")
        {
            var referenced = await store.Read(data => JsonData.Array(data, "algorithms").Concat(JsonData.Array(data, "history")).OfType<JsonObject>().Select(item => Guid.Parse(item.Text("sourceKey"))).ToHashSet());
            var missing = referenced.Where(key => !File.Exists(sources.PathFor(key))).ToArray();
            var orphans = Directory.Exists(sources.Root) ? Directory.EnumerateFiles(sources.Root, "*.js").Where(path => Guid.TryParseExact(Path.GetFileNameWithoutExtension(path), "D", out var key) && !referenced.Contains(key)).ToArray() : [];
            Console.WriteLine($"Referenced sources: {referenced.Count}; missing: {missing.Length}; unreferenced: {orphans.Length}.");
            if (missing.Length > 0) throw new InvalidDataException("Missing referenced source files. Restore the coordinated backup before serving.");
            if (args[0] == "reconcile" && args.Length == 2 && args[1] == "--apply") foreach (var path in orphans) File.Delete(path);
            else if (args.Length != 1) throw new ArgumentException("Unknown maintenance options.");
            return;
        }
        throw new ArgumentException("Unknown maintenance command or arguments.");
    }
}
