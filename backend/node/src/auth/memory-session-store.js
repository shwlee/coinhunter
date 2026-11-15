import { randomUUID } from 'node:crypto';
import { appendCookie } from './cookies.js';
import { fail } from '../persistence/errors.js';

const lifetimeMs = 8 * 3600000;
const tokenFor = (request) =>
  request.headers.cookie?.match(/(?:^|;\s*)coinhunter-session=([a-f0-9-]{36})(?:;|$)/)?.[1];

// One host, in-memory sessions. A restart intentionally requires another login.
export function createMemorySessionStore({
  now = Date.now,
  secure = false,
  sameSite = 'Strict',
} = {}) {
  const attributes = `HttpOnly; SameSite=${sameSite}; Path=/${secure ? '; Secure' : ''}`;
  const sessions = new Map();
  const listeners = new Set();
  let closed = false;
  const removeToken = (token) => {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    for (const listener of listeners) listener({ ownerId: session.userId, sessionId: session.id });
  };
  const remove = (request) => removeToken(tokenFor(request));
  const prune = () => {
    for (const [token, session] of sessions) if (session.expires <= now()) removeToken(token);
  };
  const timer = setInterval(prune, 60000);
  timer.unref();
  return {
    onRemoved(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    scope(request) {
      const session = sessions.get(tokenFor(request));
      if (!session) return null;
      if (session.expires <= now()) {
        remove(request);
        return null;
      }
      return { ownerId: session.userId, sessionId: session.id };
    },
    isActive(scope) {
      prune();
      return [...sessions.values()].some(
        (session) => session.id === scope.sessionId && session.userId === scope.ownerId,
      );
    },
    prune,
    close() {
      closed = true;
      clearInterval(timer);
      for (const token of sessions.keys()) removeToken(token);
      listeners.clear();
    },
    userId(request) {
      const token = tokenFor(request),
        session = sessions.get(token);
      if (!session) return null;
      if (session.expires <= now()) {
        removeToken(token);
        return null;
      }
      return session.userId;
    },
    issue(userId, request, response) {
      if (closed) throw fail(503, '인증 서비스가 종료되었습니다.');
      remove(request);
      const time = now();
      prune();
      const token = randomUUID();
      sessions.set(token, { id: randomUUID(), userId, expires: time + lifetimeMs });
      appendCookie(response, `coinhunter-session=${token}; ${attributes}; Max-Age=28800`);
    },
    remove,
    revokeUser(userId) {
      for (const [token, session] of sessions) if (session.userId === userId) removeToken(token);
    },
    logout(request, response) {
      remove(request);
      appendCookie(response, `coinhunter-session=; ${attributes}; Max-Age=0`);
    },
  };
}
