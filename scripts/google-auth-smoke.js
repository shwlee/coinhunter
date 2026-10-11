import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

// Google transport is replaced; the real SDK validates locally signed tokens.
const dir = await mkdtemp(join(tmpdir(), 'coin-google-browser-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  mode: 'google',
  clientId: 'browser-client',
  clientSecret: 'browser-secret',
  redirectUri: 'http://127.0.0.1:3000/api/auth/google/callback',
  secure: false,
  allowedDomains: [],
  allowedEmails: [],
};
const client = new OAuth2Client({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
});
let nonce,
  denied = true,
  exchanged = 0;
client.getToken = async (options) => {
  exchanged++;
  assert.ok(options.codeVerifier);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'RS256', kid: 'browser-key' })}.${encode({ iss: 'https://accounts.google.com', aud: config.clientId, sub: 'browser-sub', email: 'browser@example.test', email_verified: true, iat: now, exp: now + 3600, nonce })}`;
  return {
    tokens: {
      id_token: `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`,
    },
  };
};
client.getFederatedSignonCertsAsync = async () => ({
  certs: { 'browser-key': keys.publicKey.export({ type: 'spki', format: 'pem' }) },
  format: 'PEM',
});
const accounts = new FileAccountRepository(join(dir, 'store.json'));
const { server, close } = createGameServer({
  authoring: createAuthoring({ accounts, authConfig: config, googleClient: client }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
config.redirectUri = base + '/api/auth/google/callback';
client.redirectUri = config.redirectUri;
// A second local site replaces Google's consent page. Browser navigation and cookies remain real.
const consent = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  nonce = url.searchParams.get('nonce');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  const callback = new URL(config.redirectUri);
  callback.searchParams.set('state', url.searchParams.get('state'));
  callback.searchParams.set(denied ? 'error' : 'code', denied ? 'access_denied' : 'browser-code');
  denied = false;
  response.writeHead(302, { Location: callback.href });
  response.end();
});
await new Promise((resolve) => consent.listen(0, 'localhost', resolve));
const generateAuthUrl = client.generateAuthUrl.bind(client);
client.generateAuthUrl = (parameters) => {
  const actual = new URL(generateAuthUrl(parameters));
  assert.equal(actual.hostname, 'accounts.google.com');
  actual.protocol = 'http:';
  actual.hostname = 'localhost';
  actual.port = String(consent.address().port);
  return actual.href;
};
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base.replace('127.0.0.1', 'localhost') + '/signin?next=%2Feditor');
  await page.locator('#authenticate:enabled').waitFor();
  assert.equal(await page.locator('#mock-identity').isVisible(), false);
  assert.equal(await page.locator('#authenticate').textContent(), 'Google 계정으로 계속');
  await page.click('#authenticate');
  await page.locator('#entry-status').filter({ hasText: '인증에 실패' }).waitFor();
  assert.equal(exchanged, 0);
  await page.click('#authenticate');
  await page.waitForURL(base + '/editor');
  await page.locator('#account-bar').filter({ hasText: 'browser@example.test' }).waitFor();
  const session = await page.evaluate(async () => (await fetch('/api/session')).json());
  assert.equal(session.user.email, 'browser@example.test');
  assert.equal(session.user.role, 'user');
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((cookie) => cookie.name === 'coinhunter-session');
  assert.equal(authCookie.httpOnly, true);
  assert.equal(authCookie.sameSite, 'Lax');
  const flowCookie = cookies.find((cookie) => cookie.name === 'coinhunter-oauth');
  assert.equal(flowCookie.httpOnly, true);
  assert.equal(flowCookie.sameSite, 'Lax');
  assert.equal(flowCookie.path, '/api/auth/google');
  assert.equal(exchanged, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'artifacts/google-auth-editor.png', fullPage: true });
  console.log(
    'Google OAuth browser smoke passed: cancellation, retry, browser-bound callback, SDK verification, session and editor access. Google network transport was replaced.',
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error('Browser verification failed at:', new URL(page.url()).pathname);
    console.error(
      'Status:',
      await page
        .locator('#entry-status')
        .textContent()
        .catch(() => 'unavailable'),
    );
    await page.screenshot({ path: 'artifacts/google-auth-failure.png', fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  await close();
  await new Promise((resolve) => consent.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
