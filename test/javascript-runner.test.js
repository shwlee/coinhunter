import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { JavaScriptArtifacts } from '../backend/node/src/runtime/javascript-artifacts.js';
import { createJavaScriptRegistry } from '../backend/node/src/runtime/runner-registry.js';
import {
  PlayerProcess,
  algorithmHostEnvironment,
} from '../backend/node/src/runtime/player-process.js';
import { validateAlgorithm } from '../backend/node/src/runtime/preflight.js';
import {
  RunnerFault,
  RunnerContractError,
} from '../backend/node/src/runtime/contracts/validation.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from '../backend/node/src/runtime/policy.js';
import { Match } from '../backend/node/src/game/match.js';
const MAPS = [
  JSON.parse(
    await readFile(
      new URL('../backend/node/maps/samples/crossroads.json', import.meta.url),
      'utf8',
    ),
  ),
];

const source = (body = 'return -1;') =>
  `module.exports = class { initialize(n,c,r){this.n=n;this.calls=0;} getName(){return 'runner-'+this.n;} moveNext(map,position,items){${body}} }`;
async function session(code = source(), options = {}) {
  const artifacts = new JavaScriptArtifacts();
  const artifact = await artifacts.register(code);
  const context = {
    contractVersion: 1,
    gameId: randomUUID(),
    playerId: 0,
    runId: randomUUID(),
    language: 'javascript',
    artifact,
    limits: { turnMs: 500, algorithmMemoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES },
  };
  const registry = createJavaScriptRegistry({ resolveArtifact: artifacts.resolve, ...options });
  const runner = registry.create(context);
  const request = (callId) => ({
    contractVersion: 1,
    gameId: context.gameId,
    playerId: 0,
    runId: context.runId,
    callId,
    map: Array(36).fill(0),
    myPosition: 0,
    items: [-1, -1, -1, -1],
  });
  return { artifacts, context, registry, runner, request };
}
const initialize = (runner) => runner.initialize({ playerNumber: 0, columns: 6, rows: 6 });

test('registry activates only JS and refuses mismatched artifact, version, limits and source binding before spawning', async () => {
  let created = 0;
  const f = await session(source(), {
    createHost: () => {
      created++;
      throw new Error();
    },
  });
  assert.deepEqual(f.registry.supportedLanguages, ['javascript']);
  for (const context of [
    { ...f.context, language: 'python', artifact: { ...f.context.artifact, language: 'python' } },
    { ...f.context, language: 'rust' },
    { ...f.context, artifact: { ...f.context.artifact, runtime: { name: 'other', version: '1' } } },
    { ...f.context, limits: { turnMs: 500, algorithmMemoryBytes: 1 } },
  ])
    assert.throws(() => f.registry.create(context));
  const altered = f.registry.create({
    ...f.context,
    artifact: { ...f.context.artifact, optionsHash: 'f'.repeat(64) },
  });
  await assert.rejects(initialize(altered), RunnerFault);
  assert.equal(created, 0);
});

test(
  'real adapter retains PID/host/object/state across timeout, errors and voluntary -1 without overlap',
  { timeout: 15000 },
  async (t) => {
    const f = await session(
      source(
        `this.calls++;if(this.calls===2){this.saved=3;while(true){}} if(this.calls===4) throw new Error('user'); if(this.calls===5)return '2';return this.calls===3?this.saved:-1;`,
      ),
    );
    t.after(() => f.runner.close());
    const info = await initialize(f.runner);
    const pid = f.runner.host.pid;
    const first = await f.runner.move(f.request(1));
    const pending = f.runner.move(f.request(2));
    await assert.rejects(f.runner.move(f.request(3)), RunnerContractError);
    const timeout = await pending;
    const next = await f.runner.move(f.request(3));
    assert.equal(first.status, 'ok');
    assert.equal(first.direction, -1);
    assert.equal(timeout.status, 'timeout');
    assert.equal(timeout.completion, 'interrupted');
    assert.equal(next.direction, 3);
    assert.equal(next.instanceId, info.instanceId);
    assert.equal(timeout.instanceId, info.instanceId);
    assert.equal(f.runner.host.pid, pid);
    assert.equal(f.runner.info.hostId, info.hostId);
    assert.equal((await f.runner.move(f.request(4))).status, 'exception');
    assert.equal((await f.runner.move(f.request(5))).status, 'invalid-result');
    assert.equal((await f.runner.move(f.request(6))).direction, -1);
    const closing = f.runner.close();
    assert.equal(closing, f.runner.close());
    assert.equal((await closing).resourcesReleased, true);
    assert.equal(f.runner.state, 'closed');
    assert.equal(f.runner.host.terminated, true);
  },
);

