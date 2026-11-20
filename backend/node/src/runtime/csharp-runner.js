import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { RunnerLifecycle } from './contracts/lifecycle.js';
import { RunnerFault, TIMING_BOUNDARIES } from './contracts/validation.js';

// This private candidate adapter never starts a compiler or sends a turn over HTTP.
// A separate pipe per player avoids a shared request/response queue across players.
class PipeChannel {
  constructor(descriptor, context) {
    this.descriptor = descriptor;
    this.context = context;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = net.createConnection(descriptor.endpoint);
    this.connected = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new RunnerFault('unresponsive', 'initialize')),
        20000,
      );
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', () => {
        clearTimeout(timer);
        reject(new RunnerFault('host-exited', 'initialize'));
      });
      this.socket.once('close', () => {
        clearTimeout(timer);
        reject(new RunnerFault('host-exited', 'initialize'));
      });
    });
    this.connected.catch(() => {});
    this.socket.on('error', () => this.fail(new RunnerFault('host-exited', 'move')));
    this.socket.on('close', () => this.fail(new RunnerFault('host-exited', 'move')));
    this.socket.on('data', (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (size < 1 || size > 262144) throw new Error();
          if (this.buffer.length < size + 4) break;
          const decoding = performance.now();
          const value = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
          this.buffer = this.buffer.subarray(size + 4);
          const pending = this.pending.get(value.id);
          if (value.version !== 1 || typeof value.ok !== 'boolean' || !pending) throw new Error();
          if (
            !value.ok &&
            !['exception', 'operation-limit', 'cancelled'].includes(value.error?.status)
          )
            throw new Error();
          this.pending.delete(value.id);
          clearTimeout(pending.timer);
          if (!value.ok) {
            const fault = new RunnerFault('host-exited', 'move');
            fault.userStatus = value.error.status;
            if (
              typeof value.error.code === 'string' &&
              /^[A-Za-z0-9-]{1,80}$/.test(value.error.code)
            )
              fault.diagnostic = {
                code: value.error.code,
                line:
                  Number.isSafeInteger(value.error.line) && value.error.line > 0
                    ? value.error.line
                    : null,
                column:
                  Number.isSafeInteger(value.error.column) && value.error.column > 0
                    ? value.error.column
                    : null,
              };
            pending.reject(fault);
            continue;
          }
          pending.resolve(
            pending.method === 'move'
              ? {
                  ...value.result,
                  requestEncodingMs: pending.encodingMs,
                  responseProcessingMs: performance.now() - decoding,
                }
              : value.result,
          );
        }
      } catch {
        this.fail(new RunnerFault('protocol-error', 'move'));
      }
    });
  }
  fail(error) {
    this.failure ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }
  async request(method, input) {
    await this.connected;
    if (this.failure) throw this.failure;
    if (this.pending.size >= 2) throw new RunnerFault('protocol-error', 'move');
    const id = randomUUID();
    const encoding = performance.now();
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        id,
        method,
        gameId: this.context.gameId,
        playerId: this.context.playerId,
        runId: this.context.runId,
        artifactId: this.context.artifact.artifactId,
        token: this.descriptor.token,
        input,
      }),
    );
    if (bytes.length > 1048576) throw new RunnerFault('protocol-error', 'move');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    const encodingMs = performance.now() - encoding;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new RunnerFault(
              'unresponsive',
              method === 'initialize' ? 'initialize' : method === 'close' ? 'close' : 'move',
            ),
          ),
        method === 'initialize' ? 20000 : method === 'close' ? 15000 : 10000,
      );
      this.pending.set(id, { resolve, reject, timer, method, encodingMs });
      this.socket.write(Buffer.concat([header, bytes]), (error) => {
        if (error) this.fail(new RunnerFault('host-exited', 'move'));
      });
    });
  }
}

