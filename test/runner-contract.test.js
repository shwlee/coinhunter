import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RunnerLifecycle } from '../backend/node/src/runtime/contracts/lifecycle.js';
import {
  RunnerContractError,
  RunnerFault,
  RUNNER_TURN_LIMIT_MS,
  TIMING_BOUNDARIES,
  assertPreparedArtifact,
  assertPreparationRequest,
  assertRunnerContext,
  assertMoveRequest,
  assertMoveResult,
  assertCallTimings,
  assertLegacyMoveResult,
  assertPreparationResult,
  CANDIDATE_LANGUAGE_IDS,
  RUNNER_STATES,
  MOVE_STATUSES,
  LOG_LIMITS,
  RUNNER_FAULT_CODES,
  RUNNER_FAULT_STAGES,
} from '../backend/node/src/runtime/contracts/validation.js';
import { PlayerProcess } from '../backend/node/src/runtime/player-process.js';
import { TURN_LIMIT_MS, ALGORITHM_MEMORY_LIMIT_BYTES } from '../backend/node/src/runtime/policy.js';
import { GameState } from '../backend/node/src/game/state.js';
import { DEFAULT_MAP_SETTINGS } from '../backend/node/src/game/maps.js';

function fixtures() {
  const artifact = {
    contractVersion: 1,
    artifactId: randomUUID(),
    language: 'javascript',
    source: { sourceKey: randomUUID(), sha256: 'a'.repeat(64), byteLength: 100 },
    content: { artifactKey: randomUUID(), sha256: 'a'.repeat(64), byteLength: 100 },
    format: 'javascript-source',
    profileId: 'default-js',
    toolchain: { name: 'source-reference', version: '1' },
    runtime: { name: 'quickjs-emscripten', version: 'test-runtime' },
    adapterVersion: 'test-adapter',
    target: { os: 'test-os', architecture: 'test-arch' },
    optionsHash: 'b'.repeat(64),
  };
  const context = {
    contractVersion: 1,
    gameId: randomUUID(),
    playerId: 0,
    runId: randomUUID(),
    language: 'javascript',
    artifact,
    limits: { turnMs: 500, algorithmMemoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES },
  };
  const initialization = { playerNumber: 0, columns: 4, rows: 4 };
  const info = {
    contractVersion: 1,
    gameId: context.gameId,
    playerId: 0,
    runId: context.runId,
    instanceId: randomUUID(),
    hostId: randomUUID(),
    language: 'javascript',
    name: 'test',
    runtime: { ...artifact.runtime },
    adapterVersion: artifact.adapterVersion,
  };
  const request = (callId) => ({
    contractVersion: 1,
    gameId: context.gameId,
    playerId: 0,
    runId: context.runId,
    callId,
    map: Array(16).fill(0),
    myPosition: 0,
    items: [-1, -1, -1, -1],
  });
  const result = (callId, status = 'ok') => ({
    contractVersion: 1,
    gameId: context.gameId,
    playerId: 0,
    runId: context.runId,
    instanceId: info.instanceId,
    callId,
    status,
    direction: status === 'ok' ? 2 : -1,
    completion: status === 'timeout' ? 'interrupted' : 'returned',
    logs: [],
    droppedLogs: 0,
    timings: {
      executionMs: status === 'timeout' ? 500.5 : 0.2,
      executionBoundary: TIMING_BOUNDARIES.quickJsCall,
      roundTripMs: null,
      inputPreparationMs: null,
      responseProcessingMs: null,
      engineApplyDelayMs: null,
    },
  });
  return {
    artifact,
    context,
    initialization,
    info,
    request,
    result,
    receipt: { contractVersion: 1, runId: context.runId, resourcesReleased: true },
  };
}
function ready(fixture) {
  const lifecycle = new RunnerLifecycle(fixture.context);
  lifecycle.beginInitialize(fixture.initialization);
  lifecycle.completeInitialize(fixture.info);
  return lifecycle;
}

