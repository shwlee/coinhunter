import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { fail } from '../persistence/errors.js';
import { appendCookie } from './cookies.js';

const destinations = new Set([
  '/',
  '/editor',
  '/game',
  '/admin',
  '/admin/maps',
  '/admin/maps/editor',
]);
const lifetime = 10 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const browserToken = (request) =>
  request.headers.cookie?.match(/(?:^|;\s*)coinhunter-oauth=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];

export function createGoogleProvider({
  config,
  now = Date.now,
  client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    transporterOptions: { timeout: 10000 },
  }),
}) {
  const pending = new Map();
  const latest = new Map();
  const cookie = (value, age) =>
    `coinhunter-oauth=${value}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  function checkHost(request) {
    if (request.headers.host !== new URL(config.redirectUri).host)
      throw fail(400, 'Google 콜백과 같은 주소로 접속하세요.');
  }
  function prune() {
    for (const [state, flow] of pending) if (flow.expires <= now()) pending.delete(state);
    for (const [browser, flow] of latest) if (flow.expires <= now()) latest.delete(browser);
  }
  return {
    id: 'google',
    enabled: true,
    begin(request, response, next) {
      const callback = new URL(config.redirectUri);
      const target = destinations.has(next) ? next : '/';
      if (
        request.headers.host !== callback.host &&
        ['localhost', '127.0.0.1'].includes(callback.hostname)
      ) {
        const alternate = new URL(callback);
        alternate.hostname = callback.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        if (request.headers.host === alternate.host) {
          // Set the browser-bound OAuth cookie only on the registered callback host.
          const canonical = new URL('/api/auth/google/start', callback.origin);
          canonical.searchParams.set('next', target);
          return canonical.href;
        }
      }
      checkHost(request);
      prune();
      // Limit pending flows before allocating credentials. A repeated browser login replaces its flow.
      const previous = browserToken(request);
      if (previous)
        for (const [state, flow] of pending)
          if (equal(previous, flow.browser)) pending.delete(state);
      if (pending.size >= 1000 || (!latest.has(previous) && latest.size >= 1000))
        throw fail(429, '로그인 요청이 많습니다. 잠시 후 다시 시도하세요.');
      const state = random(),
        nonce = random(),
        browser = previous || random(),
        verifier = random();
      const flow = { browser, nonce, verifier, next: target, expires: now() + lifetime };
      pending.set(state, flow);
      latest.set(browser, flow);
      const url = client.generateAuthUrl({
        response_type: 'code',
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      appendCookie(response, cookie(browser, 600));
      return url;
    },
    consume(request, response, url) {
      checkHost(request);
      prune();
      const states = url.searchParams.getAll('state');
      const state = states.length === 1 ? states[0] : null;
      const flow = pending.get(state);
      if (!flow || !equal(browserToken(request), flow.browser))
        throw fail(401, '로그인 요청이 만료되었거나 일치하지 않습니다.');
      pending.delete(state); // Consume before any network request, including denied consent.
      const assertCurrent = () => {
        if (latest.get(flow.browser) !== flow || flow.expires <= now())
          throw fail(409, '새 로그인 요청으로 대체된 인증입니다.');
      };
      const complete = () => {
        if (latest.get(flow.browser) === flow) latest.delete(flow.browser);
      };
      // Keep the browser cookie across callbacks so a retry can supersede an in-flight exchange.
      // Late responses must not clear a newer attempt's cookie.
      if (url.searchParams.has('error')) return { ...flow, cancelled: true, complete };
      const codes = url.searchParams.getAll('code');
      if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        complete();
        throw fail(401, '인증 코드를 확인할 수 없습니다.');
      }
      return { ...flow, code: codes[0], assertCurrent, complete };
    },
    async authenticate(_request, credentials) {
      // Called only after the server has consumed a browser-bound flow; never expose a raw token login API.
      let payload;
      try {
        const { tokens } = await client.getToken({
          code: credentials.code,
          codeVerifier: credentials.verifier,
          redirect_uri: config.redirectUri,
        });
        if (!tokens.id_token) throw new Error('Missing ID token');
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: config.clientId,
        });
        payload = ticket.getPayload();
      } catch {
        // SDK exceptions may contain codes, credentials or token responses.
        throw fail(401, 'Google 인증을 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
      }
      if (
        !payload ||
        !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss) ||
        payload.aud !== config.clientId ||
        (payload.azp && payload.azp !== config.clientId) ||
        typeof payload.exp !== 'number' ||
        payload.exp <= now() / 1000 ||
        typeof payload.iat !== 'number' ||
        payload.iat > now() / 1000 + 300 ||
        !equal(payload.nonce, credentials.nonce) ||
        payload.email_verified !== true ||
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.sub.length > 255 ||
        typeof payload.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+$/.test(payload.email)
      )
        throw fail(401, 'Google 인증 정보를 확인할 수 없습니다.');
      const email = payload.email.toLowerCase();
      const restricted = config.allowedDomains.length || config.allowedEmails.length;
      // Workspace membership must be based on verified hd, not the email suffix or UI hd hint.
      if (
        restricted &&
        !config.allowedEmails.includes(email) &&
        !config.allowedDomains.includes(payload.hd?.toLowerCase())
      )
        throw fail(403, '이 서비스에 허용된 회사 계정으로 로그인하세요.');
      return { subject: payload.sub, email, emailVerified: true };
    },
  };
}
