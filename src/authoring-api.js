import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createAccountRepository } from './persistence/account-repository.js';
import { fail } from './persistence/errors.js';
import { validateAlgorithm } from './runtime/preflight.js';
import { createMockProvider } from './auth/mock-provider.js';
import { createAuthenticationService } from './auth/authentication-service.js';
import { readAuthConfig } from './auth/config.js';
import { createGoogleProvider } from './auth/google-provider.js';
import { createMemorySessionStore } from './auth/memory-session-store.js';
import { readAiConfig } from './ai/config.js';
import { createAiStorage } from './ai/storage-service.js';
import { createAiModelCatalog } from './ai/model-catalog.js';
import { createAiRoutes } from './ai/routes.js';
import { createAiRequestService } from './ai/request-service.js';
import { createOpenAiGeneration } from './ai/openai-generation.js';
import { join } from 'node:path';

export function createAuthoring({
  accounts = createAccountRepository(),
  authConfig = readAuthConfig(),
  mock = authConfig.mode === 'mock',
  domain = process.env.MOCK_COMPANY_DOMAIN || 'company.test',
  googleClient,
  aiConfig = readAiConfig(),
  aiEnv = process.env,
  aiProviders,
  aiGenerationProviders,
  aiDiagnostics,
} = {}) {
  const google =
    authConfig.mode === 'google'
      ? createGoogleProvider({ config: authConfig, client: googleClient })
      : null;
  const sessions = createMemorySessionStore({
    secure: !!authConfig.secure,
    sameSite: google ? 'Lax' : 'Strict',
  });
  const authentication = createAuthenticationService({
    accounts,
    providers: [
      createMockProvider({ accounts, enabled: !google && mock, domain }),
      ...(google ? [google] : []),
    ],
    sessions,
    allowIdentitySignup: async () => !!google,
  });
  let aiStorage = null;
  let aiCatalog = null;
  let aiRequests = null;
  try {
    if (aiConfig.enabled) {
      aiStorage = createAiStorage({
        sessions,
        config: aiConfig,
        env: aiEnv,
        beforeConnectionChange: async (id) => {
          aiCatalog?.cancelConnection(id);
          aiRequests?.cancelConnection(id);
        },
      });
      aiCatalog = createAiModelCatalog({
        storage: aiStorage,
        sessions,
        config: aiConfig,
        providers: aiProviders,
      });
      aiRequests = createAiRequestService({
        storage: aiStorage,
        catalog: aiCatalog,
        sessions,
        config: aiConfig,
        providers: aiGenerationProviders || { openai: createOpenAiGeneration(aiConfig) },
        directory: join(aiEnv.AI_DATA_DIR || 'data/ai', 'requests'),
        onError: aiDiagnostics,
      });
    }
  } catch (error) {
    sessions.close();
    throw error;
  }
  const { current, requireUser } = authentication;
  const aiRoute = createAiRoutes({
    config: aiConfig,
    storage: aiStorage,
    catalog: aiCatalog,
    authentication,
    requests: aiRequests,
  });
  return {
    accounts,
    current,
    requireUser,
    aiStorage,
    aiCatalog,
    aiRequests,
    aiScope: authentication.scope,
    async close() {
      authentication.close();
      await aiRequests?.close();
      await aiCatalog?.close();
      await aiStorage?.close();
    },
    async route(request, response, url, user, readJson, json, revoke, readSourceFile) {
      if (await authentication.route(request, response, url, user, readJson, json, revoke))
        return true;
      const path = url.pathname;
      if (await aiRoute(request, response, url, user, readJson, json, readSourceFile)) return true;
      if (path.startsWith('/api/admin/')) {
        requireUser(user);
        if (user.role !== 'admin') throw fail(403, '관리자 권한이 필요합니다.');
        if (path === '/api/admin/users' && request.method === 'GET') {
          json(response, 200, { users: await accounts.listUsers() });
          return true;
        }
        const id = path.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/)?.[1];
        if (id && request.method === 'PUT') {
          const input = await readJson(request);
          if (id === user.id && (!input.active || input.role !== 'admin'))
            throw fail(409, '본인 관리자 계정은 중지하거나 강등할 수 없습니다.');
          const updated = await accounts.updateUser(id, input);
          if (!updated.active) {
            authentication.revokeUser(id);
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
          const opened = await accounts.openSource(user.id, sourceId);
          try {
            response.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Coinhunter-Metadata': encodeURIComponent(JSON.stringify(opened.metadata)),
            });
            await pipeline(opened.handle.createReadStream({ autoClose: false }), response);
          } finally {
            await opened.release();
          }
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
