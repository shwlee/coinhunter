import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupOrphanUploads } from '../src/persistence/upload-cleanup.js';

test('startup cleanup removes dead-process uploads and old legacy uploads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-orphans-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const dead = `${process.pid + 100000}-${uuid}.js`;
  const live = `${process.pid}-${uuid}.js`;
  const legacyOld = `${uuid}.js`;
  const legacyRecent = 'abcdef12-1234-1234-1234-123456789abc.js';
  for (const name of [dead, live, legacyOld, legacyRecent, 'notes.js'])
    await writeFile(join(dir, name), 'code');
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(join(dir, legacyOld), oldTime, oldTime);
  await cleanupOrphanUploads(dir, (pid) => pid === process.pid);
  assert.deepEqual((await readdir(dir)).sort(), [live, legacyRecent, 'notes.js'].sort());
});
