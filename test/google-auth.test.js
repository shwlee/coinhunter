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

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
  assert.doesNotMatch(loggedIn.headers.get('set-cookie'), /coinhunter-oauth=/);
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

test('a superseded in-flight OAuth callback never issues or clears browser cookies', async (t) => {
  for (const scenario of ['token', 'account', 'cancelled', 'failed']) {
    await t.test(scenario, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'coin-google-order-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const accounts = new FileAccountRepository(join(dir, 'store.json'));
      const settings = { ...config };
      const client = testClient(settings);
      const entered = deferred(),
        release = deferred();
      t.after(() => release.resolve());
      const nonces = new Map();
      client.getToken = async ({ code }) => {
        if (code === 'old' && scenario !== 'account') {
          entered.resolve();
          await release.promise;
        }
        if (code === 'new' && scenario === 'failed') throw new Error('Exchange failed');
        const now = Math.floor(Date.now() / 1000);
        return {
          tokens: {
            id_token: jwt({
              iss: 'https://accounts.google.com',
              aud: settings.clientId,
              sub: code,
              email: code + '@company.test',
              email_verified: true,
              iat: now,
              exp: now + 3600,
              nonce: nonces.get(code),
            }),
          },
        };
      };
      if (scenario === 'account') {
        const lookup = accounts.user.bind(accounts);
        accounts.user = async (id) => {
          const user = await lookup(id);
          if (user?.email === 'old@company.test') {
            entered.resolve();
            await release.promise;
          }
          return user;
        };
      }
      const app = createGameServer({
        authoring: createAuthoring({ accounts, authConfig: settings, googleClient: client }),
      });
      await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
      t.after(app.close);
      const base = `http://127.0.0.1:${app.server.address().port}`;
      settings.redirectUri = base + '/api/auth/google/callback';
      const get = (path, cookie = '') =>
        fetch(base + path, { redirect: 'manual', headers: { cookie } });
      const start = async (code, cookie = '') => {
        const res = await get('/api/auth/google/start?next=%2Feditor', cookie);
        assert.equal(res.status, 302);
        const url = new URL(res.headers.get('location'));
        nonces.set(code, url.searchParams.get('nonce'));
        return {
          state: url.searchParams.get('state'),
          cookie: res.headers.get('set-cookie').match(/coinhunter-oauth=[A-Za-z0-9_-]+/)[0],
        };
      };
      const finish = (flow, code, extra = '') =>
        get(`/api/auth/google/callback?state=${flow.state}&code=${code}${extra}`, flow.cookie);
      const first = await start('old');
      const oldResponse = finish(first, 'old');
      await entered.promise;
      // A separate browser remains independent while the first browser's exchange is blocked.
      const other = await start('other');
      assert.equal((await finish(other, 'other')).headers.get('location'), '/editor');
      const second = await start('new', first.cookie);
      assert.equal(second.cookie, first.cookie);
      const latestResponse = await finish(
        second,
        'new',
        scenario === 'cancelled' ? '&error=access_denied' : '',
      );
      const latestSession = latestResponse.headers
        .get('set-cookie')
        ?.match(/coinhunter-session=[a-f0-9-]+/)?.[0];
      if (['token', 'account'].includes(scenario)) {
        assert.equal(latestResponse.headers.get('location'), '/editor');
        assert.ok(latestSession);
      } else {
        assert.match(latestResponse.headers.get('location'), /authError=failed/);
        assert.equal(latestSession, undefined);
      }
      release.resolve();
      const stale = await oldResponse;
      assert.match(stale.headers.get('location'), /authError=failed/);
      assert.doesNotMatch(stale.headers.get('set-cookie') || '', /coinhunter-(session|oauth)=/);
      if (latestSession) {
        const { user } = await (await get('/api/session', latestSession)).json();
        assert.equal(user.email, 'new@company.test');
      }
    });
  }
});

