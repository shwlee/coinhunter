import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { readAuthConfig } from '../src/auth/config.js';
import { createGoogleProvider } from '../src/auth/google-provider.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';

const environment = {
  AUTH_MODE: 'google',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/google/callback',
};
const config = readAuthConfig(environment);
const response = () => ({
  headers: {},
  getHeader(key) {
    return this.headers[key];
  },
  setHeader(key, value) {
    this.headers[key] = value;
  },
});
const cookieOf = (res) =>
  (Array.isArray(res.headers['Set-Cookie'])
    ? res.headers['Set-Cookie'][0]
    : res.headers['Set-Cookie']
  ).split(';')[0];
const request = (cookie = '') => ({ headers: { host: '127.0.0.1:3000', cookie } });
const callback = (state, extra = '') =>
  new URL(`${config.redirectUri}?state=${state}&code=code${extra}`);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwt(payload, privateKey = keys.privateKey) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid: 'test-key' })}.${part(payload)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
function testClient(settings = config) {
  const client = new OAuth2Client({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    redirectUri: settings.redirectUri,
  });
  const generate = client.generateAuthUrl.bind(client);
  client.generateAuthUrl = (parameters) => {
    client.parameters = parameters;
    return generate(parameters);
  };
  client.payload = {};
  client.exchangeCount = 0;
  client.getToken = async (options) => {
    client.exchangeCount++;
    client.exchange = options;
    const now = Math.floor(Date.now() / 1000);
    return {
      tokens: {
        id_token: jwt(
          {
            iss: 'https://accounts.google.com',
            aud: settings.clientId,
            sub: 'test-sub',
            email: 'person@company.test',
            email_verified: true,
            iat: now,
            exp: now + 3600,
            nonce: client.parameters?.nonce || 'nonce',
            ...client.payload,
          },
          client.signingKey || keys.privateKey,
        ),
      },
    };
  };
  // Replace the Google public-key transport only. Signature and standard claim verification run in the real SDK.
  client.getFederatedSignonCertsAsync = async () => ({
    certs: { 'test-key': keys.publicKey.export({ type: 'spki', format: 'pem' }) },
    format: 'PEM',
  });
  return client;
}

test('OAuth config fails early without secrets, rejects unsafe callbacks and requires an operational admission policy', () => {
  assert.equal(readAuthConfig({}).mode, 'mock');
  assert.equal(readAuthConfig({ NODE_ENV: 'production' }).mode, 'disabled');
  assert.throws(() => readAuthConfig({ AUTH_MODE: 'other' }));
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
    assert.throws(() => readAuthConfig({ ...environment, [key]: '' }), new RegExp(key));
  }
  for (const uri of [
    'http://example.com/api/auth/google/callback',
    'ftp://localhost/api/auth/google/callback',
    'http://localhost:3000/wrong',
    `${environment.GOOGLE_REDIRECT_URI}?secret=value`,
    'https://user:pass@example.com/api/auth/google/callback',
  ]) {
    assert.throws(() => readAuthConfig({ ...environment, GOOGLE_REDIRECT_URI: uri }));
  }
  assert.throws(() => readAuthConfig({ ...environment, NODE_ENV: 'production' }));
  assert.throws(() =>
    readAuthConfig({
      ...environment,
      NODE_ENV: 'production',
      GOOGLE_REDIRECT_URI: 'https://game.example.com/api/auth/google/callback',
    }),
  );
  const production = readAuthConfig({
    ...environment,
    NODE_ENV: 'production',
    GOOGLE_REDIRECT_URI: 'https://game.example.com/api/auth/google/callback',
    GOOGLE_ALLOWED_DOMAINS: ' Company.test,company.test ',
  });
  assert.equal(production.secure, true);
  assert.deepEqual(production.allowedDomains, ['company.test']);
});

test('OAuth state is browser-bound, single use, expiring and protects destinations with PKCE', () => {
  let now = Date.now();
  const client = testClient();
  const provider = createGoogleProvider({ config, client, now: () => now });
  const res = response();
  const location = new URL(provider.begin(request(), res, 'https://attacker.example'));
  assert.equal(location.hostname, 'accounts.google.com');
  assert.equal(location.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Lax/);
  const state = location.searchParams.get('state');
  assert.throws(() => provider.consume(request(), response(), callback(state)), { status: 401 });
  assert.throws(
    () => provider.consume(request(cookieOf(res)), response(), callback(state, `&state=${state}`)),
    { status: 401 },
  );
  const flow = provider.consume(request(cookieOf(res)), response(), callback(state));
  assert.equal(flow.next, '/');
  assert.equal(flow.nonce, location.searchParams.get('nonce'));
  assert.equal(
    createHash('sha256').update(flow.verifier).digest('base64url'),
    location.searchParams.get('code_challenge'),
  );
  assert.throws(() => provider.consume(request(cookieOf(res)), response(), callback(state)), {
    status: 401,
  });
  const expired = response();
  const later = new URL(provider.begin(request(), expired, '/editor'));
  now += 600000;
  assert.throws(
    () =>
      provider.consume(
        request(cookieOf(expired)),
        response(),
        callback(later.searchParams.get('state')),
      ),
    { status: 401 },
  );
  const aliasResponse = response();
  assert.equal(
    provider.begin({ headers: { host: 'localhost:3000' } }, aliasResponse, '/editor'),
    'http://127.0.0.1:3000/api/auth/google/start?next=%2Feditor',
  );
  assert.deepEqual(aliasResponse.headers, {});
  assert.throws(() => provider.begin({ headers: { host: 'localhost:3001' } }, response(), '/'), {
    status: 400,
  });
  assert.throws(
    () => provider.begin({ headers: { host: 'attacker.example:3000' } }, response(), '/'),
    { status: 400 },
  );
});

