import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../src/server.js';
import { createAuthoring } from '../src/authoring-api.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { readAiConfig } from '../src/ai/config.js';
import { createAiProviders } from '../src/ai/providers.js';
import { readAuthConfig } from '../src/auth/config.js';
import { createOpenAiGeneration } from '../src/ai/openai-generation.js';
import { openAiStreamResponse } from '../scripts/fixtures/openai-stream.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(
  t,
  {
    transport,
    enabled = true,
    connectionLimit = 20,
    generationTransport,
    modelCacheTtlMs = 300000,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'coin-ai-api-'));
  const providers = createAiProviders({
    fetchImpl:
      transport ||
      (async (_, options) => {
        const key =
          options.headers.Authorization?.replace('Bearer ', '') ||
          options.headers['x-api-key'] ||
          options.headers['x-goog-api-key'];
        if (key === 'invalid-fixture')
          return new Response('{"error":"invalid-fixture"}', { status: 401 });
        return new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-5' },
              { id: 'gpt-5-mini' },
              { id: 'gpt-5-2025-08-07' },
              { id: 'gpt-image-1' },
              { id: 'text-embedding-3-small' },
            ],
            has_more: false,
            models: [
              { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
        );
      }),
  });
  const authoring = createAuthoring({
    authConfig: readAuthConfig({ AUTH_MODE: 'mock', NODE_ENV: 'development' }),
    accounts: new FileAccountRepository(join(dir, 'accounts.json')),
    aiConfig: readAiConfig({
      AI_ENABLED: String(enabled),
      AI_ALLOW_STORED_CREDENTIALS: 'true',
      AI_CONNECTION_COOLDOWN_MS: '1',
      AI_CONNECTION_TIMEOUT_MS: '1000',
      AI_MAX_CONNECTIONS_PER_USER: String(connectionLimit),
      AI_MODEL_CACHE_TTL_MS: String(modelCacheTtlMs),
    }),
    aiEnv: {
      AI_DATA_DIR: join(dir, 'ai'),
      AI_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
      AI_CREDENTIAL_KEY_ID: 'test-v1',
    },
    aiProviders: providers,
    ...(generationTransport
      ? {
          aiGenerationProviders: {
            openai: createOpenAiGeneration({ fetchImpl: generationTransport }),
          },
        }
      : {}),
  });
  const { server, close } = createGameServer({ authoring });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', data, cookie = '', origin = base) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        cookie,
        ...(origin ? { Origin: origin } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const login = async (email) => {
    const result = await call('/api/auth/mock', 'POST', { email });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie').split(';')[0];
  };
  return { dir, call, login, authoring };
}
const add = (credentialMode = 'session', provider = 'openai') => ({
  name: 'test connection',
  provider,
  credentialMode,
  apiKey: 'valid-fixture',
});

