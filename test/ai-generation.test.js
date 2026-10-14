import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenAiGeneration } from '../src/ai/openai-generation.js';
import { createAiRequestService } from '../src/ai/request-service.js';
import { readAiConfig } from '../src/ai/config.js';
import { validateGenerationInput, buildGenerationInput } from '../src/ai/input.js';
import { openAiLimitError } from '../src/ai/providers.js';
import { openAiStreamResponse } from '../scripts/fixtures/openai-stream.js';
import { readOpenAiStream } from '../src/ai/response-stream.js';

const source = `module.exports = class Player { initialize(n,c,r){ this.c=c; } getName(){ return 'AI'; } moveNext(map,p,items){ return -1; } };`;
const input = {
  connectionId: 'connection',
  modelId: 'gpt-5-mini',
  intent: 'generate',
  prompt: '짧은 경로로 코인을 수집하세요.',
  priorities: ['nearestCoin'],
};
const responseBody = (data = {}) => ({
  status: 'completed',
  output: [
    { type: 'reasoning' },
    {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: JSON.stringify({ source, explanation: '근처 코인 전략' }) },
      ],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, private: 'hidden' },
  ...data,
});
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coin-ai-generation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('OpenAI credit, spend, usage and rate limits are classified without exposing external messages', () => {
  for (const [providerCode, code] of [
    ['insufficient_quota', 'quota_exceeded'],
    ['credit_balance_exhausted', 'credit_exhausted'],
    ['project_spend_limit_exceeded', 'spend_limit_exceeded'],
    ['organization_spend_limit_exceeded', 'spend_limit_exceeded'],
    ['organization_usage_limit_exceeded', 'usage_limit_exceeded'],
    ['rate_limit_exceeded', 'provider_rate_limited'],
    ['slow_down', 'provider_rate_limited'],
  ]) {
    const error = openAiLimitError({ error: { code: providerCode, message: 'fixture-secret' } });
    assert.equal(error.code, code);
    assert.equal(error.source, 'openai');
    assert.equal(error.providerCode, providerCode);
    assert.equal(error.message.includes('fixture-secret'), false);
  }
  assert.equal(openAiLimitError({ error: { type: 'insufficient_quota' } }).code, 'quota_exceeded');
  for (const code of ['unexpected-secret', '__proto__', 'constructor']) {
    const error = openAiLimitError({ error: { code, message: 'fixture-secret' } });
    assert.equal(error.code, 'provider_limit_unknown');
    assert.equal(error.providerCode, undefined);
  }
});
async function waitFor(check) {
  const until = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > until) throw new Error('state timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('generation input validates strategy conflicts and includes authoritative rules without identity', async () => {
  assert.throws(
    () => validateGenerationInput({ ...input, priorities: ['hammer', 'avoidHammer'] }),
    /획득과 회피/,
  );
  for (const bad of [
    { ...input, ownerId: 'foreign' },
    { ...input, priorities: ['unknown'] },
    { ...input, prompt: '', priorities: [] },
    { ...input, priorities: ['hammer', 'hammer'] },
  ])
    assert.throws(() => validateGenerationInput(bad));
  const built = await buildGenerationInput(validateGenerationInput(input));
  assert.match(built.instructions, /500ms/);
  assert.match(built.instructions, /module.exports/);
  assert.equal(JSON.parse(built.input).priorities[0].weight, 5);
  assert.equal(built.input.includes('ownerId'), false);
});

test('real OpenAI transport uses fixed endpoint, structured output and no retained conversation', async (t) => {
  const dir = await directory(t),
    outputPath = join(dir, 'candidate.js');
  let sent;
  const provider = createOpenAiGeneration({
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'error');
      sent = JSON.parse(options.body);
      return openAiStreamResponse(responseBody());
    },
  });
  const result = await provider.generate({
    credential: 'fixture-secret',
    modelId: input.modelId,
    instructions: 'rules',
    input: 'request',
    signal: new AbortController().signal,
    outputPath,
  });
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(sent.truncation, 'disabled');
  assert.equal(sent.text.format.strict, true);
  assert.equal(JSON.stringify(sent).includes('fixture-secret'), false);
  assert.equal(await readFile(outputPath, 'utf8'), source);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 20, total_tokens: 30 });
});

