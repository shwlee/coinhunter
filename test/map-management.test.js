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

const expected = (entry) => ({
  draftRevision: entry.draftRevision,
  publishedRevision: entry.publishedRevision,
  enabled: entry.enabled,
});
test('publication preserves hidden state and atomic management rejects stale states', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-management-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maps = new MapRepository({ dataDirectory: dir });
  const state = () => maps.registry().find((entry) => entry.id === 'managed');
  const draft = await maps.saveDraft({ ...structuredClone(MAPS[0]), id: 'managed' });
  const unposted = expected(state());
  await maps.publish(draft.id, 1, unposted);
  const match = new Match(maps.getPublished(draft.id), ['unused']);
  await assert.rejects(maps.setEnabled(draft.id, false, undefined, unposted), { status: 409 });
  const beforeConcurrent = expected(state());
  const attempts = await Promise.allSettled([
    maps.setEnabled(draft.id, false, undefined, beforeConcurrent),
    maps.setEnabled(draft.id, false, undefined, beforeConcurrent),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.status, 409);
  const hidden = expected(state());
  await maps.saveDraft({ ...draft, name: '수정본' }, { expectedRevision: 1 });
  await assert.rejects(maps.publish(draft.id, 2, hidden), { status: 409 });
  await maps.publish(draft.id, 2, expected(state()));
  assert.equal(state().enabled, false);
  assert.equal(state().publishedRevision, 2);
  const restarted = new MapRepository({ dataDirectory: dir });
  assert.equal(restarted.getDraft(draft.id).revision, 2);
  assert.equal(restarted.getPublished(draft.id), null);
  await maps.saveDraft({ ...draft, name: '추가 초안' }, { expectedRevision: 2 });
  await maps.setEnabled(draft.id, true, undefined, expected(state()));
  assert.equal(maps.getPublished(draft.id).name, '수정본');
  assert.equal(match.map.revision, 1);
  const broken = maps.getDraft(draft.id);
  broken.tiles[1] = 0;
  await maps.saveDraft(broken, { expectedRevision: 3 });
  const oldState = expected(state());
  await assert.rejects(maps.publish(draft.id, 4, oldState), /대칭/);
  assert.deepEqual(expected(state()), oldState);
});

test('admin management API lists samples, previews explicit revisions and enforces access and state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-management-api-'));
  const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  await accounts.bootstrapAdmin('admin@company.test');
  const { server, close } = createGameServer({ maps, authoring: createAuthoring({ accounts }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', data, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const login = async (email) =>
    (await call('/api/auth/mock', 'POST', { email })).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@company.test'),
    user = await login('developer@company.test');
  await maps.saveDraft({ ...structuredClone(MAPS[0]), id: 'api-map' });
  const state = () => maps.registry().find((entry) => entry.id === 'api-map');
  assert.equal((await fetch(base + '/admin/maps', { redirect: 'manual' })).status, 302);
  assert.equal((await call('/admin/maps', 'GET', undefined, user)).status, 403);
  assert.equal((await call('/map-management.js', 'GET', undefined, user)).status, 403);
  for (const [path, method] of [
    ['/api/admin/maps/api-map/publish', 'POST'],
    ['/api/admin/maps/api-map/visibility', 'PUT'],
    ['/api/admin/maps/api-map/preview?revision=1', 'GET'],
  ]) {
    assert.equal((await call(path, method, method === 'GET' ? undefined : {}, user)).status, 403);
    assert.equal((await call(path, method, method === 'GET' ? undefined : {})).status, 401);
  }
  const listing = (
    await (await call('/api/admin/maps?includeSamples=1', 'GET', undefined, admin)).json()
  ).maps;
  assert.equal(
    listing.filter((entry) => entry.source === 'sample').length,
    maps.registry().filter((entry) => entry.source === 'sample').length,
  );
  assert.equal(listing.filter((entry) => entry.source === 'custom').length, 1);
  assert.equal(listing.find((entry) => entry.id === 'api-map').coins, 52);
  const originalList = (await (await call('/api/admin/maps', 'GET', undefined, admin)).json()).maps;
  assert.equal(originalList.length, 1);
  const preview = await call(
    '/api/admin/maps/crossroads/preview?revision=1',
    'GET',
    undefined,
    admin,
  );
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).map.tiles, MAPS[0].tiles);
  assert.equal(
    (await call('/api/admin/maps/api-map/preview?revision=0', 'GET', undefined, admin)).status,
    400,
  );
  assert.equal((await call('/api/admin/maps/crossroads/visibility', 'PUT', {}, admin)).status, 403);
  assert.equal(
    (await call('/api/admin/maps/api-map/publish', 'POST', { revision: 1 }, admin)).status,
    400,
  );
  assert.equal(
    (await call('/api/admin/maps/api-map/publish', 'POST', { revision: 1, expected: null }, admin))
      .status,
    400,
  );
  const first = expected(state());
  assert.equal(
    (
      await call(
        '/api/admin/maps/api-map/visibility',
        'PUT',
        { enabled: true, expected: first },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('/api/admin/maps/api-map/publish', 'POST', { revision: 1, expected: first }, admin))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        '/api/admin/maps/api-map/visibility',
        'PUT',
        { enabled: false, expected: first },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        '/api/admin/maps/api-map/visibility',
        'PUT',
        { enabled: false, expected: expected(state()) },
        admin,
      )
    ).status,
    200,
  );
  assert.equal((await call('/api/maps')).status, 200);
  assert.equal(maps.getPublished('api-map'), null);
});