test('real SDK signature, issuer, audience, expiry and additional nonce/email checks reject forged identities', async () => {
  const client = testClient();
  const provider = createGoogleProvider({ config, client });
  const credentials = { code: 'code', verifier: 'verifier', nonce: 'nonce' };
  assert.deepEqual(await provider.authenticate(request(), credentials), {
    subject: 'test-sub',
    email: 'person@company.test',
    emailVerified: true,
  });
  assert.equal(client.exchange.codeVerifier, 'verifier');
  for (const bad of [
    { aud: 'other' },
    { iss: 'https://attacker.example' },
    { exp: Math.floor(Date.now() / 1000) - 600 },
    { nonce: 'wrong' },
    { email_verified: false },
    { sub: '' },
    { azp: 'other' },
    { iat: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    client.payload = bad;
    await assert.rejects(provider.authenticate(request(), credentials), { status: 401 });
  }
  client.payload = {};
  client.signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(provider.authenticate(request(), credentials), { status: 401 });
  client.getToken = async () => {
    throw new Error('test-secret code private-token');
  };
  await assert.rejects(
    provider.authenticate(request(), credentials),
    (error) => error.status === 401 && !/test-secret|private-token/.test(error.message),
  );
});

test('company policy uses verified Workspace hd and allows explicit email exceptions without granting admin', async () => {
  const restricted = {
    ...config,
    allowedDomains: ['company.test'],
    allowedEmails: ['exception@example.test'],
  };
  const client = testClient(restricted);
  const provider = createGoogleProvider({ config: restricted, client });
  const credentials = { code: 'code', verifier: 'verifier', nonce: 'nonce' };
  await assert.rejects(provider.authenticate(request(), credentials), { status: 403 });
  client.payload = { hd: 'company.test' };
  assert.equal((await provider.authenticate(request(), credentials)).subject, 'test-sub');
  client.payload = { email: 'exception@example.test' };
  const exception = await provider.authenticate(request(), credentials);
  assert.equal(exception.email, 'exception@example.test');
  assert.equal(exception.role, undefined);
});

test('HTTP OAuth login preserves cookies, creates sub account, handles cancellation, replay, logout and disabled users', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coin-google-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = new FileAccountRepository(join(dir, 'store.json'));
  const settings = { ...config };
  const client = testClient(settings);
  const app = createGameServer({
    authoring: createAuthoring({ accounts, authConfig: settings, googleClient: client }),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(app.close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  settings.redirectUri = base + '/api/auth/google/callback';
  client.redirectUri = settings.redirectUri;
  const alias = await new Promise((resolve, reject) => {
    http
      .get(
        base + '/api/auth/google/start?next=%2Feditor',
        { headers: { host: `localhost:${app.server.address().port}` } },
        (res) => {
          res.resume();
          resolve(res);
        },
      )
      .on('error', reject);
  });
  assert.equal(alias.statusCode, 302);
  assert.equal(alias.headers.location, base + '/api/auth/google/start?next=%2Feditor');
  assert.equal(
    alias.headers['set-cookie'].some((value) => value.includes('coinhunter-oauth=')),
    false,
  );
  const get = (path, cookie = '') =>
    fetch(base + path, { redirect: 'manual', headers: { cookie } });
  const session = await (await get('/api/session')).json();
  assert.equal(session.google, true);
  assert.equal(session.mock, false);
  assert.equal(JSON.stringify(session).includes('test-secret'), false);
  assert.equal(
    (
      await fetch(base + '/api/auth/mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'developer@company.test' }),
      })
    ).status,
    403,
  );
  async function start(next = '/editor') {
    const res = await get(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    const cookie = res.headers.get('set-cookie').match(/coinhunter-oauth=[A-Za-z0-9_-]+/)[0];
    assert.match(res.headers.get('set-cookie'), /coinhunter=/);
    return { cookie, state: location.searchParams.get('state') };
  }
  const first = await start();
  const finish = (flow, extra = '') =>
    get(`/api/auth/google/callback?state=${flow.state}&code=code${extra}`, flow.cookie);
  const bad = await finish({ ...first, cookie: '' });
  assert.match(bad.headers.get('location'), /authError=failed/);
  assert.equal(client.exchangeCount, 0);
  const loggedIn = await finish(first);
  assert.equal(loggedIn.headers.get('location'), '/editor');
  assert.match(loggedIn.headers.get('set-cookie'), /coinhunter-oauth=;.*Max-Age=0/);
  const cookie = loggedIn.headers.get('set-cookie').match(/coinhunter-session=[a-f0-9-]+/)[0];
  const user = (await (await get('/api/session', cookie)).json()).user;
  assert.equal(user.role, 'user');
  assert.match((await finish(first)).headers.get('location'), /authError=failed/);
  assert.equal(client.exchangeCount, 1);
  const cancelled = await start();
  assert.match(
    (await finish(cancelled, '&error=access_denied')).headers.get('location'),
    /authError=failed/,
  );
  assert.equal(client.exchangeCount, 1);
  const admin = await start('/admin');
  assert.equal((await finish(admin)).headers.get('location'), '/');
  const logout = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /coinhunter-session=;.*Max-Age=0/);
  assert.equal((await (await get('/api/session', cookie)).json()).user, null);
  await accounts.updateUser(user.id, { active: false, role: 'user' });
  const disabled = await start();
  assert.match((await finish(disabled)).headers.get('location'), /authError=denied/);
  assert.equal((await (await get('/api/session', cookie)).json()).user, null);
  const stored = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
  assert.equal(stored.users.length, 1);
  assert.equal(stored.identities[0].subject, 'test-sub');
  assert.equal(JSON.stringify(stored).includes('test-secret'), false);
});
