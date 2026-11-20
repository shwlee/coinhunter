namespace CoinHunter.Contracts;

// Private launch-only data, delivered over inherited stdin after OS assignment.
// This is never part of user input, a command line, a snapshot, or a journal.
public sealed record CSharpGameChannel(string PipeName, string Token, Guid GameId, int PlayerId, Guid RunId, Guid ArtifactId);