test('AI HTTP routes verify, manage, select and delete without exposing keys or internal references', async (t) => {
  const f = await fixture(t),
    cookie = await f.login('developer@company.test');
  assert.equal((await f.call('/api/ai/connections')).status, 401);
  assert.equal((await f.call('/api/ai/connections', 'POST', add(), cookie, '')).status, 403);
  assert.equal(
    (await f.call('/api/ai/connections', 'POST', { ...add(), apiKey: 'invalid-fixture' }, cookie))
      .status,
    422,
  );
  assert.deepEqual(
    (await (await f.call('/api/ai/connections', 'GET', undefined, cookie)).json()).connections,
    [],
  );
  let response = await f.call('/api/ai/connections', 'POST', add('stored'), cookie);
  assert.equal(response.status, 201);
  const body = await response.json();
  let record = body.connection;
  assert.equal(record.checkStatus, 'ready');
  const serialized = JSON.stringify(body);
  for (const field of ['valid-fixture', 'credentialRef', 'sessionId', 'ownerId'])
    assert.equal(serialized.includes(field), false);
  const disk = await readFile(join(f.dir, 'ai', 'connections.json'), 'utf8');
  assert.equal(disk.includes('valid-fixture'), false);
  const select = (modelId) =>
    f.call('/api/ai/preferences', 'PUT', { connectionId: record.id, modelId }, cookie);
  assert.equal((await select('not-returned')).status, 422);
  assert.equal((await select('gpt-image-1')).status, 422);
  assert.equal((await select('gpt-5-2025-08-07')).status, 422);
  assert.deepEqual(
    body.catalog.models.map((model) => model.name),
    ['GPT-5', 'GPT-5 Mini'],
  );
  assert.equal((await select('gpt-5')).status, 200);
  response = await f.call(
    `/api/ai/connections/${record.id}`,
    'PATCH',
    { revision: record.revision, name: 'renamed' },
    cookie,
  );
  assert.equal(response.status, 200);
  record = (await response.json()).connection;
  response = await f.call(
    `/api/ai/connections/${record.id}`,
    'PATCH',
    { revision: record.revision, apiKey: 'invalid-fixture' },
    cookie,
  );
  assert.equal(response.status, 422);
  const preservedModels = await (
    await f.call(`/api/ai/connections/${record.id}/models`, 'GET', undefined, cookie)
  ).json();
  assert.equal(preservedModels.state, 'ready');
  assert.equal(
    (await f.authoring.aiStorage.credential(await loginScope(f, cookie), record.id)).secret,
    'valid-fixture',
  );
  assert.equal(
    (
      await f.call(
        `/api/ai/connections/${record.id}`,
        'DELETE',
        { revision: record.revision - 1 },
        cookie,
      )
    ).status,
    409,
  );
  const foreign = await f.login('tester@company.test');
  assert.equal(
    (await f.call(`/api/ai/connections/${record.id}/models`, 'GET', undefined, foreign)).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `/api/ai/connections/${record.id}`,
        'PATCH',
        { revision: record.revision, apiKey: 'valid-fixture' },
        foreign,
      )
    ).status,
    404,
  );
  response = await f.call(`/api/ai/connections/${record.id}/check`, 'POST', {}, cookie);
  assert.equal(response.status, 200);
  record = (await response.json()).connection;
  assert.equal(
    (
      await f.call(
        `/api/ai/connections/${record.id}`,
        'DELETE',
        { revision: record.revision },
        cookie,
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await (await f.call('/api/ai/connections', 'GET', undefined, cookie)).json()).preference,
    { connectionId: null, modelId: null },
  );
});
const loginScope = (f, cookie) => f.authoring.aiScope({ headers: { cookie } });

test('unchanged connection can select and generate after its model cache expires without re-registering', async (t) => {
  let lookups = 0;
  let generated = 0,
    removed = false;
  const source = `module.exports = class Player { initialize(n,c,r){} getName(){return 'renewed';} moveNext(map,p,items){return -1;} };`;
  const f = await fixture(t, {
    modelCacheTtlMs: 30,
    transport: async () => {
      lookups++;
      return new Response(JSON.stringify({ data: [{ id: removed ? 'gpt-5-mini' : 'gpt-5' }] }));
    },
    generationTransport: async () => {
      generated++;
      return openAiStreamResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: JSON.stringify({ source, explanation: 'renewed' }) },
            ],
          },
        ],
      });
    },
  });
  const cookie = await f.login('developer@company.test');
  const connection = (await (await f.call('/api/ai/connections', 'POST', add(), cookie)).json())
    .connection;
  const scope = await loginScope(f, cookie);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await f.authoring.aiCatalog.cached(scope, connection.id)).state, 'not_loaded');
  const input = {
    connectionId: connection.id,
    modelId: 'gpt-5',
    intent: 'generate',
    prompt: '가까운 코인을 수집하세요.',
    priorities: [],
  };
  const prepared = await f.call('/api/ai/requests', 'POST', input, cookie);
  assert.equal(prepared.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const models = await f.call(
    `/api/ai/connections/${connection.id}/models`,
    'GET',
    undefined,
    cookie,
  );
  assert.equal(models.status, 200);
  assert.equal((await models.json()).state, 'ready');
  assert.equal(
    (await f.authoring.aiStorage.get(scope, connection.id)).revision,
    connection.revision,
  );
  assert.ok(lookups >= 3);
  const request = await prepared.json();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    (
      await f.call(
        '/api/ai/preferences',
        'PUT',
        { connectionId: connection.id, modelId: 'gpt-5' },
        cookie,
      )
    ).status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    (await f.call(`/api/ai/requests/${request.id}/start`, 'POST', {}, cookie)).status,
    202,
  );
  const events = await f.call(`/api/ai/requests/${request.id}/events`, 'GET', undefined, cookie);
  assert.match(await events.text(), /"state":"completed"/);
  assert.equal(generated, 1);
  assert.equal(
    (await f.authoring.aiStorage.get(scope, connection.id)).revision,
    connection.revision,
  );
  f.authoring.aiCatalog.cancelConnection(connection.id);
  removed = true;
  assert.equal((await f.call('/api/ai/requests', 'POST', input, cookie)).status, 422);
  assert.equal(
    generated,
    1,
    'A genuinely unavailable model must not invoke generation or switch models',
  );
});

