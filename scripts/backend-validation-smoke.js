import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchSplit } from './backend-integration.js';

const app = await launchSplit();
const user = app.client(),
  other = app.client(),
  guest = app.client();
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const expect = (response, status) => {
  assert.equal(response.status, status, response.text);
  return response.body;
};
const save = (source, id = null, revision = null) =>
  user(
    `/api/algorithms${id ? '/' + id : ''}?name=validation${revision ? '&revision=' + revision : ''}`,
    { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'text/plain' }, body: source },
  );
async function settled(id) {
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const item = expect(await user(`/api/algorithms/${id}?metadata=1`), 200);
    if (item.validation?.state !== 'pending') return item;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Stored validation did not settle');
}
try {
  expect(await user('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
  expect(await other('/api/auth/mock', json({ email: 'tester@company.test' })), 200);
  const valid = await readFile(
    new URL('../backend/node/examples/nearest-coin.js', import.meta.url),
    'utf8',
  );
  const invalid = 'module.exports = ;';
  let item = expect(await save(invalid), 201);
  assert.equal((await settled(item.id)).validation.state, 'failed');
  assert.equal((await user(`/api/algorithms/${item.id}/source`)).text, invalid);
  expect(await other(`/api/algorithms/${item.id}/validate`, { method: 'POST' }), 404);
  expect(await guest(`/api/algorithms/${item.id}/validate`, { method: 'POST' }), 401);
  console.log('PASS invalid code persists; validation failure and ownership are separate');

  const maps = expect(await user('/api/maps'), 200).maps;
  const options = {
    mapId: maps[0].id,
    mode: 'practice',
    dummyCount: 0,
    blackMatter: false,
    destroyWalls: false,
    startSlot: 0,
    characterId: 'pengko',
  };
  expect(
    await user('/api/matches', json({ ...options, algorithmId: item.id, validated: true })),
    400,
  );
  expect(
    await guest('/api/matches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-coinhunter-options': JSON.stringify(options) },
      body: invalid,
    }),
    400,
  );
  console.log('PASS direct match endpoints reject invalid saved/guest code and forged flags');

  item = expect(await save(valid, item.id, item.revision), 200);
  const accepted = await settled(item.id);
  assert.equal(accepted.validation.state, 'passed');
  assert.equal(accepted.validation.sourceHash, accepted.sourceHash);
  const checked = expect(
    await user('/api/algorithms/validate', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: valid,
    }),
    200,
  );
  assert.equal(checked.calls, 36);
  const match = expect(await user('/api/matches', json({ ...options, algorithmId: item.id })), 201);
  expect(await user('/api/matches/' + match.id, { method: 'DELETE' }), 200);
  console.log(
    'PASS corrected revision gets hash-bound success; manual validation and match admission work',
  );

  const timeout =
    'module.exports=class{initialize(){} getName(){return "timeout";} moveNext(){while(true){}}}';
  item = expect(await save(timeout, item.id, item.revision), 200);
  const timed = await settled(item.id);
  assert.equal(timed.validation.state, 'failed');
  assert.equal(timed.validation.diagnostic.code, 'AR012');
  assert.equal((await user(`/api/algorithms/${item.id}/source`)).text, timeout);
  expect(await user(`/api/algorithms/${item.id}/validate`, { method: 'POST' }), 200);
  for (const response of await Promise.all(
    Array.from({ length: 6 }, () =>
      user(`/api/algorithms/${item.id}/validate`, { method: 'POST' }),
    ),
  ))
    expect(response, 200);
  assert.equal((await settled(item.id)).validation.state, 'failed');
  console.log('PASS timeout code remains saved and can be rechecked');

  item = expect(await save(timeout, item.id, item.revision), 200);
  item = expect(await save(valid, item.id, item.revision), 200);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const current = expect(await user(`/api/algorithms/${item.id}?metadata=1`), 200);
  assert.equal(current.revision, item.revision);
  assert.notEqual(
    current.validation.state,
    'failed',
    'Old timeout must not overwrite latest revision',
  );
  expect(await user(`/api/algorithms/${item.id}/validate`, { method: 'POST' }), 200);
  assert.equal((await settled(item.id)).validation.state, 'passed');
  console.log('PASS late old revision result cannot overwrite the new source receipt');

  await app.stopHost(app.execution);
  const unavailable = expect(await save(valid), 201);
  assert.equal((await settled(unavailable.id)).validation.state, 'unverified');
  assert.equal((await user(`/api/algorithms/${unavailable.id}/source`)).text, valid);
  console.log('PASS execution outage preserves saved code and marks it unverified');
} catch (error) {
  console.error('Validation fixtures retained at ' + app.directory);
  await app.close({ keep: true });
  throw error;
}
await app.close();
