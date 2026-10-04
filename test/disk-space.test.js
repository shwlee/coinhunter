import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diskSpace, hasCopySpace, withCopySpace } from '../src/persistence/disk-space.js';

test('copy space includes the source size before starting a copy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-disk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.js');
  const target = join(directory, 'target.js');
  await writeFile(source, 'source');
  const { free, device } = await diskSpace(directory);
  assert.equal(hasCopySpace(free, device, free), false);
  assert.equal(hasCopySpace(1024 * 1024 * 1024, device, 800 * 1024 * 1024), true);
  assert.equal(hasCopySpace(1024 * 1024 * 1024, device, 900 * 1024 * 1024), false);
  await withCopySpace(source, directory, async () => writeFile(target, await readFile(source)));
  assert.equal(await readFile(target, 'utf8'), 'source');
});
