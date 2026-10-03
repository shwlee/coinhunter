import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

test('production refuses explicit mock authentication', () => {
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => createAuthoring({ mock: true }), /목업 인증/);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test('local accounts persist, isolate code, reject conflicts and revoke disabled users', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-auth-'));
  const fileAccounts = new FileAccountRepository(join(dir, 'store.json'));
  const accounts = { adminEmail: fileAccounts.adminEmail };
  for (const method of [
    'login',
    'user',
    'listUsers',
    'updateUser',
    'list',
    'get',
    'save',
    'history',
    'historyEntry',
    'recordMatch',
  ])
    accounts[method] = fileAccounts[method].bind(fileAccounts);
  const { server, close } = createGameServer({ authoring: createAuthoring({ accounts }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', data, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const login = async (email) => {
    const response = await call('/api/auth/mock', 'POST', { email });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get('set-cookie').split(';')[0],
      user: (await response.json()).user,
    };
  };
  assert.equal((await call('/api/algorithms')).status, 401);
  const protectedPage = await fetch(base + '/editor', { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/signin?next=%2Feditor');
  assert.equal((await call('/api/auth/mock', 'POST', { email: 'anyone@gmail.com' })).status, 403);
  const admin = await login('vactormanbear@gmail.com');
  const a = await login('developer@company.test');
  const b = await login('tester@company.test');
  assert.equal(admin.user.role, 'admin');
  const source =
    'module.exports = class { initialize() {} getName() { return "saved"; } moveNext() { return -1; } }';
  const created = await call('/api/algorithms', 'POST', { name: 'first', source }, a.cookie);
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal((await call(`/api/algorithms/${item.id}`, 'GET', undefined, b.cookie)).status, 404);
  assert.equal(
    (
      await call(
        `/api/algorithms/${item.id}`,
        'PUT',
        { name: 'hack', source, revision: 1 },
        b.cookie,
      )
    ).status,
    404,
  );
  const updates = await Promise.all(
    [1, 2].map((n) =>
      call(
        `/api/algorithms/${item.id}`,
        'PUT',
        { name: `save${n}`, source, revision: 1 },
        a.cookie,
      ),
    ),
  );
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await new FileAccountRepository(join(dir, 'store.json')).get(a.user.id, item.id)).revision,
    2,
  );
  const secondLogin = await login(a.user.email);
  assert.equal(
    (await (await call('/api/algorithms', 'GET', undefined, secondLogin.cookie)).json()).algorithms
      .length,
    1,
  );
  const maps = (await (await call('/api/maps')).json()).maps;
  const input = {
    algorithmId: item.id,
    mapId: maps[0].id,
    dummyCount: 0,
    blackMatter: false,
    destroyWalls: false,
  };
  assert.equal((await call('/api/matches', 'POST', input, b.cookie)).status, 404);
  const matchResponse = await call('/api/matches', 'POST', input, a.cookie);
  assert.equal(matchResponse.status, 201);
  const match = await matchResponse.json();
  assert.equal((await call('/api/matches', 'POST', input, secondLogin.cookie)).status, 409);
  assert.equal((await call('/api/admin/users', 'GET', undefined, a.cookie)).status, 403);
  assert.equal(
    (
      await call(
        `/api/admin/users/${admin.user.id}`,
        'PUT',
        { active: false, role: 'admin' },
        admin.cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/api/admin/users/${a.user.id}`,
        'PUT',
        { active: false, role: 'user' },
        admin.cookie,
      )
    ).status,
    200,
  );
  assert.equal((await call('/api/algorithms', 'GET', undefined, a.cookie)).status, 401);
  assert.equal((await call('/api/algorithms', 'GET', undefined, secondLogin.cookie)).status, 401);
  assert.equal((await call(`/api/matches/${match.id}`, 'GET', undefined, a.cookie)).status, 404);
  assert.equal((await call('/api/auth/mock', 'POST', { email: a.user.email })).status, 403);
  await call(`/api/admin/users/${a.user.id}`, 'PUT', { active: true, role: 'user' }, admin.cookie);
  const fresh = await login(a.user.email);
  assert.equal((await call('/api/algorithms', 'GET', undefined, fresh.cookie)).status, 200);
  const largeSource = `${source}\n/*${'x'.repeat(1_000_000)}*/`;
  assert.equal(
    (await call('/api/algorithms', 'POST', { name: 'large', source: largeSource }, fresh.cookie))
      .status,
    201,
  );
  await call('/api/auth/logout', 'POST', {}, fresh.cookie);
  assert.equal((await call('/api/algorithms', 'GET', undefined, fresh.cookie)).status, 401);
});

test('mock disabled mode exposes no mock identities and rejects mock login', async (t) => {
  const { server, close } = createGameServer({ authoring: createAuthoring({ mock: false }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(base + '/api/session')).json()).identities, []);
  assert.equal(
    (
      await fetch(base + '/api/auth/mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
});