test('a newer pending attempt and expiry invalidate consumed flows before session issuance', () => {
  let time = Date.now();
  const provider = createGoogleProvider({ config, client: testClient(), now: () => time });
  const firstResponse = response();
  const firstURL = new URL(provider.begin(request(), firstResponse, '/editor'));
  const cookie = cookieOf(firstResponse);
  const old = provider.consume(
    request(cookie),
    response(),
    callback(firstURL.searchParams.get('state')),
  );
  old.assertCurrent();
  const nextResponse = response();
  const nextURL = new URL(provider.begin(request(cookie), nextResponse, '/editor'));
  assert.throws(old.assertCurrent, { status: 409 });
  old.complete(); // A stale completion must not invalidate its replacement.
  const next = provider.consume(
    request(cookie),
    response(),
    callback(nextURL.searchParams.get('state')),
  );
  next.assertCurrent();
  time += 600000;
  assert.throws(next.assertCurrent, { status: 409 });
  next.complete();
});

test('logout invalidates pending and in-flight OAuth without touching other browsers or a fresh login', async (t) => {
  for (const phase of ['pending', 'token', 'account']) {
    await t.test(phase, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'coin-google-logout-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const accounts = new FileAccountRepository(join(dir, 'store.json'));
      const settings = { ...config };
      const client = testClient(settings);
      const entered = deferred(),
        release = deferred();
      t.after(() => release.resolve());
      const nonces = new Map();
      let exchanges = 0;
      client.getToken = async ({ code }) => {
        exchanges++;
        if (code === 'held' && phase === 'token') {
          entered.resolve();
          await release.promise;
        }
        const now = Math.floor(Date.now() / 1000);
        return {
          tokens: {
            id_token: jwt({
              iss: 'https://accounts.google.com',
              aud: settings.clientId,
              sub: code,
              email: code + '@company.test',
              email_verified: true,
              iat: now,
              exp: now + 3600,
              nonce: nonces.get(code),
            }),
          },
        };
      };
      if (phase === 'account') {
        const lookup = accounts.user.bind(accounts);
        accounts.user = async (id) => {
          const user = await lookup(id);
          if (user?.email === 'held@company.test') {
            entered.resolve();
            await release.promise;
          }
          return user;
        };
      }
      const app = createGameServer({
        authoring: createAuthoring({ accounts, authConfig: settings, googleClient: client }),
      });
      await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
      t.after(app.close);
      const base = `http://127.0.0.1:${app.server.address().port}`;
      settings.redirectUri = base + '/api/auth/google/callback';
      const get = (path, cookie = '') =>
        fetch(base + path, { redirect: 'manual', headers: { cookie } });
      const start = async (code, cookie = '') => {
        const res = await get('/api/auth/google/start?next=%2Feditor', cookie);
        assert.equal(res.status, 302);
        const url = new URL(res.headers.get('location'));
        nonces.set(code, url.searchParams.get('nonce'));
        assert.match(res.headers.get('set-cookie'), /Path=\/api\/auth;/);
        return {
          state: url.searchParams.get('state'),
          cookie: res.headers.get('set-cookie').match(/coinhunter-oauth=[A-Za-z0-9_-]+/)[0],
        };
      };
      const finish = (flow, code, session = '') =>
        get(
          `/api/auth/google/callback?state=${flow.state}&code=${code}`,
          flow.cookie + '; ' + session,
        );
      const initial = await finish(await start('initial'), 'initial');
      const session = initial.headers.get('set-cookie').match(/coinhunter-session=[a-f0-9-]+/)[0];
      const old = await start('held', session);
      let oldResponse;
      if (phase !== 'pending') {
        oldResponse = finish(old, 'held', session);
        await entered.promise;
      }
      const other = await start('other');
      const logout = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: {
          cookie: old.cookie + '; ' + session,
          origin: base,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(logout.status, 200);
      assert.match(
        logout.headers.get('set-cookie'),
        /coinhunter-oauth=;[^,]*Path=\/api\/auth; Max-Age=0/,
      );
      assert.match(
        logout.headers.get('set-cookie'),
        /coinhunter-oauth=;[^,]*Path=\/api\/auth\/google; Max-Age=0/,
      );
      assert.equal((await (await get('/api/session', session)).json()).user, null);
      // A different browser can still finish, and the logged-out browser may start a fresh login.
      assert.equal((await finish(other, 'other')).headers.get('location'), '/editor');
      const fresh = await start('fresh');
      assert.notEqual(fresh.cookie, old.cookie);
      const freshResponse = await finish(fresh, 'fresh');
      const freshSession = freshResponse.headers
        .get('set-cookie')
        .match(/coinhunter-session=[a-f0-9-]+/)[0];
      const before = exchanges;
      release.resolve();
      const late = await (oldResponse || finish(old, 'held', session));
      assert.match(late.headers.get('location'), /authError=failed/);
      assert.doesNotMatch(late.headers.get('set-cookie') || '', /coinhunter-(session|oauth)=/);
      if (phase === 'pending') assert.equal(exchanges, before);
      assert.equal((await (await get('/api/session', session)).json()).user, null);
      assert.equal(
        (await (await get('/api/session', freshSession)).json()).user.email,
        'fresh@company.test',
      );
    });
  }
});

