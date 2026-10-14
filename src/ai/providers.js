import { validModelId } from './contracts.js';

const messages = {
  invalid_input: 'AI 연결 입력을 확인하세요.',
  unavailable: 'AI 제공자를 지금 사용할 수 없습니다.',
  credential_invalid: 'API 키 또는 선택한 모델의 사용 권한을 확인하세요.',
  network_error: 'AI 제공자에 연결할 수 없습니다.',
  rate_limited: 'AI 요청이 많습니다. 잠시 후 다시 시도하세요.',
  quota_exceeded:
    'OpenAI API 사용 한도 또는 결제 잔액을 확인하세요. 웹 서비스 구독과 API 결제는 별개입니다.',
  credit_exhausted: 'OpenAI API 선불 크레딧이 소진됐습니다. API 결제 설정에서 잔액을 확인하세요.',
  spend_limit_exceeded:
    'OpenAI 프로젝트 또는 조직의 API 지출 한도에 도달했습니다. 해당 한도 설정을 확인하세요.',
  usage_limit_exceeded: 'OpenAI 조직의 API 사용 한도에 도달했습니다. API 사용 한도를 확인하세요.',
  provider_rate_limited:
    'OpenAI 모델의 요청·토큰 처리 한도에 도달했습니다. 잠시 후 다시 시도하거나 입력을 줄이세요.',
  provider_limit_unknown:
    'OpenAI가 사용 제한 응답을 반환했습니다. 요청 과다인지 결제·사용 한도 문제인지 확인되지 않았습니다. API 사용·결제 설정을 확인하세요.',
  invalid_response: 'AI 응답을 확인할 수 없습니다.',
  timeout: 'AI 연결 확인 시간이 초과되었습니다.',
  cancelled: 'AI 조회가 취소되었습니다.',
  model_unavailable: '현재 연결에서 선택할 수 없는 모델입니다.',
  revision_conflict: 'AI 연결이 변경되었습니다. 다시 조회하세요.',
  unauthenticated: '다시 로그인하세요.',
  input_too_large: '선택한 AI 모델의 입력 한도를 초과했습니다. 코드나 요청을 줄이세요.',
  validation_failed: '생성 코드가 실행 검사를 통과하지 못했습니다.',
  truncated: 'AI 응답이 출력 한도에서 잘렸습니다. 요청을 줄이거나 출력 한도를 조정하세요.',
  refused: 'AI가 요청에 대한 코드 생성을 거부했습니다.',
  stream_interrupted:
    'OpenAI 응답 수신이 완료되기 전에 연결이 끝났습니다. 편집 코드는 유지됩니다. 다시 생성하세요.',
};

class AiProviderError extends Error {
  constructor(code, status, source) {
    super(
      source === 'service' && code === 'rate_limited'
        ? '게임 서버의 AI 작업 한도에 도달했습니다. 진행 중인 요청이 끝난 후 다시 시도하세요.'
        : messages[code],
    );
    this.code = code;
    this.status = status;
    if (['service', 'openai', 'anthropic', 'gemini'].includes(source)) this.source = source;
  }
}

export function aiError(code, status = 502, source) {
  return new AiProviderError(code, status, source);
}

// Read only known error codes/types. Raw external messages can contain secrets.
export function openAiLimitError(body) {
  const raw = body?.error?.code;
  const codes = {
    insufficient_quota: 'quota_exceeded',
    credit_balance_exhausted: 'credit_exhausted',
    organization_spend_limit_exceeded: 'spend_limit_exceeded',
    project_spend_limit_exceeded: 'spend_limit_exceeded',
    organization_usage_limit_exceeded: 'usage_limit_exceeded',
    usage_limit_exceeded: 'usage_limit_exceeded',
    rate_limit_exceeded: 'provider_rate_limited',
    slow_down: 'provider_rate_limited',
  };
  const recognized = typeof raw === 'string' && Object.hasOwn(codes, raw);
  const code =
    (recognized ? codes[raw] : null) ||
    (body?.error?.type === 'insufficient_quota' ? 'quota_exceeded' : 'provider_limit_unknown');
  const error = aiError(code, 429, 'openai');
  if (recognized) error.providerCode = raw;
  return error;
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
            if (response.status === 429) {
              if (id === 'openai') {
                let body;
                try {
                  body = await readBody(response, controller.signal);
                } catch {
                  /* No raw error body is exposed. */
                }
                throw openAiLimitError(body);
              }
              throw aiError('rate_limited', 429, id);
            }
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
