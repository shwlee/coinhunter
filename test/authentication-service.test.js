import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySessionStore } from '../src/auth/memory-session-store.js';
import { createAuthenticationService } from '../src/auth/authentication-service.js';
import { createMockProvider } from '../src/auth/mock-provider.js';

const request = (cookie = '', address = '127.0.0.1') => ({
  headers: { cookie },
  socket: { remoteAddress: address },
});
const response = () => ({
  headers: {},
  setHeader(key, value) {
    this.headers[key] = value;
  },
});
const cookieOf = (result) => result.headers['Set-Cookie'].split(';')[0];

test('session rotation, exact expiry, logout and user-wide revocation are provider independent', () => {
  let time = 1000;
  const sessions = createMemorySessionStore({ now: () => time });
  const first = response();
  sessions.issue('user-a', request(), first);
  const firstRequest = request(cookieOf(first));
  assert.equal(sessions.userId(firstRequest), 'user-a');
  assert.match(first.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/);
  const rotated = response();
  sessions.issue('user-a', firstRequest, rotated);
  assert.notEqual(cookieOf(rotated), cookieOf(first));
  assert.equal(sessions.userId(firstRequest), null);
  const rotatedRequest = request(cookieOf(rotated));
  const second = response();
  sessions.issue('user-a', request(), second);
  const other = response();
  sessions.issue('user-b', request(), other);
  sessions.revokeUser('user-a');
  assert.equal(sessions.userId(rotatedRequest), null);
  assert.equal(sessions.userId(request(cookieOf(second))), null);
  assert.equal(sessions.userId(request(cookieOf(other))), 'user-b');
  time += 8 * 3600000;
  assert.equal(sessions.userId(request(cookieOf(other))), null);
  const logoutResponse = response();
  sessions.issue('user-b', request(), other);
  sessions.logout(request(cookieOf(other)), logoutResponse);
  assert.equal(sessions.userId(request(cookieOf(other))), null);
  assert.match(logoutResponse.headers['Set-Cookie'], /Max-Age=0/);
});

test('mock provider verifies local identity without creating accounts or sessions', async () => {
  const accounts = {
    listUsers: async () => [{ email: 'admin@example.test', active: true, role: 'admin' }],
  };
  const mock = createMockProvider({ accounts, enabled: true, domain: 'company.test' });
  assert.deepEqual(
    await mock.authenticate(request(), { email: 'developer@company.test', role: 'admin' }),
    { email: 'developer@company.test' },
  );
  await assert.rejects(
    mock.authenticate(request('', '192.168.1.5'), { email: 'developer@company.test' }),
    { status: 403 },
  );
  await assert.rejects(mock.authenticate(request(), { email: 'unknown@company.test' }), {
    status: 403,
  });
  await assert.rejects(mock.authenticate(request(), null), { status: 403 });
  const disabled = createMockProvider({ accounts, enabled: false, domain: 'company.test' });
  assert.deepEqual(await disabled.identities(), []);
  await assert.rejects(disabled.authenticate(request(), { email: 'developer@company.test' }), {
    status: 403,
  });
});

test('common login uses verified identity and stored role, preserves sessions on failure and blocks disabled users', async () => {
  let active = true;
  const user = { id: 'user-a', active: true, role: 'user', email: 'person@company.test' };
  const accounts = { user: async () => (active ? { ...user } : undefined) };
  const identities = [];
  const provider = {
    id: 'verified-test',
    async authenticate(_request, credentials) {
      if (!credentials.valid) throw Object.assign(new Error('Invalid identity'), { status: 401 });
      return { subject: 'verified-subject', provider: 'mock', role: 'admin' };
    },
  };
  const service = createAuthenticationService({
    accounts,
    providers: [provider],
    async resolveAccount(identity) {
      identities.push(identity);
      return { id: user.id, role: 'admin' };
    },
  });
  const result = response();
  assert.deepEqual(await service.login(provider.id, request(), result, { valid: true }), user);
  assert.equal(identities[0].provider, 'verified-test');
  const loggedIn = request(cookieOf(result));
  assert.deepEqual(await service.current(loggedIn), user);
  const rejected = response();
  await assert.rejects(service.login(provider.id, loggedIn, rejected, { valid: false }), {
    status: 401,
  });
  assert.deepEqual(rejected.headers, {});
  assert.deepEqual(await service.current(loggedIn), user);
  active = false;
  await assert.rejects(service.login(provider.id, request(), rejected, { valid: true }), {
    status: 403,
  });
  assert.equal(await service.current(loggedIn), null);
  active = true;
  assert.equal(await service.current(loggedIn), null);
  const unconfigured = createAuthenticationService({ accounts, providers: [provider] });
  await assert.rejects(unconfigured.login(provider.id, request(), response(), { valid: true }), {
    status: 503,
  });
});