test('login quotas reject cookie and forwarded-address churn while preserving other peers and pending retries', () => {
  let time = Date.now();
  const client = testClient();
  const provider = createGoogleProvider({
    config: { ...config, startsPerMinute: 4, flowsPerAddress: 2 },
    client,
    now: () => time,
  });
  const peer = (address, cookie = '') => ({
    ...request(cookie),
    socket: { remoteAddress: address },
  });
  const firstResponse = response();
  const first = new URL(provider.begin(peer('192.0.2.1'), firstResponse, '/editor'));
  const firstCookie = cookieOf(firstResponse);
  const secondResponse = response();
  const second = new URL(provider.begin(peer('192.0.2.1'), secondResponse, '/editor'));
  const blocked = response();
  const forged = peer('::ffff:192.0.2.1', 'coinhunter-oauth=' + 'A'.repeat(43));
  forged.headers['x-forwarded-for'] = '192.0.2.2';
  forged.headers.forwarded = 'for=192.0.2.2';
  assert.throws(() => provider.begin(forged, blocked, '/editor'), { status: 429 });
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.equal(blocked.headers['Set-Cookie'], undefined);
  // The existing browser can replace its own slot even at the per-peer active limit.
  const retryResponse = response();
  const retry = new URL(provider.begin(peer('192.0.2.1', firstCookie), retryResponse, '/editor'));
  assert.equal(cookieOf(retryResponse), firstCookie);
  assert.throws(
    () =>
      provider.consume(
        peer('192.0.2.1', firstCookie),
        response(),
        callback(first.searchParams.get('state')),
      ),
    { status: 401 },
  );
  const deniedRetry = response();
  assert.throws(() => provider.begin(peer('192.0.2.1', firstCookie), deniedRetry, '/editor'), {
    status: 429,
  });
  assert.equal(deniedRetry.headers['Retry-After'], '60');
  provider
    .consume(peer('192.0.2.1', firstCookie), response(), callback(retry.searchParams.get('state')))
    .complete();
  provider
    .consume(
      peer('192.0.2.1', cookieOf(secondResponse)),
      response(),
      callback(second.searchParams.get('state')),
    )
    .complete();
  // Completed callbacks free slots, but do not reset the start-frequency limit.
  for (let i = 0; i < 1000; i++)
    assert.throws(() => provider.begin(peer('192.0.2.1'), response(), '/editor'), { status: 429 });
  const healthy = response();
  assert.ok(
    new URL(provider.begin(peer('192.0.2.2'), healthy, '/editor')).searchParams.get('state'),
  );
  time += 60000;
  assert.ok(
    new URL(provider.begin(peer('192.0.2.1'), response(), '/editor')).searchParams.get('state'),
  );
});

