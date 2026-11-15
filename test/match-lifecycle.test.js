import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Match } from '../backend/node/src/game/match.js';
import { MATCH_TICK_MS } from '../backend/node/src/game/match-clock.js';
import { DEFAULT_MAP_SETTINGS } from '../backend/node/src/game/maps.js';
import { JavaScriptArtifacts } from '../backend/node/src/runtime/javascript-artifacts.js';
import { RunnerFault } from '../backend/node/src/runtime/contracts/validation.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function board() {
  const tiles = Array(36).fill(0);
  tiles[14] = 100;
  tiles[21] = 10;
  return {
    columns: 6,
    rows: 6,
    tiles,
    settings: {
      ...DEFAULT_MAP_SETTINGS,
      actionMs: 300,
      runningTimeMs: 60000,
      itemFirstMs: 50000,
      itemIntervalMs: 50000,
    },
  };
}
function fakeClock() {
  return {
    time: 0,
    intervals: new Set(),
    periods: [],
    now() {
      return this.time;
    },
    setInterval(callback, period) {
      this.intervals.add(callback);
      this.periods.push(period);
      return callback;
    },
    clearInterval(callback) {
      this.intervals.delete(callback);
    },
    at(time) {
      assert.ok(time >= this.time);
      this.time = time;
    },
    tick(time) {
      this.at(time);
      for (const callback of [...this.intervals]) callback();
    },
  };
}
class ControlledRunner {
  constructor(context, options = {}) {
    this.context = context;
    this.options = options;
    this.requests = [];
    this.active = 0;
    this.closeCount = 0;
    this.initializeCount = 0;
    this.info = {
      contractVersion: 1,
      gameId: context.gameId,
      playerId: context.playerId,
      runId: context.runId,
      instanceId: randomUUID(),
      hostId: randomUUID(),
      language: context.language,
      name: 'controlled-' + context.playerId,
      runtime: { ...context.artifact.runtime },
      adapterVersion: context.artifact.adapterVersion,
    };
  }
  initialize() {
    this.initializeCount++;
    this.initialization = (async () => {
      await this.options.initializeGate?.promise;
      if (this.closing) throw new RunnerFault('cancelled', 'initialize');
      return this.info;
    })();
    return this.initialization;
  }
  move(request) {
    assert.equal(this.active, 0, 'same player cannot overlap calculations');
    assert.equal(this.closing, undefined);
    this.active++;
    this.requests.push(structuredClone(request));
    const gate = deferred();
    this.pending = { ...gate, request };
    this.current = gate.promise.finally(() => {
      this.active--;
    });
    return this.current;
  }
  complete(direction = -1, status = 'ok', elapsedMs = status === 'timeout' ? 500 : 1, patch = {}) {
    const request = this.pending.request;
    this.pending.resolve({
      contractVersion: 1,
      gameId: request.gameId,
      playerId: request.playerId,
      runId: request.runId,
      instanceId: this.info.instanceId,
      callId: request.callId,
      status,
      direction,
      completion: status === 'timeout' ? 'interrupted' : 'returned',
      logs: [],
      droppedLogs: 0,
      timings: {
        executionMs: elapsedMs,
        executionBoundary: 'controlled-test-v1',
        roundTripMs: null,
        inputPreparationMs: null,
        responseProcessingMs: null,
        engineApplyDelayMs: null,
      },
      ...patch,
    });
  }
  close() {
    if (this.closed) return this.closed;
    this.closeCount++;
    this.closing = true;
    this.closed = (async () => {
      if (this.options.close) await this.options.close(this);
      else {
        this.options.initializeGate?.resolve();
        this.pending?.reject(new RunnerFault('cancelled', 'move'));
        await Promise.allSettled([this.initialization, this.current]);
      }
      return { contractVersion: 1, runId: this.context.runId, resourcesReleased: true };
    })();
    return this.closed;
  }
}
function fixture(count = 1, { map = board(), runnerOptions = [], record, random = () => 0 } = {}) {
  const clock = fakeClock(),
    runners = [],
    events = [];
  const match = new Match(
    map,
    Array(count).fill('controlled source'),
    {},
    {
      clock,
      random,
      runnerFactory: (context) => {
        const runner = new ControlledRunner(context, runnerOptions[context.playerId]);
        runners.push(runner);
        return runner;
      },
      record: (type, payload) => {
        events.push({ type, payload });
        return record?.(type, payload);
      },
    },
  );
  return { clock, runners, events, match };
}
const effects = (f, type, remaining = 3) => {
  f.match.state.players[0].effect = { type, remaining, id: ++f.match.state.effectSequence };
};

