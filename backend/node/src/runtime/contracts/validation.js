export const RUNNER_CONTRACT_VERSION = 1;
export const RUNNER_TURN_LIMIT_MS = 500;
// Candidate vocabulary, NOT a supported-language registry or runtime capability.
export const CANDIDATE_LANGUAGE_IDS = Object.freeze(['javascript', 'csharp', 'cpp', 'python']);
export const MOVE_STATUSES = Object.freeze(['ok', 'timeout', 'exception', 'invalid-result']);
export const RUNNER_STATES = Object.freeze([
  'created',
  'initializing',
  'ready',
  'computing',
  'closing',
  'closed',
  'failed',
]);
export const RUNNER_FAULT_CODES = Object.freeze([
  'unavailable',
  'initialization-failed',
  'host-exited',
  'unresponsive',
  'protocol-error',
  'memory-limit',
  'preparation-failed',
  'cancelled',
]);
export const RUNNER_FAULT_STAGES = Object.freeze(['prepare', 'initialize', 'move', 'close']);
export const LOG_LIMITS = Object.freeze({ lines: 30, lineCharacters: 1024 });
export const TIMING_BOUNDARIES = Object.freeze({
  quickJsCall: 'quickjs-call-v1',
  dotNetCall: 'dotnet-guarded-call-v1',
});

export class RunnerContractError extends Error {
  constructor(field) {
    super(`Invalid runner contract field: ${field}`);
    this.name = 'RunnerContractError';
    this.code = 'invalid-runner-contract';
    this.field = field;
  }
}

/** Infrastructure faults reject a call; they are never silently turned into a direction. */
export class RunnerFault extends Error {
  constructor(code, stage) {
    if (!RUNNER_FAULT_CODES.includes(code) || !RUNNER_FAULT_STAGES.includes(stage))
      throw new RunnerContractError('fault');
    super(`Algorithm runner fault (${stage}: ${code}).`);
    this.name = 'RunnerFault';
    this.code = code;
    this.stage = stage;
  }
}

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const emptyUuid = '00000000-0000-0000-0000-000000000000';
const hash = /^[a-f0-9]{64}$/;
const token = /^[a-z][a-z0-9.-]{0,63}$/;
const fail = (field) => {
  throw new RunnerContractError(field);
};
const id = (value, field) => {
  if (typeof value !== 'string' || !uuid.test(value) || value === emptyUuid) fail(field);
};
const integer = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field);
};
const text = (value, field, maximum = 128) => {
  if (typeof value !== 'string' || !value || value.length > maximum) fail(field);
};
const duration = (value, field, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field);
};

// Boundary values are JSON data records. Do not invoke getters while inspecting them.
function record(value, fields, path) {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (
    names.length !== fields.length ||
    names.some((name) => !fields.includes(name) || !Object.hasOwn(descriptors[name], 'value'))
  )
    fail(path);
}
function version(value) {
  if (value !== RUNNER_CONTRACT_VERSION) fail('contractVersion');
}
function language(value) {
  if (!CANDIDATE_LANGUAGE_IDS.includes(value)) fail('language');
}
function versionIdentity(value, field) {
  record(value, ['name', 'version'], field);
  text(value.name, field + '.name');
  text(value.version, field + '.version');
}
function fingerprint(value, field) {
  if (typeof value !== 'string' || !hash.test(value)) fail(field);
}
function identity(value) {
  version(value.contractVersion);
  id(value.gameId, 'gameId');
  integer(value.playerId, 'playerId', 0, 3);
  id(value.runId, 'runId');
}
function sameRun(value, binding) {
  for (const field of ['gameId', 'playerId', 'runId'])
    if (value[field] !== binding[field]) fail(field);
}
function denseArray(value, field, length) {
  if (!Array.isArray(value) || value.length !== length) fail(field);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== length + 1
  )
    fail(field);
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !Object.hasOwn(property, 'value')) fail(field);
  }
}

/** @param {*} value @returns {import('./types.js').SourceReference} */
export function assertSourceReference(value) {
  record(value, ['sourceKey', 'sha256', 'byteLength'], 'source');
  id(value.sourceKey, 'source.sourceKey');
  fingerprint(value.sha256, 'source.sha256');
  integer(value.byteLength, 'source.byteLength');
  return value;
}

