import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const fail = (status, message) => Object.assign(new Error(message), { status });

// Single local server: serialize read/modify/write and replace the file atomically.
export class Accounts {
  constructor(
    file = resolve(process.env.ACCOUNTS_FILE || 'data/accounts/store.json'),
    adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'vactormanbear@gmail.com',
  ) {
    this.file = file;
    this.adminEmail = adminEmail.toLowerCase();
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { users: [], algorithms: [] };
    }
  }
  change(update) {
    const job = this.queue.then(async () => {
      const data = await this.read();
      const result = update(data);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      await writeFile(temporary, JSON.stringify(data), 'utf8');
      await rename(temporary, this.file);
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  login(email) {
    return this.change((data) => {
      let user = data.users.find((u) => u.email === email);
      if (!user) {
        user = {
          id: randomUUID(),
          email,
          role:
            email === this.adminEmail && !data.users.some((u) => u.role === 'admin')
              ? 'admin'
              : 'user',
          active: true,
        };
        data.users.push(user);
      }
      if (!user.active) throw fail(403, '이용이 중지된 계정입니다.');
      return user;
    });
  }
  async user(id) {
    return (await this.read()).users.find((u) => u.id === id && u.active);
  }
  async list(ownerId) {
    return (await this.read()).algorithms
      .filter((a) => a.ownerId === ownerId)
      .map(({ source, ...a }) => a);
  }
  async get(ownerId, id) {
    const item = (await this.read()).algorithms.find((a) => a.ownerId === ownerId && a.id === id);
    if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
    return item;
  }
  save(ownerId, id, input) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.trim().length > 80 ||
      typeof input.source !== 'string' ||
      Buffer.byteLength(input.source) > 65536
    )
      throw fail(400, '이름은 1~80자, 코드는 64 KiB 이하로 입력하세요.');
    return this.change((data) => {
      let item;
      if (id) {
        item = data.algorithms.find((a) => a.id === id && a.ownerId === ownerId);
        if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
        if (input.revision !== item.revision)
          throw fail(409, '다른 창에서 저장했습니다. 새 이름으로 저장하거나 다시 열어 주세요.');
      } else {
        item = {
          id: randomUUID(),
          ownerId,
          language: 'javascript',
          revision: 0,
          createdAt: new Date().toISOString(),
        };
        data.algorithms.push(item);
      }
      Object.assign(item, {
        name: input.name.trim(),
        source: input.source,
        revision: item.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return item;
    });
  }
  updateUser(id, input) {
    return this.change((data) => {
      const user = data.users.find((u) => u.id === id);
      if (!user) throw fail(404, '사용자를 찾을 수 없습니다.');
      if (typeof input.active !== 'boolean' || !['user', 'admin'].includes(input.role))
        throw fail(400, '잘못된 사용자 설정입니다.');
      if (
        user.active &&
        user.role === 'admin' &&
        (!input.active || input.role !== 'admin') &&
        data.users.filter((u) => u.active && u.role === 'admin').length === 1
      )
        throw fail(409, '마지막 활성 관리자는 해제할 수 없습니다.');
      Object.assign(user, { active: input.active, role: input.role });
      return user;
    });
  }
}
