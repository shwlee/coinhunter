import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateArtifacts } from '../backend/node/src/runtime/csharp-artifacts.js';
import {
  createJavaScriptRegistry,
  createCSharpCandidateRegistry,
} from '../backend/node/src/runtime/runner-registry.js';
import {
  RunnerFault,
  RunnerContractError,
} from '../backend/node/src/runtime/contracts/validation.js';

async function fixture(
  handler = () => undefined,
  experimentalGcWindow = false,
  gcEntryCollection = false,
) {
  const sockets = new Set();
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\coinhunter-test-${randomUUID()}`
      : join(tmpdir(), `coinhunter-test-${randomUUID()}`);
  const context = {
    contractVersion: 1,
    gameId: randomUUID(),
    playerId: 0,
    runId: randomUUID(),
    language: 'csharp',
    limits: { turnMs: 500, algorithmMemoryBytes: null },
  };
  const source = { sourceKey: randomUUID(), sha256: 'a'.repeat(64), byteLength: 20 };
  const artifactId = randomUUID();
  const descriptor = {
    gameId: context.gameId,
    playerId: context.playerId,
    runId: context.runId,
    endpoint,
    turnEndpoint: endpoint + '-turns',
    token: 'd'.repeat(64),
    experimentalGcWindow,
    gcEntryCollection,
    artifact: {
      contractVersion: 1,
      artifactId,
      language: 'csharp',
      source,
      content: { artifactKey: artifactId, sha256: 'b'.repeat(64), byteLength: 50 },
      format: 'dotnet-assembly',
      profileId: 'csharp-restricted-c1-v4',
      toolchain: { name: 'roslyn', version: 'c'.repeat(64) },
      runtime: { name: 'dotnet-csharp-restricted', version: 'test' },
      adapterVersion: 'csharp-direct-pipe-v2',
      target: { os: process.platform, architecture: process.arch },
      optionsHash: 'c'.repeat(64),
    },
  };
  const info = {
    contractVersion: 1,
    gameId: context.gameId,
    playerId: 0,
    runId: context.runId,
    instanceId: randomUUID(),
    hostId: randomUUID(),
    language: 'csharp',
    name: 'pipe-test',
    runtime: descriptor.artifact.runtime,
    adapterVersion: 'csharp-direct-pipe-v2',
  };
  const requests = [];
  const serve = (channel) => (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0);
        const command = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        requests.push({ ...command, channel });
        assert.equal(command.method === 'move' ? 'turn' : 'lifecycle', channel);
        let result =
          command.method === 'initialize'
            ? info
            : command.method === 'close'
              ? { contractVersion: 1, runId: context.runId, resourcesReleased: true }
              : {
                  status: 'ok',
                  direction: 2,
                  instanceId: info.instanceId,
                  hostId: info.hostId,
                  executionMs: 1,
                  executionSettled: true,
                  inputPreparationMs: 0.1,
                  logs: [],
                  droppedLogs: 0,
                };
        const override = handler(command, result, socket);
        if (override === false) continue;
        if (override !== undefined) result = override;
        const bytes = Buffer.from(JSON.stringify({ version: 1, id: command.id, ok: true, result }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(bytes.length);
        // Exercise fragmented headers/body, not just one write per frame.
        socket.write(header.subarray(0, 1));
        socket.write(Buffer.concat([header.subarray(1), bytes]));
      }
    });
  };
  const server = net.createServer(serve('lifecycle'));
  const turnServer = net.createServer(serve('turn'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  await new Promise((resolve, reject) => {
    turnServer.once('error', reject);
    turnServer.listen(descriptor.turnEndpoint, resolve);
  });
  const artifacts = new CandidateArtifacts();
  context.artifact = await artifacts.register({ csharp: descriptor }, source, 'csharp');
  const registry = createCSharpCandidateRegistry({
    javascript: { resolveArtifact: artifacts.javascript.resolve },
    csharp: { resolveArtifact: artifacts.resolveCSharp },
  });
  const runner = registry.create(context);
  return {
    context,
    descriptor,
    runner,
    registry,
    artifacts,
    requests,
    initialize: () => runner.initialize({ playerNumber: 0, columns: 6, rows: 6 }),
    move: (callId) =>
      runner.move({
        contractVersion: 1,
        gameId: context.gameId,
        playerId: 0,
        runId: context.runId,
        callId,
        map: Array(36).fill(0),
        myPosition: 0,
        items: [-1, -1, -1, -1],
      }),
    cleanup: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => turnServer.close(resolve));
    },
  };
}

test('C# candidate preserves default JS registry and binds source/artifact/run before connecting', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(createJavaScriptRegistry().supportedLanguages, ['javascript']);
    assert.throws(() => createJavaScriptRegistry().create(f.context), RunnerFault);
    assert.throws(() => f.registry.create({ ...f.context, runId: randomUUID() }), RunnerFault);
    assert.throws(
      () =>
        f.registry.create({
          ...f.context,
          artifact: { ...f.context.artifact, optionsHash: 'f'.repeat(64) },
        }),
      RunnerFault,
    );
    await assert.rejects(
      f.artifacts.register(
        { csharp: f.descriptor },
        { ...f.descriptor.artifact.source, sha256: 'f'.repeat(64) },
        'csharp',
      ),
      RunnerFault,
    );
    assert.equal(f.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('C# pipe fragments, settled timeout and next call preserve instance and timing boundary', async () => {
  const f = await fixture((command, result) =>
    command.method === 'move' && command.input.callId === 1
      ? { ...result, status: 'timeout', direction: -1, executionMs: 501 }
      : undefined,
  );
  try {
    const info = await f.initialize();
    const timeout = await f.move(1);
    const next = await f.move(2);
    assert.equal(timeout.status, 'timeout');
    assert.equal(timeout.completion, 'interrupted');
    assert.equal(next.direction, 2);
    assert.equal(next.instanceId, info.instanceId);
    assert.equal(next.timings.executionBoundary, 'dotnet-guarded-call-v1');
    assert.ok(next.timings.roundTripMs >= 0);
    await f.runner.close();
    assert.equal(f.runner.state, 'closed');
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['initialize', 'move', 'move', 'close'],
    );
    assert.deepEqual(
      f.requests.map((r) => r.channel),
      ['lifecycle', 'turn', 'turn', 'lifecycle'],
    );
    assert.ok(
      f.requests.every(
        (r) =>
          r.gameId === f.context.gameId &&
          r.runId === f.context.runId &&
          r.artifactId === f.context.artifact.artifactId &&
          r.token === f.descriptor.token,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test('C# rejects wrong host/instance result and duplicate calls without reusable state', async () => {
  const f = await fixture((command, result) =>
    command.method === 'move' ? { ...result, instanceId: randomUUID() } : undefined,
  );
  try {
    await f.initialize();
    await assert.rejects(f.move(1), RunnerFault);
    assert.equal(f.runner.state, 'failed');
    await assert.rejects(f.move(2), RunnerContractError);
    await f.runner.close();
  } finally {
    await f.cleanup();
  }
});

test('C# close interrupts a pending caller only after confirmed private close receipt', async () => {
  const f = await fixture((command) => (command.method === 'move' ? false : undefined));
  try {
    await f.initialize();
    const pending = assert.rejects(f.move(1), RunnerFault);
    await assert.rejects(f.move(2), RunnerContractError);
    const receipt = await f.runner.close();
    await pending;
    assert.equal(receipt.resourcesReleased, true);
    assert.equal(f.runner.state, 'closed');
  } finally {
    await f.cleanup();
  }
});

const observedMemory = {
  status: 'completed',
  requestedReservationBytes: 268435456,
  workerAllocationLimitBytes: 33554432,
  workerAllocatedBytes: 1000,
  entryMs: 0.2,
  exitMs: 0.1,
  collectionDeltas: [0, 0, 0],
  regionIntact: true,
  processAllocationLimitBytes: 67108864,
  processAllocatedBytes: 2000,
  entry: {
    policy: 'fail-fast-v1',
    attempts: 1,
    collectionDeltas: [0, 0, 0],
    before: null,
    after: null,
  },
};
test('GC observations are validated without extra successful-turn IPC', async () => {
  const f = await fixture(
    (command, result) =>
      command.method === 'move' ? { ...result, experimentalMemory: observedMemory } : undefined,
    true,
  );
  try {
    await f.initialize();
    await f.move(1);
    assert.deepEqual(f.runner.lastObservation, observedMemory);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['initialize', 'move'],
    );
    await f.runner.close();
  } finally {
    await f.cleanup();
  }
});
test('GC candidate rejects lost regions, malformed counters and missing observations', async () => {
  for (const memory of [
    undefined,
    { ...observedMemory, regionIntact: false },
    { ...observedMemory, collectionDeltas: [1, 0, 0] },
    { ...observedMemory, processAllocatedBytes: 67108865 },
    { ...observedMemory, workerAllocatedBytes: -1 },
    { ...observedMemory, exitMs: Infinity },
  ]) {
    const f = await fixture(
      (command, result) =>
        command.method === 'move' ? { ...result, experimentalMemory: memory } : undefined,
      true,
    );
    try {
      await f.initialize();
      await assert.rejects(f.move(1), (e) => e.code === 'protocol-error');
      await f.runner.close();
    } finally {
      await f.cleanup();
    }
  }
});

test('GC v2 validates entry recovery, heap snapshots and failed partial observations', async () => {
  const heap = {
    managedBytes: 135520000,
    heapSizeBytes: 135530000,
    fragmentedBytes: 10000,
    committedBytes: 135570000,
    availableBytes: 603979776,
  };
  const entry = {
    policy: 'decommit-once-v2',
    attempts: 2,
    collectionDeltas: [3, 3, 3],
    before: { ...heap, managedBytes: 304000000 },
    after: heap,
  };
  const memory = { ...observedMemory, entry };
  const f = await fixture(
    (command, result) =>
      command.method === 'move' ? { ...result, experimentalMemory: memory } : undefined,
    true,
    true,
  );
  try {
    await f.initialize();
    const result = await f.move(1);
    assert.equal(result.status, 'ok');
    assert.deepEqual(f.runner.lastObservation, memory);
    assert.equal(f.runner.observationPolicy, 'csharp-gc-window-v2');
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ['initialize', 'move'],
    );
    await f.runner.close();
  } finally {
    await f.cleanup();
  }
  for (const invalid of [
    { ...entry, attempts: 3 },
    { ...entry, after: null },
    { ...entry, before: { ...heap, managedBytes: -1 } },
    { ...entry, policy: 'fail-fast-v1' },
  ]) {
    const bad = await fixture(
      (command, result) =>
        command.method === 'move'
          ? { ...result, experimentalMemory: { ...memory, entry: invalid } }
          : undefined,
      true,
      true,
    );
    try {
      await bad.initialize();
      await assert.rejects(bad.move(1), (e) => e.code === 'protocol-error');
      await bad.runner.close();
    } finally {
      await bad.cleanup();
    }
  }
  const failed = await fixture(
    (command, result, socket) => {
      if (command.method === 'move') {
        socket.destroy();
        return false;
      }
      if (command.method === 'failure')
        return {
          infrastructureFailure: 'gc-call-environment-failure',
          gcEntry: { ...entry, after: null },
        };
    },
    true,
    true,
  );
  try {
    await failed.initialize();
    await assert.rejects(
      failed.move(1),
      (e) => e.infrastructureFailure === 'gc-call-environment-failure' && e.gcEntry.after === null,
    );
    await failed.runner.close();
  } finally {
    await failed.cleanup();
  }
});
test('GC transport failure recovers only whitelisted infrastructure reasons from lifecycle owner', async () => {
  for (const reason of [
    'gc-reservation-unavailable',
    'gc-host-allocation-budget',
    'unexpected-user-text',
  ]) {
    const f = await fixture((command, result, socket) => {
      if (command.method === 'move') {
        socket.destroy();
        return false;
      }
      if (command.method === 'failure')
        return { infrastructureFailure: reason, gcEntry: observedMemory.entry };
    }, true);
    try {
      await f.initialize();
      await assert.rejects(f.move(1), (e) => {
        assert.equal(e.code, 'host-exited');
        assert.equal(e.userStatus, undefined);
        assert.equal(e.infrastructureFailure, reason.startsWith('gc-') ? reason : undefined);
        return true;
      });
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ['initialize', 'move', 'failure'],
      );
      await f.runner.close();
    } finally {
      await f.cleanup();
    }
  }
});

test('C# disconnect never becomes a fabricated clean close', async () => {
  const f = await fixture((command, result, socket) => {
    if (command.method === 'close') {
      socket.end();
      return false;
    }
  });
  try {
    await f.initialize();
    await assert.rejects(f.runner.close(), RunnerFault);
    assert.notEqual(f.runner.state, 'closed');
  } finally {
    await f.cleanup();
  }
});
