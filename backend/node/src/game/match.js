import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { JavaScriptArtifacts } from '../runtime/javascript-artifacts.js';
import { createJavaScriptRegistry } from '../runtime/runner-registry.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from '../runtime/policy.js';
import {
  RunnerFault,
  assertRunnerInfo,
  assertMoveResult,
} from '../runtime/contracts/validation.js';
import { GameState } from './state.js';
import { MatchOutput } from './match-output.js';
import { systemMatchClock, MATCH_TICK_MS } from './match-clock.js';

export class Match extends EventEmitter {
  constructor(map, sources, options = {}, dependencies = {}) {
    super();
    if (sources.length < 1 || sources.length > 4) throw new Error('플레이어는 1~4명이어야 합니다.');
    this.map = structuredClone(map);
    this.sources = [...sources];
    const { gameId, participants, runnerFactory, record, ...gameOptions } = options;
    this.options = structuredClone(gameOptions);
    this.participants = participants ? structuredClone(participants) : undefined;
    this.runners = [];
    this.contexts = [];
    this.callIds = sources.map(() => 0);
    this.turns = new Map();
    this.actionReady = new Map();
    this.phase = 'created';
    this.gameId = gameId ?? randomUUID();
    this.clock = dependencies.clock || systemMatchClock;
    this.random = dependencies.random || Math.random;
    this.artifacts = dependencies.artifacts || new JavaScriptArtifacts();
    this.registry =
      dependencies.registry ||
      createJavaScriptRegistry({ resolveArtifact: this.artifacts.resolve });
    this.runnerFactory =
      dependencies.runnerFactory || runnerFactory || ((context) => this.registry.create(context));
    this.output = new MatchOutput(dependencies.record || record, () =>
      this.stopDetached('recording-failure'),
    );
  }
  get logs() {
    return this.output.logs;
  }
  get latest() {
    return this.output.latest;
  }
  record(type, payload) {
    return this.output.record(type, payload);
  }

  start() {
    if (this.stopping) return Promise.reject(new RunnerFault('cancelled', 'initialize'));
    if (!this.starting)
      this.starting = (async () => {
        await this.prepare();
        if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
        this.run();
      })();
    return this.starting;
  }
  prepare() {
    if (this.stopping) return Promise.reject(new RunnerFault('cancelled', 'initialize'));
    if (!this.preparing) {
      this.phase = 'preparing';
      // Reserve single-flight before calling injectable preparation code.
      this.preparing = Promise.resolve().then(() => this.prepareRunners());
    }
    return this.preparing;
  }
  async closeRunners() {
    const results = await Promise.allSettled(this.runners.map(async (runner) => runner.close()));
    if (results.some((result) => result.status === 'rejected'))
      throw new RunnerFault('unresponsive', 'close');
  }
  async prepareRunners() {
    try {
      for (let index = 0; index < this.sources.length; index++) {
        if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
        const participant = this.participants?.[index];
        const language = participant?.language ?? 'javascript';
        if (!this.registry.supportedLanguages.includes(language))
          throw new RunnerFault('unavailable', 'initialize');
        const artifact = await this.artifacts.register(
          this.sources[index],
          participant?.source,
          language,
        );
        if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
        const context = {
          contractVersion: 1,
          gameId: this.gameId,
          playerId: index,
          runId: participant?.runId ?? randomUUID(),
          language,
          artifact,
          limits: {
            turnMs: 500,
            algorithmMemoryBytes: language === 'javascript' ? ALGORITHM_MEMORY_LIMIT_BYTES : null,
          },
        };
        this.contexts.push(context);
        this.runners.push(this.runnerFactory(context));
      }
      if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
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
      if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
      const infos = initialized.map((result, index) =>
        assertRunnerInfo(result.value, this.contexts[index]),
      );
      this.state = new GameState(
        this.map,
        infos.map((info) => info.name),
        this.options,
        this.random,
      );
      this.prepared = true;
      this.phase = 'ready';
      this.record('prepared', {
        runners: infos,
        players: this.state.players,
        map: this.map,
        options: {
          mode: this.options.mode,
          blackMatter: this.options.blackMatter,
          destroyWalls: this.options.destroyWalls,
        },
      });
      if (this.stopping) throw new RunnerFault('cancelled', 'initialize');
    } catch (error) {
      this.prepared = false;
      if (!this.stopping) this.phase = 'failed';
      try {
        await this.closeRunners();
      } finally {
        this.artifacts.clear();
      }
      throw error;
    }
  }