test('preparation is a barrier only before start; concurrent start/stop have one settlement and cannot restart', async () => {
  const gate = deferred();
  const f = fixture(2, { runnerOptions: [{}, { initializeGate: gate }] });
  const start = f.match.start();
  assert.equal(start, f.match.start());
  await flush();
  assert.equal(f.match.phase, 'preparing');
  assert.throws(() => f.match.run());
  assert.equal(f.runners[0].requests.length, 0);
  gate.resolve();
  await start;
  assert.equal(f.match.phase, 'running');
  assert.deepEqual(f.clock.periods, [MATCH_TICK_MS]);
  assert.ok(f.runners.every((r) => r.initializeCount === 1 && r.requests.length === 1));
  const close = f.match.stop('first');
  assert.equal(close, f.match.stop('second'));
  await close;
  assert.equal(f.match.phase, 'closed');
  assert.equal(f.match.state.reason, 'first');
  assert.equal(f.clock.intervals.size, 0);
  assert.ok(f.runners.every((r) => r.closeCount === 1 && r.active === 0));
  assert.throws(() => f.match.run());
  await assert.rejects(f.match.prepare());
  await assert.rejects(f.match.start());
  assert.equal(f.events.filter((e) => e.type === 'finished').length, 1);
});

test('fast player acts immediately and requests the next turn while another judgement is still pending', async () => {
  const f = fixture(2);
  await f.match.start();
  f.clock.at(5);
  f.runners[0].complete(2);
  await flush();
  assert.equal(f.match.state.players[0].action.startedAt, 5);
  assert.equal(
    f.match.latest.game.players[0].action.startedAt,
    5,
    'action is published without waiting for the next tick',
  );
  assert.equal(f.match.state.players[1].thinking, true);
  assert.equal(await f.match.requestTurn(0), false);
  assert.equal(await f.match.requestTurn(1), false);
  f.clock.tick(304);
  assert.equal(f.runners[0].requests.length, 1);
  f.clock.tick(320);
  assert.equal(f.runners[0].requests.length, 2);
  assert.equal(f.runners[1].requests.length, 1);
  const schedule = f.events.filter((e) => e.type === 'turn-requested' && e.payload.player === 0)[1]
    .payload.scheduling;
  assert.equal(schedule.completionDetectionDelayMs, 15);
  assert.equal(schedule.completionToRequestMs, 0);
  assert.equal(schedule.actionToRequestMs, 15);
  assert.equal(f.runners[0].requests[1].myPosition, 1);
  await f.match.stop();
});

test('request snapshots are per player and stay isolated as other actions change the world', async () => {
  const map = board();
  map.tiles[1] = 30;
  const f = fixture(2, { map });
  await f.match.prepare();
  f.match.state.players[1].position = 2;
  f.match.run();
  assert.equal(f.runners[0].requests[0].map[1], 30);
  f.runners[1].complete(0);
  await flush();
  f.clock.tick(300);
  assert.equal(f.match.state.players[1].score, 30);
  assert.equal(f.runners[0].requests[0].map[1], 30);
  assert.equal(f.runners[1].requests[1].map[1], 0);
  assert.equal(f.runners[0].requests.length, 1);
  await f.match.stop();
});

