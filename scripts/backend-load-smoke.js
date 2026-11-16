import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchSplit, request } from './backend-integration.js';
import { DEFAULT_MAP_SETTINGS } from '../backend/node/src/game/maps.js';

const run = promisify(execFile);
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const app = await launchSplit();
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const expect = (response, status) => {
  assert.equal(response.status, status, response.text.slice(0, 1000));
  return response.body;
};
const internal = (path) =>
  request(app.execution.port, path, { headers: { authorization: 'Bearer ' + app.key } });
const clients = Array.from({ length: 5 }, () => app.client());
const admin = app.client();
async function journal(id) {
  const directory = join(app.directory, 'execution/journals');
  let text;
  try {
    text = await readFile(join(directory, id + '.jsonl'), 'utf8');
  } catch {
    text = await readFile(join(directory, id + '.partial.jsonl'), 'utf8');
  }
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}
async function resources(pids) {
  if (process.platform !== 'win32')
    return { measured: false, reason: 'Windows process sampler only' };
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$idsToMeasure=@(${pids.join(',')}); @(Get-Process -Id $idsToMeasure -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,@{Name='CpuMs';Expression={$_.TotalProcessorTime.TotalMilliseconds}}) | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true },
  );
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(rows) ? rows : [rows];
}
async function playerProcesses(enginePids) {
  assert.ok(enginePids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  if (process.platform === 'win32') {
    const filter = enginePids.map((pid) => `ParentProcessId = ${pid}`).join(' OR ');
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true },
    );
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(rows) ? rows : [rows])
      .filter(
        (row) =>
          enginePids.includes(row.ParentProcessId) && row.CommandLine?.includes('player-worker.js'),
      )
      .map((row) => row.ProcessId);
  }
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  return stdout.split('\n').flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return row && enginePids.includes(Number(row[2])) && row[3].includes('player-worker.js')
      ? [Number(row[1])]
      : [];
  });
}
try {
  expect(await admin('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
  const tiles = Array(100).fill(100);
  for (const i of [0, 9, 90, 99]) tiles[i] = 0;
  const saved = expect(
    await admin(
      '/api/admin/maps',
      json({
        name: 'load and fault',
        columns: 10,
        rows: 10,
        tiles,
        settings: {
          ...DEFAULT_MAP_SETTINGS,
          actionMs: 800,
          runningTimeMs: 20000,
          hurryUpRemovalIntervalMs: { 100: 100 },
        },
      }),
    ),
    201,
  );
  expect(
    await admin(
      `/api/admin/maps/${saved.map.id}/publish`,
      json({ revision: 1, expected: saved.state }),
    ),
    200,
  );
  // Trusted fault fixture: timeout only on the actual 10x10 game, not on preflight maps.
  // This also verifies that finite preflight success does not remove runtime protection.
  const source = `module.exports = class { initialize(){this.calls=0;} getName(){return 'load';} moveNext(map){this.calls++; if(map.length===100 && this.calls===2){this.saved=3;while(true){}} return map.length===100 && this.calls===3?this.saved:2;} }`;
  const options = { mapId: saved.map.id, dummyCount: 3, blackMatter: false, destroyWalls: false };
  const ids = [];
  for (const client of clients.slice(0, 4))
    ids.push(
      expect(
        await client('/api/matches', {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'x-coinhunter-options': JSON.stringify(options),
          },
          body: source,
        }),
        201,
      ).id,
    );
  const views = await Promise.all(ids.map((id) => internal(`/internal/v1/matches/${id}`)));
  const enginePids = views.map((view) => expect(view, 200).enginePid);
  assert.equal(new Set(enginePids).size, 4, 'Each game has a separate engine PID');
  expect(
    await clients[4]('/api/matches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-coinhunter-options': JSON.stringify(options) },
      body: source,
    }),
    429,
  );
  // Observe rejections immediately; fixture cleanup may abort streams after any failed assertion.
  const streams = ids.map((id, i) =>
    clients[i](`/api/matches/${id}/events`).then(
      (response) => ({ response }),
      (error) => ({ error }),
    ),
  );
  await wait(800);
  const rows = await Promise.all(ids.map(journal));
  const actorPids = await playerProcesses(enginePids);
  assert.equal(
    actorPids.length,
    16,
    'Four persistent player hosts per isolated engine: ' +
      JSON.stringify(
        rows.map((log) => ({
          reason: log.find((row) => row.type === 'finished')?.payload.reason,
          fault: log.find((row) => row.type === 'runtime-failure')?.payload,
          last: log.at(-1)?.type,
        })),
      ),
  );
  const pids = [
    ...new Set([app.operations.child.pid, app.execution.child.pid, ...enginePids, ...actorPids]),
  ];
  const before = await resources(pids);
  const validation = await clients[4]('/api/game/validate', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: await readFile('backend/node/examples/nearest-coin.js', 'utf8'),
  });
  expect(validation, 200);
  expect(
    await admin('/api/algorithms?name=load-upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: source,
    }),
    201,
  );
  expect(await clients[4]('/styles.css'), 200);
  const retrievals = await Promise.all(Array.from({ length: 20 }, () => clients[4]('/api/maps')));
  retrievals.forEach((response) => expect(response, 200));
  await wait(700);
  const after = await resources(pids);
  for (let i = 0; i < 4; i++) {
    expect(await clients[i](`/api/matches/${ids[i]}`, { method: 'DELETE' }), 200);
    const log = await journal(ids[i]);
    const results = log
      .filter((row) => row.type === 'algorithm-result' && row.payload.player === 0)
      .map((row) => row.payload.result);
    assert.ok(results.some((result) => result.status === 'timeout'));
    assert.ok(results.length >= 3);
    assert.equal(new Set(results.map((result) => result.instanceId)).size, 1);
    assert.equal(results[2].direction, 3, 'Same object retains fields after interruption');
    const timeout = log.find(
      (row) =>
        row.type === 'algorithm-result' &&
        row.payload.player === 0 &&
        row.payload.result.status === 'timeout',
    );
    assert.ok(
      log.some(
        (row) =>
          row.type === 'action-completed' &&
          row.payload.player !== 0 &&
          row.timeMs < timeout.timeMs,
      ),
      'Fast opponents progress during slow algorithm',
    );
  }
  for (const settled of await Promise.all(streams)) {
    if (settled.error) throw settled.error;
    const response = settled.response;
    expect(response, 200);
    assert.match(response.text, /finished/);
  }
  const operationData = JSON.parse(
    await readFile(join(app.directory, 'operations/accounts/store.json'), 'utf8'),
  );
  assert.equal(
    operationData.matches.length,
    4,
    'A rejected fifth game is never left queued for later execution',
  );
  const sample = await journal(ids[0]);
  const calls = sample
    .filter((row) => row.type === 'algorithm-result')
    .map((row) => row.payload.result);
  const report = {
    date: new Date().toISOString(),
    scenario:
      '4 games x 4 players + 4 SSE + QuickJS validation + source upload/save + static asset + 20 map reads',
    source: 'synthetic isolated fixtures only',
    engineCount: enginePids.length,
    actorCountObserved: actorPids.length,
    before,
    after,
    timing: {
      algorithmMs: calls.map((call) => call.timings.executionMs),
      roundTripMs: calls.map((call) => call.timings.roundTripMs),
    },
    interpretation:
      'Working set includes shared runtime pages; sum is not unique resident memory. CPU samples cover sampler interval only, not a service capacity guarantee.',
  };
  await writeFile('artifacts/backend-load-report.json', JSON.stringify(report, null, 2));
  console.log(
    `PASS 4 independent engines / ${actorPids.length} observed player processes; admission 429; same PID/object through timeout; independent fast turns; concurrent validation/map reads. Resource report written.`,
  );
  // Kill only a PID returned by this isolated fixture, then verify its children and partial/outbox recovery.
  const faultId = expect(
    await clients[0]('/api/matches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-coinhunter-options': JSON.stringify(options) },
      body: source,
    }),
    201,
  ).id;
  await wait(500);
  const faultView = expect(await internal(`/internal/v1/matches/${faultId}`), 200);
  const faultActors = await playerProcesses([faultView.enginePid]);
  assert.equal(faultActors.length, 4);
  process.kill(faultView.enginePid);
  await wait(1200);
  const failed = expect(await internal(`/internal/v1/matches/${faultId}`), 200);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.result);
  assert.equal(failed.result.recording.status, 'partial');
  for (const pid of faultActors)
    assert.throws(() => process.kill(pid, 0), 'Player process is reclaimed after engine failure');
  const final = expect(await clients[0](`/api/matches/${faultId}`), 200);
  assert.equal(final.game.status, 'finished');
  assert.equal(final.game.reason, 'runtime-failure');
  const recovered = await journal(faultId);
  recovered.forEach((row, index) => assert.equal(row.seq, index + 1));
  console.log(
    'PASS engine failure yields explicit failure/partial recording and valid durable prefix.',
  );
  const restartId = expect(
    await clients[1]('/api/matches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-coinhunter-options': JSON.stringify(options) },
      body: source,
    }),
    201,
  ).id;
  await wait(300);
  const restartingView = expect(await internal(`/internal/v1/matches/${restartId}`), 200);
  const restartingActors = await playerProcesses([restartingView.enginePid]);
  app.execution.child.kill();
  await app.execution.exited;
  if (process.platform === 'win32') {
    const watched = [restartingView.enginePid, ...restartingActors];
    assert.equal(restartingActors.length, 4);
    assert.equal(
      (await resources(watched)).length,
      0,
      'Execution parent death must release its entire Job Object process tree',
    );
    report.parentDeathCleanup = {
      engineCount: 1,
      playerCount: restartingActors.length,
      confirmed: true,
    };
    await writeFile('artifacts/backend-load-report.json', JSON.stringify(report, null, 2));
    console.log('PASS Windows parent death kills the engine and all four player hosts.');
  }
  const unready = await request(app.operations.port, '/health/ready');
  assert.equal(unready.status, 503);
  const execution = await app.launch('CoinHunter.Execution.Host', app.execution.port);
  app.execution = execution;
  const recoveredExecution = expect(await internal(`/internal/v1/matches/${restartId}`), 200);
  assert.ok(recoveredExecution.result);
  assert.ok(['closed', 'failed'].includes(recoveredExecution.state));
  console.log(
    'PASS Execution host outage marks readiness unavailable; restart recovers terminal receipt/partial journal.',
  );
} finally {
  await app.close();
}
