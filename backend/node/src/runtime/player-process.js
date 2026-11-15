import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export class PlayerHostError extends Error {
  constructor(code) {
    super(`Algorithm host ${code}.`);
    this.code = code;
  }
}

export function algorithmHostEnvironment(base = process.env) {
  const allowed = new Set([
    'path',
    'pathext',
    'systemroot',
    'windir',
    'comspec',
    'temp',
    'tmp',
    'home',
    'userprofile',
    'appdata',
    'localappdata',
  ]);
  return Object.fromEntries(Object.entries(base).filter(([key]) => allowed.has(key.toLowerCase())));
}

// Transport deadlines detect a failed host, not a normal 500ms algorithm timeout.
export class PlayerProcess {
  constructor({ forkChild = fork, initializeMs = 30000, responseMs = 5000, closeMs = 3000 } = {}) {
    this.sequence = 0;
    this.pending = new Map();
    this.busy = false;
    this.closing = false;
    this.deadlines = { initialize: initializeMs, move: responseMs, close: closeMs };
    this.child = forkChild(fileURLToPath(new URL('./player-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      execArgv: [],
      env: algorithmHostEnvironment(),
    });
    // 'close' also occurs after spawn errors, unlike 'exit'. Wait for actual resource closure.
    this.exited = new Promise((resolve) =>
      this.child.once('close', () => {
        this.terminated = true;
        this.fail(new PlayerHostError('host-exited'));
        resolve();
      }),
    );
    this.child.on('message', (message) => {
      const request = message && this.pending.get(message.id);
      if (!request || message.type !== request.type || typeof message.ok !== 'boolean') {
        if (!this.closing) this.breakHost(new PlayerHostError('protocol-error'));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else {
        const error = new PlayerHostError('initialization-failed');
        if (this.diagnostics && message.validation) error.validation = message.validation;
        request.reject(error);
      }
    });
    this.child.on('error', () => this.breakHost(new PlayerHostError('host-exited')));
    this.child.on('exit', () => this.fail(new PlayerHostError('host-exited')));
    this.child.on('disconnect', () => {
      if (!this.closing) this.breakHost(new PlayerHostError('host-exited'));
    });
  }
  fail(error) {
    this.failure ||= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  breakHost(error) {
    this.fail(error);
    // Catastrophic transport failure ends this host; never restart it for another turn.
    if (!this.terminated && !this.terminationRequested) {
      this.terminationRequested = true;
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* close deadline reports failure if still alive */
      }
    }
  }
  request(type, payload = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child.connected) return Promise.reject(new PlayerHostError('host-exited'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.breakHost(new PlayerHostError('unresponsive')),
        this.deadlines[type],
      );
      this.pending.set(id, { resolve, reject, timer, type });
      try {
        this.child.send({ id, type, payload }, (error) => {
          if (error) this.breakHost(new PlayerHostError('host-exited'));
        });
      } catch {
        this.breakHost(new PlayerHostError('host-exited'));
      }
    });
  }
  async initialize(source, number, columns, rows, options = {}) {
    if (this.initialized || this.closing) throw new Error('이미 초기화되었거나 종료 중입니다.');
    this.initialized = true;
    this.diagnostics = options.diagnostics === true;
    const result = await this.request('initialize', {
      ...(typeof source === 'string' ? { source } : { sourcePath: source.path }),
      number,
      columns,
      rows,
      diagnostics: this.diagnostics,
      binding: options.binding,
      expectedSource: options.expectedSource,
    });
    this.name = result.name;
    this.pid = result.pid;
    return result;
  }
  async move(map, position, items = [-1, -1, -1, -1], callId) {
    if (this.busy || this.closing) throw new Error('이전 턴 진행 중이거나 종료 중입니다.');
    this.busy = true;
    try {
      const startedAt = performance.now();
      const result = await this.request('move', { map, position, items, callId });
      return { ...result, roundTripMs: performance.now() - startedAt };
    } finally {
      this.busy = false;
    }
  }
  close() {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      // Overall cleanup only, never normal algorithm timeout.
      const timer = setTimeout(() => {
        if (!this.terminated) this.breakHost(new PlayerHostError('unresponsive'));
      }, this.deadlines.close);
      try {
        if (this.child.connected && !this.failure) await this.request('close').catch(() => {});
        if (!this.terminated && this.failure) this.breakHost(this.failure);
        let releaseTimer;
        try {
          await Promise.race([
            this.exited,
            new Promise((_, reject) => {
              releaseTimer = setTimeout(
                () => reject(new PlayerHostError('unresponsive')),
                this.deadlines.close * 2,
              );
            }),
          ]);
        } finally {
          clearTimeout(releaseTimer);
        }
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closed;
  }
}
