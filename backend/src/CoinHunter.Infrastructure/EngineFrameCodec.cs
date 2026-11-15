using System.Buffers.Binary;
using System.Text.Json;
using CoinHunter.Contracts;

namespace CoinHunter.Infrastructure;

// Parent/engine framing only. Player invocation transport remains an adapter decision.
public static class EngineFrameCodec
{
    public static byte[] Encode(EngineEnvelope message, int maxBytes = Protocol.MaxFrameBytes)
    {
        ContractValidation.Envelope(message);
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, Protocol.JsonOptions);
        if (payload.Length == 0 || payload.Length > maxBytes)
            throw new InvalidDataException("Engine frame exceeds its byte limit.");
        var frame = new byte[4 + payload.Length];
        BinaryPrimitives.WriteInt32BigEndian(frame, payload.Length);
        payload.CopyTo(frame.AsSpan(4));
        return frame;
    }

    public static async ValueTask<EngineEnvelope?> ReadAsync(
        Stream stream, CancellationToken cancellationToken = default, int maxBytes = Protocol.MaxFrameBytes)
    {
        var header = new byte[4];
        var first = await stream.ReadAsync(header.AsMemory(0, 1), cancellationToken);
        if (first == 0) return null;
        try
        {
            await stream.ReadExactlyAsync(header.AsMemory(1), cancellationToken);
            var length = BinaryPrimitives.ReadInt32BigEndian(header);
            if (length <= 0 || length > maxBytes)
                throw new InvalidDataException("Invalid engine frame length.");
            var payload = new byte[length];
            await stream.ReadExactlyAsync(payload, cancellationToken);
            var message = JsonSerializer.Deserialize<EngineEnvelope>(payload, Protocol.JsonOptions)
                ?? throw new InvalidDataException("Empty engine envelope.");
            ContractValidation.Envelope(message);
            return message;
        }
        catch (EndOfStreamException)
        {
            throw new InvalidDataException("Truncated engine frame.");
        }
        catch (JsonException)
        {
            throw new InvalidDataException("Malformed engine envelope.");
        }
    }
}