test('scheduling distinguishes accepting a turn from the actual runner invocation after input/record work', async () => {
  const f = fixture(1, {
    record: (type, payload) => {
      if (type === 'turn-requested' && payload.turn === 2) f.clock.at(f.clock.now() + 7);
    },
  });
  await f.match.start();
  f.runners[0].complete(-1);
  await flush();
  f.clock.tick(320);
  const accepted = f.events.filter((event) => event.type === 'turn-requested')[1].payload
    .scheduling;
  const dispatched = f.events.filter((event) => event.type === 'algorithm-dispatched')[1].payload
    .scheduling;
  assert.equal(accepted.actionToRequestMs, 20);
  assert.equal(dispatched.actionToDispatchMs, 27);
  assert.equal(dispatched.acceptanceToDispatchMs, 7);
  await f.match.stop();
});

test('stop during computation waits for late normal result, with no action/stat mutation after game over', async () => {
  const f = fixture(1, { runnerOptions: [{ close: async () => {} }] });
  await f.match.start();
  let closed = false;
  f.match.once('closed', () => {
    closed = true;
  });
  const closing = f.match.stop();
  await flush();
  assert.equal(closed, false);
  assert.equal(f.match.phase, 'stopping');
  f.runners[0].complete(2);
  await closing;
  assert.equal(f.match.phase, 'closed');
  assert.equal(f.match.state.players[0].position, 0);
  assert.equal(f.match.state.players[0].stats.algorithmCalls, 0);
  assert.equal(f.match.state.players[0].action, null);
  assert.equal(f.events.filter((e) => e.type === 'late-result').length, 1);
  assert.equal(f.events.filter((e) => e.type === 'algorithm-result').length, 0);
  assert.equal(f.match.turns.size, 0);
  assert.equal(f.match.output.sealed, true);
  const count = f.events.length;
  f.clock.tick(1000);
  assert.equal(await f.match.requestTurn(0), false);
  assert.equal(f.events.length, count);
});

test('late errors drain before closed and do not replace the first terminal reason', async () => {
  const f = fixture(1, { runnerOptions: [{ close: async () => {} }] });
  await f.match.start();
  let observed;
  f.match.once('closed', () => {
    observed = f.events.at(-1).type;
  });
  const closed = f.match.stop('account-ended');
  f.runners[0].pending.reject(new RunnerFault('host-exited', 'move'));
  await closed;
  assert.equal(observed, 'late-failure');
  assert.equal(f.match.state.reason, 'account-ended');
  assert.equal(f.match.state.players[0].turn, 1);
});

test('stop during action discards unfinished movement and score; final reason is immutable', async () => {
  const map = board();
  map.tiles[1] = 100;
  const f = fixture(1, { map });
  await f.match.start();
  f.runners[0].complete(2);
  await flush();
  f.clock.at(100);
  await f.match.stop('user-stopped');
  f.clock.tick(1000);
  const p = f.match.state.players[0];
  assert.equal(p.position, 0);
  assert.equal(p.score, 0);
  assert.equal(p.stats.completedTurns, 0);
  f.match.state.finish('later');
  assert.equal(f.match.state.reason, 'user-stopped');
  assert.throws(() => f.match.state.start(1000));
});

test('natural last-coin finish closes all players before any next judgement', async () => {
  const map = board();
  map.tiles.fill(0);
  map.tiles[1] = 10;
  const f = fixture(2, { map });
  await f.match.start();
  f.runners[0].complete(2);
  await flush();
  f.clock.tick(300);
  await f.match.closed;
  assert.equal(f.match.state.reason, 'coins-collected');
  assert.equal(f.match.state.players[0].score, 10);
  assert.ok(f.runners.every((r) => r.requests.length === 1 && r.closeCount === 1));
  assert.equal(f.events.filter((e) => e.type === 'action-completed').length, 1);
  await f.match.stop('later');
  assert.equal(f.match.state.reason, 'coins-collected');
  const emptyMap = board();
  emptyMap.tiles.fill(0);
  const empty = fixture(1, { map: emptyMap });
  await empty.match.start();
  await empty.match.closed;
  assert.equal(empty.runners[0].requests.length, 0);
  assert.equal(empty.match.state.reason, 'coins-collected');
});

