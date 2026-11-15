// Synchronous enqueue boundary. Durable storage remains the collector's responsibility.
// Copies prevent sinks/view subscribers from mutating the live engine or its debug buffer.
export class MatchOutput {
  constructor(sink = () => {}, onFailure = () => {}) {
    this.sink = sink;
    this.onFailure = onFailure;
    this.logs = [];
    this.sequence = 0;
    this.sealed = false;
  }
  record(type, payload) {
    if (this.sealed || this.failure) return false;
    try {
      const result = this.sink(type, structuredClone(payload));
      if (result && typeof result.then === 'function') {
        // Async stores must sit behind a collector, not return storage work to the engine.
        void Promise.resolve(result).catch(() => {});
        throw new Error('Match sink must enqueue synchronously.');
      }
      return true;
    } catch {
      this.failure = true;
      this.onFailure();
      return false;
    }
  }
  appendDebug(player, turn, result) {
    if (!result.logs.length && result.status === 'ok' && result.direction !== -1) return;
    this.logs.push({
      player,
      turn,
      status: result.status,
      direction: result.direction,
      elapsedMs: Math.round(result.timings.executionMs * 10) / 10,
      lines: [...result.logs],
      dropped: result.droppedLogs,
    });
    this.logs = this.logs.slice(-40);
  }
  snapshot(state, now) {
    this.latest = {
      sequence: ++this.sequence,
      game: state.snapshot(now),
      logs: structuredClone(this.logs),
    };
    return this.latest;
  }
  seal() {
    this.sealed = true;
  }
}