function chunkedStream(text, size = 3) {
  const encoded = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < encoded.length; index += size)
          controller.enqueue(encoded.slice(index, index + size));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('stream parsing handles split UTF-8, CRLF and multiline SSE without exposing text', async () => {
  const updates = [],
    delta = '한글😀 fixture-secret';
  const terminal = JSON.stringify({ type: 'response.completed', response: responseBody() }, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\r\n');
  const response = chunkedStream(
    `: ping\r\n\r\nevent: response.created\r\ndata: ${JSON.stringify({ type: 'response.created' })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\r\n\r\n${terminal}\r\n\r\n`,
  );
  const result = await readOpenAiStream(response, new AbortController().signal, (value) =>
    updates.push(value),
  );
  assert.equal(result.body.status, 'completed');
  assert.equal(result.receivedChars, [...delta].length);
  assert.deepEqual(
    updates.map((value) => value.phase),
    ['accepted', 'receiving'],
  );
  assert.equal(JSON.stringify(updates).includes('fixture-secret'), false);
});

test('interrupted, malformed and mid-stream failure responses cannot create candidate files', async (t) => {
  const dir = await directory(t);
  const examples = [
    [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial source' })}\n\n`,
      'stream_interrupted',
    ],
    ['data: {broken}\n\n', 'invalid_response'],
    [
      `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'credit_balance_exhausted', message: 'fixture-secret' } } })}\n\n`,
      'credit_exhausted',
    ],
    [
      `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: 'fixture-secret' })}\n\n`,
      'refused',
    ],
  ];
  for (const [text, code] of examples) {
    const provider = createOpenAiGeneration({ fetchImpl: async () => chunkedStream(text) });
    await assert.rejects(
      provider.generate({
        credential: 'fixture-secret',
        modelId: input.modelId,
        instructions: 'rules',
        input: 'request',
        signal: new AbortController().signal,
        outputPath: join(dir, 'candidate.js'),
      }),
      (error) => error.code === code && !error.message.includes('fixture-secret'),
    );
  }
  assert.deepEqual(await readdir(dir), []);
});

test('cancelling a stream stops a pending read and never writes partial source', async (t) => {
  const dir = await directory(t),
    controller = new AbortController(),
    received = deferred();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  const provider = createOpenAiGeneration({ fetchImpl: async () => response });
  const running = provider.generate({
    credential: 'fixture-secret',
    modelId: input.modelId,
    instructions: 'rules',
    input: 'request',
    signal: controller.signal,
    outputPath: join(dir, 'candidate.js'),
    onProgress: () => received.resolve(),
  });
  await received.promise;
  controller.abort();
  await assert.rejects(running, { code: 'cancelled' });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(dir), []);
});

test('stream byte/frame limits bound oversized event data', async () => {
  const response = chunkedStream(`data: ${'x'.repeat(4 * 1024 * 1024 + 1)}\n\n`, 65536);
  await assert.rejects(readOpenAiStream(response, new AbortController().signal), {
    code: 'invalid_response',
  });
});

test('truncated, refused, malformed and credential-reflecting responses never become candidates', async (t) => {
  const dir = await directory(t);
  for (const body of [
    responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    responseBody({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }],
    }),
    responseBody({ output: [] }),
    responseBody({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ source: 'fixture-secret', explanation: '' }),
            },
          ],
        },
      ],
    }),
  ]) {
    const provider = createOpenAiGeneration({
      fetchImpl: async () => openAiStreamResponse(body),
    });
    await assert.rejects(
      provider.generate({
        credential: 'fixture-secret',
        modelId: input.modelId,
        instructions: 'rules',
        input: 'request',
        signal: new AbortController().signal,
        outputPath: join(dir, 'candidate.js'),
      }),
      (error) => !!error.code && !error.message.includes('fixture-secret'),
    );
  }
  assert.deepEqual(await readdir(dir), []);
});

test('provider rejects oversized input before network and sanitizes provider errors', async (t) => {
  const dir = await directory(t);
  const args = {
    credential: 'fixture-secret',
    modelId: input.modelId,
    instructions: 'rules',
    input: 'request',
    signal: new AbortController().signal,
    outputPath: join(dir, 'candidate.js'),
  };
  let called = false;
  const provider = createOpenAiGeneration({
    maxInputBytes: 2,
    fetchImpl: async () => {
      called = true;
    },
  });
  await assert.rejects(provider.generate(args), { code: 'input_too_large' });
  assert.equal(called, false);
  for (const [status, code] of [
    [401, 'credential_invalid'],
    [429, 'provider_limit_unknown'],
    [404, 'model_unavailable'],
    [500, 'unavailable'],
  ]) {
    const provider = createOpenAiGeneration({
      fetchImpl: async () => new Response('fixture-secret', { status }),
    });
    await assert.rejects(
      provider.generate(args),
      (error) => error.code === code && !error.message.includes('fixture-secret'),
    );
  }
});