test('stop before prepare, during source binding and during initialization prevents later running', async () => {
  const before = fixture();
  await before.match.stop();
  await assert.rejects(before.match.start());
  assert.equal(before.runners.length, 0);
  const gate = deferred(),
    artifacts = new JavaScriptArtifacts(),
    clock = fakeClock();
  let created = 0;
  const loading = new Match(
    board(),
    ['source'],
    {},
    {
      clock,
      artifacts: {
        resolve: artifacts.resolve,
        register: async (...args) => {
          await gate.promise;
          return artifacts.register(...args);
        },
        clear: () => artifacts.clear(),
      },
      runnerFactory: () => {
        created++;
        assert.fail('cancelled source must not create runner');
      },
    },
  );
  const preparing = loading.prepare();
  await flush();
  const closing = loading.stop();
  gate.resolve();
  await assert.rejects(preparing);
  await closing;
  assert.equal(created, 0);
  const initGate = deferred();
  const f = fixture(2, { runnerOptions: [{}, { initializeGate: initGate }] });
  const start = f.match.start();
  await flush();
  const stopped = f.match.stop();
  await assert.rejects(start);
  await stopped;
  assert.equal(f.match.phase, 'closed');
  assert.ok(f.runners.every((r) => r.closeCount === 1 && r.requests.length === 0));
});

test('reentrant factory stop tracks and closes the runner returned after cancellation', async () => {
  const clock = fakeClock();
  let runner, closing;
  const match = new Match(
    board(),
    ['source'],
    {},
    {
      clock,
      runnerFactory: (context) => {
        runner = new ControlledRunner(context);
        closing = match.stop();
        return runner;
      },
    },
  );
  await assert.rejects(match.prepare());
  await closing;
  assert.equal(runner.closeCount, 1);
  assert.equal(runner.initializeCount, 0);
});

test('runner/host failure ends the whole game and drains other players without unhandled turn jobs', async () => {
  const f = fixture(2);
  await f.match.start();
  f.runners[0].pending.reject(new RunnerFault('host-exited', 'move'));
  await flush();
  await f.match.closed;
  assert.equal(f.match.state.reason, 'runtime-failure');
  assert.equal(f.match.phase, 'closed');
  assert.ok(f.runners.every((r) => r.closeCount === 1 && r.active === 0));
  assert.equal(f.events.filter((e) => e.type === 'runtime-failure').length, 1);
  assert.equal(f.events.filter((e) => e.type === 'algorithm-result').length, 0);
});

test('malformed/replayed result cannot act even from a replacement factory', async () => {
  for (const patch of [
    { callId: 99 },
    { runId: randomUUID() },
    { instanceId: randomUUID() },
    { direction: 99 },
  ]) {
    const f = fixture();
    await f.match.start();
    f.runners[0].complete(2, 'ok', 1, patch);
    await flush();
    await f.match.closed;
    assert.equal(f.match.state.reason, 'runtime-failure');
    assert.equal(f.match.state.players[0].stats.algorithmCalls, 0);
  }
});

test('cleanup failure rejects closed instead of claiming resources are released', async () => {
  const f = fixture(1, {
    runnerOptions: [
      {
        close: async () => {
          throw new Error('release failed');
        },
      },
    ],
  });
  await f.match.start();
  let closedEvent = false;
  f.match.once('closed', () => {
    closedEvent = true;
  });
  await assert.rejects(f.match.stop(), (error) => error.stage === 'close');
  assert.equal(f.match.phase, 'failed');
  assert.equal(closedEvent, false);
  assert.equal(f.match.output.sealed, false);
  f.runners[0].pending.reject(new RunnerFault('host-exited', 'move'));
  await flush();
});

