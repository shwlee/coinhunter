import { createInterface } from 'node:readline';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from '../backend/node/src/runtime/policy.js';
import { performance } from 'node:perf_hooks';
import { CandidateArtifacts } from '../backend/node/src/runtime/csharp-artifacts.js';
import { createCSharpCandidateRegistry } from '../backend/node/src/runtime/runner-registry.js';

// Invoked only by the isolated .NET check. Credentials arrive on stdin and are
// never written to the report. This exercises the actual production adapters.
const input = createInterface({ input: process.stdin });
const config = await new Promise((resolve) =>
  input.once('line', (line) => resolve(JSON.parse(line))),
);
input.close();
const artifacts = new CandidateArtifacts();
const registry = createCSharpCandidateRegistry({
  javascript: { resolveArtifact: artifacts.javascript.resolve },
  csharp: { resolveArtifact: artifacts.resolveCSharp },
});
const runners = [];
const samples = [];
try {
  for (const player of config.players) {
    const artifact = await artifacts.register(
      player.language === 'csharp' ? { csharp: player.descriptor } : config.javascript,
      player.source,
      player.language,
    );
    const runner = registry.create({
      contractVersion: 1,
      gameId: config.gameId,
      playerId: player.id,
      runId: player.runId,
      language: player.language,
      artifact,
      limits: {
        turnMs: 500,
        algorithmMemoryBytes: player.language === 'csharp' ? null : ALGORITHM_MEMORY_LIMIT_BYTES,
      },
    });
    runners.push(runner);
    await runner.initialize({
      playerNumber: player.id,
      columns: config.columns,
      rows: config.rows,
    });
  }
  const map = Array(config.columns * config.rows).fill(0);
  // Only the opposite corner has a coin: BFS visits the whole board.
  map[map.length - 1] = 500;
  const invoke = async (runner, index, count, mode) => {
    for (let n = 0; n < count; n++) {
      const before = performance.now();
      const result = await runner.move({
        contractVersion: 1,
        gameId: config.gameId,
        playerId: index,
        runId: config.players[index].runId,
        callId: ++config.players[index].call,
        map,
        myPosition: n % 2, // Every language receives the identical position sequence.
        items: [-1, -1, -1, -1],
      });
      const observedMs = performance.now() - before;
      if (result.status !== 'ok' || result.direction !== 2)
        throw new Error('Identical BFS returned an unexpected direction/status.');
      samples.push({
        language: runner.context.language,
        player: index,
        call: result.callId,
        mode,
        executionMs: result.timings.executionMs,
        roundTripMs: result.timings.roundTripMs,
        inputPreparationMs: result.timings.inputPreparationMs,
        responseProcessingMs: result.timings.responseProcessingMs,
        adapterAndValidationMs: Math.max(0, observedMs - result.timings.roundTripMs),
        transportAndHostMs: Math.max(0, result.timings.roundTripMs - result.timings.executionMs),
      });
    }
  };
  // First calls remain in the report; no retries or averages hide an overrun.
  for (let i = 0; i < runners.length; i++) await invoke(runners[i], i, 100, 'serial');
  // Independent streams: no per-call barrier and no game scheduling changes.
  await Promise.all(runners.map((runner, i) => invoke(runner, i, 200, 'concurrent')));
} finally {
  const results = await Promise.allSettled(runners.map((r) => r.close()));
  artifacts.clear();
  if (results.some((r) => r.status === 'rejected'))
    throw new Error('Benchmark runner cleanup failed.');
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summaries = [];
for (const language of ['javascript', 'csharp']) {
  for (const mode of ['serial', 'concurrent']) {
    const group = samples.filter((s) => s.language === language && s.mode === mode);
    const metrics = {};
    for (const field of [
      'executionMs',
      'roundTripMs',
      'transportAndHostMs',
      'adapterAndValidationMs',
    ])
      metrics[field] = {
        p50: percentile(
          group.map((s) => s[field]),
          0.5,
        ),
        p95: percentile(
          group.map((s) => s[field]),
          0.95,
        ),
        max: Math.max(...group.map((s) => s[field])),
      };
    summaries.push({ language, mode, count: group.length, metrics });
  }
}
process.stdout.write(
  JSON.stringify({
    columns: config.columns,
    rows: config.rows,
    roles: config.players.map((p) => p.language),
    timing: 'actual-runtime-call plus separate transport; first calls included',
    summaries,
    samples,
  }),
);
