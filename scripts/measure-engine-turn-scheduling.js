import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platform, release, arch, cpus } from 'node:os';
import { Match } from '../backend/node/src/game/match.js';
import { MATCH_TICK_MS } from '../backend/node/src/game/match-clock.js';

// Synthetic local match only: no service/user store/.env/network. The slow runner
// deliberately reaches the real 500ms interrupt; fast players never wait for it.
const root = new URL('../', import.meta.url);
const map = JSON.parse(
  await readFile(new URL('backend/node/maps/samples/crossroads.json', root), 'utf8'),
);
map.settings = { ...map.settings, actionMs: 200, runningTimeMs: 60000, itemFirstMs: 50000 };
const source = `module.exports=class {
 initialize(number){this.number=number;this.calls=0;}
 getName(){return 'scheduling-'+this.number;}
 moveNext(){this.calls++;if(this.number===0)while(true){};return -1;}
}`;
const samples = [],
  results = [];
let reachTarget;
const target = new Promise((resolve) => {
  reachTarget = resolve;
});
const match = new Match(
  map,
  Array(4).fill(source),
  {},
  {
    random: () => 0,
    record: (type, payload) => {
      if (type === 'algorithm-dispatched' && payload.scheduling) {
        samples.push({ player: payload.player, turn: payload.turn, ...payload.scheduling });
        if (samples.length >= 40) reachTarget();
      }
      if (type === 'algorithm-result')
        results.push({ player: payload.player, status: payload.result.status });
    },
  },
);
let timer;
try {
  await match.start();
  await Promise.race([
    target,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Scheduling sample deadline exceeded')), 10000);
    }),
  ]);
} finally {
  clearTimeout(timer);
  await match.stop();
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    samples: sorted.length,
    minMs: sorted[0],
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted.at(-1),
  };
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    os: platform(),
    release: release(),
    architecture: arch(),
    cpu: cpus()[0]?.model,
  },
  configuration: {
    tickMs: MATCH_TICK_MS,
    actionMs: 200,
    players: 4,
    slowPlayer: 0,
    slowCallLimitMs: 500,
    turnBarrier: false,
  },
  hashes: {
    source: hash(source),
    ...Object.fromEntries(
      await Promise.all(
        ['match.js', 'state.js', 'match-clock.js', 'match-output.js'].map(async (file) => [
          file,
          hash(await readFile(new URL('backend/node/src/game/' + file, root))),
        ]),
      ),
    ),
  },
  boundaries: {
    completionDetectionDelayMs: 'First engine tick observing completed action minus action.endsAt.',
    completionToDispatchMs:
      'Next runner.move invocation start minus completion detection, same engine monotonic clock.',
    acceptanceToDispatchMs:
      'Runner invocation start minus engine turn acceptance; includes snapshot preparation and turn-requested enqueue.',
    actionToDispatchMs:
      'Next runner.move invocation start minus prior action.endsAt. Includes tick detection and engine dispatch, excludes the next algorithm execution.',
    limitations:
      'Single local synthetic match with four persistent JS processes; not an OS latency guarantee, cross-language measurement or scheduling optimization.',
  },
  metrics: Object.fromEntries(
    [
      'completionDetectionDelayMs',
      'completionToDispatchMs',
      'acceptanceToDispatchMs',
      'actionToDispatchMs',
    ].map((field) => [field, distribution(samples.map((row) => row[field]))]),
  ),
  players: match.state.players.map((player) => ({
    player: player.id,
    turns: player.turn,
    algorithmCalls: player.stats.algorithmCalls,
    timeouts: player.stats.timeouts,
    completedActions: player.stats.completedTurns,
  })),
  terminal: {
    phase: match.phase,
    pendingJobs: match.turns.size,
    allHostsClosed: match.runners.every((runner) => runner.host.terminated),
  },
  samples,
};
if (
  report.terminal.phase !== 'closed' ||
  report.terminal.pendingJobs ||
  !report.terminal.allHostsClosed ||
  !results.some((result) => result.player === 0 && result.status === 'timeout')
)
  throw new Error('Incomplete scheduling measurement');
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(
  new URL('artifacts/engine-turn-scheduling.json', root),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      samples: samples.length,
      metrics: report.metrics,
      players: report.players,
      terminal: report.terminal,
    },
    null,
    2,
  ),
);
console.log('Report: artifacts/engine-turn-scheduling.json');