test('consumed exchanges retain their peer quota until completion, while expiry frees abandoned flows', () => {
  let time = Date.now();
  const provider = createGoogleProvider({
    config: { ...config, flowsPerAddress: 1 },
    client: testClient(),
    now: () => time,
  });
  const res = response();
  const url = new URL(provider.begin(request(), res, '/editor'));
  const active = provider.consume(
    request(cookieOf(res)),
    response(),
    callback(url.searchParams.get('state')),
  );
  assert.throws(() => provider.begin(request(), response(), '/editor'), { status: 429 });
  active.complete();
  provider.begin(request(), response(), '/editor');
  time += 60000;
  assert.throws(() => provider.begin(request(), response(), '/editor'), { status: 429 });
  time += 540000;
  provider.begin(request(), response(), '/editor');
});

test('HTTP same-browser retries cannot exceed a one-flow limit during exchange or account lookup', async (t) => {
  for (const outcome of ['success', 'failure', 'logout', 'account']) {
    await t.test(outcome, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'coin-google-running-limit-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const accounts = new FileAccountRepository(join(dir, 'store.json'));
      const settings = { ...config, flowsPerAddress: 1 };
      const client = testClient(settings);
      const entered = deferred(),
        release = deferred();
      t.after(() => release.resolve());
      const nonces = new Map();
      let calls = 0,
        active = 0,
        maximum = 0;
      client.getToken = async ({ code }) => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        try {
          if (code === 'held' && outcome !== 'account') {
            entered.resolve();
            await release.promise;
          }
          if (code === 'held' && outcome === 'failure') throw new Error('Exchange failed');
          const now = Math.floor(Date.now() / 1000);
          return {
            tokens: {
              id_token: jwt({
                iss: 'https://accounts.google.com',
                aud: settings.clientId,
                sub: code,
                email: code + '@company.test',
                email_verified: true,
                iat: now,
                exp: now + 3600,
                nonce: nonces.get(code),
              }),
            },
          };
        } finally {
          active--;
        }
      };
      if (outcome === 'account') {
        const lookup = accounts.user.bind(accounts);
        accounts.user = async (id) => {
          const user = await lookup(id);
          if (user?.email === 'held@company.test') {
            entered.resolve();
            await release.promise;
          }
          return user;
        };
      }
      const app = createGameServer({
        authoring: createAuthoring({ accounts, authConfig: settings, googleClient: client }),
      });
      await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
      t.after(app.close);
      const base = `http://127.0.0.1:${app.server.address().port}`;
      settings.redirectUri = base + '/api/auth/google/callback';
      const get = (path, cookie = '') =>
        fetch(base + path, { redirect: 'manual', headers: { cookie } });
      const start = async (code, cookie = '') => {
        const res = await get('/api/auth/google/start?next=%2Feditor', cookie);
        assert.equal(res.status, 302);
        const url = new URL(res.headers.get('location'));
        nonces.set(code, url.searchParams.get('nonce'));
        return {
          state: url.searchParams.get('state'),
          cookie: res.headers.get('set-cookie').match(/coinhunter-oauth=[A-Za-z0-9_-]+/)[0],
        };
      };
      const finish = (flow, code) =>
        get(`/api/auth/google/callback?state=${flow.state}&code=${code}`, flow.cookie);
      const held = await start('held');
      const running = finish(held, 'held');
      await entered.promise;
      for (let i = 0; i < 3; i++) {
        const retry = await get('/api/auth/google/start', held.cookie);
        assert.equal(retry.status, 429);
        assert.doesNotMatch(retry.headers.get('set-cookie') || '', /coinhunter-oauth=/);
      }
      assert.equal(calls, 1);
      if (outcome === 'logout') {
        const logout = await fetch(base + '/api/auth/logout', {
          method: 'POST',
          headers: { cookie: held.cookie, origin: base, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(logout.status, 200);
        assert.equal((await get('/api/auth/google/start')).status, 429);
      }
      release.resolve();
      const done = await running;
      if (outcome === 'failure' || outcome === 'logout') {
        assert.match(done.headers.get('location'), /authError=failed/);
        assert.doesNotMatch(done.headers.get('set-cookie') || '', /coinhunter-session=/);
      } else assert.equal(done.headers.get('location'), '/editor');
      const fresh = await start('fresh', outcome === 'logout' ? '' : held.cookie);
      assert.equal((await finish(fresh, 'fresh')).headers.get('location'), '/editor');
      assert.equal(calls, 2);
      assert.equal(maximum, 1);
    });
  }
});

test('superseded and expired running callbacks retain peer and global reservations until completion', () => {
  let time = Date.now();
  const provider = createGoogleProvider({
    config: { ...config, flowsPerAddress: 999 },
    client: testClient(),
    now: () => time,
  });
  const flows = [];
  for (let i = 0; i < 1000; i++) {
    const res = response();
    const req = { ...request(), socket: { remoteAddress: `2001:db8::${i.toString(16)}` } };
    const url = new URL(provider.begin(req, res, '/editor'));
    req.headers.cookie = cookieOf(res);
    flows.push({
      req,
      flow: provider.consume(req, response(), callback(url.searchParams.get('state'))),
    });
  }
  // In-flight attempts cannot reuse a global slot, even with the same browser cookie.
  assert.throws(() => provider.begin(flows[0].req, response(), '/editor'), { status: 429 });
  flows[0].flow.assertCurrent();
  provider.cancel(flows[0].req, response());
  assert.throws(() => provider.begin(flows[0].req, response(), '/editor'), { status: 429 });
  time += 600000;
  assert.throws(flows[1].flow.assertCurrent, { status: 409 });
  assert.throws(() => provider.begin(flows[1].req, response(), '/editor'), { status: 429 });
  flows[0].flow.complete();
  flows[0].flow.complete(); // Repeated cleanup must not free any other callback's reservation.
  const admitted = new URL(provider.begin(flows[0].req, response(), '/editor'));
  assert.throws(() => provider.begin(flows[1].req, response(), '/editor'), { status: 429 });
  provider
    .consume(flows[0].req, response(), callback(admitted.searchParams.get('state')))
    .complete();
  for (const { flow } of flows) flow.complete();
});

test('a superseded callback completes without releasing the replacement reservation', () => {
  const provider = createGoogleProvider({
    config: { ...config, flowsPerAddress: 2 },
    client: testClient(),
  });
  const res = response();
  const url = new URL(provider.begin(request(), res, '/editor'));
  const req = request(cookieOf(res));
  const first = provider.consume(req, response(), callback(url.searchParams.get('state')));
  const secondURL = new URL(provider.begin(req, response(), '/editor'));
  const second = provider.consume(req, response(), callback(secondURL.searchParams.get('state')));
  assert.throws(first.assertCurrent, { status: 409 });
  assert.throws(() => provider.begin(req, response(), '/editor'), { status: 429 });
  first.complete();
  first.complete();
  second.assertCurrent();
  provider.begin(request(), response(), '/editor');
  assert.throws(() => provider.begin(request(), response(), '/editor'), { status: 429 });
  second.complete();
  provider.begin(request(), response(), '/editor');
});

test('a failed authorization URL does not leak a slot or invalidate a pending retry', () => {
  const client = testClient();
  const provider = createGoogleProvider({ config: { ...config, flowsPerAddress: 1 }, client });
  const res = response();
  const url = new URL(provider.begin(request(), res, '/editor'));
  const req = request(cookieOf(res));
  const generate = client.generateAuthUrl;
  client.generateAuthUrl = () => {
    throw new Error('URL failure');
  };
  assert.throws(() => provider.begin(req, response(), '/editor'), /URL failure/);
  client.generateAuthUrl = generate;
  provider.consume(req, response(), callback(url.searchParams.get('state'))).complete();
  provider.begin(request(), response(), '/editor');
});

test('global pool exhaustion still allows an admitted browser retry and recovers on callback completion', () => {
  const provider = createGoogleProvider({ config, client: testClient() });
  let admitted;
  for (let i = 0; i < 1000; i++) {
    const res = response();
    const req = { ...request(), socket: { remoteAddress: `192.0.2.${Math.floor(i / 50) + 1}` } };
    const url = new URL(provider.begin(req, res, '/editor'));
    if (i === 0)
      admitted = { req: { ...req, headers: { ...req.headers, cookie: cookieOf(res) } }, url };
  }
  const newcomer = { ...request(), socket: { remoteAddress: '198.51.100.1' } };
  assert.throws(() => provider.begin(newcomer, response(), '/editor'), { status: 429 });
  const retry = new URL(provider.begin(admitted.req, response(), '/editor'));
  assert.throws(
    () =>
      provider.consume(admitted.req, response(), callback(admitted.url.searchParams.get('state'))),
    { status: 401 },
  );
  const flow = provider.consume(
    admitted.req,
    response(),
    callback(retry.searchParams.get('state')),
  );
  flow.complete();
  provider.begin(newcomer, response(), '/editor');
});

test('rate limit configuration rejects invalid or unbounded quotas', () => {
  const defaults = readAuthConfig(environment);
  assert.equal(defaults.startsPerMinute, 60);
  assert.equal(defaults.flowsPerAddress, 50);
  for (const key of ['GOOGLE_AUTH_STARTS_PER_MINUTE', 'GOOGLE_AUTH_FLOWS_PER_ADDRESS']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '99999999999999999'])
      assert.throws(() => readAuthConfig({ ...environment, [key]: value }), new RegExp(key));
  }
  assert.throws(() => readAuthConfig({ ...environment, GOOGLE_AUTH_FLOWS_PER_ADDRESS: '1000' }));
  const configured = readAuthConfig({
    ...environment,
    GOOGLE_AUTH_STARTS_PER_MINUTE: '120',
    GOOGLE_AUTH_FLOWS_PER_ADDRESS: '80',
  });
  assert.equal(configured.startsPerMinute, 120);
  assert.equal(configured.flowsPerAddress, 80);
});

