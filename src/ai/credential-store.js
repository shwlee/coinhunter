import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fail } from '../persistence/errors.js';
import { assertScope, identifier } from './storage.js';
import { withFileLock } from '../persistence/file-lock.js';

const unavailable = () => fail(503, 'AI 자격 증명 암호화 설정 또는 저장 자료를 확인하세요.');
const missing = () => fail(404, 'AI 자격 증명을 찾을 수 없습니다.');
export class FileCredentialStore {
  #key;
  #keyId;
  #temporary = new Map();
  constructor({
    directory = 'data/ai/credentials',
    key,
    keyId,
    allowStored = false,
    guard = () => {},
  } = {}) {
    this.directory = resolve(directory);
    this.guard = guard;
    this.allowStored = allowStored;
    if (key || keyId) {
      if (
        typeof key !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(key) ||
        typeof keyId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)
      )
        throw unavailable();
      this.#key = Buffer.from(key, 'hex');
      this.#keyId = keyId;
    }
  }
  get storedAvailable() {
    return this.allowStored && !!this.#key;
  }
  #scope(scope) {
    assertScope(scope);
    this.guard(scope);
  }
  #path(reference) {
    if (!identifier(reference)) throw missing();
    return join(this.directory, reference + '.json');
  }
  #aad(record) {
    return Buffer.from(
      JSON.stringify([record.version, record.reference, record.ownerId, record.keyId]),
    );
  }
  async #ensureKey() {
    if (!this.#key) throw unavailable();
    const file = this.directory + '.key-check.json';
    await withFileLock(file, async (lease) => {
      let record;
      try {
        record = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw unavailable();
        const entries = await readdir(this.directory).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        // Missing key-check with existing ciphertext is a recovery problem, not a new vault.
        if (entries.some((entry) => entry.endsWith('.json'))) throw unavailable();
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
        cipher.setAAD(Buffer.from(JSON.stringify([1, this.#keyId, 'ai-key-check'])));
        const ciphertext = Buffer.concat([cipher.update('ai-vault-key-check-v1'), cipher.final()]);
        record = {
          version: 1,
          keyId: this.#keyId,
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        };
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
          await lease.assertOwned();
          await rename(temporary, file);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
      try {
        if (record.version !== 1 || record.keyId !== this.#keyId) throw unavailable();
        const iv = Buffer.from(record.iv, 'base64'),
          tag = Buffer.from(record.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw unavailable();
        const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
        decipher.setAAD(Buffer.from(JSON.stringify([1, record.keyId, 'ai-key-check'])));
        decipher.setAuthTag(tag);
        if (
          Buffer.concat([
            decipher.update(Buffer.from(record.ciphertext, 'base64')),
            decipher.final(),
          ]).toString('utf8') !== 'ai-vault-key-check-v1'
        )
          throw unavailable();
      } catch {
        throw unavailable();
      }
    });
  }
  async put(scope, mode, secret) {
    this.#scope(scope);
    if (
      !['session', 'stored'].includes(mode) ||
      typeof secret !== 'string' ||
      !secret.trim() ||
      secret.length > 16384 ||
      /[\r\n\u0000]/u.test(secret)
    )
      throw fail(400, 'AI 자격 증명 입력을 확인하세요.');
    const reference = randomUUID();
    if (mode === 'session') {
      this.#temporary.set(reference, {
        ownerId: scope.ownerId,
        sessionId: scope.sessionId,
        secret,
      });
      return reference;
    }
    if (!this.storedAvailable) throw unavailable();
    await this.#ensureKey();
    this.#scope(scope);
    const record = { version: 1, reference, ownerId: scope.ownerId, keyId: this.#keyId };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(this.#aad(record));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    Object.assign(record, {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
    });
    await mkdir(this.directory, { recursive: true });
    this.#scope(scope);
    const path = this.#path(reference);
    let created = false;
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      created = true;
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      handle = null;
      this.#scope(scope);
      return reference;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await unlink(path).catch(() => {});
      throw error;
    }
  }
  async #read(reference) {
    try {
      const record = JSON.parse(await readFile(this.#path(reference), 'utf8'));
      if (
        record.version !== 1 ||
        record.reference !== reference ||
        !identifier(record.ownerId) ||
        typeof record.keyId !== 'string'
      )
        throw unavailable();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') throw missing();
      if (error.status) throw error;
      throw unavailable();
    }
  }
  async resolve(scope, reference) {
    this.#scope(scope);
    this.#path(reference);
    const temporary = this.#temporary.get(reference);
    if (temporary) {
      if (temporary.ownerId !== scope.ownerId || temporary.sessionId !== scope.sessionId)
        throw missing();
      return temporary.secret;
    }
    const record = await this.#read(reference);
    this.#scope(scope);
    if (record.ownerId !== scope.ownerId) throw missing();
    if (!this.#key || record.keyId !== this.#keyId) throw unavailable();
    await this.#ensureKey();
    this.#scope(scope);
    try {
      const iv = Buffer.from(record.iv, 'base64');
      const tag = Buffer.from(record.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(this.#aad(record));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw unavailable();
    }
  }
  async delete(scope, reference) {
    this.#scope(scope);
    const path = this.#path(reference);
    const temporary = this.#temporary.get(reference);
    if (temporary) {
      if (temporary.ownerId !== scope.ownerId || temporary.sessionId !== scope.sessionId)
        throw missing();
      this.#temporary.delete(reference);
      return;
    }
    let record;
    try {
      record = await this.#read(reference);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    this.#scope(scope);
    if (record.ownerId !== scope.ownerId) throw missing();
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  deleteSession(sessionId) {
    for (const [reference, record] of this.#temporary)
      if (record.sessionId === sessionId) this.#temporary.delete(reference);
  }
  // Server-only rollback after an operation's session was revoked. Never a public API.
  async discard(ownerId, reference) {
    if (!identifier(ownerId)) throw missing();
    const temporary = this.#temporary.get(reference);
    if (temporary) {
      if (temporary.ownerId !== ownerId) throw missing();
      this.#temporary.delete(reference);
      return;
    }
    let record;
    try {
      record = await this.#read(reference);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (record.ownerId !== ownerId) throw missing();
    await unlink(this.#path(reference)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async deleteOwner(ownerId) {
    if (!identifier(ownerId)) throw missing();
    for (const [reference, record] of this.#temporary)
      if (record.ownerId === ownerId) this.#temporary.delete(reference);
    const entries = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!/^[a-f0-9-]{36}\.json$/.test(entry)) continue;
      const reference = entry.slice(0, -5);
      const record = await this.#read(reference);
      if (record.ownerId === ownerId) await unlink(this.#path(reference));
    }
  }
  clear() {
    this.#temporary.clear();
  }
}
