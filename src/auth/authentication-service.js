import { fail } from '../persistence/errors.js';
import { createMemorySessionStore } from './memory-session-store.js';

/** Providers authenticate requests; resolveAccount links verified identities to internal users.
 * Only the mock email resolver exists in this step. Google must supply its own sub-based resolver.
 */
export function createAuthenticationService({
  accounts,
  providers,
  sessions = createMemorySessionStore(),
  resolveAccount = (identity) => {
    if (identity.provider !== 'mock') throw fail(503, '인증 계정 연결이 구성되지 않았습니다.');
    return accounts.login(identity.email);
  },
}) {
  const registered = new Map();
  for (const provider of providers) {
    if (!provider.id || registered.has(provider.id))
      throw new Error('중복되거나 잘못된 인증 제공자');
    registered.set(provider.id, provider);
  }
  async function current(request) {
    const id = sessions.userId(request);
    if (!id) return null;
    const user = await accounts.user(id);
    if (!user || !user.active) {
      sessions.revokeUser(id);
      return null;
    }
    return user;
  }
  async function login(providerId, request, response, credentials) {
    const provider = registered.get(providerId);
    if (!provider) throw fail(403, '지원하지 않는 인증 방식입니다.');
    const identity = await provider.authenticate(request, credentials);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
      throw fail(401, '인증된 사용자 정보를 확인할 수 없습니다.');
    const account = await resolveAccount({ ...identity, provider: provider.id });
    // Read persisted status and role rather than accepting them from authentication credentials.
    const user = account?.id ? await accounts.user(account.id) : null;
    if (!user || !user.active) throw fail(403, '이용이 중지되었거나 사용할 수 없는 계정입니다.');
    sessions.issue(user.id, request, response);
    return user;
  }
  return {
    current,
    login,
    revokeUser: sessions.revokeUser,
    requireUser(user) {
      if (!user) throw fail(401, '로그인이 필요합니다.');
      return user;
    },
    async route(request, response, url, user, readJson, json, revoke) {
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const mock = registered.get('mock');
        json(response, 200, {
          user,
          mock: !!mock?.enabled,
          identities: mock?.enabled ? await mock.identities() : [],
        });
        return true;
      }
      if (url.pathname === '/api/auth/mock' && request.method === 'POST') {
        const next = await login('mock', request, response, await readJson(request));
        json(response, 200, { user: next });
        return true;
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        sessions.logout(request, response);
        if (user) await revoke(user.id);
        json(response, 200, { ok: true });
        return true;
      }
      return false;
    },
  };
}
