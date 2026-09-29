import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PlayerProcess } from '../runtime/player-process.js';
import { GameState } from './state.js';

export class Match extends EventEmitter {
  constructor(map, sources, options = {}) {
    super();
    if (sources.length < 1 || sources.length > 4) throw new Error('플레이어는 1~4명이어야 합니다.');
    this.map = structuredClone(map);
    this.sources = sources;
    this.options = options;
    this.runners = [];
    this.sequence = 0;
    this.logs = [];
  }

  async start() {
    try {
      // All children are accounted for before initialization can fail.
      this.runners = this.sources.map(() => new PlayerProcess());
      const initialized = await Promise.allSettled(
        this.runners.map((runner, index) =>
          runner.initialize(this.sources[index], index, this.map.columns, this.map.rows),
        ),
      );
      const failure = initialized.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (this.stopping) throw new Error('경기 종료 중입니다.');
      this.state = new GameState(
        this.map,
        this.runners.map((runner) => runner.name),
        this.options,
      );
      this.state.start(performance.now());
      this.timer = setInterval(() => this.tick(), 20);
      this.publish();
      this.tick();
    } catch (error) {
      await Promise.all(this.runners.map((runner) => runner.close()));
      throw error;
    }
  }

  tick() {
    if (this.stopping || !this.state) return;
    const now = performance.now();
    // Apply completed actions first, with stable player ordering for the same tick.
    for (const player of this.state.players) this.state.completeAction(player.id, now);
    this.state.update(now);
    if (!this.state.isRunning()) {
      this.stop(this.state.reason);
      return;
    }
    for (const player of this.state.players) {
      if (!player.action && !player.thinking) this.requestTurn(player.id);
    }
    this.publish();
  }

  async requestTurn(id) {
    const player = this.state.players[id];
    player.turn++;
    player.thinking = true;
    if (player.effect?.type === 3) {
      this.state.beginAction(id, { status: 'ok', value: 0 }, performance.now());
      return;
    }
    let result;
    try {
      result = await this.runners[id].move([...this.state.tiles], player.position, [
        ...this.state.items,
      ]);
    } catch {
      if (!this.stopping) await this.stop('runtime-failure');
      return;
    }
    if (this.stopping || !this.state.isRunning()) return;
    this.state.recordAlgorithmResult(id, result);
    if (result.logs.length || result.status !== 'ok' || result.value === -1) {
      this.logs.push({
        player: id,
        turn: player.turn,
        status: result.status,
        direction: result.value,
        elapsedMs: Math.round(result.elapsedMs * 10) / 10,
        lines: result.logs,
        dropped: result.droppedLogs,
      });
      this.logs = this.logs.slice(-40);
    }
    this.state.beginAction(id, result, performance.now());
  }

  publish() {
    if (!this.state) return;
    this.latest = {
      sequence: ++this.sequence,
      game: this.state.snapshot(performance.now()),
      logs: this.logs,
    };
    this.emit('snapshot', this.latest);
  }

  async stop(reason = 'user-stopped') {
    if (this.stopping) return this.closed;
    this.stopping = true;
    clearInterval(this.timer);
    this.state?.finish(reason);
    this.publish();
    this.closed = Promise.all(this.runners.map((runner) => runner.close()));
    await this.closed;
    this.emit('closed');
  }
}
