import { performance } from 'node:perf_hooks';
import { cpus, platform, release, arch, freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { AlgorithmSandbox } from '../backend/node/src/runtime/sandbox.js';
import { PlayerProcess } from '../backend/node/src/runtime/player-process.js';
import { TURN_LIMIT_MS, ALGORITHM_MEMORY_LIMIT_BYTES } from '../backend/node/src/runtime/policy.js';
import {
  assertLegacyMoveResult,
  TIMING_BOUNDARIES,
} from '../backend/node/src/runtime/contracts/validation.js';

// Synthetic local measurement only. Existing children inherit this intentionally minimal
// environment; no .env, user store, HTTP host, credentials or external service is used.
const osEnvironment = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'temp',
  'tmp',
  'home',
  'userprofile',
  'appdata',
  'localappdata',
]);
for (const key of Object.keys(process.env))
  if (!osEnvironment.has(key.toLowerCase())) delete process.env[key];
const quick = process.argv.slice(2).includes('--quick');
if (process.argv.slice(2).some((arg) => arg !== '--quick'))
  throw new Error('Use: node scripts/measure-runner-baseline.js [--quick]');
const rounds = quick ? 1 : 3;
const callsPerRound = quick ? 20 : 200;
const warmupCalls = quick ? 10 : 80;
const root = new URL('../', import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nearestSource = await readFile(
  new URL('backend/node/examples/nearest-coin.js', root),
  'utf8',
);
const quickJsPackage = JSON.parse(
  await readFile(new URL('node_modules/quickjs-emscripten/package.json', root), 'utf8'),
);
const player = (body) => `module.exports = class Player {
 initialize(number, columns, rows) { this.number=number; this.columns=columns; this.rows=rows; this.checksum=0; }
 getName() { return 'baseline'; }
 moveNext(map, position, items) { ${body} }
};`;
const scenarios = [
  {
    id: 'noop',
    source: player('return 2;'),
    description: 'Constant direction; dispatch/conversion overhead reference.',
  },
  {
    id: 'input-read',
    source: player(
      'let sum=position; for(let i=0;i<map.length;i++) sum+=map[i]; for(let i=0;i<items.length;i++) sum+=items[i]; this.checksum=sum; return (sum & 3);',
    ),
    description: 'Read every input cell/item and retain checksum.',
  },
  {
    id: 'nearest-coin',
    source: nearestSource,
    description: 'Existing nearest-coin BFS sample, including its periodic bounded debug output.',
  },
];
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    samples: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
function check(result) {
  assertLegacyMoveResult(result);
  if (result.status !== 'ok')
    throw new Error('Synthetic baseline did not complete normally: ' + result.status);
  return result;
}
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  profile: quick ? 'quick-smoke' : 'baseline',
  implementation: {
    runnerContractVersion: 1,
    paths: ['AlgorithmSandbox.invoke', 'PlayerProcess.move'],
    supportedLanguageMeasured: 'javascript',
    runtimePackage: { name: quickJsPackage.name, version: quickJsPackage.version },
    quickJsNativeVersion: null,
    sourceHashes: Object.fromEntries(
      scenarios.map((scenario) => [scenario.id, hash(scenario.source)]),
    ),
    runtimeSourceHashes: Object.fromEntries(
      await Promise.all(
        ['sandbox.js', 'player-process.js', 'player-worker.js', 'policy.js'].map(async (name) => [
          name,
          hash(await readFile(new URL('backend/node/src/runtime/' + name, root))),
        ]),
      ),
    ),
  },
  environment: {
    node: process.version,
    os: platform(),
    release: release(),
    architecture: arch(),
    cpuModel: cpus()[0]?.model,
    logicalCpus: cpus().length,
    freeMemoryBytesAtStart: freemem(),
  },
  configuration: {
    rounds,
    callsPerRound,
    warmupCalls,
    turnLimitMs: TURN_LIMIT_MS,
    algorithmHeapLimitBytes: ALGORITHM_MEMORY_LIMIT_BYTES,
  },
  boundaries: {
    total:
      'Caller monotonic duration including map/items snapshot copying, adapter call and response; excludes validator and statistics work.',
    execution:
      'Existing QuickJS elapsedMs: guest JSON.parse/dispatch + user method + guest primitive return validation; excludes outer JSON.stringify, IPC and final handle decoding/disposal.',
    executionBoundary: TIMING_BOUNDARIES.quickJsCall,
    roundTrip:
      'Existing PlayerProcess roundTripMs; no direct-path equivalent, reported as null for directQuickJs.',
    outsideExecutionTimer:
      'Observed caller total minus reported execution duration; includes multiple unseparated costs, NOT a precise IPC-only duration.',
    unavailable: { inputPreparationMs: null, responseProcessingMs: null, engineApplyDelayMs: null },
  },
  methodology: {
    simultaneousGames: false,
    httpOrEngineLoop: false,
    modes: ['directQuickJs', 'ipcOnePlayer', 'ipcFourPlayers'],
    batching:
      'Four-player mode measures simultaneous call batches. Its Promise.all is a benchmark harness and is not a game turn scheduling policy.',
    coldAndWarm:
      'Setup durations separate; sample calls warmed up. Rotates mode order by round. No fixed speed thresholds and no artificial waits to equalize languages.',
    limitations:
      'Single local JS runtime; no cross-language or .NET direct hosting measurement. No extraction of unmeasured subsegments; memory/GC/OS scheduling affect results.',
  },
  cases: [],
};

