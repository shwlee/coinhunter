import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiProviders } from '../src/ai/providers.js';
import { createAiModelCatalog } from '../src/ai/model-catalog.js';
import { readAiConfig } from '../src/ai/config.js';
import { createAiStorage } from '../src/ai/storage-service.js';
import { createMemorySessionStore } from '../src/auth/memory-session-store.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('provider transports use fixed hosts, header credentials and actual model IDs', async () => {
  const requests = [];
  const providers = createAiProviders({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.hostname === 'api.openai.com')
        return json({ data: [{ id: 'text-model' }, { id: 'embedding-model' }] });
      if (url.hostname === 'api.anthropic.com')
        return json({
          data: [{ id: 'claude-test', display_name: 'Claude test' }],
          has_more: true,
          last_id: 'claude-test',
        });
      return json({
        models: [
          {
            name: 'models/gemini-test',
            displayName: 'Gemini test',
            supportedGenerationMethods: ['generateContent'],
          },
          { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'opaque +/ token',
      });
    },
  });
  const input = { credential: 'fixture-secret' };
  const openai = await providers.openai.listModels(input);
  assert.deepEqual(
    openai.models.map((m) => m.id),
    ['text-model', 'embedding-model'],
  );
  assert.ok(openai.models.every((m) => m.generationVerified === false));
  const anthropic = await providers.anthropic.listModels({ ...input, cursor: 'before +&/' });
  const gemini = await providers.gemini.listModels({ ...input, cursor: 'page +&/' });
  assert.equal(anthropic.nextCursor, 'claude-test');
  assert.deepEqual(
    gemini.models.map((m) => m.id),
    ['gemini-test'],
  );
  assert.equal(gemini.nextCursor, 'opaque +/ token');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-secret');
  assert.equal(requests[1].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[2].options.headers['x-goog-api-key'], 'fixture-secret');
  assert.equal(requests[1].url.searchParams.get('after_id'), 'before +&/');
  assert.equal(requests[2].url.searchParams.get('pageToken'), 'page +&/');
  for (const { url, options } of requests) {
    assert.equal(options.redirect, 'error');
    assert.equal(url.toString().includes('fixture-secret'), false);
  }
  await providers.openai.checkConnection(input);
});

test('provider errors exclude response bodies, transport errors and key material', async () => {
  for (const [status, code] of [
    [401, 'credential_invalid'],
    [403, 'credential_invalid'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [302, 'unavailable'],
  ]) {
    const providers = createAiProviders({
      fetchImpl: async () => json({ error: 'fixture-secret' }, status),
    });
    for (const provider of Object.values(providers))
      await assert.rejects(
        provider.checkConnection({ credential: 'fixture-secret' }),
        (e) => e.code === code && !e.message.includes('fixture-secret') && !e.cause,
      );
  }
  const providers = createAiProviders({
    fetchImpl: async () => {
      throw new Error('fixture-secret network trace');
    },
  });
  await assert.rejects(providers.openai.checkConnection({ credential: 'fixture-secret' }), {
    code: 'network_error',
  });
});

test('malformed, oversized and invalid pagination responses fail safely', async () => {
  for (const [id, body] of [
    ['openai', { data: [{}] }],
    ['openai', { data: 'wrong' }],
    ['anthropic', { data: [], has_more: true, last_id: null }],
    [
      'gemini',
      { models: [{ name: 'models/test', supportedGenerationMethods: 'generateContent' }] },
    ],
    ['gemini', { models: [], nextPageToken: '' }],
    ['openai', { data: [{ id: 'bad\nmodel' }] }],
  ]) {
    const providers = createAiProviders({ fetchImpl: async () => json(body) });
    await assert.rejects(providers[id].listModels({ credential: 'fixture-secret' }), {
      code: 'invalid_response',
    });
  }
  const oversized = createAiProviders({
    fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1)),
  });
  await assert.rejects(oversized.openai.listModels({ credential: 'fixture-secret' }), {
    code: 'invalid_response',
  });
  const malformed = createAiProviders({ fetchImpl: async () => new Response('not JSON') });
  await assert.rejects(malformed.openai.listModels({ credential: 'fixture-secret' }), {
    code: 'invalid_response',
  });
});

