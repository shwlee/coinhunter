using System.Text.Json.Nodes;
using CoinHunter.Infrastructure.Storage;

namespace CoinHunter.Execution.Host.Services;

public static class JournalRecovery
{
    public static async Task<JsonObject> Recover(string root, Guid id)
    {
        var complete = Path.Combine(root, "journals", id + ".jsonl");
        var partial = Path.Combine(root, "journals", id + ".partial.jsonl");
        var path = File.Exists(complete) ? complete : partial;
        long seq = 0, validBytes = 0;
        if (File.Exists(path))
        {
            // Stream lines with a bounded event size. Preserve partial records for operator inspection.
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            var line = new List<byte>(); var buffer = new byte[65536]; var bad = false;
            while (!bad)
            {
                var count = await stream.ReadAsync(buffer); if (count == 0) break;
                for (var i = 0; i < count; i++)
                {
                    if (buffer[i] != 10) { line.Add(buffer[i]); if (line.Count > 4 * 1024 * 1024) { bad = true; break; } continue; }
                    try
                    {
                        var item = JsonNode.Parse(line.ToArray())!.AsObject();
                        if (item["seq"]!.GetValue<long>() != seq + 1) { bad = true; break; }
                        seq++; validBytes += line.Count + 1; line.Clear();
                    }
                    catch (System.Text.Json.JsonException) { bad = true; break; }
                }
            }
            if (path == partial) { stream.SetLength(validBytes); stream.Flush(true); }
            else if (bad || line.Count != 0) throw new InvalidDataException("Completed journal is corrupt.");
        }
        return new JsonObject { ["status"] = File.Exists(complete) ? "complete" : "partial", ["key"] = id.ToString(), ["durableThroughSeq"] = seq };
    }
}