test('HTTP rejects excessive starts with Retry-After without breaking an admitted callback', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coin-google-limit-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = { ...config, startsPerMinute: 1 };
  const app = createGameServer({
    authoring: createAuthoring({
      accounts: new FileAccountRepository(join(dir, 'store.json')),
      authConfig: settings,
      googleClient: testClient(settings),
    }),
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(app.close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  settings.redirectUri = base + '/api/auth/google/callback';
  const started = await fetch(base + '/api/auth/google/start', { redirect: 'manual' });
  const state = new URL(started.headers.get('location')).searchParams.get('state');
  const cookie = started.headers.get('set-cookie').match(/coinhunter-oauth=[A-Za-z0-9_-]+/)[0];
  const blocked = await fetch(base + '/api/auth/google/start', {
    redirect: 'manual',
    headers: { cookie, 'x-forwarded-for': '192.0.2.99' },
  });
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get('retry-after'), /^[1-9]\d*$/);
  assert.doesNotMatch(blocked.headers.get('set-cookie') || '', /coinhunter-oauth=/);
  const finished = await fetch(base + `/api/auth/google/callback?state=${state}&code=code`, {
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(finished.status, 303);
  assert.equal(finished.headers.get('location'), '/');
  assert.match(finished.headers.get('set-cookie'), /coinhunter-session=/);
});

test('rate tracker memory is bounded and expired peer buckets permit new clients again', () => {
  let time = Date.now();
  const provider = createGoogleProvider({ config, client: testClient(), now: () => time });
  const peer = (address, cookie = '') => ({
    ...request(cookie),
    socket: { remoteAddress: address },
  });
  for (let i = 0; i < 4096; i++) {
    const address = `2001:db8::${i.toString(16)}`;
    const res = response();
    const url = new URL(provider.begin(peer(address), res, '/editor'));
    provider
      .consume(
        peer(address, cookieOf(res)),
        response(),
        callback(url.searchParams.get('state'), '&error=access_denied'),
      )
      .complete();
  }
  assert.throws(() => provider.begin(peer('2001:db8::ffff'), response(), '/editor'), {
    status: 429,
  });
  provider.begin(peer('2001:db8::0'), response(), '/editor');
  time += 60000;
  provider.begin(peer('2001:db8::ffff'), response(), '/editor');
});
