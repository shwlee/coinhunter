import { PlayerProcess } from './player-process.js';
import { RunnerLifecycle } from './contracts/lifecycle.js';
import {
  RunnerFault,
  RunnerContractError,
  assertLegacyMoveResult,
  TIMING_BOUNDARIES,
} from './contracts/validation.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from './policy.js';
import { JAVASCRIPT_RUNTIME, JAVASCRIPT_ADAPTER_VERSION } from './javascript-artifacts.js';

const faultFor = (error, stage) =>
  new RunnerFault(
    ['host-exited', 'unresponsive', 'protocol-error'].includes(error?.code)
      ? error.code
      : stage === 'initialize'
        ? 'initialization-failed'
        : 'protocol-error',
    stage,
  );

export class JavaScriptRunner {
  constructor(
    context,
    { resolveArtifact, diagnostics = false, createHost = () => new PlayerProcess() } = {},
  ) {
    this.lifecycle = new RunnerLifecycle(context);
    const artifact = this.lifecycle.context.artifact;
    if (
      context.language !== 'javascript' ||
      artifact.runtime.name !== JAVASCRIPT_RUNTIME.name ||
      artifact.runtime.version !== JAVASCRIPT_RUNTIME.version ||
      artifact.adapterVersion !== JAVASCRIPT_ADAPTER_VERSION ||
      artifact.format !== 'javascript-source' ||
      artifact.profileId !== 'default-js' ||
      context.limits.algorithmMemoryBytes !== ALGORITHM_MEMORY_LIMIT_BYTES
    )
      throw new RunnerFault('unavailable', 'initialize');
    this.resolveArtifact = resolveArtifact;
    this.diagnostics = diagnostics;
    this.createHost = createHost;
  }
  get name() {
    return this.lifecycle.info?.name;
  }
  get info() {
    return this.lifecycle.info;
  }
  get state() {
    return this.lifecycle.state;
  }
  get context() {
    return this.lifecycle.context;
  }
  async initialize(input) {
    this.lifecycle.beginInitialize(input);
    try {
      const source = this.resolveArtifact(this.context.artifact);
      this.host = this.createHost();
      const result = await this.host.initialize(
        source,
        input.playerNumber,
        input.columns,
        input.rows,
        {
          diagnostics: this.diagnostics,
          expectedSource: this.context.artifact.source,
          binding: {
            gameId: this.context.gameId,
            playerId: this.context.playerId,
            runId: this.context.runId,
          },
        },
      );
      return this.lifecycle.completeInitialize({
        contractVersion: 1,
        gameId: result.gameId,
        playerId: result.playerId,
        runId: result.runId,
        instanceId: result.instanceId,
        hostId: result.hostId,
        language: 'javascript',
        name: result.name,
        runtime: { ...JAVASCRIPT_RUNTIME },
        adapterVersion: JAVASCRIPT_ADAPTER_VERSION,
      });
    } catch (error) {
      const fault = faultFor(error, 'initialize');
      if (this.diagnostics && error?.validation) fault.validation = error.validation;
      if (this.state !== 'closed') this.lifecycle.fail(fault);
      await this.close();
      throw fault;
    }
  }
  async move(request) {
    this.lifecycle.beginMove(request);
    try {
      const result = assertLegacyMoveResult(
        await this.host.move(request.map, request.myPosition, request.items, request.callId),
      );
      if (result.hostId !== this.info.hostId) throw new RunnerContractError('hostId');
      const normalized = {
        contractVersion: 1,
        gameId: result.gameId,
        playerId: result.playerId,
        runId: result.runId,
        instanceId: result.instanceId,
        callId: result.callId,
        status: result.status,
        direction: result.value,
        completion: result.status === 'timeout' ? 'interrupted' : 'returned',
        logs: result.logs,
        droppedLogs: result.droppedLogs,
        timings: {
          executionMs: result.elapsedMs,
          executionBoundary: TIMING_BOUNDARIES.quickJsCall,
          roundTripMs: result.roundTripMs,
          inputPreparationMs: result.inputPreparationMs ?? null,
          responseProcessingMs: null,
          engineApplyDelayMs: null,
        },
      };
      this.lifecycle.completeMove(normalized);
      this.lastExceptionMessage =
        this.diagnostics && typeof result.exceptionMessage === 'string'
          ? result.exceptionMessage.slice(0, 400)
          : '';
      return normalized;
    } catch (error) {
      const fault = faultFor(error, 'move');
      if (this.state !== 'closed') this.lifecycle.fail(fault);
      throw fault;
    }
  }
  close() {
    if (this.closed) return this.closed;
    this.lifecycle.beginClose();
    this.closed = (async () => {
      try {
        await this.host?.close();
      } catch (error) {
        const fault = faultFor(error, 'close');
        this.lifecycle.fail(fault);
        throw fault;
      }
      const receipt = { contractVersion: 1, runId: this.context.runId, resourcesReleased: true };
      if (this.state === 'failed') this.lifecycle.beginClose();
      this.lifecycle.confirmClosed(receipt);
      return receipt;
    })();
    return this.closed;
  }
}