for (const scenario of scenarios)
  for (const [columns, rows] of [
    [12, 10],
    [20, 16],
    [40, 30],
  ]) {
    const map = Array.from({ length: columns * rows }, (_, i) =>
      i % columns === 0 || i % columns === columns - 1 || i < columns || i >= columns * (rows - 1)
        ? -1
        : i % 17 === 0
          ? 10
          : 0,
    );
    const position = columns + 1;
    map[position] = 0;
    const items = [columns + 3, columns * 2 + 3, -1, -1];
    const runners = [];
    let sandbox;
    try {
      let started = performance.now();
      sandbox = await AlgorithmSandbox.create(scenario.source, 0, columns, rows);
      const directPrepareMs = performance.now() - started;
      started = performance.now();
      for (let i = 0; i < 4; i++) runners.push(new PlayerProcess());
      await Promise.all(
        runners.map((runner, i) => runner.initialize(scenario.source, i, columns, rows)),
      );
      const fourPlayerPrepareMs = performance.now() - started;
      for (let i = 0; i < warmupCalls; i++) {
        check(sandbox.invoke('moveNext', [[...map], position, [...items]]));
        await Promise.all(
          runners.map((runner) => runner.move([...map], position, [...items]).then(check)),
        );
      }
      const samples = Object.fromEntries(
        ['directQuickJs', 'ipcOnePlayer', 'ipcFourPlayers'].map((mode) => [mode, []]),
      );
      for (let round = 0; round < rounds; round++) {
        const modes = Object.keys(samples);
        const order = [...modes.slice(round), ...modes.slice(0, round)];
        for (const mode of order)
          for (let call = 0; call < callsPerRound; call++) {
            if (mode === 'directQuickJs') {
              const before = performance.now();
              const result = sandbox.invoke('moveNext', [[...map], position, [...items]]);
              const totalMs = performance.now() - before;
              check(result);
              samples[mode].push({ totalMs, executionMs: result.elapsedMs, roundTripMs: null });
            } else {
              const active = mode === 'ipcOnePlayer' ? runners.slice(0, 1) : runners;
              await Promise.all(
                active.map(async (runner) => {
                  const before = performance.now();
                  const result = await runner.move([...map], position, [...items]);
                  const totalMs = performance.now() - before;
                  check(result);
                  if (result.pid !== runner.pid)
                    throw new Error('Player PID changed during baseline');
                  samples[mode].push({
                    totalMs,
                    executionMs: result.elapsedMs,
                    roundTripMs: result.roundTripMs,
                  });
                }),
              );
            }
          }
        await new Promise((resolveYield) => setImmediate(resolveYield));
      }
      report.cases.push({
        scenario: scenario.id,
        description: scenario.description,
        columns,
        rows,
        cells: map.length,
        payloadJsonBytes: Buffer.byteLength(JSON.stringify({ map, position, items })),
        preparation: { directMs: directPrepareMs, fourPlayersParallelMs: fourPlayerPrepareMs },
        modes: Object.fromEntries(
          Object.entries(samples).map(([mode, values]) => [
            mode,
            {
              total: stats(values.map((value) => value.totalMs)),
              execution: stats(values.map((value) => value.executionMs)),
              outsideExecutionTimer: stats(
                values.map((value) => value.totalMs - value.executionMs),
              ),
              roundTrip:
                mode === 'directQuickJs' ? null : stats(values.map((value) => value.roundTripMs)),
            },
          ]),
        ),
      });
      console.log(
        `PASS baseline ${scenario.id} ${columns}x${rows}, 3 modes; instances retained across all sample calls.`,
      );
    } finally {
      sandbox?.dispose();
      await Promise.all(runners.map((runner) => runner.close()));
    }
  }
await mkdir(new URL('artifacts/', root), { recursive: true });
const output = new URL('artifacts/runner-js-baseline.json', root);
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log('Report: artifacts/runner-js-baseline.json');
