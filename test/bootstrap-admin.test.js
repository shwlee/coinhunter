import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

test('bootstrap command persists the administrator in local account data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-admin-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'accounts.json');
  const { stdout } = await run(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/bootstrap-admin.js', import.meta.url)),
      'admin@company.test',
    ],
    { env: { ...process.env, ACCOUNTS_FILE: file } },
  );
  assert.match(stdout, /관리자 계정이 로컬 저장소에 등록되었습니다/);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    data.users.map(({ email, role, active }) => ({ email, role, active })),
    [{ email: 'admin@company.test', role: 'admin', active: true }],
  );
});
