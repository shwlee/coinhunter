using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoinHunter.Contracts;

public static class Protocol
{
    public const int Version = 1;
    public const int Stage = 9;
    public const int MaxFrameBytes = 4 * 1024 * 1024;
    public const int AlgorithmLimitMs = 500;
    public const string OperationsService = "coinhunter-operations";
    public const string ExecutionService = "coinhunter-execution";

    public static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        NumberHandling = JsonNumberHandling.Strict,
        MaxDepth = 64
    };

    public static readonly IReadOnlySet<string> MessageTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "initialize", "prepared", "start", "snapshot", "stop", "closed", "failed",
        "recording-status", "ack"
    };
}

public sealed record ApiError(string Error, string Code, int? RequiredStage = null);

public sealed record ExecutionServiceStatus(
    string Service, int ContractVersion, int Stage, bool BusinessReady, string[] Capabilities);

public sealed record ReadinessReport(
    string Service, string Status, string Scope, bool BusinessReady, int ContractVersion,
    IReadOnlyDictionary<string, string> Dependencies);
