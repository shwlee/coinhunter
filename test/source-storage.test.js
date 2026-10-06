import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { validateSource } from '../src/runtime/policy.js';

test('administrator is bootstrapped once and its role persists without configuration', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-admin-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  const repository = new FileAccountRepository(file);
  const before = await repository.login('admin@company.test');
  assert.equal(before.role, 'user');
  const admin = await repository.bootstrapAdmin('admin@company.test');
  assert.equal(admin.role, 'admin');
  assert.equal((await repository.bootstrapAdmin('admin@company.test')).id, admin.id);
  await assert.rejects(repository.bootstrapAdmin('other@company.test'), { status: 409 });
  const reopened = new FileAccountRepository(file);
  assert.equal((await reopened.login('admin@company.test')).role, 'admin');
});

test('source files stay separate from account and match metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-sources-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  const repository = new FileAccountRepository(file);
  const user = await repository.login('developer@company.test');
  const source = `module.exports = class { initialize() {} getName() { return 'large'; } moveNext() { return -1; } };\n/*${'x'.repeat(120000)}*/`;
  validateSource(source);
  const first = await repository.save(user.id, null, { name: 'large', source });
  let metadata = JSON.parse(await readFile(file, 'utf8'));
  const firstKey = metadata.algorithms[0].sourceKey;
  assert.equal(metadata.algorithms[0].source, undefined);
  assert.equal(await readFile(join(dir, 'sources', `${firstKey}.js`), 'utf8'), source);
  assert.equal((await repository.list(user.id))[0].sourceKey, undefined);
  assert.equal((await repository.get(user.id, first.id)).source, source);
  const snapshot = join(dir, 'match-snapshot.js');
  await repository.snapshotSource(user.id, first.id, snapshot);

  const updated = await repository.save(user.id, first.id, {
    name: 'updated',
    source: 'module.exports = 1;',
    revision: first.revision,
  });
  metadata = JSON.parse(await readFile(file, 'utf8'));
  assert.notEqual(metadata.algorithms[0].sourceKey, firstKey);
  await assert.rejects(readFile(join(dir, 'sources', `${firstKey}.js`)), { code: 'ENOENT' });
  assert.equal((await repository.get(user.id, updated.id)).source, updated.source);
  assert.equal(await readFile(snapshot, 'utf8'), source);

  await repository.recordMatch(user.id, { score: 5, source });
  metadata = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(metadata.history[0].source, undefined);
  assert.equal((await repository.history(user.id))[0].sourceKey, undefined);
  const reopened = new FileAccountRepository(file);
  assert.equal((await reopened.historyEntry(user.id, metadata.history[0].id)).source, source);
  assert.equal((await reopened.get(user.id, first.id)).source, updated.source);
  const other = await reopened.login('tester@company.test');
  await assert.rejects(reopened.get(other.id, first.id), { status: 404 });
  await assert.rejects(reopened.snapshotSource(other.id, first.id, join(dir, 'forbidden.js')), {
    status: 404,
  });
  await assert.rejects(reopened.historyEntry(other.id, metadata.history[0].id), { status: 404 });
});

test('legacy inline sources migrate to files before the first read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-source-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  await writeFile(
    file,
    JSON.stringify({
      users: [{ id: 'user-1', email: 'old@company.test', role: 'user', active: true }],
      algorithms: [{ id: 'algorithm-1', ownerId: 'user-1', revision: 1, source: 'old code' }],
      history: [
        { id: 'history-1', ownerId: 'user-1', playedAt: '2026-01-01', source: 'old match' },
      ],
    }),
  );
  const repository = new FileAccountRepository(file);
  assert.equal((await repository.get('user-1', 'algorithm-1')).source, 'old code');
  assert.equal((await repository.historyEntry('user-1', 'history-1')).source, 'old match');
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(metadata.algorithms[0].source, undefined);
  assert.equal(metadata.history[0].source, undefined);
  assert.equal(
    await readFile(join(dir, 'sources', `${metadata.algorithms[0].sourceKey}.js`), 'utf8'),
    'old code',
  );
  assert.equal(
    await readFile(join(dir, 'sources', `${metadata.history[0].sourceKey}.js`), 'utf8'),
    'old match',
  );
});

test('opened source keeps its matching metadata through a concurrent overwrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-open-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = new FileAccountRepository(join(dir, 'store.json'));
  const user = await repository.login('developer@company.test');
  const first = await repository.save(user.id, null, { name: 'first', source: 'old source' });
  const oldPath = await repository.sourcePath(user.id, first.id);
  const opened = await repository.openSource(user.id, first.id);
  assert.equal(opened.metadata.revision, first.revision);
  assert.equal(opened.metadata.name, 'first');
  const second = await repository.save(user.id, first.id, {
    name: 'second',
    source: 'new source',
    revision: first.revision,
  });
  const chunks = [];
  for await (const chunk of opened.handle.createReadStream({ autoClose: false }))
    chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'old source');
  await opened.release();
  await assert.rejects(readFile(oldPath), { code: 'ENOENT' });
  const current = await repository.openSource(user.id, first.id);
  assert.equal(current.metadata.revision, second.revision);
  await current.release();
});