test('adapter copies map/items into isolated guest and exposes bounded debug, no raw source in result', async (t) => {
  const f = await session(
    source(`for(let i=0;i<40;i++)debug.print('line',i);map[0]=999;return items[0]===5?2:-1;`),
  );
  t.after(() => f.runner.close());
  await initialize(f.runner);
  const request = f.request(1);
  request.items[0] = 5;
  const result = await f.runner.move(request);
  assert.equal(result.direction, 2);
  assert.equal(request.map[0], 0);
  assert.equal(result.logs.length, 30);
  assert.equal(result.droppedLogs, 10);
  assert.equal(result.timings.inputPreparationMs, null);
  assert.equal(JSON.stringify(result).includes('source'), false);
  assert.equal(Object.hasOwn(result, 'exceptionMessage'), false);
});

test(
  'two real player adapters progress independently while one is interrupted',
  { timeout: 10000 },
  async (t) => {
    const slow = await session(source('while(true){}'));
    const fast = await session(source('return 2;'));
    t.after(() => Promise.all([slow.runner.close(), fast.runner.close()]));
    await Promise.all([initialize(slow.runner), initialize(fast.runner)]);
    const order = [];
    const results = await Promise.all(
      [slow, fast].map((f, i) =>
        f.runner.move(f.request(1)).then((r) => {
          order.push(i);
          return r;
        }),
      ),
    );
    assert.equal(order[0], 1);
    assert.equal(results[0].status, 'timeout');
    assert.equal(results[1].direction, 2);
    assert.notEqual(slow.runner.info.hostId, fast.runner.info.hostId);
    assert.notEqual(slow.runner.info.instanceId, fast.runner.info.instanceId);
  },
);

test('bad initialization releases host and diagnostics are opt-in; no raw exception is in common fault', async () => {
  for (const diagnostics of [false, true]) {
    const f = await session('module.exports = class {};', { diagnostics });
    await assert.rejects(initialize(f.runner), (error) => {
      assert.equal(error.code, 'initialization-failed');
      assert.equal(error.message.includes('Required'), false);
      assert.equal(Boolean(error.validation), diagnostics);
      return true;
    });
    assert.equal(f.runner.state, 'closed');
    assert.equal(f.runner.host.terminated, true);
    await assert.rejects(initialize(f.runner), RunnerContractError);
  }
});

