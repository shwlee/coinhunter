import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeStrategyInput,
  expandStrategyPriorities,
  buildStrategyRequest,
} from '../public/algorithm-strategy.js';
import { STRATEGY_TEMPLATES, PRIORITY_WEIGHTS } from '../public/strategy-templates.js';
import { loadAlgorithmContract } from '../src/algorithm-assistant/contract.js';
import { TURN_LIMIT_MS, ALGORITHM_MEMORY_LIMIT_BYTES } from '../src/runtime/policy.js';
import { validateGenerationInput, buildGenerationInput } from '../src/ai/input.js';
import { createGameServer } from '../src/server.js';
import { createAuthoring } from '../src/authoring-api.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { readAiConfig } from '../src/ai/config.js';
import { readAuthConfig } from '../src/auth/config.js';

const input = {
  intent: 'generate',
  prompt: '  코인을 모으세요.  ',
  priorities: ['nearestCoin', 'valuableCoin', 'hammer'],
};
const withConnection = (strategy) => ({
  ...strategy,
  connectionId: 'private-connection',
  modelId: 'model',
});
async function temporaryDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('provider-independent strategy input preserves rank, validation rules and detached values', () => {
  const normalized = normalizeStrategyInput(input);
  assert.equal(normalized.prompt, '코인을 모으세요.');
  assert.notEqual(normalized.priorities, input.priorities);
  assert.deepEqual(
    buildStrategyRequest(input).priorities.map(({ rank, weight }) => [rank, weight]),
    [
      [1, 5],
      [2, 3],
      [3, 1],
    ],
  );
  assert.deepEqual(
    buildStrategyRequest(input).priorities.map((entry) => entry.name),
    input.priorities.map((id) => STRATEGY_TEMPLATES.find((entry) => entry.id === id).label),
  );
  const reversed = buildStrategyRequest({ ...input, priorities: [...input.priorities].reverse() });
  assert.equal(reversed.priorities[0].name, '망치 획득');
  assert.equal(reversed.priorities[0].weight, 5);
  assert.deepEqual(normalizeStrategyInput({ ...input, priorities: [] }).priorities, []);
  assert.equal(normalizeStrategyInput({ ...input, prompt: '' }).prompt, '');
  assert.equal(normalizeStrategyInput({ ...input, prompt: '가'.repeat(8000) }).prompt.length, 8000);
  const { connectionId, modelId, ...apiStrategy } = validateGenerationInput(withConnection(input));
  assert.deepEqual(apiStrategy, normalized);
});

test('shared strategy validation rejects malformed, conflicting and identity-bearing inputs in both paths', () => {
  const invalid = [
    null,
    [],
    {},
    { ...input, ownerId: 'foreign' },
    { ...input, connectionId: 'not-strategy' },
    { ...input, intent: 'unknown' },
    { ...input, prompt: null },
    { ...input, prompt: 'a'.repeat(8001) },
    { ...input, prompt: ' ', priorities: [] },
    { ...input, priorities: null },
    { ...input, priorities: ['unknown'] },
    { ...input, priorities: ['hammer', 'hammer'] },
    { ...input, priorities: ['nearestCoin', 'valuableCoin', 'hammer', 'shoes'] },
    { ...input, priorities: Array(1) },
    ...[
      ['shoes', 'avoidShoes'],
      ['hammer', 'avoidHammer'],
      ['double', 'avoidDouble'],
      ['jump', 'avoidJump'],
    ].map((priorities) => ({ ...input, priorities })),
  ];
  for (const value of invalid)
    assert.throws(
      () => normalizeStrategyInput(value),
      (error) => error.code === 'invalid_input' && error.status === 400,
    );
  for (const value of invalid.filter(
    (value) => value && !Array.isArray(value) && !Object.hasOwn(value, 'connectionId'),
  ))
    assert.throws(
      () => validateGenerationInput(withConnection(value)),
      (error) => error.code === 'invalid_input' && error.status === 400,
    );
  assert.throws(() => expandStrategyPriorities(['hammer', 'avoidHammer']), /획득과 회피/);
});

