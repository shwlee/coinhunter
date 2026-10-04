import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createAccountRepository } from './persistence/account-repository.js';
import { fail } from './persistence/errors.js';
import { validateAlgorithm } from './runtime/preflight.js';

export function createAuthoring({
  accounts = createAccountRepository(),
  mock = process.env.AUTH_MODE
    ? process.env.AUTH_MODE === 'mock'
    : process.env.NODE_ENV !== 'production',
  domain = process.env.MOCK_COMPANY_DOMAIN || 'company.test',
} = {}) {
  if (mock && process.env.NODE_ENV === 'production')
    throw new Error('운영 환경에서는 목업 인증을 사용할 수 없습니다.');
  const sessions = new Map();
  const identities = [accounts.adminEmail, `developer@${domain}`, `tester@${domain}`];
  const tokenFor = (request) =>
    request.headers.cookie?.match(/(?:^|;\s*)coinhunter-session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  async function current(request) {
    const token = tokenFor(request);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return (await accounts.user(session.userId)) || null;
  }
  const requireUser = (user) => {
    if (!user) throw fail(401, '로그인이 필요합니다.');
    return user;
  };
  return {
    accounts,
    current,
    requireUser,
    async route(request, response, url, user, readJson, json, revoke, readSourceFile) {
      const path = url.pathname;
      if (path === '/api/session' && request.method === 'GET') {
        json(response, 200, { user, mock, identities: mock ? identities : [] });
        return true;
      }
      if (path === '/api/auth/mock' && request.method === 'POST') {
        if (
          !mock ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
        )
          throw fail(403, '로컬 개발에서만 목업 로그인을 사용할 수 있습니다.');
        const { email } = await readJson(request);
        if (!identities.includes(email)) throw fail(403, '등록된 개발용 계정을 선택하세요.');
        const next = await accounts.login(email);
        sessions.delete(tokenFor(request));
        for (const [key, session] of sessions)
          if (session.expires <= Date.now()) sessions.delete(key);
        const token = randomUUID();
        sessions.set(token, { userId: next.id, expires: Date.now() + 8 * 3600000 });
        response.setHeader(
          'Set-Cookie',
          `coinhunter-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        json(response, 200, { user: next });
        return true;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        sessions.delete(tokenFor(request));
        response.setHeader(
          'Set-Cookie',
          'coinhunter-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        );
        if (user) await revoke(user.id);
        json(response, 200, { ok: true });
        return true;
      }
      if (path.startsWith('/api/admin/')) {
        requireUser(user);
        if (user.role !== 'admin') throw fail(403, '관리자 권한이 필요합니다.');
        if (path === '/api/admin/users' && request.method === 'GET') {
          json(response, 200, { users: await accounts.listUsers() });
          return true;
        }
        const id = path.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/)?.[1];
        if (id && request.method === 'PUT') {
          const updated = await accounts.updateUser(id, await readJson(request));
          if (!updated.active) {
            for (const [token, session] of sessions)
              if (session.userId === id) sessions.delete(token);
            await revoke(id);
          }
          json(response, 200, updated);
          return true;
        }
      }
      if (path.startsWith('/api/algorithms')) {
        requireUser(user);
        if (path === '/api/algorithms/validate' && request.method === 'POST') {
          const raw = request.headers['content-type']?.split(';')[0] === 'text/plain';
          const sourcePath = raw ? await readSourceFile(request) : null;
          try {
            const source = sourcePath
              ? undefined
              : (await readJson(request, 2 * 1024 * 1024)).source;
            const result = await validateAlgorithm(source, user.id, sourcePath);
            json(response, result.ok ? 200 : 400, result);
          } catch (error) {
            json(response, error.status || 400, {
              error: String(error.message).slice(0, 500),
              diagnostic: Number.isInteger(error.pos)
                ? { offset: error.pos, line: error.loc.line, column: error.loc.column + 1 }
                : null,
            });
            return true;
          } finally {
            if (sourcePath) await unlink(sourcePath).catch(() => {});
          }
          return true;
        }
        if (path === '/api/algorithms') {
          if (request.method === 'GET') {
            json(response, 200, { algorithms: await accounts.list(user.id) });
            return true;
          }
          if (request.method === 'POST') {
            const raw = request.headers['content-type']?.split(';')[0] === 'text/plain';
            const sourcePath = raw ? await readSourceFile(request) : null;
            try {
              json(
                response,
                201,
                await accounts.save(
                  user.id,
                  null,
                  sourcePath
                    ? { name: url.searchParams.get('name') }
                    : await readJson(request, 2 * 1024 * 1024),
                  sourcePath,
                ),
              );
            } finally {
              if (sourcePath) await unlink(sourcePath).catch(() => {});
            }
            return true;
          }
        }
        const sourceId = path.match(/^\/api\/algorithms\/([a-f0-9-]+)\/source$/)?.[1];
        if (sourceId && request.method === 'GET') {
          const sourcePath = await accounts.sourcePath(user.id, sourceId);
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          await pipeline(createReadStream(sourcePath), response);
          return true;
        }
        const id = path.match(/^\/api\/algorithms\/([a-f0-9-]+)$/)?.[1];
        if (id && request.method === 'GET') {
          if (url.searchParams.get('metadata') === '1')
            json(response, 200, await accounts.metadata(user.id, id));
          else {
            const sourcePath = await accounts.sourcePath(user.id, id);
            if ((await stat(sourcePath)).size > 2 * 1024 * 1024)
              throw fail(413, '큰 코드는 코드 파일 다운로드 경로를 사용하세요.');
            json(response, 200, await accounts.get(user.id, id));
          }
          return true;
        }
        if (id && request.method === 'PUT') {
          const raw = request.headers['content-type']?.split(';')[0] === 'text/plain';
          const sourcePath = raw ? await readSourceFile(request) : null;
          try {
            json(
              response,
              200,
              await accounts.save(
                user.id,
                id,
                sourcePath
                  ? {
                      name: url.searchParams.get('name'),
                      revision: Number(url.searchParams.get('revision')),
                    }
                  : await readJson(request, 2 * 1024 * 1024),
                sourcePath,
              ),
            );
          } finally {
            if (sourcePath) await unlink(sourcePath).catch(() => {});
          }
          return true;
        }
      }
      if (path === '/api/history' && request.method === 'GET') {
        requireUser(user);
        json(response, 200, { history: await accounts.history(user.id) });
        return true;
      }
      return false;
    },
  };
}
