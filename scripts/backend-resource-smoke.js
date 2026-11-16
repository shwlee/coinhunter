import assert from 'node:assert/strict';
import { launchSplit, request } from './backend-integration.js';

const app = await launchSplit();
const client = app.client();
const get = () =>
  request(app.execution.port, '/internal/v1/resources', {
    headers: { authorization: 'Bearer ' + app.key },
  });
const expect = (response, status) => {
  assert.equal(response.status, status, response.text);
  return response.body;
};
async function waitFor(count) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = expect(await get(), 200);
    if (value.reservedProcesses === count) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Resource reservation count did not reach ' + count);
}
try {
  expect(await request(app.execution.port, '/internal/v1/resources'), 401);
  const initial = await waitFor(0);
  assert.equal(initial.reservedMemoryBytes, 0);
  const map = expect(await client('/api/maps'), 200).maps.find((x) => x.id === 'four-courtyards');
  const options = {
    mapId: map.id,
    dummyCount: 0,
    startSlot: 0,
    characterId: 'pengko',
    blackMatter: false,
    destroyWalls: false,
  };
  const source =
    'module.exports=class{initialize(){}getName(){return "resource";}moveNext(){return -1;}}';
  const game = expect(
    await client('/api/matches', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-coinhunter-options': JSON.stringify(options) },
      body: source,
    }),
    201,
  );
  const processUnit = initial.processLimitUnit === 'processes';
  const gameTasks = processUnit ? 5 : 256,
    validationTasks = processUnit ? 3 : 128;
  assert.equal((await waitFor(gameTasks)).reservedMemoryBytes, 1024 * 1024 * 1024);
  const validation = app.client()('/api/game/validate', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: source.replace('return -1;', 'while(true){}'),
  });
  const overlap = await waitFor(gameTasks + validationTasks);
  assert.equal(overlap.reservedMemoryBytes, 1536 * 1024 * 1024);
  expect(await validation, 400);
  await waitFor(gameTasks);
  expect(await client(`/api/matches/${game.id}`, { method: 'DELETE' }), 200);
  assert.equal((await waitFor(0)).reservedMemoryBytes, 0);
  console.log(
    'PASS internal resource status requires service auth; game/validation reservations overlap and return to zero only after cleanup',
  );
} catch (error) {
  console.error('Resource fixtures retained at ' + app.directory);
  await app.close({ keep: true });
  throw error;
}
await app.close();
