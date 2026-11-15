// Presentation only. Never predicts a direction or changes authoritative turn timing.
export class GamePresentation {
  constructor({ delayMs = 40, capacity = 64 } = {}) {
    this.delayMs = delayMs;
    this.capacity = capacity;
    this.reset();
  }
  reset(preview = null) {
    this.preview = preview;
    this.snapshots = [];
    this.sequence = -1;
    this.offset = null;
    this.time = -Infinity;
  }
  push(snapshot, receivedAt) {
    const game = snapshot.game;
    if (
      !Number.isFinite(game?.serverTime) ||
      !Number.isFinite(receivedAt) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence <= this.sequence ||
      (this.snapshots.length && game.serverTime < this.snapshots.at(-1).serverTime)
    )
      return false;
    this.sequence = snapshot.sequence;
    // The least delayed observation keeps network jitter from rewinding the clock.
    this.offset = Math.max(this.offset ?? -Infinity, game.serverTime - receivedAt);
    this.snapshots.push(game);
    if (this.snapshots.length > this.capacity)
      this.snapshots.splice(0, this.snapshots.length - this.capacity);
    return true;
  }
  sample(localNow) {
    if (!this.snapshots.length) return this.preview ? { game: this.preview, time: 0 } : null;
    const latest = this.snapshots.at(-1);
    if (latest.status === 'finished') return { game: latest, time: latest.serverTime };
    this.time = Math.max(
      this.time,
      this.snapshots[0].serverTime,
      localNow + this.offset - this.delayMs,
    );
    let index = 0;
    while (index + 1 < this.snapshots.length && this.snapshots[index + 1].serverTime <= this.time)
      index++;
    // Keep the state at/before render time. Future snapshots reveal confirmed actions
    // before the display reaches them; real thinking gaps remain real thinking gaps.
    if (index) this.snapshots.splice(0, index);
    return { game: this.snapshots[0], time: this.time };
  }
}
