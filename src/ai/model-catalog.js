import { aiError, createAiProviders } from './providers.js';
import { selectRepresentativeModels } from './model-selection.js';

// No credentials, external response bodies or durable model lists are cached.
export function createAiModelCatalog({
  storage,
  sessions,
  config,
  providers = createAiProviders({ timeoutMs: config.connectionTimeoutMs }),
  now = Date.now,
}) {
  const cache = new Map();
  const running = new Set();
  const lastStart = new Map();
  let closed = false;
  function guard(scope) {
    if (
      closed ||
      !scope ||
      typeof scope.ownerId !== 'string' ||
      typeof scope.sessionId !== 'string' ||
      !sessions.isActive(scope)
    )
      throw aiError('unauthenticated', 401);
    if (!config.enabled) throw aiError('unavailable', 503);
  }
  const detach = sessions.onRemoved(({ sessionId }) => {
    for (const job of running) if (job.scope.sessionId === sessionId) job.controller.abort();
    for (const [key, value] of cache) if (value.sessionId === sessionId) cache.delete(key);
  });
  const keyFor = (scope, connection) =>
    JSON.stringify([scope.ownerId, scope.sessionId, connection.id, connection.revision]);
  async function connection(scope, id) {
    guard(scope);
    const value = await storage.get(scope, id);
    guard(scope);
    if (!config.allowedProviders.includes(value.provider)) throw aiError('unavailable', 503);
    return value;
  }
  return {
    async cached(scope, id) {
      const selected = await connection(scope, id);
      const key = keyFor(scope, selected);
      const value = cache.get(key);
      if (!value || value.expiresAt <= now()) {
        cache.delete(key);
        return { state: 'not_loaded', models: [], checkedAt: null };
      }
      return {
        state: value.state || 'ready',
        models: value.models.map((model) => ({ ...model })),
        checkedAt: value.checkedAt,
        ...(value.errorCode ? { errorCode: value.errorCode } : {}),
      };
    },
    async remember(scope, selected, result) {
      const current = await connection(scope, selected.id);
      if (current.revision !== selected.revision) throw aiError('revision_conflict', 409);
      const allowed = config.allowedModels[selected.provider];
      for (const key of cache.keys()) if (JSON.parse(key)[2] === selected.id) cache.delete(key);
      while (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(keyFor(scope, selected), {
        sessionId: scope.sessionId,
        expiresAt: Date.parse(result.checkedAt) + config.modelCacheTtlMs,
        checkedAt: result.checkedAt,
        models: selectRepresentativeModels(selected.provider, result.models, allowed),
      });
    },
    verify(scope, provider, credential, id = null) {
      return this.refresh(scope, id, { provider, credential });
    },
    async refresh(scope, id, verification = null) {
      guard(scope);
      const selected = id
        ? await connection(scope, id)
        : { id: null, provider: verification?.provider, revision: 0 };
      if (
        !config.allowedProviders.includes(selected.provider) ||
        (verification && verification.provider !== selected.provider)
      )
        throw aiError('invalid_input', 400);
      if (
        running.size >= config.maxConnectionRunning ||
        [...running].filter((job) => job.scope.ownerId === scope.ownerId).length >=
          config.maxConnectionRunningPerUser
      )
        throw aiError('rate_limited', 429, 'service');
      for (const [owner, time] of lastStart)
        if (time + config.connectionCooldownMs <= now()) lastStart.delete(owner);
      if (lastStart.has(scope.ownerId) || lastStart.size >= 1000)
        throw aiError('rate_limited', 429, 'service');
      lastStart.set(scope.ownerId, now());
      const job = { scope: { ...scope }, id, controller: new AbortController() };
      running.add(job);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const previous = verification ? null : cache.get(keyFor(scope, selected));
          if (previous) {
            previous.state = 'stale';
            previous.errorCode = 'timeout';
          }
          job.controller.abort();
          reject(aiError('timeout', 504));
        }, config.connectionTimeoutMs);
      });
      const work = (async () => {
        try {
          const { secret, connection: current } = verification
            ? { secret: verification.credential, connection: selected }
            : await storage.credential(scope, id);
          if (current.revision !== selected.revision) throw aiError('revision_conflict', 409);
          const models = new Map();
          const cursors = new Set();
          let cursor;
          for (let page = 0; ; page++) {
            guard(scope);
            if (job.controller.signal.aborted) throw aiError('cancelled', 409);
            if (page >= 20) throw aiError('invalid_response');
            const result = await providers[selected.provider].listModels({
              credential: secret,
              cursor,
              signal: job.controller.signal,
            });
            for (const model of result.models) models.set(model.id, model);
            if (models.size > 1000) throw aiError('invalid_response');
            if (!result.nextCursor) break;
            if (cursors.has(result.nextCursor)) throw aiError('invalid_response');
            cursors.add(result.nextCursor);
            cursor = result.nextCursor;
          }
          guard(scope);
          if (job.controller.signal.aborted) throw aiError('cancelled', 409);
          if (id && (await connection(scope, id)).revision !== selected.revision)
            throw aiError('revision_conflict', 409);
          guard(scope);
          if (job.controller.signal.aborted) throw aiError('cancelled', 409);
          const allowed = config.allowedModels[selected.provider];
          const value = {
            sessionId: scope.sessionId,
            expiresAt: now() + config.modelCacheTtlMs,
            checkedAt: new Date(now()).toISOString(),
            models: selectRepresentativeModels(selected.provider, [...models.values()], allowed),
          };
          if (!verification) {
            for (const [key, item] of cache) if (item.expiresAt <= now()) cache.delete(key);
            while (cache.size >= 128) cache.delete(cache.keys().next().value);
            cache.set(keyFor(scope, selected), value);
          }
          return {
            state: 'ready',
            models: value.models.map((model) => ({ ...model })),
            checkedAt: value.checkedAt,
          };
        } catch (error) {
          const key = keyFor(scope, selected);
          const previous = verification ? null : cache.get(key);
          if (!verification && error.code === 'credential_invalid') cache.delete(key);
          else if (previous && !job.controller.signal.aborted) {
            previous.state = 'stale';
            previous.errorCode = error.code || 'unavailable';
          }
          throw error;
        } finally {
          running.delete(job);
        }
      })();
      job.work = work;
      try {
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    cancelConnection(id) {
      for (const job of running) if (job.id === id) job.controller.abort();
      for (const key of cache.keys()) if (JSON.parse(key)[2] === id) cache.delete(key);
    },
    async close() {
      closed = true;
      detach();
      for (const job of running) job.controller.abort();
      cache.clear();
      lastStart.clear();
      await Promise.allSettled([...running].map((job) => job.work));
    },
  };
}