test('file replacement between descriptor and worker load fails integrity check without leaking path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-runner-'));
  try {
    const file = join(dir, 'private-source.js');
    await writeFile(file, source());
    const f = await session({ path: file });
    await writeFile(file, source('return 3;'));
    await assert.rejects(
      initialize(f.runner),
      (error) => error instanceof RunnerFault && !error.message.includes(dir),
    );
    assert.equal(f.runner.host.terminated, true);
  } finally {
    assert.equal(dirname(dir), tmpdir());
    assert.ok(basename(dir).startsWith('coinhunter-runner-'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('closing during real initialization or move settles once and never returns to ready', async () => {
  const initializing = await session();
  const init = initialize(initializing.runner);
  const closed = initializing.runner.close();
  await Promise.allSettled([init, closed]);
  assert.equal(initializing.runner.state, 'closed');
  assert.equal(initializing.runner.host.terminated, true);
  const f = await session(source('while(true){}'));
  await initialize(f.runner);
  const pending = f.runner.move(f.request(1));
  const receipt = f.runner.close();
  assert.equal((await pending).status, 'timeout');
  await receipt;
  assert.equal(f.runner.state, 'closed');
  await assert.rejects(f.runner.move(f.request(2)), RunnerContractError);
});

test('misrouted or malformed transport response fails runner rather than applying a direction', async () => {
  let real;
  const f = await session(source('return 2;'), {
    createHost: () => {
      real = new PlayerProcess();
      const move = real.move.bind(real);
      real.move = async (...args) => ({ ...(await move(...args)), callId: 999 });
      return real;
    },
  });
  try {
    await initialize(f.runner);
    await assert.rejects(f.runner.move(f.request(1)), (error) => error.code === 'protocol-error');
    assert.equal(f.runner.state, 'failed');
    await assert.rejects(f.runner.move(f.request(2)), RunnerContractError);
  } finally {
    await f.runner.close();
  }
  assert.equal(real.terminated, true);
});

class SilentChild extends EventEmitter {
  connected = true;
  pid = 123;
  killed = false;
  send(_message, callback) {
    callback?.();
  }
  kill() {
    if (this.killed) return true;
    this.killed = true;
    this.connected = false;
    setImmediate(() => {
      this.emit('exit', null, 'SIGKILL');
      this.emit('close', null, 'SIGKILL');
    });
    return true;
  }
}
test('host initialization and response watchdogs classify infrastructure failure and await child closure', async () => {
  for (const type of ['initialize', 'move']) {
    const child = new SilentChild();
    const host = new PlayerProcess({
      forkChild: () => child,
      initializeMs: 15,
      responseMs: 15,
      closeMs: 15,
    });
    const call = type === 'initialize' ? host.initialize(source(), 0, 6, 6) : host.move([0], 0);
    await assert.rejects(call, (error) => error.code === 'unresponsive');
    await host.close();
    assert.equal(host.terminated, true);
    assert.equal(host.pending.size, 0);
    assert.equal(child.killed, true);
  }
});
test('unresponsive close, spawn error and wrong IPC correlation cannot hang cleanup', async () => {
  for (const mode of ['close', 'spawn', 'wrong-id']) {
    const child = new SilentChild();
    const host = new PlayerProcess({ forkChild: () => child, closeMs: 15 });
    if (mode === 'spawn') setImmediate(() => child.emit('error', new Error('private/path')));
    if (mode === 'wrong-id') {
      const pending = host.move([0], 0);
      setImmediate(() => child.emit('message', { id: 999, type: 'move', ok: true, result: {} }));
      await assert.rejects(pending, (error) => error.code === 'protocol-error');
    }
    const closed = host.close();
    assert.equal(closed, host.close());
    await closed;
    assert.equal(host.terminated, true);
    assert.equal(host.pending.size, 0);
  }
});

test('host cleanup rejects without release acknowledgement if even forced termination fails', async () => {
  const child = new SilentChild();
  child.kill = () => false;
  const host = new PlayerProcess({ forkChild: () => child, closeMs: 10 });
  await assert.rejects(host.close(), (error) => error.code === 'unresponsive');
  assert.notEqual(host.terminated, true);
  child.connected = false;
  child.emit('close', 1, null);
});

test('dead host stays failed and cannot be replaced silently for the next call', async () => {
  const f = await session();
  await initialize(f.runner);
  const pid = f.runner.host.pid;
  f.runner.host.child.kill('SIGKILL');
  await f.runner.host.exited;
  await assert.rejects(f.runner.move(f.request(1)), (error) => error.code === 'host-exited');
  assert.equal(f.runner.host.pid, pid);
  assert.equal(f.runner.state, 'failed');
  await f.runner.close();
});

test('algorithm hosts receive only OS environment and cancelled validation releases its session', async () => {
  assert.deepEqual(
    algorithmHostEnvironment({
      Path: 'path',
      TEMP: 'tmp',
      GOOGLE_CLIENT_SECRET: 'private',
      COINHUNTER_INTERNAL_KEY: 'private',
      NODE_OPTIONS: '--require private',
    }),
    { Path: 'path', TEMP: 'tmp' },
  );
  const controller = new AbortController();
  const pending = validateAlgorithm(
    source('while(true){}'),
    'cancel-adapter',
    null,
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(pending, (error) => error.code === 'cancelled');
  } finally {
    clearTimeout(timer);
  }
  assert.equal((await validateAlgorithm(source(), 'cancel-adapter')).ok, true);
});

test('Match tracks earlier factories and closes every runner when later creation/initialization fails', async () => {
  for (const mode of ['factory', 'initialize']) {
    let calls = 0;
    const released = [];
    const match = new Match(MAPS[0], [source(), source()], {
      runnerFactory: (context) => {
        const id = calls++;
        if (mode === 'factory' && id === 1) throw new Error('factory probe');
        return {
          initialize: async () => {
            if (id === 1) throw new Error('init probe');
            return { name: 'probe' };
          },
          close: async () => {
            released.push(id);
          },
        };
      },
    });
    await assert.rejects(match.prepare());
    assert.equal(match.prepared, false);
    assert.ok(released.includes(0));
    if (mode === 'initialize') assert.ok(released.includes(1));
  }
  const real = new Match(MAPS[0], [source(), 'module.exports = class {};']);
  await assert.rejects(real.prepare());
  assert.ok(real.runners.every((runner) => runner.state === 'closed' && runner.host.terminated));
  const attempted = [];
  const cleanupFailure = new Match(MAPS[0], [source(), source()], {
    runnerFactory: (context) => ({
      initialize: async () => {
        throw new Error('initialization probe');
      },
      close: async () => {
        attempted.push(context.playerId);
        if (context.playerId === 0) throw new Error('cleanup probe');
      },
    }),
  });
  await assert.rejects(cleanupFailure.prepare(), (error) => error.stage === 'close');
  assert.deepEqual(attempted, [0, 1]);
});
test('Match preparation is single-flight, uses assigned run IDs and stop during preparation reclaims hosts', async () => {
  const gameId = randomUUID(),
    runId = randomUUID();
  const match = new Match(MAPS[0], [source()], {
    gameId,
    participants: [{ language: 'javascript', runId }],
  });
  assert.equal(match.prepare(), match.prepare());
  await match.preparing;
  assert.equal(match.runners[0].info.gameId, gameId);
  assert.equal(match.runners[0].info.runId, runId);
  await match.stop();
  assert.equal(match.runners[0].state, 'closed');
  const stopping = new Match(MAPS[0], [source(), source()]);
  const preparing = stopping.prepare();
  const closed = stopping.stop();
  await assert.rejects(preparing);
  await closed;
  assert.ok(stopping.runners.every((runner) => runner.state === 'closed'));
});
