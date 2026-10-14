import { AI_PROVIDERS, validateConnectionMetadata, validModelId } from './contracts.js';
import { aiError } from './providers.js';
import { fail } from '../persistence/errors.js';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

function fields(input, allowed) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw fail(400, 'AI 요청 입력을 확인하세요.');
  return input;
}
const revisionOf = (input) => {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw fail(400, 'AI 연결 리비전이 필요합니다.');
  return input.revision;
};
function modelAvailable(result, id) {
  if (
    id != null &&
    (result.state !== 'ready' ||
      !validModelId(id) ||
      !result.models.some((model) => model.id === id))
  )
    throw aiError('model_unavailable', 422);
}

export function createAiRoutes({ config, storage, catalog, authentication, requests }) {
  return async (request, response, url, user, readJson, json, readSourceFile) => {
    if (!url.pathname.startsWith('/api/ai/')) return false;
    try {
      authentication.requireUser(user);
      const scope = await authentication.scope(request);
      if (!scope) throw aiError('unauthenticated', 401);
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        request.headers.origin !== `http://${request.headers.host}`
      )
        throw fail(403, '같은 서비스 화면에서 요청하세요.');
      const path = url.pathname;
      if (path === '/api/ai/providers' && request.method === 'GET') {
        json(response, 200, {
          enabled: config.enabled,
          storedAvailable: storage?.storedAvailable || false,
          providers: AI_PROVIDERS.filter((provider) =>
            config.allowedProviders.includes(provider.id),
          ),
          generationAvailable: !!requests,
          generationProviders: requests?.providers || [],
        });
        return true;
      }
      if (!storage || !catalog) throw aiError('unavailable', 503);
      if (path.startsWith('/api/ai/requests')) {
        if (!requests) throw aiError('unavailable', 503);
        if (path === '/api/ai/requests' && request.method === 'POST') {
          json(response, 201, await requests.prepare(scope, await readJson(request)));
          return true;
        }
        const match = path.match(/^\/api\/ai\/requests\/([a-f0-9-]+)(?:\/(source|start|events))?$/);
        if (!match) throw fail(404, 'AI 요청을 찾을 수 없습니다.');
        const [, id, action] = match;
        requests.status(scope, id); // Check ownership before uploads or opening streams.
        if (!action && request.method === 'GET') json(response, 200, requests.status(scope, id));
        else if (!action && request.method === 'DELETE')
          json(response, 200, await requests.cancel(scope, id));
        else if (action === 'start' && request.method === 'POST') {
          fields(await readJson(request), []);
          json(response, 202, await requests.start(scope, id));
        } else if (action === 'source' && request.method === 'PUT') {
          const uploaded = await readSourceFile(request);
          try {
            await requests.attachSource(scope, id, uploaded);
            json(response, 200, requests.status(scope, id));
          } finally {
            await unlink(uploaded).catch(() => {});
          }
        } else if (action === 'source' && request.method === 'GET') {
          const opened = await requests.openCandidate(scope, id);
          try {
            response.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            await pipeline(opened.handle.createReadStream({ autoClose: false }), response);
          } finally {
            await opened.release();
          }
        } else if (action === 'events' && request.method === 'GET') {
          let detach, heartbeat;
          const stop = () => {
            clearInterval(heartbeat);
            detach?.();
            if (!response.writableEnded) response.end();
          };
          const send = (value) => {
            if (response.destroyed || response.writableEnded) {
              stop();
              return;
            }
            if (response.writableLength > 128 * 1024) {
              stop();
              return;
            }
            response.write(
              `id: ${value.sequence}\nevent: state\ndata: ${JSON.stringify(value)}\n\n`,
            );
            if (
              ['completed', 'validation_failed', 'failed', 'cancelled', 'expired'].includes(
                value.state,
              )
            )
              stop();
          };
          detach = requests.subscribe(scope, id, send);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          response.on('close', stop);
          heartbeat = setInterval(() => {
            try {
              requests.status(scope, id);
              response.write(': heartbeat\n\n');
            } catch {
              stop();
            }
          }, 15000);
          heartbeat.unref();
          send(requests.status(scope, id)); // Snapshot on every reconnect, no source or credentials.
        } else throw fail(405, '지원하지 않는 AI 생성 요청입니다.');
        return true;
      }
      if (path === '/api/ai/connections' && request.method === 'GET') {
        json(response, 200, {
          connections: await storage.list(scope),
          preference: await storage.preference(scope),
        });
      } else if (path === '/api/ai/connections' && request.method === 'POST') {
        const { apiKey, ...metadata } = fields(await readJson(request), [
          'name',
          'provider',
          'credentialMode',
          'defaultModelId',
          'apiKey',
        ]);
        const input = validateConnectionMetadata(metadata);
        if (input.credentialMode === 'stored' && !storage.storedAvailable)
          throw fail(
            503,
            '암호화 키 저장 설정이 준비되지 않았습니다. 이번 로그인 동안 사용하세요.',
          );
        const result = await catalog.verify(scope, input.provider, apiKey);
        modelAvailable(result, input.defaultModelId);
        const connection = await storage.create(scope, input, apiKey, {
          checkStatus: 'ready',
          checkedAt: result.checkedAt,
        });
        await catalog.remember(scope, connection, result);
        json(response, 201, { connection, catalog: result });
      } else if (path === '/api/ai/preferences' && request.method === 'PUT') {
        const input = fields(await readJson(request), ['connectionId', 'modelId']);
        let revision;
        if (input.connectionId !== null || input.modelId !== null) {
          if (!input.connectionId || !input.modelId)
            throw fail(400, '연결과 모델을 함께 선택하세요.');
          const selected = await storage.get(scope, input.connectionId);
          revision = selected.revision;
          modelAvailable(await catalog.ensure(scope, input.connectionId), input.modelId);
        }
        await storage.setPreference(scope, input, revision);
        json(response, 200, { preference: await storage.preference(scope) });
      } else {
        const match = path.match(
          /^\/api\/ai\/connections\/([a-f0-9-]+)(?:\/(check|models(?:\/refresh)?))?$/,
        );
        if (!match) throw fail(404, 'AI 메뉴를 찾을 수 없습니다.');
        const [, id, action] = match;
        const previous = await storage.get(scope, id);
        if (action === 'models' && request.method === 'GET') {
          json(
            response,
            200,
            url.searchParams.get('cacheOnly') === '1'
              ? await catalog.cached(scope, id)
              : await catalog.ensure(scope, id),
          );
        } else if (['check', 'models/refresh'].includes(action) && request.method === 'POST') {
          fields(await readJson(request), []);
          const result = await catalog.refresh(scope, id);
          const connection = await storage.recordCheck(
            scope,
            id,
            previous.revision,
            'ready',
            result.checkedAt,
          );
          await catalog.remember(scope, connection, result);
          json(response, 200, { connection, catalog: result });
        } else if (!action && request.method === 'PATCH') {
          const input = fields(await readJson(request), [
            'revision',
            'name',
            'defaultModelId',
            'apiKey',
          ]);
          const revision = revisionOf(input);
          if (previous.revision !== revision) throw aiError('revision_conflict', 409);
          // Separate key replacement from other edits so a failed verification never edits metadata.
          if (Object.hasOwn(input, 'apiKey')) {
            if (Object.keys(input).some((key) => !['revision', 'apiKey'].includes(key)))
              throw fail(400, 'API 키 교체는 다른 변경과 따로 진행하세요.');
            const result = await catalog.verify(scope, previous.provider, input.apiKey, id);
            const connection = await storage.replaceCredential(
              scope,
              id,
              revision,
              input.apiKey,
              undefined,
              { checkStatus: 'ready', checkedAt: result.checkedAt },
            );
            await catalog.remember(scope, connection, result);
            json(response, 200, { connection, catalog: result });
          } else {
            const { revision: _, ...changes } = input;
            const result = Object.hasOwn(changes, 'defaultModelId')
              ? await catalog.ensure(scope, id)
              : await catalog.cached(scope, id);
            if (Object.hasOwn(changes, 'defaultModelId'))
              modelAvailable(result, changes.defaultModelId);
            const connection = await storage.update(scope, id, revision, changes);
            if (result.state === 'ready') await catalog.remember(scope, connection, result);
            json(response, 200, { connection });
          }
        } else if (!action && request.method === 'DELETE') {
          const input = fields(await readJson(request), ['revision']);
          await storage.delete(scope, id, revisionOf(input));
          json(response, 200, { deleted: true });
        } else throw fail(405, '지원하지 않는 AI 요청입니다.');
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return true;
      }
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
      json(response, known ? error.status : 503, {
        error: known ? error.message : 'AI 연결 처리에 실패했습니다.',
        code: error.code || (known ? 'invalid_input' : 'unavailable'),
        ...(error.source ? { source: error.source } : {}),
      });
    }
    return true;
  };
}
