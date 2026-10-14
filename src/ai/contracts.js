/**
 * AI storage and provider contracts. Credentials and source files are server-only.
 * Connections have no company/personal type. All reads and mutations are owner scoped;
 * temporary connections additionally require the creating login session.
 *
 * @typedef {{ownerId: string, sessionId: string}} AiScope
 * @typedef {'anthropic' | 'openai' | 'gemini'} AiProviderId
 * @typedef {'session' | 'stored'} CredentialMode
 * @typedef {{id: string, ownerId: string, provider: AiProviderId, name: string,
 * credentialMode: CredentialMode, credentialRef: string, sessionId?: string,
 * defaultModelId: string | null, revision: number, createdAt: string,
 * updatedAt: string, checkStatus: string, checkedAt: string | null}} AiConnection
 * @typedef {{id: string, name: string, description?: string, generationVerified?: boolean}} AiModel
 *
 * @typedef {object} AiConnectionRepository
 * @property {(scope: AiScope) => Promise<AiConnection[]>} list
 * @property {(scope: AiScope, id: string) => Promise<AiConnection>} get
 * @property {(scope: AiScope, input: object) => Promise<AiConnection>} create
 * @property {(scope: AiScope, id: string, revision: number, input: object) => Promise<AiConnection>} update Atomic revision conflict checks; never accepts raw API keys.
 * @property {(scope: AiScope, id: string, revision: number) => Promise<void>} delete
 * @property {(ownerId: string) => Promise<void>} deleteOwner Server-only account cleanup.
 * @property {(sessionId: string) => Promise<void>} deleteSession Remove temporary metadata only.
 * @property {(scope: AiScope) => Promise<{connectionId: string | null, modelId: string | null}>} preference
 * @property {(scope: AiScope, selection: {connectionId: string | null, modelId: string | null}) => Promise<void>} setPreference Temporary selections remain bound to their session; durable preferences contain no session secret.
 *
 * @typedef {object} CredentialStore
 * @property {(scope: AiScope, mode: CredentialMode, secret: string) => Promise<string>} put Returns an opaque server-only reference, never the secret.
 * @property {(scope: AiScope, reference: string) => Promise<string>} resolve For outbound authentication only; never exposed through HTTP.
 * @property {(scope: AiScope, reference: string) => Promise<void>} delete
 * @property {(ownerId: string) => Promise<void>} deleteOwner
 * @property {(sessionId: string) => Promise<void>} deleteSession
 *
 * @typedef {object} AiProvider
 * @property {AiProviderId} id
 * @property {(input: {credential: string, signal: AbortSignal}) => Promise<void>} checkConnection Does not imply generation permission for every listed model.
 * @property {(input: {credential: string, signal: AbortSignal, cursor?: string}) => Promise<{models: AiModel[], nextCursor: string | null}>} listModels
 * @property {(input: {credential: string, modelId: string, instructions: string, input: string, signal: AbortSignal, outputPath: string, onProgress?: (value: {phase: string, receivedChars: number}) => void}) => Promise<{explanation: string, usage: object, finishReason: 'complete' | 'truncated' | 'refused'}>} generate Writes candidate code to outputPath; progress contains no source or reasoning; never executes or saves account code.
 *
 * @typedef {object} AiRequestService
 * @property {(scope: AiScope, input: {connectionId: string, modelId: string, intent: 'generate' | 'modify', prompt: string, priorities: string[]}) => Promise<object>} prepare Reserves a bounded, expiring input slot; model and connection checked server side.
 * @property {(scope: AiScope, id: string, sourcePath: string) => Promise<void>} attachSource Uses server-owned upload snapshots, never caller-provided file paths.
 * @property {(scope: AiScope, id: string) => Promise<void>} start Rechecks session, account, connection revision and model policy before queue admission.
 * @property {(scope: AiScope, id: string) => Promise<object>} status Public metadata only.
 * @property {(scope: AiScope, id: string, afterSequence: number) => AsyncIterable<object>} events Revalidates access; bounded replay plus snapshot for gaps.
 * @property {(scope: AiScope, id: string) => Promise<object>} openCandidate Owner/session checked handle plus release, like openSource; deletion waits for active readers.
 * @property {(scope: AiScope, id: string) => Promise<void>} cancel Idempotent; never frees executing capacity early.
 * @property {(ownerId: string) => Promise<void>} cancelOwner
 * @property {(sessionId: string) => Promise<void>} cancelSession
 * @property {(connectionId: string) => Promise<void>} cancelConnection Server-only operation following owner-checked mutation.
 * @property {() => Promise<void>} close Cancels work and closes streams; orphan recovery follows file ownership rules.
 *
 * Requests bind owner, login session, connection revision, model and input snapshot.
 * Prepared/queued/executing counts are bounded separately. Cancellation invalidates
 * delivery immediately, but an executing slot remains reserved until actual completion.
 * Key replacement/deletion and account cleanup cancel work before removing references;
 * revision and session checks prevent late results from resurrecting deleted data.
 * Provider calls and validation never run inside repository locks.
 */

export const AI_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'anthropic', name: 'Claude' }),
  Object.freeze({ id: 'openai', name: 'OpenAI' }),
  Object.freeze({ id: 'gemini', name: 'Gemini' }),
]);
export const CREDENTIAL_MODES = Object.freeze(['session', 'stored']);
// External SDK exceptions are mapped to these categories, never forwarded verbatim.
export const AI_ERROR_CODES = Object.freeze([
  'invalid_input',
  'unauthenticated',
  'unavailable',
  'credential_invalid',
  'model_unavailable',
  'revision_conflict',
  'network_error',
  'rate_limited',
  'quota_exceeded',
  'credit_exhausted',
  'spend_limit_exceeded',
  'usage_limit_exceeded',
  'provider_rate_limited',
  'provider_limit_unknown',
  'input_too_large',
  'invalid_response',
  'validation_failed',
  'timeout',
  'cancelled',
  'truncated',
  'refused',
  'stream_interrupted',
]);
export const AI_REQUEST_STATES = Object.freeze([
  'prepared',
  'queued',
  'generating',
  'validating',
  'completed',
  'validation_failed',
  'failed',
  'cancelled',
  'expired',
]);

function invalid() {
  const error = new Error('AI 연결 입력을 확인하세요.');
  error.status = 400;
  return error;
}

// Raw credentials and caller-supplied ownership never enter connection metadata.
export function validateConnectionMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const allowed = new Set(['name', 'provider', 'credentialMode', 'defaultModelId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw invalid();
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80)
    throw invalid();
  if (!AI_PROVIDERS.some(({ id }) => id === input.provider)) throw invalid();
  const credentialMode = input.credentialMode ?? 'session';
  if (!CREDENTIAL_MODES.includes(credentialMode)) throw invalid();
  const defaultModelId = input.defaultModelId ?? null;
  if (defaultModelId !== null && !validModelId(defaultModelId)) throw invalid();
  return { name: input.name.trim(), provider: input.provider, credentialMode, defaultModelId };
}

export function validModelId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\s\u0000-\u001f\u007f]/u.test(value)
  );
}

// An explicit allowlist, not a spread/destructure that can expose future secret fields.
export function publicConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    credentialMode: connection.credentialMode,
    defaultModelId: connection.defaultModelId,
    revision: connection.revision,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    checkStatus: connection.checkStatus,
    checkedAt: connection.checkedAt,
  };
}