test('provider deadlines, caller cancellation and invalid inputs prevent late successes', async () => {
  let calls = 0;
  const providers = createAiProviders({
    timeoutMs: 10,
    fetchImpl: async (_, { signal }) => {
      calls++;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('secret')), { once: true });
      });
    },
  });
  await assert.rejects(providers.openai.listModels({ credential: 'key' }), { code: 'timeout' });
  const controller = new AbortController();
  controller.abort(new Error('secret'));
  await assert.rejects(
    providers.openai.listModels({ credential: 'key', signal: controller.signal }),
    { code: 'cancelled' },
  );
  for (const credential of ['', 'key\r\nAuthorization: other', '한글', ' key'])
    await assert.rejects(providers.openai.listModels({ credential }), { code: 'invalid_input' });
  await assert.rejects(
    providers.openai.listModels({ credential: 'key', cursor: 'https://evil.test' }),
    { code: 'invalid_input' },
  );
  assert.equal(calls, 1);
});

function fixture(t, options = {}) {
  const scope = { ownerId: randomUUID(), sessionId: randomUUID() };
  let active = true,
    revision = 1,
    clock = 100000,
    calls = 0;
  const listeners = new Set();
  const sessions = {
    isActive: (s) => active && s?.ownerId === scope.ownerId && s?.sessionId === scope.sessionId,
    onRemoved: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const selected = () => ({ id: 'connection', provider: 'openai', revision });
  const storage = {
    get: async (s) => {
      if (s.ownerId !== scope.ownerId) throw Object.assign(new Error('missing'), { status: 404 });
      return selected();
    },
    credential: async () => ({ secret: 'fixture-secret', connection: selected() }),
  };
  const provider = {
    listModels: async (input) => {
      calls++;
      return options.list
        ? options.list(input)
        : { models: [{ id: 'model-a', name: 'A', generationVerified: false }], nextCursor: null };
    },
  };
  const config = readAiConfig({
    AI_ENABLED: 'true',
    AI_CONNECTION_TIMEOUT_MS: '100',
    ...options.env,
  });
  const catalog = createAiModelCatalog({
    storage,
    sessions,
    config,
    providers: { openai: provider },
    now: () => clock,
  });
  t.after(() => catalog.close());
  return {
    scope,
    catalog,
    calls: () => calls,
    tick: (n = 1100) => {
      clock += n;
    },
    revise: () => {
      revision++;
    },
    logout: () => {
      active = false;
      for (const listener of listeners) listener(scope);
    },
  };
}

test('catalog discovers all pages, deduplicates and applies allowlist without inventing models', async (t) => {
  const f = fixture(t, {
    env: { AI_OPENAI_ALLOWED_MODELS: 'model-a,not-returned' },
    list: async ({ cursor }) =>
      cursor
        ? { models: [{ id: 'model-a', name: 'A' }], nextCursor: null }
        : {
            models: [
              { id: 'model-b', name: 'B' },
              { id: 'model-a', name: 'A' },
            ],
            nextCursor: 'next',
          },
  });
  assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
  await assert.rejects(f.catalog.cached(null, 'connection'), { code: 'unauthenticated' });
  const result = await f.catalog.refresh(f.scope, 'connection');
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['model-a'],
  );
  assert.equal(f.calls(), 2);
  result.models[0].name = 'tamper';
  assert.equal((await f.catalog.cached(f.scope, 'connection')).models[0].name, 'A');
  await assert.rejects(f.catalog.refresh(f.scope, 'connection'), { code: 'rate_limited' });
  f.revise();
  assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
  f.tick(300001);
  assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
  await assert.rejects(
    f.catalog.cached({ ownerId: 'foreign', sessionId: 'foreign' }, 'connection'),
    { code: 'unauthenticated' },
  );
});

test('catalog discards late results on logout, key revision or connection cancellation', async (t) => {
  for (const action of ['logout', 'revise', 'cancel']) {
    const held = deferred(),
      started = deferred();
    const f = fixture(t, {
      list: async () => {
        started.resolve();
        return held.promise;
      },
    });
    const operation = f.catalog.refresh(f.scope, 'connection');
    const rejected = assert.rejects(operation, (e) =>
      ['unauthenticated', 'revision_conflict', 'cancelled'].includes(e.code),
    );
    await started.promise;
    if (action === 'cancel') f.catalog.cancelConnection('connection');
    else f[action]();
    held.resolve({ models: [{ id: 'late', name: 'late' }], nextCursor: null });
    await rejected;
    if (action !== 'logout')
      assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
  }
});

