using System.Text;
using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Operations.Api.Services;

public static class LegacyMigration
{
    public static async Task Run(string[] args, StorageSettings settings)
    {
        if (args.Length is < 2 or > 3 || args.Length == 3 && args[2] != "--apply") throw new ArgumentException("Use maintenance migrate <offline-export-directory> [--apply]. Export contains accounts/store.json, accounts/sources/, maps/.");
        var source = Path.GetFullPath(args[1]); var destination = settings.DataRoot;
        if (source.Equals(destination, StringComparison.OrdinalIgnoreCase) || destination.StartsWith(source.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || source.StartsWith(destination.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Use a separate offline export and empty destination.");
        if (File.Exists(Path.Combine(destination, "accounts/store.json")) || Directory.Exists(Path.Combine(destination, "maps")) || File.Exists(Path.Combine(destination, ".migration.in-progress"))) throw new InvalidOperationException("Migration destination must be empty. Preserve existing writes and restore/export explicitly.");
        var data = await AtomicFile.Read(Path.Combine(source, "accounts/store.json"), new JsonObject());
        foreach (var name in new[] { "users", "algorithms", "history" }) if (data[name] is not JsonArray) throw new InvalidDataException("Incomplete account export.");
        var userIds = new HashSet<string>();
        foreach (var user in data["users"]!.AsArray().OfType<JsonObject>())
            if (!Guid.TryParseExact(user.Text("id"), "D", out _) || !userIds.Add(user.Text("id")) || user.Text("role") is not ("user" or "admin") || user["active"] is not JsonValue) throw new InvalidDataException("Invalid user export.");
        var identities = JsonData.Array(data, "identities").OfType<JsonObject>().ToArray();
        if (identities.Any(link => !userIds.Contains(link.Text("userId")) || link.Text("provider") != "google" || string.IsNullOrEmpty(link.Text("subject"))) || identities.GroupBy(link => (link.Text("provider"), link.Text("subject"))).Any(group => group.Count() != 1)) throw new InvalidDataException("Invalid/duplicate identity links.");
        var files = new Dictionary<Guid, string?>();
        var inline = new Dictionary<Guid, string>();
        foreach (var collection in new[] { "algorithms", "history" })
        {
            var ids = new HashSet<string>();
            foreach (var item in data[collection]!.AsArray().OfType<JsonObject>())
            {
                if (!Guid.TryParseExact(item.Text("id"), "D", out _) || !ids.Add(item.Text("id")) || !userIds.Contains(item.Text("ownerId"))) throw new InvalidDataException("Invalid ownership/identifier in export.");
                if (item["source"] is JsonValue text)
                {
                    var key = Guid.NewGuid(); inline.Add(key, text.GetValue<string>()); files[key] = null; item["sourceKey"] = key.ToString(); item.Remove("source");
                }
                else
                {
                    if (!Guid.TryParseExact(item.Text("sourceKey"), "D", out var key)) throw new InvalidDataException("Invalid source reference.");
                    var path = Path.Combine(source, "accounts/sources", key + ".js");
                    if (!File.Exists(path)) throw new InvalidDataException("Missing source in export.");
                    files[key] = path;
                }
            }
        }
        var content = new GameContent(settings); var registryPath = Path.Combine(source, "maps/registry.json");
        var registry = await AtomicFile.Read(registryPath, new JsonObject { ["schemaVersion"] = 1, ["maps"] = new JsonArray() });
        var mapFiles = new List<(string Relative, JsonObject Value)>(); var mapIds = new HashSet<string>();
        if (registry.Int("schemaVersion") != 1 || registry["maps"] is not JsonArray entries) throw new InvalidDataException("Invalid map registry.");
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var id = entry.Text("id");
            if (!MapRules.IdPattern().IsMatch(id) || !mapIds.Add(id) || entry.Int("draftRevision") < 1) throw new InvalidDataException("Invalid map export reference.");
            for (var revision = 1; revision <= entry.Int("draftRevision"); revision++)
            {
                var map = await AtomicFile.Read(Path.Combine(source, "maps", id, revision + ".json"), new JsonObject());
                MapRules.Validate(map, content, published: revision == entry.Int("publishedRevision"));
                if (map.Text("id") != id || map.Int("revision") != revision) throw new InvalidDataException("Map revision mismatch.");
                mapFiles.Add((Path.Combine("maps", id, revision + ".json"), map));
            }
        }
        Console.WriteLine($"Dry run: {userIds.Count} users, {identities.Length} identities, {files.Count} source files, {mapIds.Count} maps / {mapFiles.Count} revisions. IDs and ownership preserved.");
        if (args.Length == 2) return;
        // Source is an offline export. Original Node locks/writers cannot be made compatible by this importer.
        using var lease = new FileAccountStore(settings);
        var marker = Path.Combine(destination, ".migration.in-progress"); await File.WriteAllTextAsync(marker, "offline export import");
        foreach (var (key, path) in files)
        {
            var target = Path.Combine(destination, "accounts/sources", key + ".js"); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (path is null) await File.WriteAllTextAsync(target, inline[key], new UTF8Encoding(false));
            else File.Copy(path, target, false);
        }
        foreach (var (relative, value) in mapFiles) await AtomicFile.Json(Path.Combine(destination, relative), value);
        await AtomicFile.Json(Path.Combine(destination, "maps/registry.json"), registry);
        // Old running games/sessions cannot be imported. Historical source snapshots remain available.
        data["matches"] = new JsonArray(); await AtomicFile.Json(Path.Combine(destination, "accounts/store.json"), data);
        File.Delete(marker);
        Console.WriteLine("Import committed. Old servers must stay stopped; sign in again on the new backend.");
    }
}
