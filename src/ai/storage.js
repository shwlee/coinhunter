import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withFileLock } from '../persistence/file-lock.js';
import { fail } from '../persistence/errors.js';

export const identifier = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function assertScope(scope) {
  if (!identifier(scope?.ownerId) || !identifier(scope?.sessionId))
    throw fail(401, '유효한 로그인 세션이 필요합니다.');
}

// File lock covers the entire read/modify/write, including independent instances.
export class AiJsonStore {
  constructor(file) {
    this.file = resolve(file);
    this.queue = Promise.resolve();
  }
  transaction(operation, { write = false, guard = () => {} } = {}) {
    const job = this.queue.then(() =>
      withFileLock(this.file, async (lease) => {
        let data;
        try {
          data = JSON.parse(await readFile(this.file, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw fail(503, 'AI 저장 데이터를 확인하세요.');
          data = { version: 1, connections: [], preferences: [] };
        }
        if (
          !data ||
          data.version !== 1 ||
          !Array.isArray(data.connections) ||
          !Array.isArray(data.preferences)
        )
          throw fail(503, 'AI 저장 형식을 확인하세요.');
        guard();
        const result = operation(data);
        if (write) {
          const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
            await lease.assertOwned();
            guard();
            await rename(temporary, this.file);
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        return result;
      }),
    );
    this.queue = job.catch(() => {});
    return job;
  }
}