test('timeout keeps actual running capacity occupied until transport settles', async (t) => {
  const held = deferred(),
    started = deferred();
  const f = fixture(t, {
    env: { AI_CONNECTION_TIMEOUT_MS: '10' },
    list: async () => {
      started.resolve();
      return held.promise;
    },
  });
  const operation = f.catalog.refresh(f.scope, 'connection');
  await started.promise;
  await assert.rejects(operation, { code: 'timeout' });
  f.tick();
  await assert.rejects(f.catalog.refresh(f.scope, 'connection'), { code: 'rate_limited' });
  held.resolve({ models: [{ id: 'late', name: 'late' }], nextCursor: null });
  await new Promise((done) => setImmediate(done));
  assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
});

test('pagination cycles and failures do not overwrite a previous catalog', async (t) => {
  let fail = false;
  const f = fixture(t, {
    list: async () => ({
      models: [{ id: 'model-a', name: 'A' }],
      nextCursor: fail ? 'cycle' : null,
    }),
  });
  await f.catalog.refresh(f.scope, 'connection');
  f.tick();
  fail = true;
  await assert.rejects(f.catalog.refresh(f.scope, 'connection'), { code: 'invalid_response' });
  const previous = await f.catalog.cached(f.scope, 'connection');
  assert.equal(previous.models[0].id, 'model-a');
  assert.equal(previous.state, 'stale');
  assert.equal(previous.errorCode, 'invalid_response');
});

test('real storage isolates users and cancels lookup on key replacement and logout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coin-ai-catalog-'));
  const sessions = createMemorySessionStore();
  const config = readAiConfig({ AI_ENABLED: 'true', AI_CONNECTION_COOLDOWN_MS: '1' });
  let catalog;
  const storage = createAiStorage({
    sessions,
    config,
    env: { AI_DATA_DIR: dir },
    beforeConnectionChange: async (id) => catalog?.cancelConnection(id),
  });
  const held = deferred(),
    started = deferred();
  let hold = false;
  const providers = createAiProviders({
    fetchImpl: async () => {
      if (hold) {
        started.resolve();
        return held.promise;
      }
      return json({ data: [{ id: 'model-a' }] });
    },
  });
  catalog = createAiModelCatalog({ storage, sessions, config, providers });
  t.after(async () => {
    held.resolve(json({ data: [] }));
    sessions.close();
    await catalog.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  function login(ownerId = randomUUID()) {
    const response = {
      headers: {},
      getHeader(name) {
        return this.headers[name];
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
    };
    sessions.issue(ownerId, { headers: {} }, response);
    const request = { headers: { cookie: response.headers['Set-Cookie'].split(';')[0] } };
    return { request, scope: sessions.scope(request) };
  }
  const a = login(),
    b = login(),
    another = login(a.scope.ownerId);
  const record = await storage.create(
    a.scope,
    { name: 'test', provider: 'openai' },
    'fixture-secret',
  );
  await catalog.refresh(a.scope, record.id);
  await assert.rejects(catalog.cached(b.scope, record.id), { status: 404 });
  await assert.rejects(catalog.cached(another.scope, record.id), { status: 404 });
  const changed = await storage.replaceCredential(
    a.scope,
    record.id,
    record.revision,
    'replacement-fixture',
  );
  assert.equal((await catalog.cached(a.scope, record.id)).state, 'not_loaded');
  hold = true;
  const lookup = catalog.refresh(a.scope, record.id);
  const rejection = assert.rejects(lookup, (e) =>
    ['unauthenticated', 'cancelled'].includes(e.code),
  );
  await started.promise;
  sessions.remove(a.request);
  held.resolve(json({ data: [{ id: 'late-result' }] }));
  await rejection;
  assert.ok(changed.revision > record.revision);
  await assert.rejects(catalog.cached(a.scope, record.id), { code: 'unauthenticated' });
});

test('invalid credential refresh removes a previously usable catalog', async (t) => {
  let invalid = false;
  const f = fixture(t, {
    list: async () => {
      if (invalid) throw Object.assign(new Error('safe'), { code: 'credential_invalid' });
      return { models: [{ id: 'model-a', name: 'A' }], nextCursor: null };
    },
  });
  await f.catalog.refresh(f.scope, 'connection');
  f.tick();
  invalid = true;
  await assert.rejects(f.catalog.refresh(f.scope, 'connection'), { code: 'credential_invalid' });
  assert.equal((await f.catalog.cached(f.scope, 'connection')).state, 'not_loaded');
});
