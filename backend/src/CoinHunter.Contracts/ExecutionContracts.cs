using System.Text.Json;

namespace CoinHunter.Contracts;

// Internal DTOs, not replacements for the legacy browser JSON. No raw source, credentials or paths.
public sealed record ExecutionScope
{
    public required string Kind { get; init; }
    public required Guid SubjectId { get; init; }
}

public sealed record SourceReference
{
    public required Guid SourceKey { get; init; }
    public required string Sha256 { get; init; }
    public required long ByteLength { get; init; }
}

public sealed record ParticipantRequest
{
    public required int PlayerId { get; init; }
    public required Guid RunId { get; init; }
    public required string Language { get; init; }
    public required SourceReference Source { get; init; }
    public required int StartSlot { get; init; }
    public required string CharacterId { get; init; }
}

public sealed record MapSnapshot
{
    public required string Id { get; init; }
    public required int Revision { get; init; }
    public required int Columns { get; init; }
    public required int Rows { get; init; }
    public required int[] Tiles { get; init; }
    // Existing JS settings schema remains authoritative through generated content/parity checks.
    public required JsonElement Settings { get; init; }
}

public sealed record MatchOptions
{
    public required string Mode { get; init; }
    public required bool BlackMatter { get; init; }
    public required bool DestroyWalls { get; init; }
}

public sealed record ExecutionRequest
{
    public required int ContractVersion { get; init; }
    public required Guid RequestId { get; init; }
    public required Guid MatchId { get; init; }
    public required ExecutionScope Scope { get; init; }
    public required MapSnapshot Map { get; init; }
    public required ParticipantRequest[] Participants { get; init; }
    public required MatchOptions Options { get; init; }
}

public sealed record ExecutionAccepted(Guid MatchId, Guid RequestId, string State);
public sealed record ExecutionStop(Guid RequestId, string Reason);
public sealed record ResultAcknowledgement(Guid MatchId, int ResultVersion);

public sealed record RecordingReference
{
    public required string Status { get; init; }
    public string? Key { get; init; }
    public long DurableThroughSeq { get; init; }
    public string? ReceiptStatus { get; init; }
}

public sealed record ParticipantScore(int PlayerId, int Score);
public sealed record FinalExecutionResult
{
    public required int ContractVersion { get; init; }
    public required Guid MatchId { get; init; }
    public required int ResultVersion { get; init; }
    public required string Outcome { get; init; }
    public required string Reason { get; init; }
    public required ParticipantScore[] Scores { get; init; }
    public required RecordingReference Recording { get; init; }
    public JsonElement? Snapshot { get; init; }
}

public sealed record EngineEnvelope
{
    public required int ContractVersion { get; init; }
    public required Guid MatchId { get; init; }
    public required Guid MessageId { get; init; }
    public Guid? CorrelationId { get; init; }
    public required string Type { get; init; }
    public required JsonElement Payload { get; init; }
}

public sealed record PreparedPlayer(int PlayerId, Guid RunId, string Name);
public sealed record PreparedPayload(PreparedPlayer[] Players);
public sealed record StartPayload(Guid RequestId);
public sealed record StopPayload(Guid RequestId, string Reason);
public sealed record FailedPayload(string Code, string Stage, string Message);
public sealed record AckPayload(string State);
public sealed record DebugRecord(
    int Player, int Turn, string Status, int Direction, double ElapsedMs, string[] Lines, int Dropped);
// Game is the existing GameState.snapshot shape; no gameplay model is ported in stage 1.
public sealed record SnapshotPayload(long Sequence, JsonElement Game, DebugRecord[] Logs);

public static class ContractValidation
{
    public static void Envelope(EngineEnvelope value)
    {
        if (value.ContractVersion != Protocol.Version || value.MatchId == Guid.Empty ||
            value.MessageId == Guid.Empty || value.CorrelationId == Guid.Empty ||
            !Protocol.MessageTypes.Contains(value.Type) || value.Payload.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Invalid engine envelope or unsupported contract version.");
    }

    public static void Execution(ExecutionRequest value,bool allowCSharpCandidate=false)
    {
        if (value.ContractVersion != Protocol.Version || value.MatchId == Guid.Empty ||
            value.RequestId == Guid.Empty || value.Scope is null || value.Map is null ||
            value.Options is null || value.Participants is null ||
            value.Scope.Kind is not ("user" or "guest") || value.Scope.SubjectId == Guid.Empty ||
            value.Map.Columns is < 4 or > 40 || value.Map.Rows is < 4 or > 30 ||
            value.Map.Revision < 1 || string.IsNullOrWhiteSpace(value.Map.Id) ||
            value.Map.Tiles is null || value.Map.Tiles.Length != value.Map.Columns * value.Map.Rows ||
            value.Map.Settings.ValueKind != JsonValueKind.Object ||
            value.Participants.Length is < 1 or > 4 || value.Participants.Any(p => p is null) ||
            value.Options.Mode is not ("practice" or "duel"))
            throw new InvalidDataException("Invalid immutable execution request.");
        if (value.Options.Mode == "duel" && (value.Scope.Kind != "user" || value.Participants.Length != 2))
            throw new InvalidDataException("Duel requires an authenticated owner and two participants.");
        if (value.Participants.Select(p => p.PlayerId).Order().Where((id, index) => id != index).Any() ||
            value.Participants.Select(p => p.RunId).Distinct().Count() != value.Participants.Length ||
            value.Participants.Select(p => p.StartSlot).Distinct().Count() != value.Participants.Length)
            throw new InvalidDataException("Participant identities or slots are invalid.");
        foreach (var player in value.Participants)
        {
            if (player.RunId == Guid.Empty || player.StartSlot is < 0 or > 3 ||
                (player.Language != "javascript" && !(allowCSharpCandidate&&value.Scope.Kind=="user"&&player.Language=="csharp")) || string.IsNullOrWhiteSpace(player.CharacterId) ||
                player.Source is null || player.Source.SourceKey == Guid.Empty || player.Source.ByteLength < 0 ||
                player.Source.Sha256 is null || player.Source.Sha256.Length != 64 ||
                player.Source.Sha256.Any(c => !char.IsAsciiHexDigit(c)))
                throw new InvalidDataException("Invalid participant or source reference.");
        }
    }
}
