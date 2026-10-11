import test from 'node:test';
import assert from 'node:assert/strict';
import { readAiConfig } from '../src/ai/config.js';
import { validateConnectionMetadata, publicConnection } from '../src/ai/contracts.js';

test('AI defaults are disabled, session-only, bounded and immutable without secrets', () => {
  const config = readAiConfig({ AI_MASTER_KEY: 'private', OPENAI_API_KEY: 'private' });
  assert.equal(config.enabled, false);
  assert.equal(config.allowStoredCredentials, false);
  assert.deepEqual(config.allowedProviders, ['anthropic', 'openai', 'gemini']);
  assert.equal(config.maxRunningPerUser, 1);
  assert.equal(config.maxRunning, 2);
  assert.equal(config.candidateTtlMs, 900000);
  assert.equal(JSON.stringify(config).includes('private'), false);
  assert.throws(() => config.allowedProviders.push('other'), TypeError);
  assert.throws(() => config.allowedModels.openai.push('other'), TypeError);
});

test('AI configuration validates quotas, boolean switches and discovered-model policies', () => {
  const config = readAiConfig({
    AI_ENABLED: 'true',
    AI_ALLOWED_PROVIDERS: 'openai,gemini,openai',
    AI_OPENAI_ALLOWED_MODELS: 'model-a,model-a,model-b',
    AI_MAX_RUNNING: '4',
    AI_MAX_RUNNING_PER_USER: '2',
  });
  assert.deepEqual(config.allowedProviders, ['openai', 'gemini']);
  assert.deepEqual(config.allowedModels.openai, ['model-a', 'model-b']);
  for (const env of [
    { AI_ENABLED: 'yes' },
    { AI_ALLOW_STORED_CREDENTIALS: '1' },
    { AI_ALLOWED_PROVIDERS: 'unknown' },
    { AI_MAX_RUNNING: '0' },
    { AI_MAX_RUNNING: '2.5' },
    { AI_MAX_RUNNING: '101' },
    { AI_MAX_RUNNING_PER_USER: '3' },
    { AI_MAX_QUEUED_PER_USER: '11' },
    { AI_MAX_PREPARED_PER_USER: '21' },
    { AI_REQUEST_TIMEOUT_MS: 'Infinity' },
    { AI_CANDIDATE_TTL_MS: '-1' },
    { AI_MAX_CONNECTION_RUNNING_PER_USER: '3' },
    { AI_CONNECTION_COOLDOWN_MS: '0' },
    { AI_MODEL_CACHE_TTL_MS: 'invalid' },
    { AI_OPENAI_ALLOWED_MODELS: 'invalid model' },
  ])
    assert.throws(() => readAiConfig(env), /AI 설정/);
  assert.throws(
    () => readAiConfig({ AI_ENABLED: 'secret-value' }),
    (error) => !error.message.includes('secret-value'),
  );
});

test('connection metadata excludes credentials and ownership and defaults to session scope', () => {
  const input = { name: ' 업무용 ', provider: 'anthropic' };
  assert.deepEqual(validateConnectionMetadata(input), {
    name: '업무용',
    provider: 'anthropic',
    credentialMode: 'session',
    defaultModelId: null,
  });
  for (const field of ['apiKey', 'credentialRef', 'ownerId', 'sessionId', 'company', 'endpoint'])
    assert.throws(
      () => validateConnectionMetadata({ ...input, [field]: 'secret' }),
      (error) => error.status === 400 && !error.message.includes('secret'),
    );
  for (const invalid of [
    null,
    [],
    {},
    { ...input, name: ' ' },
    { ...input, provider: 'claude' },
    { ...input, credentialMode: 'localStorage' },
    { ...input, defaultModelId: 'model\nheader' },
  ])
    assert.throws(() => validateConnectionMetadata(invalid));
});

test('public connection projection excludes present and future secret fields', () => {
  const projected = publicConnection({
    id: 'id',
    ownerId: 'owner',
    sessionId: 'session',
    name: 'my connection',
    provider: 'gemini',
    credentialMode: 'stored',
    credentialRef: 'reference',
    apiKey: 'private',
    internalPath: 'private',
    futureSecret: 'private',
    defaultModelId: 'model-a',
    revision: 2,
    checkStatus: 'unchecked',
  });
  assert.equal(projected.name, 'my connection');
  assert.equal(projected.revision, 2);
  assert.equal(JSON.stringify(projected).includes('private'), false);
  for (const key of [
    'ownerId',
    'sessionId',
    'credentialRef',
    'apiKey',
    'internalPath',
    'futureSecret',
  ])
    assert.equal(Object.hasOwn(projected, key), false);
});