const gcFailures = new Set([
  'gc-reservation-unavailable',
  'gc-state-conflict',
  'gc-window-lost',
  'gc-call-environment-failure',
  'gc-host-allocation-budget',
]);
function entryObservation(value, collectionAllowed, failure = false) {
  const fields = ['policy', 'attempts', 'collectionDeltas', 'before', 'after'];
  const bad = () => {
    throw new RunnerFault('protocol-error', 'move');
  };
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(value, k)) ||
    value.policy !== (collectionAllowed ? 'decommit-once-v2' : 'fail-fast-v1') ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < (failure ? 0 : 1) ||
    value.attempts > (collectionAllowed ? 2 : 1) ||
    !Array.isArray(value.collectionDeltas) ||
    value.collectionDeltas.length !== 3 ||
    value.collectionDeltas.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    bad();
  if (value.attempts === 2) {
    for (const [index, snapshot] of [value.before, value.after].entries()) {
      if (failure && index === 1 && snapshot === null) continue;
      const keys = [
        'managedBytes',
        'heapSizeBytes',
        'fragmentedBytes',
        'committedBytes',
        'availableBytes',
      ];
      if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        Object.keys(snapshot).length !== keys.length ||
        keys.some((k) => !Number.isSafeInteger(snapshot[k]) || snapshot[k] < 0)
      )
        bad();
    }
  } else if (value.before !== null || value.after !== null) bad();
  return structuredClone(value);
}
function memoryObservation(value, collectionAllowed) {
  const fields = [
    'status',
    'requestedReservationBytes',
    'workerAllocationLimitBytes',
    'workerAllocatedBytes',
    'entryMs',
    'exitMs',
    'collectionDeltas',
    'regionIntact',
    'processAllocationLimitBytes',
    'processAllocatedBytes',
    'entry',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    value.status !== 'completed' ||
    value.regionIntact !== true ||
    value.requestedReservationBytes !== 268435456 ||
    value.workerAllocationLimitBytes !== 33554432 ||
    value.processAllocationLimitBytes !== 67108864 ||
    !Array.isArray(value.collectionDeltas) ||
    value.collectionDeltas.length !== 3 ||
    value.collectionDeltas.some((n) => n !== 0) ||
    ['workerAllocatedBytes', 'processAllocatedBytes'].some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 0,
    ) ||
    value.processAllocatedBytes > value.processAllocationLimitBytes ||
    ['entryMs', 'exitMs'].some((key) => !Number.isFinite(value[key]) || value[key] < 0)
  )
    throw new RunnerFault('protocol-error', 'move');
  entryObservation(value.entry, collectionAllowed);
  return structuredClone(value);
}

