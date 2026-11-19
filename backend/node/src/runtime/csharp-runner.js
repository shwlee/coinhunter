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
          if (size < 1 || size > 65536) throw new Error();
          if (this.buffer.length < size + 4) break;
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
            pending.reject(fault);
            continue;
          }
          pending.resolve(value.result);
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
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(Buffer.concat([header, bytes]), (error) => {
        if (error) this.fail(new RunnerFault('host-exited', 'move'));
      });
    });
  }
}

export class CSharpRunner {
  constructor(context, { resolveArtifact }) {
    this.lifecycle = new RunnerLifecycle(context);
    if (
      context.language !== 'csharp' ||
      context.artifact.format !== 'dotnet-assembly' ||
      context.artifact.profileId !== 'csharp-restricted-c1-v2' ||
      context.artifact.adapterVersion !== 'csharp-pipe-v1' ||
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
  async initialize(input) {
    this.lifecycle.beginInitialize(input);
    try {
      this.channel = new PipeChannel(this.descriptor, this.context);
      return this.lifecycle.completeInitialize(await this.channel.request('initialize', input));
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
      const value = await this.channel.request('move', request);
      if (
        value.hostId !== this.info.hostId ||
        value.instanceId !== this.info.instanceId ||
        value.executionSettled !== true
      )
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
        logs: [],
        droppedLogs: 0,
        timings: {
          executionMs: value.executionMs,
          executionBoundary: TIMING_BOUNDARIES.dotNetCall,
          roundTripMs: performance.now() - before,
          inputPreparationMs: null,
          responseProcessingMs: null,
          engineApplyDelayMs: null,
        },
      };
      this.lifecycle.completeMove(result);
      return result;
    } catch (error) {
      const fault =
        error instanceof RunnerFault ? error : new RunnerFault('protocol-error', 'move');
      if (this.state !== 'closed') this.lifecycle.fail(fault);
      throw fault;
    }
  }
  close() {
    if (this.closed) return this.closed;
    this.lifecycle.beginClose();
    this.closed = (async () => {
      const receipt = this.channel
        ? await this.channel.request('close', {})
        : { contractVersion: 1, runId: this.context.runId, resourcesReleased: true };
      this.channel?.fail(new RunnerFault('cancelled', 'close'));
      if (this.state === 'failed') this.lifecycle.beginClose();
      this.lifecycle.confirmClosed(receipt);
      return receipt;
    })();
    return this.closed;
  }
}