  run() {
    if (this.phase !== 'ready' || !this.prepared || this.stopping)
      throw new Error('Invalid match state');
    this.running = true;
    this.phase = 'running';
    this.state.start(this.clock.now());
    this.record('started', { game: this.state.snapshot(this.clock.now()) });
    if (this.stopping) return;
    this.timer = this.clock.setInterval(() => this.tick(), MATCH_TICK_MS);
    this.publish();
    this.tick();
  }
  tick() {
    if (this.phase !== 'running' || this.stopping || !this.state) return;
    try {
      this.advance();
    } catch {
      this.stopDetached('runtime-failure');
    }
  }
  advance() {
    const now = this.clock.now();
    // Stable ordering resolves simultaneous arrivals; no wait for other judgements.
    for (const player of this.state.players) {
      const action = player.action;
      if (this.state.completeAction(player.id, now)) {
        this.actionReady.set(player.id, { dueAt: action.endsAt, detectedAt: now });
        this.record('action-completed', {
          player: player.id,
          turn: player.turn,
          action,
          game: this.state.snapshot(now),
          timing: {
            completedAt: now,
            completionDetectionDelayMs: Math.max(0, now - action.endsAt),
          },
        });
        if (this.stopping) return;
      }
    }
    const before = JSON.stringify([this.state.tiles, this.state.items, this.state.status]);
    this.state.update(now);
    if (before !== JSON.stringify([this.state.tiles, this.state.items, this.state.status]))
      this.record('world-updated', { game: this.state.snapshot(now) });
    if (this.stopping) return;
    if (!this.state.isRunning()) {
      this.stopDetached(this.state.reason);
      return;
    }
    for (const player of this.state.players) {
      if (this.stopping) break;
      if (!player.action && !player.thinking) this.requestTurn(player.id);
    }
    this.publish();
  }

  requestTurn(id) {
    const player = this.state?.players[id];
    if (
      this.phase !== 'running' ||
      this.stopping ||
      !this.state.isRunning() ||
      !player ||
      player.action ||
      player.thinking ||
      this.turns.has(id)
    )
      return Promise.resolve(false);
    const turn = ++player.turn;
    player.thinking = true;
    let settle;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    this.turns.set(id, pending);
    // Reserve busy state before any callback can reenter the engine.
    const done = () => {
      this.turns.delete(id);
      settle(true);
    };
    void this.performTurn(id, turn).then(done, () => {
      this.stopDetached('runtime-failure');
      done();
    });
    return pending;
  }
  async performTurn(id, turn) {
    const player = this.state.players[id];
    const requestedAt = this.clock.now();
    const ready = this.actionReady.get(id);
    this.actionReady.delete(id);
    this.record('turn-requested', {
      player: id,
      turn,
      position: player.position,
      jump: player.effect?.type === 3,
      scheduling: ready
        ? {
            actionEndedAt: ready.dueAt,
            completionDetectedAt: ready.detectedAt,
            requestedAt,
            completionDetectionDelayMs: Math.max(0, ready.detectedAt - ready.dueAt),
            completionToRequestMs: Math.max(0, requestedAt - ready.detectedAt),
            actionToRequestMs: Math.max(0, requestedAt - ready.dueAt),
          }
        : null,
    });
    if (this.stopping) return;
    if (player.effect?.type === 3) {
      this.state.beginAction(id, { status: 'ok', value: 0 }, this.clock.now());
      this.record('action-started', { player: id, turn, action: player.action });
      if (!this.stopping) this.publish();
      return;
    }
    const context = this.contexts[id];
    const callId = ++this.callIds[id];
    let result;
    try {
      const request = {
        contractVersion: 1,
        gameId: context.gameId,
        playerId: id,
        runId: context.runId,
        callId,
        map: [...this.state.tiles],
        myPosition: player.position,
        items: [...this.state.items],
      };
      const dispatchStartedAt = this.clock.now();
      const response = this.runners[id].move(request);
      this.record('algorithm-dispatched', {
        player: id,
        turn,
        callId,
        dispatchStartedAt,
        scheduling: ready
          ? {
              actionEndedAt: ready.dueAt,
              completionDetectedAt: ready.detectedAt,
              dispatchStartedAt,
              completionDetectionDelayMs: Math.max(0, ready.detectedAt - ready.dueAt),
              completionToDispatchMs: Math.max(0, dispatchStartedAt - ready.detectedAt),
              acceptanceToDispatchMs: Math.max(0, dispatchStartedAt - requestedAt),
              actionToDispatchMs: Math.max(0, dispatchStartedAt - ready.dueAt),
            }
          : null,
      });
      result = await response;
      assertMoveResult(result, this.runners[id].info, callId);
    } catch (error) {
      this.record(this.stopping ? 'late-failure' : 'runtime-failure', {
        player: id,
        turn,
        callId,
        code: error instanceof RunnerFault ? error.code : 'protocol-error',
        ...(['exception', 'operation-limit', 'cancelled'].includes(error?.userStatus)
          ? { status: error.userStatus }
          : {}),
        ...(error instanceof RunnerFault && error.diagnostic
          ? { diagnostic: error.diagnostic }
          : {}),
        ...(error instanceof RunnerFault && error.infrastructureFailure
          ? { infrastructureFailure: error.infrastructureFailure, gcEntry: error.gcEntry }
          : {}),
      });
      // Never await stop from a job that stop itself must drain.
      if (!this.stopping)
        this.stopDetached(
          error instanceof RunnerFault && error.infrastructureFailure
            ? error.infrastructureFailure
            : 'runtime-failure',
        );
      return;
    }
    if (this.stopping || !this.state.isRunning()) {
      this.record('late-result', { player: id, turn, result });
      return;
    }
    this.record('algorithm-result', { player: id, turn, result });
    if (this.runners[id].lastObservation)
      this.record('runtime-observation', {
        player: id,
        turn,
        callId,
        instanceId: result.instanceId,
        policy: this.runners[id].observationPolicy,
        memory: this.runners[id].lastObservation,
      });
    if (this.stopping) return;
    const actionResult = {
      status: result.status,
      value: result.direction,
      elapsedMs: result.timings.executionMs,
    };
    this.state.recordAlgorithmResult(id, actionResult);
    this.output.appendDebug(id, turn, result);
    this.state.beginAction(id, actionResult, this.clock.now());
    this.record('action-started', { player: id, turn, action: player.action });
    if (!this.stopping) this.publish();
  }

