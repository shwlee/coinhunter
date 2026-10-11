import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MapRepository, MAPS } from '../src/game/map-repository.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { Match } from '../src/game/match.js';

test('map settings create independent drafts, validate input, enforce ownership roles and preserve publication', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-options-'));
  const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
  const original = structuredClone(MAPS[0]);
  original.id = 'options-map';
  delete original.settings.hurryUpRemovalIntervalMs;
  await maps.saveDraft(original);
  await maps.publish(original.id, 1);
  const published = maps.getPublished(original.id),
    match = new Match(published, ['unused']);
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  await accounts.bootstrapAdmin('admin@company.test');
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
      headers: { cookie, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const login = async (email) =>
    (await call('/api/auth/mock', 'POST', { email })).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@company.test'),
    user = await login('developer@company.test');
  const path = '/api/admin/maps/options-map/settings';
  for (const method of ['GET', 'PUT']) {
    assert.equal((await call(path, method, method === 'PUT' ? {} : undefined)).status, 401);
    assert.equal((await call(path, method, method === 'PUT' ? {} : undefined, user)).status, 403);
  }
  const loaded = (await (await call(path, 'GET', undefined, admin)).json()).map;
  assert.equal(loaded.settings.hurryUpRemovalIntervalMs['10'], 300);
  const input = { expectedRevision: 1, settings: { ...loaded.settings, actionMs: 777 } };
  const saved = await call(path, 'PUT', input, admin);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).map.revision, 2);
  assert.deepEqual(maps.getDraft(original.id).tiles, published.tiles);
  assert.equal(maps.getDraft(original.id).name, published.name);
  assert.deepEqual(maps.getPublished(original.id), published);
  assert.equal(match.map.settings.actionMs, published.settings.actionMs);
  assert.equal((await call(path, 'PUT', input, admin)).status, 409);
  for (const settings of [
    { ...input.settings, actionMs: 49 },
    { ...input.settings, itemDuration: 1.5 },
    { ...input.settings, itemIntervalMs: '1000' },
    { ...input.settings, hurryUpRemovalIntervalMs: { 10: 99 } },
    { ...input.settings, hurryUpRemovalIntervalMs: { 20: 1000 } },
    { ...input.settings, enabled: true },
    {},
  ]) {
    assert.equal((await call(path, 'PUT', { expectedRevision: 2, settings }, admin)).status, 400);
  }
  assert.equal(maps.getDraft(original.id).revision, 2);
  assert.equal(
    (await call('/api/admin/maps/crossroads/settings', 'GET', undefined, admin)).status,
    200,
  );
  assert.equal(
    (await call('/api/admin/maps/crossroads/settings', 'PUT', input, admin)).status,
    403,
  );
  assert.equal(
    (await call('/api/admin/maps/missing/settings', 'GET', undefined, admin)).status,
    404,
  );
  const restarted = new MapRepository({ dataDirectory: maps.dataDirectory });
  assert.equal(restarted.getDraft(original.id).settings.actionMs, 777);
  await maps.publish(original.id, 2);
  assert.equal(maps.getPublished(original.id).settings.actionMs, 777);
  assert.equal(match.map.settings.actionMs, published.settings.actionMs);
});
