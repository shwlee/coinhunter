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
    this.runnerFactory = options.runnerFactory || (() => new PlayerProcess());
    this.record = options.record || (() => {});
  }

  async start() {
    await this.prepare();
    this.run();
  }

  async prepare() {
    if (this.prepared) return;
    try {
      // All children are accounted for before initialization can fail.
      this.runners = this.sources.map(() => this.runnerFactory());
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
      this.prepared = true;
      this.record('prepared', {
        players: this.state.players,
        map: this.map,
        options: {
          mode: this.options.mode,
          blackMatter: this.options.blackMatter,
          destroyWalls: this.options.destroyWalls,
        },
      });
    } catch (error) {
      await Promise.all(this.runners.map((runner) => runner.close()));
      throw error;
    }
  }

  run() {
    if (!this.prepared || this.running || this.stopping) throw new Error('Invalid match state');
    this.running = true;
    this.state.start(performance.now());
    this.record('started', { game: this.state.snapshot(performance.now()) });
    this.timer = setInterval(() => this.tick(), 20);
    this.publish();
    this.tick();
  }

  tick() {
    if (this.stopping || !this.state) return;
    const now = performance.now();
    // Apply completed actions first, with stable player ordering for the same tick.
    for (const player of this.state.players) {
      const action = player.action;
      if (this.state.completeAction(player.id, now))
        this.record('action-completed', {
          player: player.id,
          turn: player.turn,
          action,
          game: this.state.snapshot(now),
        });
    }
    const before = JSON.stringify([this.state.tiles, this.state.items, this.state.status]);
    this.state.update(now);
    if (before !== JSON.stringify([this.state.tiles, this.state.items, this.state.status]))
      this.record('world-updated', { game: this.state.snapshot(now) });
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
    this.record('turn-requested', {
      player: id,
      turn: player.turn,
      position: player.position,
      jump: player.effect?.type === 3,
    });
    if (player.effect?.type === 3) {
      this.state.beginAction(id, { status: 'ok', value: 0 }, performance.now());
      this.record('action-started', { player: id, turn: player.turn, action: player.action });
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
    if (this.stopping || !this.state.isRunning()) {
      this.record('late-result', { player: id, turn: player.turn, result });
      return;
    }
    this.record('algorithm-result', { player: id, turn: player.turn, result });
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
    this.record('action-started', { player: id, turn: player.turn, action: player.action });
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
    this.record('finished', { reason, game: this.state?.snapshot(performance.now()) || null });
    this.publish();
    this.closed = Promise.all(this.runners.map((runner) => runner.close()));
    await this.closed;
    this.emit('closed');
  }
}
