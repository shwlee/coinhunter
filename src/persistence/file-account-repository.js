import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fail } from './errors.js';
import { FileSourceStore } from './file-source-store.js';
import { withCopySpace } from './disk-space.js';

// Single local server: serialize read/modify/write and replace the file atomically.
export class FileAccountRepository {
  constructor(
    file = resolve(process.env.ACCOUNTS_FILE || 'data/accounts/store.json'),
    adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'vactormanbear@gmail.com',
    sources = new FileSourceStore(
      process.env.ALGORITHM_SOURCE_DIR || join(dirname(file), 'sources'),
    ),
  ) {
    this.file = file;
    this.adminEmail = adminEmail.toLowerCase();
    this.sources = sources;
    this.queue = Promise.resolve();
    this.migrated = false;
  }
  async read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { users: [], algorithms: [], history: [] };
    }
  }
  async write(data) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    await writeFile(temporary, JSON.stringify(data), 'utf8');
    await rename(temporary, this.file);
  }
  async migrateInlineSources() {
    if (this.migrated) return;
    const data = await this.read();
    const written = [];
    try {
      for (const item of [...data.algorithms, ...(data.history || [])]) {
        if (typeof item.source !== 'string') continue;
        const key = await this.sources.put(item.source);
        written.push(key);
        item.sourceKey = key;
        delete item.source;
      }
      if (written.length) await this.write(data);
      this.migrated = true;
    } catch (error) {
      await Promise.all(written.map((key) => this.sources.delete(key).catch(() => {})));
      throw error;
    }
  }
  enqueue(operation) {
    const job = this.queue.then(async () => {
      await this.migrateInlineSources();
      return operation();
    });
    this.queue = job.catch(() => {});
    return job;
  }
  inspect(select) {
    return this.enqueue(async () => select(await this.read()));
  }
  change(update) {
    return this.enqueue(async () => {
      const data = await this.read();
      const result = await update(data);
      await this.write(data);
      return result;
    });
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
  user(id) {
    return this.inspect((data) => data.users.find((u) => u.id === id && u.active));
  }
  listUsers() {
    return this.inspect((data) => data.users);
  }
  list(ownerId) {
    return this.inspect((data) =>
      data.algorithms
        .filter((a) => a.ownerId === ownerId)
        .map(({ sourceKey, ...metadata }) => metadata),
    );
  }
  get(ownerId, id) {
    return this.inspect(async (data) => {
      const item = data.algorithms.find((a) => a.ownerId === ownerId && a.id === id);
      if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
      const { sourceKey, ...metadata } = item;
      return { ...metadata, source: await this.sources.get(sourceKey) };
    });
  }
  metadata(ownerId, id) {
    return this.inspect((data) => {
      const item = data.algorithms.find((a) => a.ownerId === ownerId && a.id === id);
      if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
      const { sourceKey, ...metadata } = item;
      return metadata;
    });
  }
  sourcePath(ownerId, id) {
    return this.inspect((data) => {
      const item = data.algorithms.find((a) => a.ownerId === ownerId && a.id === id);
      if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
      return this.sources.path(item.sourceKey);
    });
  }
  snapshotSource(ownerId, id, destination) {
    return this.inspect(async (data) => {
      const item = data.algorithms.find((a) => a.ownerId === ownerId && a.id === id);
      if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
      await withCopySpace(this.sources.path(item.sourceKey), dirname(destination), () =>
        copyFile(this.sources.path(item.sourceKey), destination),
      );
      return destination;
    });
  }
  history(ownerId) {
    return this.inspect((data) =>
      (data.history || [])
        .filter((entry) => entry.ownerId === ownerId)
        .sort((a, b) => b.playedAt.localeCompare(a.playedAt))
        .map(({ sourceKey, ownerId: omittedOwner, ...metadata }) => metadata),
    );
  }
  historyEntry(ownerId, id) {
    return this.inspect(async (data) => {
      const entry = (data.history || []).find((item) => item.ownerId === ownerId && item.id === id);
      if (!entry) throw fail(404, '경기 기록을 찾을 수 없습니다.');
      const { sourceKey, ...metadata } = entry;
      return { ...metadata, source: await this.sources.get(sourceKey) };
    });
  }
  historySourcePath(ownerId, id) {
    return this.inspect((data) => {
      const entry = (data.history || []).find((item) => item.ownerId === ownerId && item.id === id);
      if (!entry) throw fail(404, '경기 기록을 찾을 수 없습니다.');
      return this.sources.path(entry.sourceKey);
    });
  }
  async recordMatch(ownerId, entry) {
    if (typeof entry.source !== 'string' && typeof entry.sourcePath !== 'string')
      throw fail(400, '알고리즘 코드가 필요합니다.');
    let staged;
    try {
      return await this.change(async (data) => {
        staged = entry.sourcePath
          ? await this.sources.putFile(entry.sourcePath)
          : await this.sources.put(entry.source);
        data.history ||= [];
        const { source, sourcePath, ...metadata } = entry;
        const record = {
          id: randomUUID(),
          ownerId,
          playedAt: new Date().toISOString(),
          ...metadata,
          sourceKey: staged,
        };
        data.history.push(record);
        return { ...record, source };
      });
    } catch (error) {
      if (staged) await this.sources.delete(staged).catch(() => {});
      throw error;
    }
  }
  async save(ownerId, id, input, sourcePath = null) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.trim().length > 80 ||
      (typeof input.source !== 'string' && typeof sourcePath !== 'string')
    )
      throw fail(400, '이름은 1~80자, 코드는 문자열로 입력하세요.');
    let staged;
    let previous;
    try {
      const result = await this.change(async (data) => {
        let item;
        if (id) {
          item = data.algorithms.find((a) => a.id === id && a.ownerId === ownerId);
          if (!item) throw fail(404, '알고리즘을 찾을 수 없습니다.');
          if (input.revision !== item.revision)
            throw fail(409, '다른 창에서 저장했습니다. 새 이름으로 저장하거나 다시 열어 주세요.');
          previous = item.sourceKey;
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
        staged = sourcePath
          ? await this.sources.putFile(sourcePath)
          : await this.sources.put(input.source);
        Object.assign(item, {
          name: input.name.trim(),
          sourceKey: staged,
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        });
        const { sourceKey, ...metadata } = item;
        return { ...metadata, ...(sourcePath ? {} : { source: input.source }) };
      });
      if (previous) await this.sources.delete(previous).catch(() => {});
      return result;
    } catch (error) {
      if (staged) await this.sources.delete(staged).catch(() => {});
      throw error;
    }
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
