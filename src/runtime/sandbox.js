import { performance } from 'node:perf_hooks';
import { getQuickJS } from 'quickjs-emscripten';
import { TURN_LIMIT_MS, validateSource } from './policy.js';

// Prototype only exposes synchronous language built-ins, never Node host objects.
// All user property access and conversions stay inside the interruptible runtime.
export class AlgorithmSandbox {
  static async create(source, playerNumber, columns, rows) {
    validateSource(source);
    const module = await getQuickJS();
    const sandbox = new AlgorithmSandbox(module);
    try {
      sandbox.load(source);
      const initialized = sandbox.invoke('initialize', [playerNumber, columns, rows]);
      if (initialized.status !== 'ok') throw new Error('initialize 실패: ' + initialized.status);
      const named = sandbox.invoke('getName', []);
      if (named.status !== 'ok') throw new Error('getName 실패: ' + named.status);
      sandbox.name = named.value;
      return sandbox;
    } catch (error) {
      sandbox.dispose();
      throw error;
    }
  }

  constructor(module) {
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(32 * 1024 * 1024);
    this.runtime.setMaxStackSize(512 * 1024);
    this.context = this.runtime.newContext();
    this.deadline = Infinity;
    this.interrupted = false;
    this.logs = [];
    this.droppedLogs = 0;
    this.runtime.setInterruptHandler(() => {
      if (performance.now() >= this.deadline) this.interrupted = true;
      return this.interrupted;
    });
    const emit = this.context.newFunction('__emit', (...args) => {
      if (this.logs.length >= 30) {
        this.droppedLogs++;
        return;
      }
      // The guest wrapper passes bounded primitive strings only.
      const parts = args
        .slice(0, 8)
        .map((arg) =>
          this.context.typeof(arg) === 'string'
            ? this.context.getString(arg).slice(0, 512)
            : '[value]',
        );
      this.logs.push(parts.join(' ').slice(0, 1024));
    });
    this.context.setProp(this.context.global, '__emit', emit);
    emit.dispose();
  }

  run(operation) {
    this.logs = [];
    this.droppedLogs = 0;
    this.interrupted = false;
    const start = performance.now();
    this.deadline = start + TURN_LIMIT_MS;
    let result;
    try {
      result = operation();
      const elapsedMs = performance.now() - start;
      if (this.interrupted || elapsedMs > TURN_LIMIT_MS) {
        result.error?.dispose();
        result.value?.dispose();
        return {
          status: 'timeout',
          value: -1,
          elapsedMs,
          logs: this.logs,
          droppedLogs: this.droppedLogs,
        };
      }
      if (result.error) {
        // Do not dump untrusted error objects: getters/toJSON could execute more code.
        result.error.dispose();
        return {
          status: 'exception',
          value: -1,
          elapsedMs,
          logs: this.logs,
          droppedLogs: this.droppedLogs,
        };
      }
      return {
        status: 'ok',
        handle: result.value,
        elapsedMs,
        logs: this.logs,
        droppedLogs: this.droppedLogs,
      };
    } finally {
      this.deadline = Infinity;
      this.interrupted = false;
    }
  }

  load(source) {
    // Compile in the global guest scope so user code cannot capture bootstrap
    // bindings such as the host log bridge or dispatch helpers.
    const compiled = this.run(() =>
      this.context.evalCode(
        '(function(module, exports) { "use strict";\n' + source + '\n})',
        'player.js',
      ),
    );
    if (compiled.status !== 'ok') throw new Error('코드 컴파일 실패: ' + compiled.status);
    this.context.setProp(this.context.global, '__load', compiled.handle);
    compiled.handle.dispose();
    const bootstrap = `(() => {
      'use strict';
      const load = globalThis.__load;
      delete globalThis.__load;
      const emit = globalThis.__emit;
      delete globalThis.__emit;
      const parse = JSON.parse;
      const apply = Reflect.apply;
      const stringifyPrimitive = String;
      const slice = String.prototype.slice;
      const prototype = Object.getPrototypeOf(function () {});
      Object.defineProperty(prototype, 'constructor', { value: undefined, writable: false, configurable: false });
      for (const key of ['eval', 'Function', 'Promise', 'WebAssembly', 'WeakRef', 'FinalizationRegistry']) {
        Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
      }
      const print = (...args) => {
        const parts = [];
        for (let i = 0; i < args.length && i < 8; i++) {
          const value = args[i];
          const type = typeof value;
          const text = value === null || ['string', 'number', 'boolean', 'undefined', 'bigint'].includes(type)
            ? stringifyPrimitive(value) : '[' + type + ']';
          parts[i] = apply(slice, text, [0, 512]);
        }
        emit(...parts);
      };
      Object.defineProperty(globalThis, 'debug', { value: Object.freeze({ print }), writable: false, configurable: false });
      const module = { exports: {} };
      load(module, module.exports);
      if (typeof module.exports !== 'function') throw new Error('module.exports must be a class');
      const player = new module.exports();
      const initialize = player.initialize;
      const getName = player.getName;
      const moveNext = player.moveNext;
      if (typeof initialize !== 'function' || typeof getName !== 'function' || typeof moveNext !== 'function')
        throw new Error('Required player methods are missing');
      return (operation, payload) => {
        const args = parse(payload);
        if (operation === 'initialize') { apply(initialize, player, args); return 0; }
        if (operation === 'getName') {
          const name = apply(getName, player, []);
          if (typeof name !== 'string') throw new Error('Name must be a string');
          return apply(slice, name, [0, 40]);
        }
        const direction = apply(moveNext, player, args);
        return typeof direction === 'number' && (direction === -1 || direction === 0 || direction === 1 || direction === 2 || direction === 3)
          ? direction : -99;
      };
    })()`;
    const loaded = this.run(() => this.context.evalCode(bootstrap, 'player.js'));
    if (loaded.status !== 'ok') throw new Error('코드 로딩 실패: ' + loaded.status);
    this.dispatch = loaded.handle;
  }

  invoke(operation, payload) {
    if (!this.dispatch) throw new Error('알고리즘이 준비되지 않았습니다.');
    const command = this.context.newString(operation);
    const input = this.context.newString(JSON.stringify(payload));
    try {
      const result = this.run(() =>
        this.context.callFunction(this.dispatch, this.context.undefined, command, input),
      );
      if (result.status !== 'ok') return result;
      const handle = result.handle;
      try {
        const value =
          operation === 'getName' ? this.context.getString(handle) : this.context.getNumber(handle);
        const { handle: unused, ...metadata } = result;
        return {
          ...metadata,
          status: value === -99 ? 'invalid-result' : 'ok',
          value: value === -99 ? -1 : value,
        };
      } finally {
        handle.dispose();
      }
    } finally {
      command.dispose();
      input.dispose();
    }
  }

  dispose() {
    this.dispatch?.dispose();
    this.dispatch = null;
    this.context.dispose();
    this.runtime.dispose();
  }
}
