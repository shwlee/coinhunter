import { AI_PROVIDERS, validModelId } from './contracts.js';

// Pure configuration: no provider calls, credentials, or encryption keys in this object.
export function readAiConfig(env = process.env) {
  const problem = (key) => {
    throw new Error(`AI 설정을 확인하세요: ${key}`);
  };
  const flag = (key, fallback) => {
    const value = env[key]?.trim();
    if (!value) return fallback;
    if (value !== 'true' && value !== 'false') problem(key);
    return value === 'true';
  };
  const integer = (key, fallback, max) => {
    const value = env[key]?.trim();
    if (!value) return fallback;
    const number = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > max) problem(key);
    return number;
  };
  const list = (key) => [
    ...new Set(
      (env[key] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const providers = list('AI_ALLOWED_PROVIDERS');
  const allowedProviders = providers.length ? providers : AI_PROVIDERS.map(({ id }) => id);
  if (allowedProviders.some((id) => !AI_PROVIDERS.some((p) => p.id === id)))
    problem('AI_ALLOWED_PROVIDERS');
  const allowedModels = {};
  for (const { id } of AI_PROVIDERS) {
    const key = `AI_${id.toUpperCase()}_ALLOWED_MODELS`;
    const models = list(key);
    if (models.some((model) => !validModelId(model))) problem(key);
    allowedModels[id] = Object.freeze(models);
  }
  const maxRunning = integer('AI_MAX_RUNNING', 2, 100);
  const maxRunningPerUser = integer('AI_MAX_RUNNING_PER_USER', 1, 100);
  if (maxRunningPerUser > maxRunning) problem('AI_MAX_RUNNING_PER_USER');
  const maxQueued = integer('AI_MAX_QUEUED', 10, 1000);
  const maxQueuedPerUser = integer('AI_MAX_QUEUED_PER_USER', 1, 1000);
  const maxPrepared = integer('AI_MAX_PREPARED', 20, 1000);
  const maxPreparedPerUser = integer('AI_MAX_PREPARED_PER_USER', 2, 1000);
  if (maxQueuedPerUser > maxQueued) problem('AI_MAX_QUEUED_PER_USER');
  if (maxPreparedPerUser > maxPrepared) problem('AI_MAX_PREPARED_PER_USER');
  return Object.freeze({
    enabled: flag('AI_ENABLED', false),
    // This is permission to offer storage, not proof that encryption is configured.
    allowStoredCredentials: flag('AI_ALLOW_STORED_CREDENTIALS', false),
    allowedProviders: Object.freeze(allowedProviders),
    // Empty lists mean discovered models may be used, never invented/unverified models.
    allowedModels: Object.freeze(allowedModels),
    maxRunning,
    maxRunningPerUser,
    maxQueued,
    maxQueuedPerUser,
    maxPrepared,
    maxPreparedPerUser,
    maxCandidatesPerUser: integer('AI_MAX_CANDIDATES_PER_USER', 3, 100),
    requestTimeoutMs: integer('AI_REQUEST_TIMEOUT_MS', 120000, 600000),
    connectionTimeoutMs: integer('AI_CONNECTION_TIMEOUT_MS', 10000, 60000),
    preparedTtlMs: integer('AI_PREPARED_TTL_MS', 120000, 600000),
    candidateTtlMs: integer('AI_CANDIDATE_TTL_MS', 900000, 86400000),
  });
}
