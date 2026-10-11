import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthenticationService } from '../src/auth/authentication-service.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'coin-identities-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'store.json');
  return { file, accounts: new FileAccountRepository(file) };
}
const identity = (subject = 'subject-a', email = 'person@example.test') => ({
  provider: 'google',
  subject,
  email,
});

test('explicit identity linking preserves legacy administrator, source files and history across email changes', async (t) => {
  const { file, accounts } = await fixture(t);
  await writeFile(file, JSON.stringify({ users: [], algorithms: [], history: [] }));
  const admin = await accounts.bootstrapAdmin('admin@example.test');
  const algorithm = await accounts.save(admin.id, null, {
    name: 'strategy',
    source: 'original-code',
  });
  const match = await accounts.recordMatch(admin.id, { source: 'match-code', score: 42 });
  assert.equal(await accounts.findByIdentity('google', 'admin-sub'), null);
  await accounts.linkIdentity(admin.id, identity('admin-sub', admin.email));
  const reloaded = new FileAccountRepository(file);
  const loggedIn = await reloaded.loginIdentity(identity('admin-sub', 'New@example.test'));
  assert.equal(loggedIn.id, admin.id);
  assert.equal(loggedIn.role, 'admin');
  assert.equal(loggedIn.email, 'new@example.test');
  assert.equal((await reloaded.get(loggedIn.id, algorithm.id)).source, 'original-code');
  assert.equal((await reloaded.historyEntry(loggedIn.id, match.id)).source, 'match-code');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.identities.length, 1);
  assert.equal(stored.identities[0].userId, admin.id);
  assert.equal(stored.algorithms[0].source, undefined);
  assert.equal((await reloaded.listUsers())[0].subject, undefined);
});

test('email collisions never merge Google identities, elevate roles or expose linked accounts through mock login', async (t) => {
  const { accounts } = await fixture(t);
  const admin = await accounts.bootstrapAdmin('person@example.test');
  await assert.rejects(accounts.loginIdentity(identity()), { status: 403 });
  const google = await accounts.loginIdentity(identity(), { allowCreate: true });
  assert.notEqual(google.id, admin.id);
  assert.equal(google.role, 'user');
  assert.equal((await accounts.login(admin.email)).id, admin.id);
  await accounts.loginIdentity(identity('subject-a', 'changed@example.test'));
  const mock = await accounts.login('changed@example.test');
  assert.notEqual(mock.id, google.id);
  assert.equal(mock.role, 'user');
  const other = await accounts.loginIdentity(identity('subject-b', google.email), {
    allowCreate: true,
  });
  assert.notEqual(other.id, google.id);
});

test('concurrent creation and linking enforce unique identities and one identity per provider on each user', async (t) => {
  const { file, accounts } = await fixture(t);
  const users = await Promise.all(
    Array.from({ length: 8 }, () => accounts.loginIdentity(identity(), { allowCreate: true })),
  );
  assert.equal(new Set(users.map((user) => user.id)).size, 1);
  const a = await accounts.login('a@example.test');
  const b = await accounts.login('b@example.test');
  const results = await Promise.allSettled([
    accounts.linkIdentity(a.id, identity('contested')),
    accounts.linkIdentity(b.id, identity('contested')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
  const winner = results.find((result) => result.status === 'fulfilled').value;
  await accounts.linkIdentity(winner.id, identity('contested'));
  await assert.rejects(accounts.linkIdentity(winner.id, identity('replacement')), { status: 409 });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.users.length, 3);
  assert.equal(stored.identities.length, 2);
});

test('invalid identities and disabled accounts cannot modify identity storage', async (t) => {
  const { file, accounts } = await fixture(t);
  const user = await accounts.loginIdentity(identity(), { allowCreate: true });
  await accounts.updateUser(user.id, { active: false, role: 'user' });
  const before = await readFile(file, 'utf8');
  await assert.rejects(accounts.loginIdentity(identity('subject-a', 'changed@example.test')), {
    status: 403,
  });
  await assert.rejects(accounts.linkIdentity(user.id, identity('replacement')), { status: 403 });
  await assert.rejects(accounts.linkIdentity('missing', identity()), { status: 404 });
  for (const invalid of [
    null,
    identity(''),
    identity(' padded '),
    { ...identity(), provider: 'mock' },
    identity('x'.repeat(256)),
    identity('valid', 'invalid-email'),
  ]) {
    await assert.rejects(async () => accounts.loginIdentity(invalid, { allowCreate: true }), {
      status: 400,
    });
  }
  assert.equal(await readFile(file, 'utf8'), before);
});

test('Google service uses trusted provider output, explicit signup policy and persisted account permissions', async (t) => {
  const { accounts } = await fixture(t);
  const provider = { id: 'google', authenticate: async (_request, value) => value };
  const request = { headers: {} };
  const response = () => ({
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
  });
  const verified = { ...identity(), emailVerified: true, role: 'admin' };
  const closed = createAuthenticationService({ accounts, providers: [provider] });
  await assert.rejects(closed.login('google', request, response(), verified), { status: 403 });
  const open = createAuthenticationService({
    accounts,
    providers: [provider],
    allowIdentitySignup: async () => true,
  });
  const rejected = response();
  await assert.rejects(
    open.login('google', request, rejected, { ...verified, emailVerified: false }),
    { status: 401 },
  );
  assert.deepEqual(rejected.headers, {});
  const result = response();
  const user = await open.login('google', request, result, verified);
  assert.equal(user.role, 'user');
  const again = await closed.login('google', request, response(), {
    ...verified,
    email: 'changed@example.test',
  });
  assert.equal(again.id, user.id);
  const sessionRequest = { headers: { cookie: result.headers['Set-Cookie'].split(';')[0] } };
  assert.equal((await open.current(sessionRequest)).id, user.id);
  await accounts.updateUser(user.id, { active: false, role: 'user' });
  assert.equal(await open.current(sessionRequest), null);
  await assert.rejects(open.login('google', request, response(), verified), { status: 403 });
});