test('record sink failures at preparation, judgement, or finish cannot skip cleanup', async () => {
  for (const target of ['prepared', 'turn-requested', 'algorithm-result', 'finished', 'async']) {
    const f = fixture(1, {
      record: (type) => {
        if (type === target) throw new Error('sink probe');
        if (target === 'async' && type === 'prepared')
          return Promise.reject(new Error('async sink probe'));
      },
    });
    try {
      await f.match.start();
    } catch {
      assert.ok(target === 'prepared' || target === 'async');
    }
    if (target === 'algorithm-result') {
      f.runners[0].complete(2);
      await flush();
    }
    if (target === 'finished') await f.match.stop();
    await f.match.closed;
    assert.ok(f.runners.every((r) => r.closeCount === 1 && r.active === 0));
    assert.equal(f.match.phase, 'closed');
    assert.equal(f.match.state.players[0].stats.algorithmCalls, 0);
    assert.equal(
      f.match.state.reason,
      target === 'finished' ? 'user-stopped' : 'recording-failure',
    );
  }
});

test('record/view consumers receive independent copies; snapshot reentry and listener exceptions terminate safely', async () => {
  const f = fixture(1, {
    record: (_type, payload) => {
      if (payload.players) payload.players[0].position = 999;
      if (payload.map) payload.map.tiles[1] = 999;
    },
  });
  await f.match.start();
  assert.equal(f.match.state.players[0].position, 0);
  assert.equal(f.match.state.tiles[1], 0);
  f.runners[0].complete(-1, 'ok', 1, { logs: ['debug'] });
  await flush();
  f.match.publish();
  f.match.latest.game.players[0].score = 999;
  f.match.latest.logs[0].lines[0] = 'changed';
  assert.equal(f.match.state.players[0].score, 0);
  assert.equal(f.match.logs[0].lines[0], 'debug');
  await f.match.stop();
  let notified = 0;
  const notify = fixture();
  notify.match.once('closed', () => {
    throw new Error('observer');
  });
  notify.match.once('closed', () => {
    notified++;
  });
  await notify.match.start();
  await notify.match.stop();
  assert.equal(notified, 1);
  for (const throws of [false, true]) {
    const other = fixture();
    const stops = [];
    other.match.on('snapshot', () => {
      if (throws) throw new Error('observer');
      stops.push(other.match.stop('viewer-stop'));
    });
    await other.match.start();
    await other.match.closed;
    assert.equal(other.runners[0].requests.length, 0);
    assert.equal(other.match.state.reason, throws ? 'transport-failure' : 'viewer-stop');
    if (!throws) assert.equal(stops[0], stops[1]);
  }
});

test('current-turn penalty, timeout and invalid return consume exactly one normal-duration action', async () => {
  for (const status of ['ok', 'timeout', 'exception', 'invalid-result']) {
    const f = fixture();
    await f.match.start();
    if (status === 'timeout') f.clock.at(500);
    f.runners[0].complete(-1, status);
    await flush();
    const p = f.match.state.players[0],
      action = p.action;
    assert.equal(action.type, 'penalty');
    assert.equal(action.endsAt - action.startedAt, 300);
    f.clock.tick(action.endsAt);
    assert.equal(p.stats.penalties, 1);
    assert.equal(f.runners[0].requests.length, 2);
    f.runners[0].complete(2);
    await flush();
    f.clock.tick(p.action.endsAt);
    assert.equal(p.position, 1);
    await f.match.stop();
  }
});

test('wall confusion and hammer breaking use one action; hammer count changes only when a wall breaks', async () => {
  for (const hammer of [false, true]) {
    const map = board();
    map.tiles[1] = -1;
    const f = fixture(1, { map });
    await f.match.prepare();
    if (hammer) effects(f, 1);
    f.match.run();
    f.runners[0].complete(2);
    await flush();
    let p = f.match.state.players[0];
    assert.equal(p.action.type, hammer ? 'break' : 'confused');
    assert.equal(p.action.endsAt, 300);
    f.clock.tick(300);
    assert.equal(p.position, 0);
    assert.equal(f.match.state.tiles[1], hammer ? 0 : -1);
    if (hammer) {
      assert.equal(p.effect.remaining, 2);
      f.runners[0].complete(2);
      await flush();
      f.clock.tick(600);
      assert.equal(p.position, 1);
      assert.equal(p.effect.remaining, 2);
    }
    await f.match.stop();
  }
});