/** @param {*} value @returns {import('./types.js').PreparedArtifact} */
export function assertPreparedArtifact(value) {
  record(
    value,
    [
      'contractVersion',
      'artifactId',
      'language',
      'source',
      'content',
      'format',
      'profileId',
      'toolchain',
      'runtime',
      'adapterVersion',
      'target',
      'optionsHash',
    ],
    'artifact',
  );
  version(value.contractVersion);
  id(value.artifactId, 'artifactId');
  language(value.language);
  assertSourceReference(value.source);
  record(value.content, ['artifactKey', 'sha256', 'byteLength'], 'content');
  id(value.content.artifactKey, 'content.artifactKey');
  fingerprint(value.content.sha256, 'content.sha256');
  integer(value.content.byteLength, 'content.byteLength');
  if (typeof value.format !== 'string' || !token.test(value.format)) fail('format');
  if (typeof value.profileId !== 'string' || !token.test(value.profileId)) fail('profileId');
  versionIdentity(value.toolchain, 'toolchain');
  versionIdentity(value.runtime, 'runtime');
  text(value.adapterVersion, 'adapterVersion');
  record(value.target, ['os', 'architecture'], 'target');
  text(value.target.os, 'target.os');
  text(value.target.architecture, 'target.architecture');
  fingerprint(value.optionsHash, 'optionsHash');
  return value;
}

/** @param {*} value @returns {import('./types.js').PreparationRequest} */
export function assertPreparationRequest(value) {
  record(value, ['contractVersion', 'requestId', 'language', 'source', 'profileId'], 'preparation');
  version(value.contractVersion);
  id(value.requestId, 'requestId');
  language(value.language);
  assertSourceReference(value.source);
  if (typeof value.profileId !== 'string' || !token.test(value.profileId)) fail('profileId');
  return value;
}

/** @param {*} value @param {import('./types.js').PreparationRequest} request @returns {import('./types.js').PreparedArtifact} */
export function assertPreparationResult(value, request) {
  assertPreparationRequest(request);
  assertPreparedArtifact(value);
  if (value.language !== request.language) fail('language');
  if (value.profileId !== request.profileId) fail('profileId');
  for (const field of ['sourceKey', 'sha256', 'byteLength'])
    if (value.source[field] !== request.source[field]) fail('source.' + field);
  return value;
}

/** @param {*} value @returns {import('./types.js').RunnerContext} */
export function assertRunnerContext(value) {
  record(
    value,
    ['contractVersion', 'gameId', 'playerId', 'runId', 'language', 'artifact', 'limits'],
    'context',
  );
  identity(value);
  language(value.language);
  assertPreparedArtifact(value.artifact);
  if (value.language !== value.artifact.language) fail('artifact.language');
  record(value.limits, ['turnMs', 'algorithmMemoryBytes'], 'limits');
  if (value.limits.turnMs !== RUNNER_TURN_LIMIT_MS) fail('limits.turnMs');
  if (value.limits.algorithmMemoryBytes !== null)
    integer(value.limits.algorithmMemoryBytes, 'limits.algorithmMemoryBytes', 1);
  return value;
}

/** @param {*} value @param {import('./types.js').RunnerContext} context @returns {import('./types.js').InitializationInput} */
export function assertInitializationInput(value, context) {
  record(value, ['playerNumber', 'columns', 'rows'], 'initialization');
  integer(value.playerNumber, 'playerNumber', 0, 3);
  integer(value.columns, 'columns', 4, 40);
  integer(value.rows, 'rows', 4, 30);
  if (value.playerNumber !== context.playerId) fail('playerNumber');
  return value;
}

/** @param {*} value @param {import('./types.js').RunnerContext} context @returns {import('./types.js').RunnerInfo} */
export function assertRunnerInfo(value, context) {
  record(
    value,
    [
      'contractVersion',
      'gameId',
      'playerId',
      'runId',
      'instanceId',
      'hostId',
      'language',
      'name',
      'runtime',
      'adapterVersion',
    ],
    'info',
  );
  identity(value);
  sameRun(value, context);
  id(value.instanceId, 'instanceId');
  id(value.hostId, 'hostId');
  language(value.language);
  if (value.language !== context.language) fail('language');
  if (typeof value.name !== 'string' || value.name.length > 40) fail('name');
  versionIdentity(value.runtime, 'runtime');
  text(value.adapterVersion, 'adapterVersion');
  if (
    value.runtime.name !== context.artifact.runtime.name ||
    value.runtime.version !== context.artifact.runtime.version ||
    value.adapterVersion !== context.artifact.adapterVersion
  )
    fail('runtime');
  return value;
}

/** @param {*} value @param {import('./types.js').RunnerContext} context @param {import('./types.js').InitializationInput} initialization @param {number} [lastCallId] @returns {import('./types.js').MoveRequest} */
export function assertMoveRequest(value, context, initialization, lastCallId = 0) {
  record(
    value,
    ['contractVersion', 'gameId', 'playerId', 'runId', 'callId', 'map', 'myPosition', 'items'],
    'move',
  );
  identity(value);
  sameRun(value, context);
  integer(value.callId, 'callId', 1);
  if (value.callId <= lastCallId || (lastCallId === 0 && value.callId !== 1)) fail('callId');
  const size = initialization.columns * initialization.rows;
  denseArray(value.map, 'map', size);
  for (const tile of value.map) if (![-1, 0, 10, 30, 100, 200, 500].includes(tile)) fail('map');
  integer(value.myPosition, 'myPosition', 0, size - 1);
  denseArray(value.items, 'items', 4);
  for (const position of value.items) integer(position, 'items', -1, size - 1);
  const placed = value.items.filter((position) => position !== -1);
  if (new Set(placed).size !== placed.length) fail('items');
  return value;
}