test('generation HTTP preserves ownership, streams terminal snapshots and exposes only inspected source files', async (t) => {
  const source = `module.exports = class Player { initialize(n,c,r){} getName(){ return 'HTTP AI'; } moveNext(map,p,items){return -1;} };`;
  const f = await fixture(t, {
    generationTransport: async () =>
      openAiStreamResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ source, explanation: 'HTTP strategy' }),
              },
            ],
          },
        ],
        usage: { total_tokens: 50 },
      }),
  });
  const cookie = await f.login('developer@company.test');
  const connection = (await (await f.call('/api/ai/connections', 'POST', add(), cookie)).json())
    .connection;
  const input = {
    connectionId: connection.id,
    modelId: 'gpt-5',
    intent: 'generate',
    prompt: '코인 수집',
    priorities: [],
  };
  assert.equal((await f.call('/api/ai/requests', 'POST', input)).status, 401);
  assert.equal((await f.call('/api/ai/requests', 'POST', input, cookie, '')).status, 403);
  assert.equal(
    (await f.call('/api/ai/requests', 'POST', { ...input, modelId: 'gpt-image-1' }, cookie)).status,
    422,
  );
  const prepared = await f.call('/api/ai/requests', 'POST', input, cookie);
  assert.equal(prepared.status, 201);
  const record = await prepared.json();
  const foreign = await f.login('tester@company.test');
  for (const suffix of ['', '/source', '/events'])
    assert.equal(
      (await f.call(`/api/ai/requests/${record.id}${suffix}`, 'GET', undefined, foreign)).status,
      404,
    );
  assert.equal(
    (await f.call(`/api/ai/requests/${record.id}/source`, 'GET', undefined, cookie)).status,
    409,
  );
  assert.equal(
    (await f.call(`/api/ai/requests/${record.id}/start`, 'POST', {}, cookie)).status,
    202,
  );
  const events = await f.call(`/api/ai/requests/${record.id}/events`, 'GET', undefined, cookie);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const text = await events.text();
  assert.match(text, /"state":"completed"/);
  assert.equal(text.includes('valid-fixture'), false);
  assert.equal(text.includes('ownerId'), false);
  assert.equal(text.includes('module.exports'), false);
  assert.match(text, /"receivedChars":\d+/);
  const downloaded = await f.call(`/api/ai/requests/${record.id}/source`, 'GET', undefined, cookie);
  assert.equal(await downloaded.text(), source);
  assert.equal(
    (await f.call(`/api/ai/requests/${record.id}`, 'DELETE', undefined, cookie)).status,
    200,
  );
  assert.equal(
    (await f.call(`/api/ai/requests/${record.id}/source`, 'GET', undefined, cookie)).status,
    409,
  );
});

