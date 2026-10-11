import { validModelId } from './contracts.js';

const messages = {
  invalid_input: 'AI 연결 입력을 확인하세요.',
  unavailable: 'AI 제공자를 지금 사용할 수 없습니다.',
  credential_invalid: 'API 키 또는 모델 조회 권한을 확인하세요.',
  network_error: 'AI 제공자에 연결할 수 없습니다.',
  rate_limited: 'AI 조회 요청이 많습니다. 잠시 후 다시 시도하세요.',
  invalid_response: 'AI 모델 목록 응답을 확인할 수 없습니다.',
  timeout: 'AI 연결 확인 시간이 초과되었습니다.',
  cancelled: 'AI 조회가 취소되었습니다.',
  model_unavailable: '현재 연결에서 선택할 수 없는 모델입니다.',
  revision_conflict: 'AI 연결이 변경되었습니다. 다시 조회하세요.',
  unauthenticated: '다시 로그인하세요.',
};

class AiProviderError extends Error {
  constructor(code, status) {
    super(messages[code]);
    this.code = code;
    this.status = status;
  }
}

export function aiError(code, status = 502) {
  return new AiProviderError(code, status);
}

const definitions = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    cursor: 'after_id',
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key }),
    cursor: 'pageToken',
  },
};

function cursorValid(cursor) {
  return (
    typeof cursor === 'string' &&
    cursor.length > 0 &&
    cursor.length <= 4096 &&
    !/[\x00-\x1f\x7f]/.test(cursor)
  );
}

async function readBody(response, signal) {
  if (!response.body) throw aiError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw aiError('invalid_response');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Server-only transport injection; callers cannot supply an API endpoint.
export function createAiProviders({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw aiError('invalid_input', 400);
  return Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => {
      async function listModels({ credential, signal, cursor } = {}) {
        if (
          typeof credential !== 'string' ||
          !credential ||
          credential.length > 16384 ||
          /[^\x21-\x7e]/.test(credential)
        )
          throw aiError('invalid_input', 400);
        if (cursor != null && (!definition.cursor || !cursorValid(cursor)))
          throw aiError('invalid_input', 400);
        const controller = new AbortController();
        const cancel = () => controller.abort(aiError('cancelled', 409));
        if (signal?.aborted) cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(aiError('timeout', 504)), timeoutMs);
        let response;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const url = new URL(definition.url);
          if (cursor != null) url.searchParams.set(definition.cursor, cursor);
          response = await fetchImpl(url, {
            method: 'GET',
            headers: definition.headers(credential),
            redirect: 'error',
            signal: controller.signal,
          });
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!response.ok) {
            if (response.status === 401 || response.status === 403)
              throw aiError('credential_invalid', 422);
            if (response.status === 429) throw aiError('rate_limited', 429);
            throw aiError('unavailable', 503);
          }
          const body = await readBody(response, controller.signal);
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw aiError('invalid_response');
          const entries = id === 'gemini' ? (body.models ?? []) : body.data;
          if (!Array.isArray(entries) || entries.length > 1000) throw aiError('invalid_response');
          let nextCursor = null;
          if (id === 'anthropic') {
            if (typeof body.has_more !== 'boolean') throw aiError('invalid_response');
            if (body.has_more) nextCursor = body.last_id;
            if (body.has_more && !cursorValid(nextCursor)) throw aiError('invalid_response');
          }
          if (id === 'gemini' && body.nextPageToken !== undefined) {
            if (!cursorValid(body.nextPageToken)) throw aiError('invalid_response');
            nextCursor = body.nextPageToken;
          }
          if (nextCursor?.includes(credential)) throw aiError('invalid_response');
          const models = [];
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') throw aiError('invalid_response');
            const modelId = id === 'gemini' ? entry.name?.replace(/^models\//, '') : entry.id;
            if (!validModelId(modelId)) throw aiError('invalid_response');
            if (id === 'gemini') {
              if (!Array.isArray(entry.supportedGenerationMethods))
                throw aiError('invalid_response');
              if (!entry.supportedGenerationMethods.includes('generateContent')) continue;
            }
            const label = id === 'gemini' ? entry.displayName : entry.display_name;
            if (
              label != null &&
              (typeof label !== 'string' || label.length > 300 || /[\x00-\x1f\x7f]/.test(label))
            )
              throw aiError('invalid_response');
            if (modelId.includes(credential) || label?.includes(credential))
              throw aiError('invalid_response');
            // The listing does not prove generation permission or text output support.
            models.push({ id: modelId, name: label || modelId, generationVerified: false });
          }
          return { models, nextCursor };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof AiProviderError) throw error;
          throw aiError(response?.ok ? 'invalid_response' : 'network_error');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        }
      }
      return [
        id,
        Object.freeze({
          id,
          listModels,
          async checkConnection(input) {
            await listModels(input);
          },
        }),
      ];
    }),
  );
}