/** @param {*} value @returns {import('./types.js').CallTimings} */
export function assertCallTimings(value) {
  record(
    value,
    [
      'executionMs',
      'executionBoundary',
      'roundTripMs',
      'inputPreparationMs',
      'responseProcessingMs',
      'engineApplyDelayMs',
    ],
    'timings',
  );
  duration(value.executionMs, 'executionMs');
  if (typeof value.executionBoundary !== 'string' || !token.test(value.executionBoundary))
    fail('executionBoundary');
  for (const field of [
    'roundTripMs',
    'inputPreparationMs',
    'responseProcessingMs',
    'engineApplyDelayMs',
  ])
    duration(value[field], field, true);
  return value;
}

/** @param {*} value @param {import('./types.js').RunnerInfo} info @param {number} callId @returns {import('./types.js').MoveResult} */
export function assertMoveResult(value, info, callId) {
  record(
    value,
    [
      'contractVersion',
      'gameId',
      'playerId',
      'runId',
      'instanceId',
      'callId',
      'status',
      'direction',
      'completion',
      'logs',
      'droppedLogs',
      'timings',
    ],
    'result',
  );
  identity(value);
  sameRun(value, info);
  id(value.instanceId, 'instanceId');
  if (value.instanceId !== info.instanceId) fail('instanceId');
  integer(value.callId, 'callId', 1);
  if (value.callId !== callId) fail('callId');
  if (!MOVE_STATUSES.includes(value.status)) fail('status');
  integer(value.direction, 'direction', -1, 3);
  if (value.status !== 'ok' && value.direction !== -1) fail('direction');
  if (value.completion !== (value.status === 'timeout' ? 'interrupted' : 'returned'))
    fail('completion');
  if (!Array.isArray(value.logs) || value.logs.length > LOG_LIMITS.lines) fail('logs');
  denseArray(value.logs, 'logs', value.logs.length);
  if (
    value.logs.some((line) => typeof line !== 'string' || line.length > LOG_LIMITS.lineCharacters)
  )
    fail('logs');
  integer(value.droppedLogs, 'droppedLogs');
  assertCallTimings(value.timings);
  if (value.status !== 'timeout' && value.timings.executionMs > RUNNER_TURN_LIMIT_MS)
    fail('executionMs');
  if (value.status === 'timeout' && value.timings.executionMs < RUNNER_TURN_LIMIT_MS)
    fail('executionMs');
  return value;
}

/** @param {*} value @param {import('./types.js').RunnerContext} context @returns {import('./types.js').CloseReceipt} */
export function assertCloseReceipt(value, context) {
  record(value, ['contractVersion', 'runId', 'resourcesReleased'], 'close');
  version(value.contractVersion);
  if (value.runId !== context.runId) fail('runId');
  if (value.resourcesReleased !== true) fail('resourcesReleased');
  return value;
}

/** Validate existing JS output without assigning invented run/instance IDs or new timing semantics. */
export function assertLegacyMoveResult(value) {
  if (!value || !MOVE_STATUSES.includes(value.status)) fail('legacy.status');
  integer(value.value, 'legacy.value', -1, 3);
  if (value.status !== 'ok' && value.value !== -1) fail('legacy.value');
  duration(value.elapsedMs, 'legacy.elapsedMs');
  if (value.status !== 'timeout' && value.elapsedMs > RUNNER_TURN_LIMIT_MS)
    fail('legacy.elapsedMs');
  if (value.status === 'timeout' && value.elapsedMs < RUNNER_TURN_LIMIT_MS)
    fail('legacy.elapsedMs');
  if (!Array.isArray(value.logs) || value.logs.length > LOG_LIMITS.lines) fail('legacy.logs');
  denseArray(value.logs, 'legacy.logs', value.logs.length);
  if (
    value.logs.some((line) => typeof line !== 'string' || line.length > LOG_LIMITS.lineCharacters)
  )
    fail('legacy.logs');
  integer(value.droppedLogs, 'legacy.droppedLogs');
  if (Object.hasOwn(value, 'roundTripMs')) duration(value.roundTripMs, 'legacy.roundTripMs');
  if (Object.hasOwn(value, 'pid')) integer(value.pid, 'legacy.pid', 1);
  return value;
}