  publish() {
    if (!this.state || this.output.sealed) return;
    const latest = this.output.snapshot(this.state, this.clock.now());
    try {
      this.emit('snapshot', latest);
    } catch {
      this.stopDetached('transport-failure');
    }
  }
  stopDetached(reason) {
    // Timer/event callbacks must not create unhandled rejections. Explicit callers still
    // receive the original rejected close promise and can report resource-release failure.
    void this.stop(reason).catch(() => {});
  }
  stop(reason = 'user-stopped') {
    if (this.closed) return this.closed;
    this.stopping = true;
    this.running = false;
    this.phase = 'stopping';
    this.stopReason = this.state?.reason || reason;
    // Reserve settlement before synchronous output/listener callbacks can reenter stop.
    let resolve, reject;
    this.closed = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.clock.clearInterval(this.timer);
    this.state?.finish(this.stopReason);
    this.record('finished', {
      reason: this.stopReason,
      game: this.state?.snapshot(this.clock.now()) || null,
    });
    this.publish();
    void this.shutdown().then(resolve, (error) => {
      reject(error);
      // An embedding engine needs a terminal fault even if a runner cannot
      // confirm clean closure. Explicit stop callers still receive the error.
      for (const listener of this.rawListeners('cleanup-failed')) {
        try {
          listener.call(this, error);
        } catch {
          /* Parent supervision remains authoritative. */
        }
      }
    });
    return this.closed;
  }
  async shutdown() {
    let failure;
    try {
      // Start closing now, including an initializing/computing runner. Later creation is
      // prohibited by stopping; preparation will also settle its own failure/cleanup.
      const closing = this.closeRunners();
      // Attach immediately, so even an early close rejection is observed.
      const cleanup = await Promise.allSettled([closing, this.preparing]);
      if (cleanup[0].status === 'rejected') failure = cleanup[0].reason;
      // Also include a factory that reentered stop immediately before returning its runner.
      try {
        await this.closeRunners();
      } catch (error) {
        failure ||= error;
      }
      if (failure) throw failure;
      // No collector may finish until all late-result/error producers have stopped.
      await Promise.allSettled([...this.turns.values()]);
      this.artifacts.clear();
      this.actionReady.clear();
    } catch (error) {
      failure = error;
    }
    if (failure) {
      this.phase = 'failed';
      throw failure;
    }
    this.output.seal();
    this.phase = 'closed';
    // 'closed' means resources + engine continuations drained, not just game over.
    for (const listener of this.rawListeners('closed')) {
      try {
        listener.call(this);
      } catch {
        /* One observer cannot suppress other close notifications. */
      }
    }
  }
}