test('provider choices share verification quotas and session-only connections cannot cross logins', async (t) => {
  const f = await fixture(t),
    cookie = await f.login('developer@company.test');
  for (const provider of ['anthropic', 'openai', 'gemini']) {
    const response = await f.call('/api/ai/connections', 'POST', add('session', provider), cookie);
    assert.equal(response.status, 201);
  }
  const data = await (await f.call('/api/ai/connections', 'GET', undefined, cookie)).json();
  const second = await f.login('developer@company.test');
  assert.equal(
    (await f.call(`/api/ai/connections/${data.connections[0].id}/models`, 'GET', undefined, second))
      .status,
    404,
  );
  await f.call('/api/auth/logout', 'POST', {}, cookie);
  assert.equal((await f.call('/api/ai/connections', 'GET', undefined, cookie)).status, 401);
  const disabled = await fixture(t, { enabled: false }),
    other = await disabled.login('developer@company.test');
  const policy = await (await disabled.call('/api/ai/providers', 'GET', undefined, other)).json();
  assert.equal(policy.enabled, false);
  assert.equal((await disabled.call('/api/ai/connections', 'POST', add(), other)).status, 503);
});

test('pending replacement does not lock unrelated edits and cannot overwrite their revision', async (t) => {
  const held = deferred(),
    started = deferred();
  let waiting = false;
  const f = await fixture(t, {
    transport: async () => {
      if (waiting) {
        started.resolve();
        await held.promise;
      }
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
    },
  });
  t.after(() => held.resolve());
  const cookie = await f.login('developer@company.test');
  const record = (await (await f.call('/api/ai/connections', 'POST', add(), cookie)).json())
    .connection;
  waiting = true;
  const pending = f.call(
    `/api/ai/connections/${record.id}`,
    'PATCH',
    { revision: record.revision, apiKey: 'replacement-fixture' },
    cookie,
  );
  await started.promise;
  const rename = await f.call(
    `/api/ai/connections/${record.id}`,
    'PATCH',
    { revision: record.revision, name: 'edited while checking' },
    cookie,
  );
  assert.equal(rename.status, 200);
  held.resolve();
  assert.equal((await pending).status, 409);
  const current = await f.authoring.aiStorage.credential(await loginScope(f, cookie), record.id);
  assert.equal(current.secret, 'valid-fixture');
  assert.equal(current.connection.name, 'edited while checking');
});

test('logout during new-key verification cannot register a late persistent connection', async (t) => {
  const held = deferred(),
    started = deferred();
  const f = await fixture(t, {
    transport: async () => {
      started.resolve();
      await held.promise;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }));
    },
  });
  t.after(() => held.resolve());
  const cookie = await f.login('developer@company.test');
  const pending = f.call('/api/ai/connections', 'POST', add('stored'), cookie);
  await started.promise;
  assert.equal((await f.call('/api/auth/logout', 'POST', {}, cookie)).status, 200);
  held.resolve();
  assert.ok([401, 409].includes((await pending).status));
  const fresh = await f.login('developer@company.test');
  assert.deepEqual(
    (await (await f.call('/api/ai/connections', 'GET', undefined, fresh)).json()).connections,
    [],
  );
});

test('connection capacity rejects new credentials without changing existing connections', async (t) => {
  const f = await fixture(t, { connectionLimit: 1 });
  const cookie = await f.login('developer@company.test');
  assert.equal((await f.call('/api/ai/connections', 'POST', add(), cookie)).status, 201);
  assert.equal(
    (await f.call('/api/ai/connections', 'POST', { ...add(), apiKey: 'second-fixture' }, cookie))
      .status,
    429,
  );
  const records = (await (await f.call('/api/ai/connections', 'GET', undefined, cookie)).json())
    .connections;
  assert.equal(records.length, 1);
  const scope = await loginScope(f, cookie);
  assert.equal(
    (await f.authoring.aiStorage.credential(scope, records[0].id)).secret,
    'valid-fixture',
  );
});
