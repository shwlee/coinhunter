import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class PlayerProcess {
  constructor() {
    this.sequence = 0;
    this.pending = new Map();
    this.busy = false;
    this.closing = false;
    this.child = fork(fileURLToPath(new URL('./player-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      execArgv: [],
    });
    this.exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.on('message', (message) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('알고리즘 프로세스가 종료되었습니다.')));
  }

  fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  request(type, payload = {}) {
    if (!this.child.connected) return Promise.reject(new Error('실행 프로세스 연결이 없습니다.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, type, payload }, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async initialize(source, number, columns, rows) {
    if (this.initialized) throw new Error('이미 초기화되었습니다.');
    this.initialized = true;
    const result = await this.request('initialize', {
      ...(typeof source === 'string' ? { source } : { sourcePath: source.path }),
      number,
      columns,
      rows,
    });
    this.name = result.name;
    this.pid = result.pid;
    return result;
  }

  async move(map, position, items = [-1, -1, -1, -1]) {
    if (this.busy || this.closing) throw new Error('이전 턴 진행 중이거나 종료 중입니다.');
    this.busy = true;
    try {
      return await this.request('move', { map, position, items });
    } finally {
      this.busy = false;
    }
  }

  async close() {
    if (this.closing) return this.exited;
    this.closing = true;
    // Called only when the match is over; never used as a turn timeout mechanism.
    if (this.child.connected) await this.request('close').catch(() => {});
    await this.exited;
  }
}
