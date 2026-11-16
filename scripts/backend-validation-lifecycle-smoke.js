import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchSplit, request } from './backend-integration.js';

const app = await launchSplit();
const user = app.client();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const expect = (response, status) => {
  assert.equal(response.status, status, response.text);
  return response.body;
};
const good =
  'module.exports=class{initialize(){} getName(){return "lifecycle";} moveNext(){return -1;}}';
const slow =
  'module.exports=class{initialize(){} getName(){return "slow";} moveNext(){while(true){}}}';
const save = (code) =>
  user('/api/algorithms?name=lifecycle', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: code,
  });
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(50);
  }
  throw new Error(label);
}
try {
  expect(await user('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
  const saved = expect(await save(good), 201);
  await until(
    async () =>
      (await user(`/api/algorithms/${saved.id}?metadata=1`)).body?.validation?.state === 'passed',
    'Initial validation stalled',
  );
  const map = expect(await user('/api/maps'), 200).maps.find((m) => m.id === 'four-courtyards');
  assert.ok(map);
  const game = expect(
    await user(
      '/api/matches',
      json({
        mapId: map.id,
        dummyCount: 0,
        startSlot: 0,
        characterId: 'pengko',
        blackMatter: false,
        destroyWalls: false,
        algorithmId: saved.id,
      }),
    ),
    201,
  );
  const internal = () =>
    request(app.execution.port, `/internal/v1/matches/${game.id}`, {
      headers: { authorization: 'Bearer ' + app.key },
    });
  const before = expect(await internal(), 200);
  assert.ok(before.enginePid > 0);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      app.client()('/api/game/validate', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: slow,
      }),
    ),
  );
  assert.ok(
    responses.some((r) => r.status === 429),
    'Saturation should reject excess work',
  );
  assert.ok(
    responses.some((r) => r.status === 400),
    'Admitted timeout fixtures should fail validation',
  );
  assert.ok(responses.every((r) => r.status === 400 || r.status === 429));
  expect(await user('/api/maps'), 200);
  expect(await request(app.operations.port, '/health/live'), 200);
  const after = expect(await internal(), 200);
  assert.equal(after.enginePid, before.enginePid);
  assert.ok(
    after.snapshot.sequence > before.snapshot.sequence,
    'Game must continue during validation saturation',
  );
  console.log(
    'PASS real validation saturation returns bounded failures while the same game engine progresses',
  );

  const pending = expect(await save(slow), 201);
  assert.equal(pending.validation.state, 'pending');
  await until(
    async () =>
      (
        await readdir(join(app.directory, 'operations/validation-leases')).catch((e) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        })
      ).some((f) => f.endsWith('.json')),
    'Validation snapshot never acquired a durable lease',
  );
  app.operations.child.kill('SIGKILL');
  await app.operations.exited;
  // Only this isolated fixture is edited, while its sole Operations writer is stopped.
  const storePath = join(app.directory, 'operations/accounts/store.json');
  const stored = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(stored.algorithms.find((a) => a.id === pending.id).validation.state, 'pending');
  stored.algorithms.find((a) => a.id === saved.id).validation.version = 'old-fixture-profile';
  await writeFile(storePath, JSON.stringify(stored));
  await app.launch('CoinHunter.Operations.Api', app.operations.port);
  expect(await user('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
  const recovered = expect(await user(`/api/algorithms/${pending.id}?metadata=1`), 200);
  const stale = expect(await user(`/api/algorithms/${saved.id}?metadata=1`), 200);
  assert.equal(recovered.validation.state, 'unverified');
  assert.equal(stale.validation.state, 'stale');
  assert.equal((await user(`/api/algorithms/${pending.id}/source`)).text, slow);
  const resumed = expect(await internal(), 200);
  assert.equal(resumed.enginePid, before.enginePid);
  assert.ok(resumed.snapshot.sequence >= after.snapshot.sequence);
  console.log(
    'PASS abrupt Operations restart recovers pending/stale receipts and retains game PID and sources',
  );

  expect(await user(`/api/algorithms/${saved.id}/validate`, { method: 'POST' }), 200);
  await until(
    async () =>
      (await user(`/api/algorithms/${saved.id}?metadata=1`)).body?.validation?.state === 'passed',
    'Recovered code did not pass',
  );
  expect(await user('/api/matches/' + game.id, { method: 'DELETE' }), 200);
  await until(async () => {
    const folders = await readdir(join(app.directory, 'execution/validations')).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    return folders.length === 0;
  }, 'Orphan validation directories remain');
  const allowed = new Set(
    stored.matches.flatMap((m) => m.request.participants.map((p) => p.source.sourceKey + '.js')),
  );
  for (const file of (await readdir(join(app.directory, 'exchange'))).filter((f) =>
    f.endsWith('.js'),
  ))
    assert.ok(allowed.has(file), 'Only recorded match snapshots may remain: ' + file);
  assert.equal(
    (await readdir(join(app.directory, 'operations/validation-leases'))).filter((f) =>
      f.endsWith('.json'),
    ).length,
    0,
  );
  console.log(
    'PASS explicit recheck recovers stale code and execution/validation snapshots are reclaimed',
  );
} catch (error) {
  console.error('Lifecycle fixtures retained at ' + app.directory);
  await app.close({ keep: true });
  throw error;
}
await app.close();
