import { performance } from 'node:perf_hooks';
import { cpus, platform, release, freemem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { AlgorithmSandbox } from '../src/runtime/sandbox.js';
import { PlayerProcess } from '../src/runtime/player-process.js';

// Local synthetic measurement only. Does not start an HTTP server or read user data.
// Both paths use the same QuickJS implementation, source and map copies.
const source = `module.exports = class Player {
  initialize(number, columns, rows) { this.number = number; }
  getName() { return 'overhead-probe'; }
  moveNext(map, position, items) { return 2; }
};`;
const rounds = 3;
const callsPerRound = 400;
const warmupCalls = 120;
const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1),
  };
}
function check(result) {
  if (result.status !== 'ok' || result.value !== 2) throw new Error('Unexpected probe result');
}
const report = {
  purpose: 'Same QuickJS in-process invocation versus existing child-process IPC wrapper',
  limitations: [
    'Not a .NET direct-hosting benchmark or a comparison between algorithm languages.',
    'No-op algorithm, no debug output, warmed instances; preparation is excluded.',
    'IPC minus direct is an observed difference between these configurations, not pure IPC cost.',
    'Guest elapsedMs includes QuickJS dispatch and JSON.parse; it is not pure user-function time.',
    'No running Match, 20ms engine tick, HTTP/SSE, log writer or loaded-service benchmark.',
    'Uncontrolled Windows desktop environment; not a throughput or hard-real-time guarantee.',
  ],
  environment: {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: platform(),
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    freeMemoryBytesAtStart: freemem(),
  },
  rounds,
  callsPerRound,
  warmupCalls,
  cases: [],
};
for (const [columns, rows] of [
  [12, 10],
  [20, 16],
  [40, 30],
]) {
  const map = Array.from({ length: columns * rows }, (_, i) =>
    i % columns === 0 || i % columns === columns - 1 || i < columns || i >= columns * (rows - 1)
      ? -1
      : i % 5 === 0
        ? 10
        : 0,
  );
  const position = columns + 1;
  const items = [columns + 3, columns * 2 + 3, -1, -1];
  const runners = [];
  let sandbox;
  try {
    sandbox = await AlgorithmSandbox.create(source, 0, columns, rows);
    for (let i = 0; i < 4; i++) runners.push(new PlayerProcess());
    await Promise.all(runners.map((runner, i) => runner.initialize(source, i, columns, rows)));
    for (let i = 0; i < warmupCalls; i++) {
      check(sandbox.invoke('moveNext', [[...map], position, [...items]]));
      await Promise.all(
        runners.map((runner) => runner.move([...map], position, [...items]).then(check)),
      );
    }
    const samples = Object.fromEntries(
      ['directQuickJs', 'ipcOnePlayer', 'ipcFourPlayers'].map((key) => [key, []]),
    );
    for (let round = 0; round < rounds; round++) {
      // Rotate scenario order to avoid always placing a mode before/after a GC or warmup phase.
      const modes = Object.keys(samples);
      const order = [...modes.slice(round), ...modes.slice(0, round)];
      for (const mode of order) {
        for (let i = 0; i < callsPerRound; i++) {
          if (mode === 'directQuickJs') {
            const start = performance.now();
            const result = sandbox.invoke('moveNext', [[...map], position, [...items]]);
            const totalMs = performance.now() - start;
            check(result);
            samples[mode].push({ totalMs, guestMs: result.elapsedMs });
          } else {
            const active = mode === 'ipcOnePlayer' ? runners.slice(0, 1) : runners;
            await Promise.all(
              active.map(async (runner) => {
                const start = performance.now();
                const result = await runner.move([...map], position, [...items]);
                const totalMs = performance.now() - start;
                check(result);
                samples[mode].push({ totalMs, guestMs: result.elapsedMs });
              }),
            );
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const modes = Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [
        name,
        {
          total: stats(values.map((value) => value.totalMs)),
          guestReported: stats(values.map((value) => value.guestMs)),
          outsideGuestTimer: stats(values.map((value) => value.totalMs - value.guestMs)),
        },
      ]),
    );
    const entry = {
      columns,
      rows,
      cells: map.length,
      payloadJsonBytes: Buffer.byteLength(JSON.stringify({ map, position, items })),
      modes,
    };
    report.cases.push(entry);
    console.log(JSON.stringify(entry));
  } finally {
    sandbox?.dispose();
    await Promise.all(runners.map((runner) => runner.close()));
  }
}
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../artifacts/algorithm-call-overhead-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log('Report: artifacts/algorithm-call-overhead-results.json');