export class CSharpRunner {
  constructor(context, { resolveArtifact }) {
    this.lifecycle = new RunnerLifecycle(context);
    if (
      context.language !== 'csharp' ||
      context.artifact.format !== 'dotnet-assembly' ||
      context.artifact.profileId !== 'csharp-restricted-c1-v4' ||
      context.artifact.adapterVersion !== 'csharp-direct-pipe-v2' ||
      context.limits.algorithmMemoryBytes !== null
    )
      throw new RunnerFault('unavailable', 'initialize');
    this.descriptor = resolveArtifact(context.artifact);
    if (
      this.descriptor.gameId !== context.gameId ||
      this.descriptor.playerId !== context.playerId ||
      this.descriptor.runId !== context.runId ||
      !isDeepStrictEqual(this.descriptor.artifact, context.artifact) ||
      typeof this.descriptor.endpoint !== 'string' ||
      typeof this.descriptor.turnEndpoint !== 'string' ||
      (this.descriptor.experimentalGcWindow !== undefined &&
        typeof this.descriptor.experimentalGcWindow !== 'boolean') ||
      (this.descriptor.gcEntryCollection !== undefined &&
        typeof this.descriptor.gcEntryCollection !== 'boolean') ||
      (this.descriptor.gcEntryCollection === true &&
        this.descriptor.experimentalGcWindow !== true) ||
      !/^[a-f0-9]{64}$/.test(this.descriptor.token)
    )
      throw new RunnerFault('unavailable', 'initialize');
  }
  get state() {
    return this.lifecycle.state;
  }
  get context() {
    return this.lifecycle.context;
  }
  get info() {
    return this.lifecycle.info;
  }
  get name() {
    return this.info?.name;
  }
  get observationPolicy() {
    return this.descriptor.gcEntryCollection === true
      ? 'csharp-gc-window-v2'
      : 'csharp-gc-window-v1';
  }
  async initialize(input) {
    this.lifecycle.beginInitialize(input);
    try {
      this.channel = new PipeChannel(this.descriptor, this.context);
      const info = await this.channel.request('initialize', input);
      this.turnChannel = new PipeChannel(
        { ...this.descriptor, endpoint: this.descriptor.turnEndpoint },
        this.context,
      );
      await this.turnChannel.connected;
      return this.lifecycle.completeInitialize(info);
    } catch (error) {
      const fault =
        error instanceof RunnerFault
          ? error
          : new RunnerFault('initialization-failed', 'initialize');
      if (this.state !== 'closed') this.lifecycle.fail(fault);
      await this.close().catch(() => {});
      throw fault;
    }
  }
  async move(request) {
    this.lifecycle.beginMove(request);
    const before = performance.now();
    try {
      const value = await this.turnChannel.request('move', request);
      if (
        value.hostId !== this.info.hostId ||
        value.instanceId !== this.info.instanceId ||
        value.executionSettled !== true
      )
        throw new RunnerFault('protocol-error', 'move');
      this.lastObservation =
        this.descriptor.experimentalGcWindow === true
          ? memoryObservation(value.experimentalMemory, this.descriptor.gcEntryCollection === true)
          : null;
      if (!this.descriptor.experimentalGcWindow && value.experimentalMemory != null)
        throw new RunnerFault('protocol-error', 'move');
      const result = {
        contractVersion: 1,
        gameId: this.context.gameId,
        playerId: this.context.playerId,
        runId: this.context.runId,
        instanceId: value.instanceId,
        callId: request.callId,
        status: value.status,
        direction: value.direction,
        completion: value.status === 'timeout' ? 'interrupted' : 'returned',
        logs: value.logs,
        droppedLogs: value.droppedLogs,
        timings: {
          executionMs: value.executionMs,
          executionBoundary: TIMING_BOUNDARIES.dotNetCall,
          roundTripMs: performance.now() - before,
          inputPreparationMs: value.inputPreparationMs + value.requestEncodingMs,
          responseProcessingMs: value.responseProcessingMs,
          engineApplyDelayMs: null,
        },
      };
      this.lifecycle.completeMove(result);
      return result;
    } catch (error) {
      const fault =
        error instanceof RunnerFault ? error : new RunnerFault('protocol-error', 'move');
      // Only on a failed transport: ask the lifecycle owner for its trusted
      // terminal reason. No extra IPC or waiting is added to successful turns.
      if (
        this.descriptor.experimentalGcWindow === true &&
        fault.code === 'host-exited' &&
        !fault.userStatus
      ) {
        try {
          const terminal = await this.channel.request('failure', {});
          if (gcFailures.has(terminal.infrastructureFailure)) {
            const entry = entryObservation(
              terminal.gcEntry,
              this.descriptor.gcEntryCollection === true,
              true,
            );
            fault.infrastructureFailure = terminal.infrastructureFailure;
            fault.gcEntry = entry;
          }
        } catch {
          /* Preserve the original transport fault if the owner is gone. */
        }
      }
      if (this.state !== 'closed') this.lifecycle.fail(fault);
      throw fault;
    }
  }
  close() {
    if (this.closed) return this.closed;
    this.lifecycle.beginClose();
    this.closed = (async () => {
      try {
        const receipt = this.channel
          ? await this.channel.request('close', {})
          : { contractVersion: 1, runId: this.context.runId, resourcesReleased: true };
        if (this.state === 'failed') this.lifecycle.beginClose();
        this.lifecycle.confirmClosed(receipt);
        return receipt;
      } finally {
        this.channel?.fail(new RunnerFault('cancelled', 'close'));
        this.turnChannel?.fail(new RunnerFault('cancelled', 'close'));
      }
    })();
    return this.closed;
  }
}
