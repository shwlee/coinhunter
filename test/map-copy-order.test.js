import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MapRepository } from '../src/game/map-repository.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

test('map copies preserve source, use latest draft, and order survives restart without changing samples', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-copy-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maps = new MapRepository({ dataDirectory: dir });
  const sample = maps.registry().find((entry) => entry.source === 'sample');
  const original = maps.getPublished(sample.id);
  const sampleRegistry = await readFile(join(maps.samplesDirectory, 'registry.json'));
  const first = await maps.copy(sample.id, '샘플 복사', sample.publishedRevision);
  assert.notEqual(first.id, sample.id);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.tiles, original.tiles);
  assert.deepEqual(first.settings, original.settings);
  assert.equal(maps.getPublished(first.id), null);
  await maps.publish(first.id, 1);
  await maps.saveDraft(
    { ...first, name: '최신 초안', settings: { ...first.settings, actionMs: 888 } },
    { expectedRevision: 1 },
  );
  await assert.rejects(maps.copy(first.id, '오래된 복사', 1), { status: 409 });
  const second = await maps.copy(first.id, '복제', 2);
  assert.equal(second.settings.actionMs, 888);
  assert.equal(second.revision, 1);
  assert.equal(maps.getPublished(first.id).settings.actionMs, original.settings.actionMs);
  assert.equal(maps.getPublished(second.id), null);
  const before = maps.registry().map((entry) => entry.id);
  const after = [...before].reverse();
  const attempts = await Promise.allSettled([
    maps.reorder(after, before),
    maps.reorder(after, before),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.status, 409);
  assert.deepEqual(
    maps.registry().map((entry) => entry.id),
    after,
  );
  assert.deepEqual(
    maps.listPublished().map((map) => map.id),
    after.filter((id) => id !== second.id),
  );
  const restarted = new MapRepository({ dataDirectory: dir });
  assert.deepEqual(
    restarted.registry().map((entry) => entry.id),
    after,
  );
  assert.deepEqual(restarted.getPublished(sample.id), original);
  assert.deepEqual(await readFile(join(maps.samplesDirectory, 'registry.json')), sampleRegistry);
  await assert.rejects(maps.reorder([sample.id, sample.id], after), { status: 400 });
  assert.deepEqual(
    maps.registry().map((entry) => entry.id),
    after,
  );
  const third = await maps.copy(sample.id, '추가 맵', sample.publishedRevision);
  assert.equal(maps.registry().at(-1).id, third.id);
  await assert.rejects(maps.reorder(after, after), { status: 409 });
});

test('copy and order APIs enforce admin role, reject malformed requests and expose public order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-copy-api-'));
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
  const call = (path, method = 'GET', body, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (email) =>
    (await call('/api/auth/mock', 'POST', { email })).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@company.test'),
    user = await login('developer@company.test');
  const sample = maps.registry()[0];
  const copyPath = `/api/admin/maps/${sample.id}/copy`;
  for (const [cookie, status] of [
    ['', 401],
    [user, 403],
  ]) {
    assert.equal((await call(copyPath, 'POST', {}, cookie)).status, status);
    assert.equal((await call('/api/admin/maps/order', 'PUT', {}, cookie)).status, status);
  }
  for (const body of [
    null,
    {},
    { name: ' ', sourceRevision: 1 },
    { name: 'a'.repeat(101), sourceRevision: 1 },
  ])
    assert.equal((await call(copyPath, 'POST', body, admin)).status, 400);
  assert.equal(
    (await call(copyPath, 'POST', { name: 'copy', sourceRevision: 99 }, admin)).status,
    409,
  );
  assert.equal(
    (await call('/api/admin/maps/missing/copy', 'POST', { name: 'copy', sourceRevision: 1 }, admin))
      .status,
    404,
  );
  const copied = await call(
    copyPath,
    'POST',
    { name: 'API 복사본', sourceRevision: sample.publishedRevision },
    admin,
  );
  assert.equal(copied.status, 201);
  const { map, state } = await copied.json();
  assert.equal(state.enabled, false);
  assert.equal(state.publishedRevision, null);
  const beforeDuplicate = maps.registry().length;
  assert.equal(
    (
      await call(
        copyPath,
        'POST',
        { name: ' API 복사본 ', sourceRevision: sample.publishedRevision },
        admin,
      )
    ).status,
    409,
  );
  assert.equal(maps.registry().length, beforeDuplicate);
  await maps.publish(map.id, 1);
  const expectedIds = maps.registry().map((entry) => entry.id),
    ids = [...expectedIds].reverse();
  assert.equal(
    (await call('/api/admin/maps/order', 'PUT', { ids, expectedIds }, admin)).status,
    200,
  );
  const publicMaps = await (await call('/api/maps')).json();
  assert.deepEqual(
    publicMaps.maps.map((map) => map.id),
    ids,
  );
  assert.equal(
    (await call('/api/admin/maps/order', 'PUT', { ids, expectedIds }, admin)).status,
    409,
  );
  for (const body of [
    null,
    {},
    { ids: [sample.id], expectedIds: ids },
    { ids: [...ids, sample.id], expectedIds: ids },
  ])
    assert.equal((await call('/api/admin/maps/order', 'PUT', body, admin)).status, 400);
});

test('duplicate copy names are rejected atomically including published names and Unicode variants', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-copy-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maps = new MapRepository({ dataDirectory: dir });
  const sample = maps.registry()[0];
  const original = maps.getPublished(sample.id);
  await assert.rejects(maps.copy(sample.id, original.name, sample.publishedRevision), {
    status: 409,
  });
  const attempts = await Promise.allSettled([
    maps.copy(sample.id, '새 복사본', sample.publishedRevision),
    maps.copy(sample.id, ' 새 복사본 ', sample.publishedRevision),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((result) => result.status === 'rejected').reason.status, 409);
  const saved = attempts.find((result) => result.status === 'fulfilled').value;
  await maps.publish(saved.id, 1);
  await maps.saveDraft({ ...saved, name: '다른 초안 이름' }, { expectedRevision: 1 });
  await assert.rejects(
    maps.copy(sample.id, saved.name.normalize('NFD'), sample.publishedRevision),
    { status: 409 },
  );
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 1);
});
