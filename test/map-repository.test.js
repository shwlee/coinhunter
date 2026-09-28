import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MapRepository, MAPS } from '../src/game/map-repository.js';
import { validateMapDocument } from '../src/game/maps.js';
import { Match } from '../src/game/match.js';
import { createGameServer } from '../src/server.js';

async function repository(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'coinhunter-maps-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return new MapRepository({ dataDirectory });
}
function custom(id = 'test-map') {
  return { ...structuredClone(MAPS[0]), id, name: '테스트 맵' };
}

test('file-backed sample preserves 52 coins, dimensions and publication validation', () => {
  assert.equal(MAPS[0].tiles.filter((tile) => tile > 0).length, 52);
  assert.equal(MAPS[0].columns, 12);
  assert.equal(MAPS[0].rows, 10);
  validateMapDocument(MAPS[0]);
});

test('draft, publish, revision, disable and restart retain independent map versions', async (t) => {
  const repo = await repository(t);
  const first = await repo.saveDraft(custom());
  assert.equal(repo.getPublished(first.id), null);
  await repo.publish(first.id, first.revision);
  const match = new Match(repo.getPublished(first.id), ['unused']);
  const edited = { ...first, name: '수정된 맵' };
  const second = await repo.saveDraft(edited, { expectedRevision: 1 });
  assert.equal(second.revision, 2);
  assert.equal(repo.getPublished(first.id).name, first.name);
  await assert.rejects(repo.saveDraft(edited, { expectedRevision: 1 }), /최신 버전/);
  await repo.publish(second.id, 2);
  assert.equal(repo.getPublished(first.id).name, second.name);
  assert.equal(match.map.revision, 1);
  const restarted = new MapRepository({ dataDirectory: repo.dataDirectory });
  assert.equal(restarted.getPublished(first.id).revision, 2);
  const oldFile = JSON.parse(await readFile(join(repo.dataDirectory, first.id, '1.json'), 'utf8'));
  assert.equal(oldFile.name, first.name);
  await repo.setEnabled(first.id, false);
  assert.equal(repo.getPublished(first.id), null);
  assert.equal(repo.getDraft(first.id).revision, 2);
  await repo.setEnabled(first.id, true, -1);
  assert.equal(repo.listPublished()[0].id, first.id);
});

test('unsafe IDs and sample edits rejected; invalid symmetry and islands cannot publish', async (t) => {
  const repo = await repository(t);
  await assert.rejects(repo.saveDraft(custom('../escape')), /ID/);
  await assert.rejects(repo.saveDraft(custom('crossroads')), /복사/);
  const asymmetric = custom();
  asymmetric.tiles[1] = 0;
  await repo.saveDraft(asymmetric);
  await assert.rejects(repo.publish(asymmetric.id, 1), /대칭/);
  const island = custom('island');
  island.columns = 6;
  island.rows = 6;
  island.tiles = Array(36).fill(0);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++) {
      if (x === 1 || x === 4 || y === 1 || y === 4) island.tiles[y * 6 + x] = -1;
    }
  for (const i of [14, 15, 20, 21]) island.tiles[i] = 10;
  await repo.saveDraft(island);
  await assert.rejects(repo.publish(island.id, 1), /연결/);
  const bad = custom('bad');
  bad.settings.itemIntervalMs = 0;
  await assert.rejects(repo.saveDraft(bad), /옵션/);
});

test('HurryUp intervals reject invalid settings and accept older maps', () => {
  for (const value of [
    null,
    [],
    100,
    { 10: 0 },
    { 10: 60001 },
    { 10: 1.5 },
    { 10: '300' },
    { 20: 300 },
  ]) {
    const map = custom();
    map.settings.hurryUpRemovalIntervalMs = value;
    assert.throws(() => validateMapDocument(map), /소멸 간격|hurryUpRemovalIntervalMs/);
  }
  const map = custom();
  delete map.settings.hurryUpRemovalIntervalMs;
  validateMapDocument(map);
});

test('concurrent saves reject stale revision and keep a readable registry', async (t) => {
  const repo = await repository(t);
  const results = await Promise.allSettled([repo.saveDraft(custom()), repo.saveDraft(custom())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(repo.getDraft('test-map').revision, 1);
});

test('API lists only enabled published files and refuses unpublished maps for play', async (t) => {
  const maps = await repository(t);
  const { server, close } = createGameServer({ maps });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  await maps.saveDraft(custom());
  let response = await fetch(base + '/api/maps');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await response.json()).maps.length, MAPS.length);
  const rejected = await fetch(base + '/api/matches', {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapId: 'test-map',
      dummyCount: 0,
      blackMatter: false,
      destroyWalls: false,
    }),
  });
  assert.equal(rejected.status, 400);
  await maps.publish('test-map', 1);
  response = await fetch(base + '/api/maps');
  assert.equal((await response.json()).maps.length, MAPS.length + 1);
  await maps.setEnabled('test-map', false);
  response = await fetch(base + '/api/maps');
  assert.equal((await response.json()).maps.length, MAPS.length);
});