test('language-neutral manifest and JS policy/validation boundaries agree', async () => {
  const spec = JSON.parse(
    await readFile(
      new URL('../backend/contracts/runner-contract-v1.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(spec.candidateLanguages, CANDIDATE_LANGUAGE_IDS);
  assert.deepEqual(spec.states, RUNNER_STATES);
  assert.deepEqual(spec.moveStatuses, MOVE_STATUSES);
  assert.equal(spec.limits.turnMs, TURN_LIMIT_MS);
  assert.equal(spec.limits.debugLines, LOG_LIMITS.lines);
  assert.equal(spec.limits.debugLineCharacters, LOG_LIMITS.lineCharacters);
  assert.equal(spec.timings.existingJavascriptBoundary, TIMING_BOUNDARIES.quickJsCall);
  assert.equal(spec.timings.unmeasured, null);
  assert.deepEqual(spec.infrastructureFaultCodes, RUNNER_FAULT_CODES);
  assert.deepEqual(spec.infrastructureFaultStages, RUNNER_FAULT_STAGES);
  const state = new GameState(
    { columns: 4, rows: 4, tiles: Array(16).fill(0), settings: DEFAULT_MAP_SETTINGS },
    ['contract'],
  );
  assert.equal(state.neighbor(5, spec.directions.left), 4);
  assert.equal(state.neighbor(5, spec.directions.up), 1);
  assert.equal(state.neighbor(5, spec.directions.right), 6);
  assert.equal(state.neighbor(5, spec.directions.down), 9);
  assert.equal(spec.directions.stay, -1);
});

test('prepared artifact is bound to requested language, exact source and approved profile', () => {
  const f = fixtures();
  const request = {
    contractVersion: 1,
    requestId: randomUUID(),
    language: 'javascript',
    source: f.artifact.source,
    profileId: 'default-js',
  };
  assertPreparationResult(f.artifact, request);
  for (const changed of [
    { ...f.artifact, profileId: 'other-profile' },
    { ...f.artifact, language: 'python' },
    { ...f.artifact, source: { ...f.artifact.source, sourceKey: randomUUID() } },
    { ...f.artifact, source: { ...f.artifact.source, sha256: 'c'.repeat(64) } },
    { ...f.artifact, source: { ...f.artifact.source, byteLength: 101 } },
  ])
    assert.throws(() => assertPreparationResult(changed, request), RunnerContractError);
});

test('contract separates file references and preparation profiles from runner state and credentials', () => {
  const f = fixtures();
  assert.equal(RUNNER_TURN_LIMIT_MS, TURN_LIMIT_MS);
  assertPreparedArtifact(f.artifact);
  assertRunnerContext(f.context);
  assertPreparationRequest({
    contractVersion: 1,
    requestId: randomUUID(),
    language: 'javascript',
    source: f.artifact.source,
    profileId: 'default-js',
  });
  for (const field of ['source', 'path', 'command', 'apiKey'])
    assert.throws(
      () =>
        assertPreparedArtifact({
          ...f.artifact,
          [field]: field === 'source' ? 'raw code' : 'do-not-echo',
        }),
      RunnerContractError,
    );
  assert.throws(
    () => assertRunnerContext({ ...f.context, language: 'python' }),
    RunnerContractError,
  );
  assert.throws(
    () => assertRunnerContext({ ...f.context, limits: { ...f.context.limits, turnMs: 1000 } }),
    RunnerContractError,
  );
  assertPreparedArtifact({
    ...f.artifact,
    source: { ...f.artifact.source, byteLength: 8 * 1024 * 1024 * 1024 },
  });
});

test('snapshot validation rejects wrong run, replay, invalid arrays and aliases without mutating inputs', () => {
  const f = fixtures();
  const request = f.request(1);
  const copy = structuredClone(request);
  assertMoveRequest(request, f.context, f.initialization);
  assert.deepEqual(request, copy);
  for (const input of [
    { ...request, runId: randomUUID() },
    { ...request, gameId: randomUUID() },
    { ...request, playerId: 1 },
    { ...request, myPosition: 16 },
    { ...request, map: [0] },
    { ...request, items: [1, 1, -1, -1] },
    { ...request, items: [16, -1, -1, -1] },
    { ...request, map: Array(16) },
  ])
    assert.throws(() => assertMoveRequest(input, f.context, f.initialization), RunnerContractError);
  assert.throws(
    () => assertMoveRequest(request, f.context, f.initialization, 1),
    RunnerContractError,
  );
  assert.throws(
    () => assertMoveRequest(f.request(2), f.context, f.initialization),
    RunnerContractError,
  );
});

test('validator rejects unknown fields and accessors without reading their values or echoing input', () => {
  const f = fixtures();
  let called = false;
  Object.defineProperty(f.context, 'gameId', {
    get() {
      called = true;
      throw new Error('secret');
    },
    enumerable: true,
  });
  assert.throws(
    () => assertRunnerContext(f.context),
    (error) => error instanceof RunnerContractError && !error.message.includes('secret'),
  );
  assert.equal(called, false);
  const arrays = fixtures();
  const request = arrays.request(1);
  Object.defineProperty(request.map, '0', {
    get() {
      called = true;
      return 0;
    },
    enumerable: true,
  });
  assert.throws(
    () => assertMoveRequest(request, arrays.context, arrays.initialization),
    RunnerContractError,
  );
  assert.equal(called, false);
});

test('current-turn outcomes distinguish voluntary -1, timeout, exception and invalid return', () => {
  const f = fixtures();
  assertMoveResult({ ...f.result(1), direction: -1 }, f.info, 1);
  for (const status of ['timeout', 'exception', 'invalid-result'])
    assertMoveResult(f.result(1, status), f.info, 1);
  for (const result of [
    { ...f.result(1, 'timeout'), completion: 'returned' },
    { ...f.result(1, 'exception'), direction: 2 },
    { ...f.result(1), status: 'memory-limit' },
    { ...f.result(1), callId: 2 },
    { ...f.result(1), instanceId: randomUUID() },
    { ...f.result(1), direction: 1.5 },
  ])
    assert.throws(() => assertMoveResult(result, f.info, 1), RunnerContractError);
});

test('unknown timing is null, finite per-call budget and bounded debug data are enforced', () => {
  const f = fixtures();
  const valid = f.result(1);
  assertCallTimings(valid.timings);
  for (const value of [NaN, Infinity, -1, undefined])
    assert.throws(
      () => assertCallTimings({ ...valid.timings, roundTripMs: value }),
      RunnerContractError,
    );
  assert.throws(
    () =>
      assertMoveResult({ ...valid, timings: { ...valid.timings, executionMs: 501 } }, f.info, 1),
    RunnerContractError,
  );
  const timeout = f.result(1, 'timeout');
  assert.throws(
    () =>
      assertMoveResult({ ...timeout, timings: { ...timeout.timings, executionMs: 0 } }, f.info, 1),
    RunnerContractError,
  );
  assert.throws(
    () => assertMoveResult({ ...valid, logs: Array(31).fill('x') }, f.info, 1),
    RunnerContractError,
  );
  assert.throws(
    () => assertMoveResult({ ...valid, logs: ['x'.repeat(1025)] }, f.info, 1),
    RunnerContractError,
  );
  assert.throws(
    () => assertMoveResult({ ...valid, droppedLogs: -1 }, f.info, 1),
    RunnerContractError,
  );
});

test('lifecycle prevents overlap, stale replies and implicit readiness after cancellation', () => {
  const f = fixtures();
  const lifecycle = ready(f);
  lifecycle.beginMove(f.request(1));
  assert.throws(() => lifecycle.beginMove(f.request(2)), RunnerContractError);
  assert.throws(
    () => lifecycle.completeMove({ ...f.result(1), instanceId: randomUUID() }),
    RunnerContractError,
  );
  assert.equal(lifecycle.state, 'computing');
  assert.equal(lifecycle.activeCallId, 1);
  lifecycle.completeMove(f.result(1, 'timeout'));
  assert.equal(lifecycle.state, 'ready');
  assert.throws(() => lifecycle.beginMove(f.request(1)), RunnerContractError);
  lifecycle.beginMove(f.request(2));
  assert.equal(lifecycle.beginClose(), true);
  assert.equal(lifecycle.beginClose(), false);
  assert.throws(() => lifecycle.beginMove(f.request(3)), RunnerContractError);
  lifecycle.completeMove(f.result(2));
  assert.equal(lifecycle.state, 'closing');
  assert.throws(
    () => lifecycle.confirmClosed({ ...f.receipt, resourcesReleased: false }),
    RunnerContractError,
  );
  lifecycle.confirmClosed(f.receipt);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(lifecycle.beginClose(), false);
});

test('failed initialization and close during initialization cannot resume a fresh player', () => {
  const f = fixtures();
  const lifecycle = new RunnerLifecycle(f.context);
  lifecycle.beginInitialize(f.initialization);
  lifecycle.fail(new RunnerFault('initialization-failed', 'initialize'));
  assert.equal(lifecycle.state, 'failed');
  assert.throws(() => lifecycle.beginInitialize(f.initialization), RunnerContractError);
  lifecycle.beginClose();
  lifecycle.confirmClosed(f.receipt);
  const cancelled = new RunnerLifecycle(f.context);
  cancelled.beginInitialize(f.initialization);
  cancelled.beginClose();
  cancelled.completeInitialize(f.info);
  assert.equal(cancelled.state, 'closing');
  cancelled.confirmClosed(f.receipt);
});

test('infrastructure failure cannot manufacture -1 success or release a still active call', () => {
  const f = fixtures();
  const lifecycle = ready(f);
  lifecycle.beginMove(f.request(1));
  lifecycle.fail(new RunnerFault('host-exited', 'move'));
  assert.equal(lifecycle.state, 'failed');
  assert.equal(lifecycle.activeCallId, 1);
  assert.throws(() => lifecycle.beginMove(f.request(2)), RunnerContractError);
  lifecycle.beginClose();
  lifecycle.confirmClosed(f.receipt);
  assert.equal(lifecycle.activeCallId, null);
  assert.throws(() => new RunnerFault('raw-private-error-text', 'move'), RunnerContractError);
});

test('lifecycle owns frozen metadata copies; caller mutations cannot change the bound run', () => {
  const f = fixtures();
  const lifecycle = ready(f);
  const original = lifecycle.context.runId;
  f.context.runId = randomUUID();
  f.info.instanceId = randomUUID();
  assert.equal(lifecycle.context.runId, original);
  assert.notEqual(lifecycle.info.instanceId, f.info.instanceId);
  assert.throws(() => {
    lifecycle.context.artifact.source.sha256 = 'changed';
  }, TypeError);
});

test(
  'real current JS results satisfy legacy mapping and preserve PID/state through interruption',
  { timeout: 10000 },
  async () => {
    const runner = new PlayerProcess();
    try {
      await runner.initialize(
        `module.exports = class { initialize(){this.calls=0;} getName(){return 'contract-probe';} moveNext(){this.calls++;if(this.calls===2){this.saved=3;while(true){}} return this.calls===3?this.saved:-1;} }`,
        0,
        4,
        4,
      );
      const inputs = [Array(16).fill(0), 0, [-1, -1, -1, -1]];
      const first = assertLegacyMoveResult(await runner.move(...inputs));
      const timeout = assertLegacyMoveResult(await runner.move(...inputs));
      const next = assertLegacyMoveResult(await runner.move(...inputs));
      assert.equal(first.status, 'ok');
      assert.equal(first.value, -1);
      assert.equal(timeout.status, 'timeout');
      assert.equal(next.value, 3);
      assert.equal(first.pid, timeout.pid);
      assert.equal(first.pid, next.pid);
      assert.ok(next.roundTripMs >= 0);
      assert.equal(first.instanceId, next.instanceId);
      assert.equal(timeout.instanceId, next.instanceId);
      assert.equal(first.hostId, next.hostId);
    } finally {
      await runner.close();
    }
  },
);