async function fixture(t, options = {}) {
  const dir = await directory(t),
    listeners = new Set();
  let revision = 1,
    active = true,
    clock = Date.now();
  const scope = { ownerId: 'owner', sessionId: 'session' };
  const config = readAiConfig({
    AI_ENABLED: 'true',
    AI_MAX_RUNNING: '1',
    AI_MAX_CANDIDATES_PER_USER: '10',
    ...options.env,
  });
  const service = createAiRequestService({
    config,
    directory: dir,
    now: () => clock,
    sessions: {
      isActive: (s) => active && ['owner', 'other'].includes(s.ownerId),
      onRemoved: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    storage: {
      get: async () => ({ id: 'connection', provider: 'openai', revision }),
      credential: async () => ({ connection: { revision }, secret: 'fixture-secret' }),
    },
    catalog: { cached: async () => ({ state: 'ready', models: [{ id: input.modelId }] }) },
    providers: {
      openai: {
        generate: async (args) => {
          if (options.generate) return options.generate(args);
          await writeFile(args.outputPath, source, { flag: 'wx' });
          return { explanation: 'strategy', usage: { total_tokens: 30 }, finishReason: 'complete' };
        },
      },
    },
    ...(options.validate ? { validate: options.validate } : {}),
  });
  t.after(() => service.close());
  return {
    dir,
    service,
    scope,
    advance: (n) => {
      clock += n;
    },
    revise: () => {
      revision++;
    },
    logout: () => {
      active = false;
      for (const listener of listeners) listener({ sessionId: scope.sessionId });
    },
  };
}

test('requests generate and run the real preflight before offering an owner-bound file', async (t) => {
  const f = await fixture(t);
  const request = await f.service.prepare(f.scope, input);
  assert.equal(request.state, 'prepared');
  await f.service.start(f.scope, request.id);
  await waitFor(() => f.service.status(f.scope, request.id).state === 'completed');
  const result = f.service.status(f.scope, request.id);
  assert.equal(result.validation.calls, 24);
  assert.equal(result.candidateAvailable, true);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.throws(() => f.service.status({ ownerId: 'other', sessionId: 'session' }, request.id), {
    status: 404,
  });
  const opened = await f.service.openCandidate(f.scope, request.id);
  await f.service.cancel(f.scope, request.id);
  assert.equal(await opened.handle.readFile('utf8'), source); // Active readers hold cleanup.
  await opened.release();
  assert.deepEqual(await readdir(f.dir), []);
});

test('cancelled uncooperative work holds capacity and late results are discarded', async (t) => {
  const gate = deferred(),
    entered = deferred();
  let calls = 0;
  const f = await fixture(t, {
    validate: async () => ({ ok: true }),
    generate: async (args) => {
      calls++;
      entered.resolve();
      await gate.promise;
      await writeFile(args.outputPath, source);
      return { explanation: 'late', usage: {}, finishReason: 'complete' };
    },
  });
  const first = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, first.id);
  await entered.promise;
  await f.service.cancel(f.scope, first.id);
  const second = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, second.id);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(calls, 1);
  assert.equal(f.service.status(f.scope, second.id).state, 'queued');
  gate.resolve();
  await waitFor(() => calls === 2 && f.service.status(f.scope, second.id).state === 'completed');
  assert.equal(f.service.status(f.scope, first.id).candidateAvailable, false);
});

test('modify requires a file snapshot, rejects large AI input and preserves a validation-failed candidate', async (t) => {
  let inspected;
  const f = await fixture(t, {
    validate: async () => ({ error: 'undefined name', diagnostic: { line: 3, column: 1 } }),
    generate: async (args) => {
      inspected = JSON.parse(args.input).source;
      await writeFile(args.outputPath, source);
      return { explanation: 'modified', usage: {}, finishReason: 'complete' };
    },
  });
  const request = await f.service.prepare(f.scope, { ...input, intent: 'modify' });
  await assert.rejects(f.service.start(f.scope, request.id), { status: 409 });
  const file = join(f.dir, 'upload.js');
  await writeFile(file, source);
  await f.service.attachSource(f.scope, request.id, file);
  await writeFile(file, 'changed after snapshot');
  await f.service.start(f.scope, request.id);
  await waitFor(() => f.service.status(f.scope, request.id).state === 'validation_failed');
  assert.equal(inspected, source);
  assert.equal(f.service.status(f.scope, request.id).candidateAvailable, true);
  const large = await f.service.prepare(f.scope, { ...input, intent: 'modify' });
  await writeFile(file, 'x'.repeat(131073));
  await assert.rejects(f.service.attachSource(f.scope, large.id, file), {
    code: 'input_too_large',
  });
});

