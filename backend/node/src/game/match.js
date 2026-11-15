import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { JavaScriptArtifacts } from '../runtime/javascript-artifacts.js';
import { createJavaScriptRegistry } from '../runtime/runner-registry.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from '../runtime/policy.js';
import { RunnerFault } from '../runtime/contracts/validation.js';
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
    this.gameId = options.gameId ?? randomUUID();
    this.artifacts = new JavaScriptArtifacts();
    this.registry = createJavaScriptRegistry({ resolveArtifact: this.artifacts.resolve });
    this.runnerFactory = options.runnerFactory || ((context) => this.registry.create(context));
    this.contexts = [];
    this.callIds = sources.map(() => 0);
    this.record = options.record || (() => {});
  }

  async start() {
    await this.prepare();
    this.run();
  }

  prepare() {
    if (!this.preparing) this.preparing = this.prepareRunners();
    return this.preparing;
  }

  async prepareRunners() {
    try {
      for (let index = 0; index < this.sources.length; index++) {
        if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
        const participant = this.options.participants?.[index];
        const language = participant?.language ?? 'javascript';
        if (!this.registry.supportedLanguages.includes(language))
          throw new RunnerFault('unavailable', 'initialize');
        const artifact = await this.artifacts.register(this.sources[index], participant?.source);
        if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
        const context = {
          contractVersion: 1,
          gameId: this.gameId,
          playerId: index,
          runId: participant?.runId ?? randomUUID(),
          language,
          artifact,
          limits: { turnMs: 500, algorithmMemoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES },
        };
        this.contexts.push(context);
        // A later factory failure cannot lose earlier created resources.
        this.runners.push(this.runnerFactory(context));
      }
      const initialized = await Promise.allSettled(
        this.runners.map(async (runner, index) =>
          runner.initialize({
            playerNumber: index,
            columns: this.map.columns,
            rows: this.map.rows,
          }),
        ),
      );
      const failure = initialized.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (this.stopping) throw new Error('경기 종료 중입니다.');
      this.state = new GameState(
        this.map,
        initialized.map((result) => result.value.name),
        this.options,
      );
      this.prepared = true;
      this.record('prepared', {
        runners: this.runners.map((runner) => runner.info),
        players: this.state.players,
        map: this.map,
        options: {
          mode: this.options.mode,
          blackMatter: this.options.blackMatter,
          destroyWalls: this.options.destroyWalls,
        },
      });
    } catch (error) {
      this.prepared = false;
      const cleanup = await Promise.allSettled(this.runners.map(async (runner) => runner.close()));
      this.artifacts.clear();
      if (cleanup.some((result) => result.status === 'rejected'))
        throw new RunnerFault('unresponsive', 'close');
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
      const context = this.contexts[id];
      result = await this.runners[id].move({
        contractVersion: 1,
        gameId: context.gameId,
        playerId: id,
        runId: context.runId,
        callId: ++this.callIds[id],
        map: [...this.state.tiles],
        myPosition: player.position,
        items: [...this.state.items],
      });
    } catch {
      if (!this.stopping) await this.stop('runtime-failure');
      return;
    }
    if (this.stopping || !this.state.isRunning()) {
      this.record('late-result', { player: id, turn: player.turn, result });
      return;
    }
    this.record('algorithm-result', { player: id, turn: player.turn, result });
    // Game rules retain their existing action DTO; runner/transport details stop here.
    const actionResult = {
      status: result.status,
      value: result.direction,
      elapsedMs: result.timings.executionMs,
    };
    this.state.recordAlgorithmResult(id, actionResult);
    if (result.logs.length || result.status !== 'ok' || result.direction === -1) {
      this.logs.push({
        player: id,
        turn: player.turn,
        status: result.status,
        direction: result.direction,
        elapsedMs: Math.round(result.timings.executionMs * 10) / 10,
        lines: result.logs,
        dropped: result.droppedLogs,
      });
      this.logs = this.logs.slice(-40);
    }
    this.state.beginAction(id, actionResult, performance.now());
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
    this.closed = (async () => {
      // A preparation already in flight may still be registering/initializing resources.
      await this.preparing?.catch(() => {});
      const results = await Promise.allSettled(this.runners.map(async (runner) => runner.close()));
      this.artifacts.clear();
      if (results.some((result) => result.status === 'rejected'))
        throw new RunnerFault('host-exited', 'close');
    })();
    await this.closed;
    this.emit('closed');
  }
}
