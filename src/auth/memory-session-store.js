import { randomUUID } from 'node:crypto';
import { appendCookie } from './cookies.js';

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
  const remove = (request) => sessions.delete(tokenFor(request));
  return {
    userId(request) {
      const token = tokenFor(request),
        session = sessions.get(token);
      if (!session) return null;
      if (session.expires <= now()) {
        sessions.delete(token);
        return null;
      }
      return session.userId;
    },
    issue(userId, request, response) {
      remove(request);
      const time = now();
      for (const [token, session] of sessions) if (session.expires <= time) sessions.delete(token);
      const token = randomUUID();
      sessions.set(token, { userId, expires: time + lifetimeMs });
      appendCookie(response, `coinhunter-session=${token}; ${attributes}; Max-Age=28800`);
    },
    remove,
    revokeUser(userId) {
      for (const [token, session] of sessions)
        if (session.userId === userId) sessions.delete(token);
    },
    logout(request, response) {
      remove(request);
      appendCookie(response, `coinhunter-session=; ${attributes}; Max-Age=0`);
    },
  };
}
