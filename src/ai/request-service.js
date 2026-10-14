import { randomUUID } from 'node:crypto';
import { chmod, copyFile, open, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cleanupOrphanUploads } from '../persistence/upload-cleanup.js';
import { validateAlgorithm } from '../runtime/preflight.js';
import { aiError } from './providers.js';
import { validateGenerationInput, buildGenerationInput } from './input.js';

const terminal = (state) =>
  ['completed', 'validation_failed', 'failed', 'cancelled', 'expired'].includes(state);
const candidateState = (state) => ['completed', 'validation_failed'].includes(state);

export function createAiRequestService({
  storage,
  catalog,
  sessions,
  config,
  providers,
  directory = 'data/ai/requests',
  validate = validateAlgorithm,
  now = Date.now,
  onError = () => {},
}) {
  const root = resolve(directory);
  const ready = cleanupOrphanUploads(root);
  // Consume startup errors even before the first API call; callers still receive them.
  ready.catch(() => {});
  const records = new Map(),
    running = new Set(),
    queue = [];
  let closed = false,
    scheduling = false,
    subscribers = 0;
  const guard = (scope) => {
    if (closed || !scope || !sessions.isActive(scope)) throw aiError('unauthenticated', 401);
    if (!config.enabled) throw aiError('unavailable', 503);
  };
  function get(scope, id) {
    guard(scope);
    const record = records.get(id);
    if (
      !record ||
      record.scope.ownerId !== scope.ownerId ||
      record.scope.sessionId !== scope.sessionId
    )
      throw aiError('invalid_input', 404);
    if (record.expiresAt <= now()) {
      cancel(record, 'expired');
      throw aiError('invalid_input', 404);
    }
    return record;
  }
  const path = () => join(root, `${process.pid}-${randomUUID()}.js`);
  const count = (scope, states) =>
    [...records.values()].filter(
      (r) => (!scope || r.scope.ownerId === scope.ownerId) && states.includes(r.state),
    ).length;
  const snapshot = (r) => ({
    id: r.id,
    state: r.state,
    sequence: r.sequence,
    intent: r.input.intent,
    provider: r.provider,
    modelId: r.input.modelId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    serverTime: now(),
    expiresAt: r.expiresAt,
    startedAt: r.startedAt || null,
    finishedAt: r.finishedAt || null,
    progress: r.progress ? { ...r.progress } : null,
    candidateAvailable: candidateState(r.state) && !!r.outputPath,
    explanation: r.explanation || '',
    usage: { ...r.usage },
    validation: r.validation ? structuredClone(r.validation) : null,
    error: r.error ? { ...r.error } : null,
  });
  function change(r, state) {
    r.state = state;
    r.sequence++;
    r.updatedAt = now();
    if (terminal(state)) {
      r.expiresAt = now() + config.candidateTtlMs;
      r.finishedAt = now();
    }
    for (const notify of r.listeners) notify(snapshot(r));
  }
  async function clean(r) {
    if (running.has(r) || r.attaching || r.readers) return;
    const files = [r.sourcePath, ...(candidateState(r.state) ? [] : [r.outputPath])].filter(
      Boolean,
    );
    await Promise.all(
      files.map((file) =>
        unlink(file).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        }),
      ),
    );
    r.sourcePath = null;
    if (!candidateState(r.state)) r.outputPath = null;
  }
  function cancel(r, state = 'cancelled') {
    if (['cancelled', 'expired'].includes(r.state)) return;
    r.controller.abort();
    clearTimeout(r.deadline);
    clearTimeout(r.progressTimer);
    r.input.prompt = '';
    r.input.priorities = [];
    r.error = null;
    r.explanation = '';
    r.validation = null;
    change(r, state);
    void clean(r).catch(() => {});
    schedule();
  }
  async function checked(r, requireCatalog = false) {
    guard(r.scope);
    if (r.controller.signal.aborted) throw aiError('cancelled', 409);
    const connection = await storage.get(r.scope, r.input.connectionId);
    if (
      connection.revision !== r.revision ||
      !config.allowedProviders.includes(connection.provider)
    )
      throw aiError('revision_conflict', 409);
    const allowed = config.allowedModels[connection.provider];
    if (allowed.length && !allowed.includes(r.input.modelId))
      throw aiError('model_unavailable', 422);
    if (requireCatalog) {
      const models = await catalog.cached(r.scope, connection.id);
      if (models.state !== 'ready' || !models.models.some((model) => model.id === r.input.modelId))
        throw aiError('model_unavailable', 422);
    }
    guard(r.scope);
    if (r.controller.signal.aborted) throw aiError('cancelled', 409);
  }
  function schedule() {
    if (scheduling || closed) return;
    scheduling = true;
    queueMicrotask(() => {
      scheduling = false;
      while (!closed && running.size < config.maxRunning) {
        const index = queue.findIndex(
          (r) =>
            r.state === 'queued' &&
            [...running].filter((job) => job.scope.ownerId === r.scope.ownerId).length <
              config.maxRunningPerUser,
        );
        if (index < 0) break;
        const [r] = queue.splice(index, 1);
        running.add(r);
        r.work = execute(r);
      }
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].state !== 'queued') queue.splice(i, 1);
    });
  }
  async function execute(r) {
    try {
      await checked(r, true);
      change(r, 'generating');
      const input = await buildGenerationInput(r.input, r.sourcePath);
      if (
        Buffer.byteLength(input.instructions) + Buffer.byteLength(input.input) >
        config.maxInputBytes
      )
        throw aiError('input_too_large', 422);
      await checked(r);
      const credential = await storage.credential(r.scope, r.input.connectionId);
      if (credential.connection.revision !== r.revision) throw aiError('revision_conflict', 409);
      await checked(r);
      const result = await providers[r.provider].generate({
        ...input,
        credential: credential.secret,
        modelId: r.input.modelId,
        signal: r.controller.signal,
        outputPath: r.outputPath,
        onProgress: (value) => {
          if (
            r.state !== 'generating' ||
            r.controller.signal.aborted ||
            !sessions.isActive(r.scope)
          )
            return;
          const phases = ['requesting', 'accepted', 'receiving', 'generated'];
          if (phases.indexOf(value.phase) < phases.indexOf(r.progress?.phase || 'requesting'))
            return;
          if (
            !['accepted', 'receiving', 'generated'].includes(value.phase) ||
            !Number.isSafeInteger(value.receivedChars) ||
            value.receivedChars < (r.progress?.receivedChars || 0) ||
            value.receivedChars > 4 * 1024 * 1024
          )
            return;
          const phaseChanged = r.progress?.phase !== value.phase;
          r.progress = {
            phase: value.phase,
            receivedChars: value.receivedChars,
            lastResponseAt: now(),
          };
          const publish = () => {
            clearTimeout(r.progressTimer);
            r.progressTimer = null;
            if (r.state !== 'generating' || r.controller.signal.aborted) return;
            r.lastProgressAt = now();
            change(r, 'generating');
          };
          if (phaseChanged || now() - (r.lastProgressAt || 0) >= 200) publish();
          else if (!r.progressTimer) r.progressTimer = setTimeout(publish, 200);
        },
      });
      await checked(r);
      if (result.finishReason !== 'complete') throw aiError('invalid_response');
      r.explanation = result.explanation;
      r.usage = result.usage;
      change(r, 'validating');
      const validation = await validate(
        undefined,
        r.scope.ownerId,
        r.outputPath,
        r.controller.signal,
      );
      await checked(r);
      r.validation = validation;
      change(r, validation.ok ? 'completed' : 'validation_failed');
    } catch (error) {
      if (!terminal(r.state)) {
        // Never expose raw provider/SDK/file exceptions through metadata or SSE.
        const safe =
          error.status && error.code
            ? aiError(error.code, error.status, error.source)
            : aiError(
                error.status === 429 ? 'rate_limited' : 'unavailable',
                error.status === 429 ? 429 : 503,
                error.status === 429 ? 'service' : undefined,
              );
        r.error = { code: safe.code, message: safe.message };
        if (safe.source) r.error.source = safe.source;
        if (
          error.source === 'openai' &&
          typeof error.providerCode === 'string' &&
          /^[a-z_]{1,80}$/.test(error.providerCode)
        )
          r.error.providerCode = error.providerCode;
        // Optional server-side diagnostics contain only normalized categories, no IDs/keys/source.
        try {
          onError({ ...r.error });
        } catch {
          /* Diagnostics cannot break cleanup. */
        }
        change(r, 'failed');
      }
    } finally {
      running.delete(r);
      clearTimeout(r.deadline);
      clearTimeout(r.progressTimer);
      r.input.prompt = '';
      r.input.priorities = [];
      await clean(r).catch(() => {});
      schedule();
    }
  }
  function sweep() {
    for (const r of records.values()) {
      if (!sessions.isActive(r.scope)) cancel(r);
      if (r.expiresAt <= now()) {
        cancel(r, 'expired');
        if (!running.has(r) && !r.attaching && !r.readers) {
          records.delete(r.id);
          void clean(r).catch(() => {});
        }
      }
    }
  }
  const timer = setInterval(sweep, 1000);
  timer.unref();
  const detach = sessions.onRemoved(({ sessionId }) => {
    for (const r of records.values()) if (r.scope.sessionId === sessionId) cancel(r);
  });
  return {
    providers: Object.keys(providers),
    async prepare(scope, data) {
      guard(scope);
      sweep();
      const input = validateGenerationInput(data);
      const connection = await storage.get(scope, input.connectionId);
      if (!providers[connection.provider]?.generate) throw aiError('unavailable', 503);
      const models = await catalog.cached(scope, input.connectionId);
      if (models.state !== 'ready' || !models.models.some((model) => model.id === input.modelId))
        throw aiError('model_unavailable', 422);
      await ready;
      guard(scope);
      // Keep a single account from filling the global retained-metadata bound.
      const old = [...records.values()].filter(
        (r) =>
          r.scope.ownerId === scope.ownerId &&
          ['cancelled', 'expired', 'failed'].includes(r.state) &&
          !running.has(r) &&
          !r.readers &&
          !r.attaching,
      );
      while (old.length >= 20) {
        const r = old.shift();
        records.delete(r.id);
        void clean(r).catch(() => {});
      }
      if (
        records.size >= 1000 ||
        count(null, ['prepared']) >= config.maxPrepared ||
        count(scope, ['prepared']) >= config.maxPreparedPerUser ||
        count(scope, [
          'prepared',
          'queued',
          'generating',
          'validating',
          'completed',
          'validation_failed',
        ]) >= config.maxCandidatesPerUser
      )
        throw aiError('rate_limited', 429, 'service');
      const r = {
        id: randomUUID(),
        scope: { ...scope },
        input,
        provider: connection.provider,
        revision: connection.revision,
        state: 'prepared',
        sequence: 1,
        createdAt: now(),
        updatedAt: now(),
        expiresAt: now() + config.preparedTtlMs,
        sourcePath: null,
        outputPath: path(),
        readers: 0,
        attaching: null,
        controller: new AbortController(),
        listeners: new Set(),
        usage: {},
      };
      records.set(r.id, r);
      return snapshot(r);
    },
    async attachSource(scope, id, sourcePath) {
      const r = get(scope, id);
      if (r.state !== 'prepared' || r.input.intent !== 'modify' || r.sourcePath || r.attaching)
        throw aiError('invalid_input', 409);
      const target = path();
      const work = (async () => {
        if ((await stat(sourcePath)).size > config.maxInputBytes)
          throw aiError('input_too_large', 422);
        await copyFile(sourcePath, target, 1);
        try {
          await chmod(target, 0o600);
          await checked(r);
          r.sourcePath = target;
        } catch (error) {
          await unlink(target).catch(() => {});
          throw error;
        }
      })();
      r.attaching = work;
      try {
        await work;
      } finally {
        r.attaching = null;
        if (terminal(r.state)) await clean(r);
      }
    },
    async start(scope, id) {
      const r = get(scope, id);
      if (r.state !== 'prepared' || r.attaching || (r.input.intent === 'modify' && !r.sourcePath))
        throw aiError('invalid_input', 409);
      await checked(r, true);
      if (r.state !== 'prepared' || r.attaching || r.expiresAt <= now())
        throw aiError('invalid_input', 409);
      if (
        count(null, ['queued']) >= config.maxQueued ||
        count(scope, ['queued']) >= config.maxQueuedPerUser
      )
        throw aiError('rate_limited', 429, 'service');
      r.startedAt = now();
      r.progress = { phase: 'requesting', receivedChars: 0, lastResponseAt: null };
      change(r, 'queued');
      r.expiresAt = now() + config.requestTimeoutMs;
      r.deadline = setTimeout(() => {
        if (terminal(r.state)) return;
        r.error = { code: 'timeout', message: 'AI 생성 대기·실행 시간이 초과되었습니다.' };
        r.controller.abort();
        change(r, 'failed');
        void clean(r).catch(() => {});
        schedule();
      }, config.requestTimeoutMs);
      r.deadline.unref();
      queue.push(r);
      schedule();
      return snapshot(r);
    },
    status(scope, id) {
      sweep();
      return snapshot(get(scope, id));
    },
    subscribe(scope, id, notify) {
      const r = get(scope, id);
      if (subscribers >= 100 || r.listeners.size >= 5)
        throw aiError('rate_limited', 429, 'service');
      subscribers++;
      r.listeners.add(notify);
      let detached = false;
      return () => {
        if (!detached) {
          detached = true;
          subscribers--;
          r.listeners.delete(notify);
        }
      };
    },
    async openCandidate(scope, id) {
      const r = get(scope, id);
      if (!candidateState(r.state)) throw aiError('invalid_input', 409);
      r.readers++;
      let handle;
      try {
        handle = await open(r.outputPath, 'r');
        guard(scope);
        if (!candidateState(r.state)) throw aiError('cancelled', 409);
      } catch (error) {
        await handle?.close();
        r.readers--;
        await clean(r);
        throw error;
      }
      let released = false;
      return {
        handle,
        release: async () => {
          if (released) return;
          released = true;
          await handle.close();
          r.readers--;
          await clean(r);
        },
      };
    },
    async cancel(scope, id) {
      const r = get(scope, id);
      cancel(r);
      return snapshot(r);
    },
    cancelConnection(id) {
      for (const r of records.values()) if (r.input.connectionId === id) cancel(r);
    },
    cancelOwner(ownerId) {
      for (const r of records.values()) if (r.scope.ownerId === ownerId) cancel(r);
    },
    cancelSession(sessionId) {
      for (const r of records.values()) if (r.scope.sessionId === sessionId) cancel(r);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      detach();
      for (const r of records.values()) cancel(r);
      await Promise.allSettled(
        [...records.values()].flatMap((r) => [r.work, r.attaching].filter(Boolean)),
      );
      await Promise.all([...records.values()].map(clean));
      records.clear();
    },
  };
}