test('prepared expiry, connection revision and logout reject or discard late work', async (t) => {
  const f = await fixture(t, { validate: async () => ({ ok: true }) });
  const expired = await f.service.prepare(f.scope, input);
  f.advance(120001);
  assert.throws(() => f.service.status(f.scope, expired.id), { status: 404 });
  const changed = await f.service.prepare(f.scope, input);
  f.revise();
  await assert.rejects(f.service.start(f.scope, changed.id), { code: 'revision_conflict' });
  f.logout();
  assert.throws(() => f.service.status(f.scope, changed.id), { status: 401 });
});

test('progress metadata is monotonic, contains counters only and ignores late events after cancel', async (t) => {
  const gate = deferred(),
    reached = deferred();
  let notify;
  const f = await fixture(t, {
    validate: async () => ({ ok: true }),
    generate: async (args) => {
      notify = args.onProgress;
      notify({ phase: 'accepted', receivedChars: 0, source: 'fixture-secret' });
      notify({ phase: 'receiving', receivedChars: 20 });
      notify({ phase: 'accepted', receivedChars: 20 }); // Older phase cannot replace reception.
      notify({ phase: 'receiving', receivedChars: 1 });
      reached.resolve();
      await gate.promise;
      notify({ phase: 'receiving', receivedChars: 100 });
      await writeFile(args.outputPath, source);
      return { explanation: '', usage: {}, finishReason: 'complete' };
    },
  });
  const request = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, request.id);
  await reached.promise;
  const before = f.service.status(f.scope, request.id);
  assert.equal(before.progress.phase, 'receiving');
  assert.equal(before.progress.receivedChars, 20);
  assert.equal(JSON.stringify(before).includes('fixture-secret'), false);
  assert.equal(typeof before.progress.lastResponseAt, 'number');
  assert.equal(typeof before.serverTime, 'number');
  await f.service.cancel(f.scope, request.id);
  const cancelled = f.service.status(f.scope, request.id);
  notify({ phase: 'generated', receivedChars: 50 });
  assert.equal(f.service.status(f.scope, request.id).sequence, cancelled.sequence);
  gate.resolve();
  await f.service.close();
  assert.deepEqual(await readdir(f.dir), []);
});

test('timeout keeps an actual provider call reserved until it settles', async (t) => {
  const gate = deferred(),
    entered = deferred();
  let calls = 0;
  const f = await fixture(t, {
    env: { AI_REQUEST_TIMEOUT_MS: '40' },
    validate: async () => ({ ok: true }),
    generate: async (args) => {
      calls++;
      entered.resolve();
      if (calls === 1) await gate.promise;
      await writeFile(args.outputPath, source);
      return { explanation: '', usage: {}, finishReason: 'complete' };
    },
  });
  const first = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, first.id);
  await entered.promise;
  await waitFor(() => f.service.status(f.scope, first.id).state === 'failed');
  assert.equal(f.service.status(f.scope, first.id).error.code, 'timeout');
  const second = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, second.id);
  assert.equal(calls, 1);
  gate.resolve();
  await waitFor(() => f.service.status(f.scope, second.id).state === 'completed');
  assert.equal(f.service.status(f.scope, first.id).candidateAvailable, false);
});

test('logout during validation aborts the check and prevents completed metadata', async (t) => {
  const entered = deferred(),
    release = deferred();
  let signal;
  const f = await fixture(t, {
    validate: async (_source, _owner, _file, supplied) => {
      signal = supplied;
      entered.resolve();
      await release.promise;
      return { ok: true };
    },
  });
  const request = await f.service.prepare(f.scope, input);
  await f.service.start(f.scope, request.id);
  await entered.promise;
  f.logout();
  assert.equal(signal.aborted, true);
  release.resolve();
  await f.service.close();
  assert.deepEqual(await readdir(f.dir), []);
});

test('parallel start cannot enqueue twice, candidate quota and subscriber quota are enforced', async (t) => {
  const f = await fixture(t, {
    env: { AI_MAX_CANDIDATES_PER_USER: '1' },
    validate: async () => ({ ok: true }),
  });
  const request = await f.service.prepare(f.scope, input);
  await assert.rejects(f.service.prepare(f.scope, input), { code: 'rate_limited' });
  const releases = Array.from({ length: 5 }, () =>
    f.service.subscribe(f.scope, request.id, () => {}),
  );
  assert.throws(() => f.service.subscribe(f.scope, request.id, () => {}), { code: 'rate_limited' });
  releases.forEach((release) => release());
  const started = await Promise.allSettled([
    f.service.start(f.scope, request.id),
    f.service.start(f.scope, request.id),
  ]);
  assert.equal(started.filter((result) => result.status === 'fulfilled').length, 1);
  await waitFor(() => f.service.status(f.scope, request.id).state === 'completed');
  f.advance(900001);
  assert.throws(() => f.service.status(f.scope, request.id), { status: 404 });
  assert.equal((await f.service.prepare(f.scope, input)).state, 'prepared');
});
