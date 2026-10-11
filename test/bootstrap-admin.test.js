import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';

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
    { env: { ...process.env, AUTH_MODE: 'mock', ACCOUNTS_FILE: file } },
  );
  assert.match(stdout, /관리자 계정이 로컬 저장소에 등록되었습니다/);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    data.users.map(({ email, role, active }) => ({ email, role, active })),
    [{ email: 'admin@company.test', role: 'admin', active: true }],
  );
});

test('explicit account ID grants the Google administrator without merging same-email mock data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-admin-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'accounts.json');
  const accounts = new FileAccountRepository(file);
  const email = 'same@company.test';
  const mock = await accounts.bootstrapAdmin(email);
  const google = await accounts.loginIdentity(
    { provider: 'google', subject: 'private-google-sub', email },
    { allowCreate: true },
  );
  const algorithm = await accounts.save(google.id, null, { name: 'code', source: 'google-code' });
  const history = await accounts.recordMatch(mock.id, { source: 'mock-history', score: 8 });
  const options = { env: { ...process.env, AUTH_MODE: 'google', ACCOUNTS_FILE: file } };
  const cli = (script, ...args) =>
    run(
      process.execPath,
      [fileURLToPath(new URL('../scripts/' + script, import.meta.url)), ...args],
      options,
    );
  const before = await readFile(file, 'utf8');
  await assert.rejects(accounts.bootstrapAdmin(email), { status: 409 });
  await assert.rejects(cli('bootstrap-admin.js', email), /계정 ID/);
  assert.equal(await readFile(file, 'utf8'), before);
  const listed = await cli('grant-admin.js', '--list', '--email', email.toUpperCase());
  const users = JSON.parse(listed.stdout);
  assert.deepEqual(
    users.map((user) => user.authProviders),
    [['mock'], ['google']],
  );
  assert.equal(users[1].id, google.id);
  assert.equal(listed.stdout.includes('private-google-sub'), false);
  await cli('grant-admin.js', '--user-id', google.id);
  await cli('grant-admin.js', '--user-id', google.id);
  assert.equal((await accounts.user(mock.id)).role, 'admin');
  assert.equal((await accounts.user(google.id)).role, 'admin');
  assert.equal((await accounts.get(google.id, algorithm.id)).source, 'google-code');
  assert.equal((await accounts.historyEntry(mock.id, history.id)).source, 'mock-history');
  const result = await cli('bootstrap-admin.js', email);
  assert.ok(result.stdout.includes(google.id));
  assert.equal(result.stdout.includes(mock.id), false);
  const saved = await readFile(file, 'utf8');
  await assert.rejects(cli('grant-admin.js', '--user-id', randomUUID()), /대상 계정/);
  await assert.rejects(cli('grant-admin.js', '--user-id', email), /계정 ID/);
  await assert.rejects(cli('grant-admin.js', '--user-id', google.id, '--unknown'), /사용법/);
  assert.equal(await readFile(file, 'utf8'), saved);
  await accounts.updateUser(google.id, { active: false, role: 'user' });
  const disabled = await readFile(file, 'utf8');
  await assert.rejects(cli('grant-admin.js', '--user-id', google.id), /이용 중지/);
  assert.equal(await readFile(file, 'utf8'), disabled);
});

test('Google bootstrap requires a verified existing account and cannot silently create a mock admin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-google-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'accounts.json');
  const accounts = new FileAccountRepository(file);
  const email = 'first@company.test';
  const command = () =>
    run(
      process.execPath,
      [fileURLToPath(new URL('../scripts/bootstrap-admin.js', import.meta.url)), email],
      { env: { ...process.env, AUTH_MODE: 'google', ACCOUNTS_FILE: file } },
    );
  await assert.rejects(command(), /먼저 Google 로그인/);
  assert.equal((await accounts.listUsers()).length, 0);
  const first = await accounts.loginIdentity(
    { provider: 'google', subject: 'first-sub', email },
    { allowCreate: true },
  );
  assert.ok((await command()).stdout.includes(first.id));
  await accounts.loginIdentity(
    { provider: 'google', subject: 'second-sub', email },
    { allowCreate: true },
  );
  const saved = await readFile(file, 'utf8');
  await assert.rejects(command(), /같은 이메일/);
  assert.equal(await readFile(file, 'utf8'), saved);
});
