import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySessionStore } from '../src/auth/memory-session-store.js';
import { FileCredentialStore } from '../src/ai/credential-store.js';
import { FileAiConnectionRepository } from '../src/ai/connection-repository.js';
import { createAiStorage } from '../src/ai/storage-service.js';
import { readAiConfig } from '../src/ai/config.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';

const key = randomBytes(32).toString('hex');
const scope = () => ({ ownerId: randomUUID(), sessionId: randomUUID() });
const metadata = (mode = 'session') => ({
  name: 'my Claude',
  provider: 'anthropic',
  credentialMode: mode,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coin-ai-storage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function login(sessions, ownerId = randomUUID()) {
  const response = {
    headers: {},
    getHeader(name) {
      return this.headers[name];
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  sessions.issue(ownerId, { headers: {} }, response);
  const cookie = response.headers['Set-Cookie'].split(';')[0];
  const request = { headers: { cookie } };
  return { request, scope: sessions.scope(request), response };
}
function storage(dir, sessions, options = {}) {
  return createAiStorage({
    sessions,
    config: readAiConfig({ AI_ENABLED: 'true', AI_ALLOW_STORED_CREDENTIALS: 'true' }),
    env: { AI_DATA_DIR: dir, AI_CREDENTIAL_KEY: key, AI_CREDENTIAL_KEY_ID: 'test-v1' },
    ...options,
  });
}

test('temporary credentials never reach disk, isolate sessions and reject paths or foreign owners', async (t) => {
  const dir = await directory(t);
  const vault = new FileCredentialStore({ directory: dir });
  const owner = scope(),
    otherSession = { ...owner, sessionId: randomUUID() };
  const reference = await vault.put(owner, 'session', 'sensitive-session-key');
  assert.equal(await vault.resolve(owner, reference), 'sensitive-session-key');
  await assert.rejects(vault.resolve(otherSession, reference), { status: 404 });
  await assert.rejects(vault.resolve(scope(), reference), { status: 404 });
  await assert.rejects(vault.resolve(owner, '../outside'), { status: 404 });
  assert.deepEqual(await readdir(dir), []);
  vault.deleteSession(owner.sessionId);
  await assert.rejects(vault.resolve(owner, reference), { status: 404 });
  await assert.rejects(vault.put(owner, 'stored', 'key'), { status: 503 });
});

test('AES-GCM survives restart, binds owner/reference and detects wrong keys and tampering without rewriting', async (t) => {
  const dir = await directory(t),
    owner = scope();
  const options = { directory: dir, key, keyId: 'v1', allowStored: true };
  const vault = new FileCredentialStore(options);
  const reference = await vault.put(owner, 'stored', 'private-api-key');
  const path = join(dir, reference + '.json');
  const original = await readFile(path, 'utf8');
  assert.equal(original.includes('private-api-key'), false);
  assert.equal(
    await new FileCredentialStore(options).resolve(
      { ...owner, sessionId: randomUUID() },
      reference,
    ),
    'private-api-key',
  );
  for (const candidate of [
    new FileCredentialStore({ directory: dir }),
    new FileCredentialStore({ ...options, key: randomBytes(32).toString('hex') }),
    new FileCredentialStore({ ...options, keyId: 'v2' }),
  ]) {
    await assert.rejects(candidate.resolve(owner, reference), { status: 503 });
    await assert.rejects(candidate.put(owner, 'stored', 'must-not-create'), { status: 503 });
    assert.equal(await readFile(path, 'utf8'), original);
  }
  await assert.rejects(vault.resolve(scope(), reference), { status: 404 });
  const tampered = JSON.parse(original);
  tampered.ownerId = randomUUID();
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(vault.resolve({ ...owner, ownerId: tampered.ownerId }, reference), {
    status: 503,
  });
  await writeFile(path, original);
  const secondRef = randomUUID();
  await writeFile(join(dir, secondRef + '.json'), original);
  await assert.rejects(vault.resolve(owner, secondRef), { status: 503 });
  assert.throws(
    () => new FileCredentialStore({ key: 'secret-invalid', keyId: 'v1' }),
    (error) => error.status === 503 && !error.message.includes('secret-invalid'),
  );
});

test('connection metadata and selections persist only for stored connections and compare revisions atomically', async (t) => {
  const dir = await directory(t),
    owner = scope(),
    stranger = scope();
  const file = join(dir, 'connections.json');
  const repository = new FileAiConnectionRepository({ file });
  const temporary = await repository.create(owner, { ...metadata(), credentialRef: randomUUID() });
  const stored = await repository.create(owner, {
    ...metadata('stored'),
    credentialRef: randomUUID(),
  });
  await repository.setPreference(owner, { connectionId: stored.id, modelId: 'model-a' });
  await repository.setPreference(owner, { connectionId: temporary.id, modelId: 'model-b' });
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(owner.sessionId), false);
  assert.equal(raw.includes(temporary.id), false);
  const restarted = new FileAiConnectionRepository({ file });
  assert.equal((await restarted.list(owner)).length, 1);
  assert.deepEqual(await restarted.preference(owner), {
    connectionId: stored.id,
    modelId: 'model-a',
  });
  assert.deepEqual(await repository.preference(owner), {
    connectionId: temporary.id,
    modelId: 'model-b',
  });
  await assert.rejects(repository.get(stranger, stored.id), { status: 404 });
  const results = await Promise.allSettled([
    repository.update(owner, stored.id, 1, { name: 'first' }),
    restarted.update(owner, stored.id, 1, { name: 'second' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  repository.deleteSession(owner.sessionId);
  assert.deepEqual(await repository.preference(owner), {
    connectionId: stored.id,
    modelId: 'model-a',
  });
  const latest = await repository.get(owner, stored.id);
  await repository.delete(owner, stored.id, latest.revision);
  assert.deepEqual(await restarted.preference(owner), { connectionId: null, modelId: null });
});

test('storage coordinates key replacement failures, revision conflicts and deletion without leaking keys', async (t) => {
  const dir = await directory(t),
    sessions = createMemorySessionStore();
  const current = login(sessions),
    other = login(sessions);
  const service = storage(dir, sessions);
  t.after(async () => {
    sessions.close();
    await service.close();
  });
  const connection = await service.create(current.scope, metadata('stored'), 'old-secret');
  assert.equal(JSON.stringify(connection).includes('secret'), false);
  await assert.rejects(
    service.replaceCredential(current.scope, connection.id, 1, 'new-secret', async () => {
      throw new Error('rejected by provider');
    }),
  );
  assert.equal((await service.credential(current.scope, connection.id)).secret, 'old-secret');
  assert.equal((await readdir(join(dir, 'credentials'))).length, 1);
  const changed = await service.replaceCredential(current.scope, connection.id, 1, 'new-secret');
  assert.equal(changed.revision, 2);
  assert.equal(changed.checkStatus, 'unchecked');
  await assert.rejects(service.replaceCredential(current.scope, connection.id, 1, 'bad'), {
    status: 409,
  });
  await assert.rejects(service.credential(other.scope, connection.id), { status: 404 });
  assert.equal((await service.credential(current.scope, connection.id)).secret, 'new-secret');
  const text = await readFile(join(dir, 'connections.json'), 'utf8');
  assert.equal(text.includes('new-secret'), false);
  await service.delete(current.scope, connection.id, 2);
  assert.deepEqual(await service.list(current.scope), []);
  assert.deepEqual(await readdir(join(dir, 'credentials')), []);
});

test('logout, expiry, revocation and close synchronously remove only affected temporary credentials', async (t) => {
  const dir = await directory(t);
  let now = 0;
  const sessions = createMemorySessionStore({ now: () => now });
  const a = login(sessions),
    b = login(sessions, a.scope.ownerId),
    c = login(sessions);
  const service = storage(dir, sessions);
  t.after(async () => {
    sessions.close();
    await service.close();
  });
  const aConnection = await service.create(a.scope, metadata(), 'a-key');
  const bConnection = await service.create(b.scope, metadata(), 'b-key');
  const cConnection = await service.create(c.scope, metadata(), 'c-key');
  assert.notEqual(a.scope.sessionId, a.request.headers.cookie.split('=')[1]);
  sessions.logout(a.request, a.response);
  await assert.rejects(service.get(a.scope, aConnection.id), { status: 401 });
  assert.equal((await service.credential(b.scope, bConnection.id)).secret, 'b-key');
  sessions.revokeUser(b.scope.ownerId);
  await assert.rejects(service.credential(b.scope, bConnection.id), { status: 401 });
  assert.equal((await service.credential(c.scope, cConnection.id)).secret, 'c-key');
  now = 8 * 3600000;
  sessions.prune();
  await assert.rejects(service.credential(c.scope, cConnection.id), { status: 401 });
  const fresh = login(sessions);
  assert.deepEqual(await service.list(fresh.scope), []);
  await service.close();
  await assert.rejects(service.list(fresh.scope), { status: 401 });
  sessions.close();
  assert.throws(() => login(sessions), { status: 503 });
});

test('logout while key verification is pending cannot publish or resurrect temporary connections', async (t) => {
  const dir = await directory(t),
    sessions = createMemorySessionStore();
  const current = login(sessions),
    peer = login(sessions, current.scope.ownerId);
  const service = storage(dir, sessions),
    entered = deferred(),
    release = deferred();
  t.after(async () => {
    release.resolve();
    sessions.close();
    await service.close();
  });
  const connection = await service.create(current.scope, metadata(), 'old-key');
  const pending = service.replaceCredential(
    current.scope,
    connection.id,
    1,
    'new-key',
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  const rejected = assert.rejects(pending, { status: 401 });
  await entered.promise;
  sessions.logout(current.request, current.response);
  release.resolve();
  await rejected;
  assert.deepEqual(await service.list(peer.scope), []);
  assert.deepEqual(await readdir(dir), []);
});

test('metadata write failure rolls back staged credentials and preserves existing temporary revision', async (t) => {
  const dir = await directory(t),
    sessions = createMemorySessionStore(),
    current = login(sessions);
  const file = join(dir, 'connections.json');
  const repository = new FileAiConnectionRepository({ file });
  const service = storage(dir, sessions, { repository });
  t.after(async () => {
    sessions.close();
    await service.close();
  });
  const stored = await service.create(current.scope, metadata('stored'), 'saved-key');
  const temporary = await service.create(current.scope, metadata(), 'temporary-key');
  const saved = await readFile(file, 'utf8');
  await rm(file);
  await mkdir(file);
  await assert.rejects(service.create(current.scope, metadata('stored'), 'staged-key'));
  assert.equal((await readdir(join(dir, 'credentials'))).length, 1);
  await assert.rejects(service.update(current.scope, temporary.id, 1, { name: 'failed-name' }));
  await rm(file, { recursive: true });
  await writeFile(file, saved);
  assert.equal((await service.get(current.scope, temporary.id)).revision, 1);
  assert.equal((await service.credential(current.scope, stored.id)).secret, 'saved-key');
});

test('owner cleanup removes metadata, stored credentials and selections but preserves other owners', async (t) => {
  const dir = await directory(t),
    sessions = createMemorySessionStore();
  const a = login(sessions),
    b = login(sessions),
    service = storage(dir, sessions);
  t.after(async () => {
    sessions.close();
    await service.close();
  });
  const first = await service.create(a.scope, metadata('stored'), 'a-key');
  const second = await service.create(b.scope, metadata('stored'), 'b-key');
  await service.setPreference(a.scope, { connectionId: first.id, modelId: 'model-a' });
  sessions.revokeUser(a.scope.ownerId);
  await service.deleteOwner(a.scope.ownerId);
  assert.equal((await service.credential(b.scope, second.id)).secret, 'b-key');
  assert.equal((await readdir(join(dir, 'credentials'))).length, 1);
  const next = login(sessions, a.scope.ownerId);
  assert.deepEqual(await service.list(next.scope), []);
  assert.deepEqual(await service.preference(next.scope), { connectionId: null, modelId: null });
});

test('HTTP authentication scope activates AI storage cleanup on logout without exposing internal session IDs', async (t) => {
  const dir = await directory(t);
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  const authoring = createAuthoring({
    accounts,
    aiConfig: readAiConfig({ AI_ENABLED: 'true' }),
    aiEnv: { AI_DATA_DIR: join(dir, 'ai') },
    authConfig: { mode: 'mock' },
  });
  const app = createGameServer({ authoring });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'developer@company.test' }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const authenticated = await authoring.aiScope({ headers: { cookie } });
  const item = await authoring.aiStorage.create(authenticated, metadata(), 'private-key');
  const session = await (await fetch(base + '/api/session', { headers: { cookie } })).text();
  assert.equal(session.includes(authenticated.sessionId), false);
  assert.equal(
    (await fetch(base + '/api/auth/logout', { method: 'POST', headers: { origin: base, cookie } }))
      .status,
    200,
  );
  await assert.rejects(authoring.aiStorage.credential(authenticated, item.id), { status: 401 });
});
