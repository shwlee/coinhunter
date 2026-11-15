import {
  RunnerContractError,
  RunnerFault,
  assertRunnerContext,
  assertInitializationInput,
  assertRunnerInfo,
  assertMoveRequest,
  assertMoveResult,
  assertCloseReceipt,
} from './validation.js';

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

/** Lifecycle checks only: this object cannot interrupt code or release a host. */
export class RunnerLifecycle {
  #context;
  #state = 'created';
  #initialization = null;
  #initializing = false;
  #info = null;
  #lastCallId = 0;
  #activeCallId = null;
  /** @param {import('./types.js').RunnerContext} context */
  constructor(context) {
    this.#context = freeze(structuredClone(assertRunnerContext(context)));
  }
  get state() {
    return this.#state;
  }
  get context() {
    return this.#context;
  }
  get info() {
    return this.#info;
  }
  get activeCallId() {
    return this.#activeCallId;
  }
  #require(...states) {
    if (!states.includes(this.#state)) throw new RunnerContractError('state');
  }
  beginInitialize(input) {
    this.#require('created');
    assertInitializationInput(input, this.#context);
    this.#initialization = Object.freeze({ ...input });
    this.#initializing = true;
    this.#state = 'initializing';
  }
  completeInitialize(info) {
    this.#require('initializing', 'closing');
    if (!this.#initializing) throw new RunnerContractError('initialization');
    assertRunnerInfo(info, this.#context);
    this.#info = freeze(structuredClone(info));
    this.#initializing = false;
    if (this.#state !== 'closing') this.#state = 'ready';
    return this.#info;
  }
  beginMove(request) {
    this.#require('ready');
    assertMoveRequest(request, this.#context, this.#initialization, this.#lastCallId);
    this.#lastCallId = request.callId;
    this.#activeCallId = request.callId;
    this.#state = 'computing';
  }
  completeMove(result) {
    this.#require('computing', 'closing');
    if (this.#activeCallId === null) throw new RunnerContractError('callId');
    // Bad/misrouted replies leave the pending call intact. They never make the runner reusable.
    assertMoveResult(result, this.#info, this.#activeCallId);
    this.#activeCallId = null;
    if (this.#state !== 'closing') this.#state = 'ready';
  }
  fail(fault) {
    this.#require('created', 'initializing', 'ready', 'computing', 'closing', 'failed');
    if (!(fault instanceof RunnerFault)) throw new RunnerContractError('fault');
    // Resource reclamation is still required. Failure alone does not settle an active call.
    this.#state = 'failed';
  }
  beginClose() {
    if (this.#state === 'closed' || this.#state === 'closing') return false;
    this.#state = 'closing';
    return true;
  }
  confirmClosed(receipt) {
    this.#require('closing');
    assertCloseReceipt(receipt, this.#context);
    this.#activeCallId = null;
    this.#initializing = false;
    this.#state = 'closed';
  }
}