test('contract uses current documents and runtime limits with separate API and copy output instructions', async () => {
  const contract = await loadAlgorithmContract();
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.language, 'javascript');
  assert.deepEqual(contract.limits, {
    turnMs: TURN_LIMIT_MS,
    memoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES,
  });
  assert.deepEqual(contract.strategies, STRATEGY_TEMPLATES);
  assert.deepEqual(contract.priorityWeights, PRIORITY_WEIGHTS);
  for (const path of [
    '../docs/algorithm-api.md',
    '../docs/game-rules.md',
    '../examples/nearest-coin.js',
  ])
    assert.ok(
      contract.instructions.includes(await readFile(new URL(path, import.meta.url), 'utf8')),
    );
  assert.match(contract.instructions, /500ms and 32MiB/);
  assert.equal(contract.instructions.includes('Return JSON'), false);
  assert.match(contract.outputInstructions.api, /Return JSON with source/);
  assert.match(contract.outputInstructions.prompt, /JavaScript 코드 블록 하나/);
  contract.strategies[0].label = 'changed';
  contract.priorityWeights[0] = -1;
  contract.outputInstructions.api = 'changed';
  const next = await loadAlgorithmContract();
  assert.deepEqual(next.strategies, STRATEGY_TEMPLATES);
  assert.deepEqual(next.priorityWeights, PRIORITY_WEIGHTS);
  assert.match(next.outputInstructions.api, /Return JSON/);
});

test('API generation keeps its request schema and exact modify source without identities or truncation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-assistant-http-'));
  const source = '// 引用 \" \\ ` ``` </source>\n' + '/* 한글 */\n'.repeat(20000);
  const path = join(dir, 'input.js');
  await writeFile(path, source);
  const contract = await loadAlgorithmContract();
  const request = await buildGenerationInput(
    validateGenerationInput(withConnection({ ...input, intent: 'modify' })),
    path,
  );
  assert.equal(
    request.instructions,
    `${contract.instructions}\n\n${contract.outputInstructions.api}`,
  );
  const payload = JSON.parse(request.input);
  assert.deepEqual(Object.keys(payload), ['intent', 'priorities', 'request', 'source']);
  assert.equal(payload.source, source);
  assert.equal(payload.intent, 'modify');
  assert.equal(payload.request, '코인을 모으세요.');
  assert.equal(request.input.includes('private-connection'), false);
  assert.deepEqual(buildStrategyRequest({ ...input, intent: 'modify' }, source), payload);
  assert.throws(() => buildStrategyRequest(input, {}), /수정할 코드/);
});

for (const enabled of [false, true])
  test(`authenticated contract is available with AI enabled=${enabled}, no credentials and no external calls`, async (t) => {
    const dir = await temporaryDirectory(t);
    const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
    const authoring = createAuthoring({
      accounts,
      authConfig: readAuthConfig({ AUTH_MODE: 'mock' }),
      aiConfig: readAiConfig({ AI_ENABLED: String(enabled) }),
      aiEnv: { AI_DATA_DIR: join(dir, 'ai') },
    });
    const { server, close } = createGameServer({ authoring });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await close();
      await rm(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const originalFetch = globalThis.fetch;
    let externalCalls = 0;
    t.mock.method(globalThis, 'fetch', (url, options) => {
      if (!String(url).startsWith(base + '/')) {
        externalCalls++;
        throw new Error('External request is forbidden in this test');
      }
      return originalFetch(url, options);
    });
    const endpoint = base + '/api/algorithm-assistant/contract';
    assert.equal((await fetch(endpoint)).status, 401);
    const guest = await fetch(base + '/api/session');
    const guestCookie = guest.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(endpoint, { headers: { cookie: guestCookie } })).status, 401);
    const login = await fetch(base + '/api/auth/mock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'developer@company.test' }),
    });
    assert.equal(login.status, 200);
    const { user } = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(endpoint, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const contract = await response.json();
    assert.deepEqual(contract, await loadAlgorithmContract());
    const text = JSON.stringify(contract);
    assert.equal(text.includes(user.email), false);
    assert.equal(text.includes(user.id), false);
    assert.equal(text.includes(cookie), false);
    const wrongMethod = await fetch(endpoint, { method: 'POST', headers: { cookie } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
    assert.equal(
      (await fetch(endpoint, { headers: { cookie, Origin: 'https://foreign.example' } })).status,
      403,
    );
    const sharedModule = await fetch(base + '/algorithm-strategy.js', { headers: { cookie } });
    assert.equal(sharedModule.status, 200);
    assert.match(sharedModule.headers.get('content-type'), /javascript/);
    assert.equal(
      (await fetch(base + '/api/ai/connections', { headers: { cookie } })).status,
      enabled ? 200 : 503,
    );
    if (enabled)
      assert.deepEqual(
        await authoring.aiStorage.list(await authoring.aiScope({ headers: { cookie } })),
        [],
      );
    await accounts.updateUser(user.id, { active: false, role: 'user' });
    assert.equal((await fetch(endpoint, { headers: { cookie } })).status, 401);
    assert.equal(externalCalls, 0);
  });