test('shoes expire after three actions, x2 consumes coins, and pickup replaces rather than decrements the new effect', async () => {
  const shoes = fixture();
  await shoes.match.prepare();
  effects(shoes, 0);
  shoes.match.run();
  for (let turn = 0; turn < 3; turn++) {
    shoes.runners[0].complete(-1);
    await flush();
    const action = shoes.match.state.players[0].action;
    assert.equal(action.endsAt - action.startedAt, 150);
    shoes.clock.tick(action.endsAt);
  }
  assert.equal(shoes.match.state.players[0].effect, null);
  shoes.runners[0].complete(-1);
  await flush();
  assert.equal(shoes.match.state.players[0].action.endsAt - shoes.clock.now(), 300);
  await shoes.match.stop();
  const map = board();
  map.tiles[1] = 30;
  const f = fixture(1, { map });
  await f.match.prepare();
  effects(f, 2);
  f.match.state.items[0] = 2;
  f.match.run();
  f.runners[0].complete(2);
  await flush();
  f.clock.tick(300);
  assert.equal(f.match.state.players[0].score, 60);
  assert.equal(f.match.state.players[0].effect.remaining, 2);
  f.runners[0].complete(2);
  await flush();
  f.clock.tick(600);
  assert.equal(f.match.state.players[0].effect.type, 0);
  assert.equal(f.match.state.players[0].effect.remaining, 3);
  await f.match.stop();
});

test('three random-jump actions skip runner calls, deterministic random and failure consume effects equally', async () => {
  for (const fail of [false, true]) {
    const map = board();
    const f = fixture(1, { map });
    await f.match.prepare();
    if (fail) {
      f.match.state.tiles.fill(10);
      f.match.state.tiles[0] = 0;
    }
    effects(f, 3);
    f.match.run();
    await flush();
    for (let i = 0; i < 3; i++) {
      const action = f.match.state.players[0].action;
      assert.equal(action.type, fail ? 'jump-failed' : 'jump');
      assert.equal(action.endsAt - action.startedAt, 300);
      assert.equal(f.runners[0].requests.length, 0);
      f.clock.tick(action.endsAt);
      await flush();
    }
    assert.equal(f.match.state.players[0].effect, null);
    assert.equal(f.runners[0].requests.length, 1);
    assert.equal(f.runners[0].requests[0].callId, 1);
    assert.equal(f.match.state.players[0].turn, 4);
    await f.match.stop();
  }
});

test(
  'real JS runners keep engine turns independent through interruption and preserve the same object',
  { timeout: 10000 },
  async (t) => {
    const source = `module.exports=class {initialize(n){this.n=n;this.calls=0;}getName(){return 'actual';}moveNext(){this.calls++;if(this.n===0&&this.calls===1){this.saved=3;while(true){}}debug.print(this.calls,this.saved||0);return -1;}}`;
    const events = [];
    const clock = fakeClock();
    const match = new Match(
      board(),
      [source, source],
      {},
      { clock, record: (type, payload) => events.push({ type, payload }) },
    );
    t.after(() => match.stop());
    await match.start();
    const until = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('real runner progress deadline');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await until(() => match.state.players[1].action);
    assert.equal(match.state.players[0].thinking, true);
    clock.tick(300);
    await until(() => match.state.players[1].stats.algorithmCalls === 2);
    assert.equal(match.state.players[0].thinking, true);
    await until(() => match.state.players[0].stats.timeouts === 1);
    const info = match.runners[0].info;
    clock.tick(600);
    await until(() => match.state.players[0].stats.algorithmCalls === 2);
    const own = events.filter((e) => e.type === 'algorithm-result' && e.payload.player === 0);
    assert.deepEqual(
      own.map((e) => e.payload.result.status),
      ['timeout', 'ok'],
    );
    assert.equal(own[1].payload.result.instanceId, info.instanceId);
    assert.deepEqual(own[1].payload.result.logs, ['2 3']);
    await match.stop();
    assert.equal(match.turns.size, 0);
    assert.ok(match.runners.every((r) => r.host.terminated));
  },
);
