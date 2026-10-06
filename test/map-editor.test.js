import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placementIndices, applyTile, inspectMap } from '../public/map-editing.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository } from '../src/game/map-repository.js';
import { DEFAULT_MAP_SETTINGS } from '../src/game/maps.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

test('symmetric placement handles odd axes, erasing and protected starts', () => {
  const map = { columns: 5, rows: 5, tiles: Array(25).fill(0) };
  assert.deepEqual(placementIndices(5, 5, 12, true), [12]);
  assert.deepEqual(placementIndices(5, 5, 2, true), [2, 22]);
  assert.equal(applyTile(map, 6, 100, true).length, 4);
  assert.deepEqual(
    [6, 8, 16, 18].map((i) => map.tiles[i]),
    [100, 100, 100, 100],
  );
  assert.equal(inspectMap(map).asymmetric.length, 0);
  assert.equal(applyTile(map, 0, -1, true).length, 0);
  assert.equal(applyTile(map, 6, 0, false).length, 1);
  assert.ok(inspectMap(map).asymmetric.length > 0);
  applyTile(map, 6, 0, true);
  assert.equal(inspectMap(map).coins, 0);
});

test('editor detects inaccessible areas and scores without requiring draft symmetry', () => {
  const map = { columns: 5, rows: 5, tiles: Array(25).fill(0) };
  for (const i of [7, 11, 13, 17]) map.tiles[i] = -1;
  map.tiles[12] = 500;
  const result = inspectMap(map);
  assert.deepEqual(result.isolated, [12]);
  assert.equal(result.score, 500);
  assert.equal(result.walls, 4);
});

test('admin map API protects access, preserves settings and publication, rejects stale writes and restores drafts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-map-api-'));
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  await accounts.bootstrapAdmin('admin@company.test');
  const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
  const { server, close } = createGameServer({ maps, authoring: createAuthoring({ accounts }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', body, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const login = async (email) =>
    (await call('/api/auth/mock', 'POST', { email })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admin/maps')).status, 401);
  const guestPage = await fetch(base + '/admin/maps/editor', { redirect: 'manual' });
  assert.equal(guestPage.status, 302);
  assert.match(guestPage.headers.get('location'), /next=%2Fadmin%2Fmaps%2Feditor/);
  const ordinary = await login('developer@company.test');
  for (const path of ['/api/admin/maps', '/admin/maps/editor', '/map-editor.js'])
    assert.equal((await call(path, 'GET', undefined, ordinary)).status, 403);
  assert.equal((await call('/api/admin/maps', 'POST', {}, ordinary)).status, 403);
  const cookie = await login('admin@company.test');
  assert.equal((await call('/admin/maps/editor', 'GET', undefined, cookie)).status, 200);
  const input = {
    columns: 5,
    rows: 5,
    tiles: Array(25).fill(0),
    name: '새 맵',
    description: '빈 맵',
  };
  const created = await call(
    '/api/admin/maps',
    'POST',
    { ...input, id: '../bad', settings: { actionMs: 0 }, enabled: true },
    cookie,
  );
  assert.equal(created.status, 201);
  const first = (await created.json()).map;
  assert.match(first.id, /^map-/);
  assert.deepEqual(first.settings, DEFAULT_MAP_SETTINGS);
  assert.equal(maps.getPublished(first.id), null);
  assert.equal(
    (await call(`/api/admin/maps/${first.id}/draft`, 'GET', undefined, cookie)).status,
    200,
  );
  const edited = { ...input, tiles: [...input.tiles], expectedRevision: 1 };
  edited.tiles[6] = 10; // Asymmetric drafts are valid.
  assert.equal(
    (await call(`/api/admin/maps/${first.id}/draft`, 'PUT', edited, cookie)).status,
    200,
  );
  assert.equal(
    (await call(`/api/admin/maps/${first.id}/draft`, 'PUT', edited, cookie)).status,
    409,
  );
  assert.equal(maps.getDraft(first.id).revision, 2);
  const list = (await (await call('/api/admin/maps', 'GET', undefined, cookie)).json()).maps;
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, false);
  assert.equal(list[0].draftRevision, 2);
  const customized = maps.getDraft(first.id);
  customized.settings.actionMs = 777;
  applyTile(customized, 6, 10, true);
  const third = await maps.saveDraft(customized, { expectedRevision: 2 });
  await maps.publish(first.id, third.revision);
  const published = maps.getPublished(first.id);
  const update = await call(
    `/api/admin/maps/${first.id}/draft`,
    'PUT',
    { ...input, name: '미게시 수정', expectedRevision: 3, settings: { actionMs: 1 } },
    cookie,
  );
  assert.equal(update.status, 200);
  assert.equal((await update.json()).map.settings.actionMs, 777);
  assert.deepEqual(maps.getPublished(first.id), published);
  const restarted = new MapRepository({ dataDirectory: maps.dataDirectory });
  assert.equal(restarted.getDraft(first.id).revision, 4);
  assert.equal(restarted.getDraft(first.id).name, '미게시 수정');
  assert.equal(restarted.getPublished(first.id).revision, 3);
  for (const body of [
    null,
    [],
    { ...input, columns: 41 },
    { ...input, tiles: [0] },
    { ...input, name: ' ' },
    { ...input, tiles: input.tiles.map((v, i) => (i === 0 ? -1 : v)) },
  ]) {
    assert.equal((await call('/api/admin/maps', 'POST', body, cookie)).status, 400);
  }
  assert.equal((await call(`/api/admin/maps/${first.id}/draft`, 'PUT', input, cookie)).status, 400);
  assert.equal((await call('/api/admin/maps/missing/draft', 'GET', undefined, cookie)).status, 404);
  assert.equal(
    (
      await call(
        '/api/admin/maps/crossroads/draft',
        'PUT',
        { ...input, expectedRevision: 1 },
        cookie,
      )
    ).status,
    404,
  );
});
