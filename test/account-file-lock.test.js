import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  writeFile,
  utimes,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { withFileLock } from '../src/persistence/file-lock.js';

const run = promisify(execFile);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'coin-account-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  return { dir, file, repository: new FileAccountRepository(file) };
}
function message(child, predicate) {
  return new Promise((resolve, reject) => {
    const receive = (value) => {
      if (predicate(value)) {
        cleanup();
        resolve(value);
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('Lock test worker exited before responding: ' + child.testStderr));
    };
    const cleanup = () => {
      child.off('message', receive);
      child.off('exit', closed);
    };
    child.on('message', receive);
    child.once('exit', closed);
  });
}
async function worker(t, file) {
  const script = `
    import { FileAccountRepository } from ${JSON.stringify(new URL('../src/persistence/file-account-repository.js', import.meta.url).href)};
    import { randomUUID } from 'node:crypto';
    const repository = new FileAccountRepository(process.argv[1]);
    let release;
    process.on('message', async input => {
      if(input.type === 'release') { release?.(); return; }
      try {
        if(input.type === 'hold') await repository.change(async data => {
          const wait = new Promise(resolve => { release=resolve; });
          process.send({type:'holding'});
          await wait;
          data.users.push({id:randomUUID(),email:'held@example.test',role:'user',active:true});
        });
        if(input.type === 'batch') for(let i=0;i<input.count;i++) {
          const user = await repository.login(input.prefix+i+'@example.test');
          await repository.save(user.id,null,{name:'code',source:'code-'+input.prefix+i});
          await repository.recordMatch(user.id,{score:i,source:'match-'+input.prefix+i});
        }
        process.send({type:'done'});
      } catch(error) { process.send({type:'failure',message:error.message}); }
    });
    process.send({type:'ready'});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.testStderr = '';
  child.stderr.on('data', (chunk) => {
    child.testStderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  });
  await message(child, (value) => value.type === 'ready');
  return child;
}

test('separate repository instances serialize the entire read-modify-write without losing a promotion', async (t) => {
  const { file, repository } = await fixture(t);
  const user = await repository.login('admin@example.test');
  const entered = deferred(),
    resume = deferred();
  const held = repository.change(async (data) => {
    entered.resolve();
    await resume.promise;
    data.users.push({ id: 'additional', email: 'other@example.test', role: 'user', active: true });
  });
  await entered.promise;
  let completed = false;
  const second = new FileAccountRepository(file)
    .updateUser(user.id, { active: true, role: 'admin' })
    .then(() => {
      completed = true;
    });
  await delay(60);
  assert.equal(completed, false);
  resume.resolve();
  await Promise.all([held, second]);
  assert.equal((await repository.user(user.id)).role, 'admin');
  assert.equal((await repository.listUsers()).length, 2);
});

test(
  'a real maintenance CLI waits for a different process transaction and preserves both writes',
  { timeout: 15000 },
  async (t) => {
    const { file, repository } = await fixture(t);
    const user = await repository.login('admin@example.test');
    const child = await worker(t, file);
    const holding = message(child, (value) => value.type === 'holding');
    child.send({ type: 'hold' });
    await holding;
    let completed = false;
    const command = run(
      process.execPath,
      [fileURLToPath(new URL('../scripts/bootstrap-admin.js', import.meta.url)), user.email],
      { env: { ...process.env, AUTH_MODE: 'mock', ACCOUNTS_FILE: file } },
    ).then((value) => {
      completed = true;
      return value;
    });
    await delay(150);
    assert.equal(completed, false);
    const done = message(child, (value) => value.type === 'done' || value.type === 'failure');
    child.send({ type: 'release' });
    assert.equal((await done).type, 'done');
    await command;
    assert.equal((await repository.user(user.id)).role, 'admin');
    assert.equal(
      (await repository.listUsers()).some((value) => value.email === 'held@example.test'),
      true,
    );
  },
);

test(
  'multiple processes preserve all accounts, algorithm files and match records',
  { timeout: 15000 },
  async (t) => {
    const { file, dir, repository } = await fixture(t);
    const children = await Promise.all([worker(t, file), worker(t, file), worker(t, file)]);
    const done = children.map((child) =>
      message(child, (value) => value.type === 'done' || value.type === 'failure'),
    );
    children.forEach((child, index) =>
      child.send({ type: 'batch', prefix: `process${index}-`, count: 8 }),
    );
    for (const result of await Promise.all(done)) assert.equal(result.type, 'done', result.message);
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.users.length, 24);
    assert.equal(data.algorithms.length, 24);
    assert.equal(data.history.length, 24);
    assert.equal((await readdir(join(dir, 'sources'))).length, 48);
    for (const algorithm of data.algorithms)
      assert.match((await repository.get(algorithm.ownerId, algorithm.id)).source, /^code-process/);
    for (const entry of data.history)
      assert.match(
        (await repository.historyEntry(entry.ownerId, entry.id)).source,
        /^match-process/,
      );
  },
);

test('a killed lock owner is recovered without overwriting existing data', async (t) => {
  const { file, repository } = await fixture(t);
  const user = await repository.login('admin@example.test');
  const child = await worker(t, file);
  const holding = message(child, (value) => value.type === 'holding');
  child.send({ type: 'hold' });
  await holding;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const contenders = Array.from({ length: 6 }, () => new FileAccountRepository(file));
  await Promise.all([
    repository.updateUser(user.id, { active: true, role: 'admin' }),
    ...contenders.map((value, index) => value.login(`recovery${index}@example.test`)),
  ]);
  assert.equal((await repository.user(user.id)).role, 'admin');
  assert.equal((await repository.listUsers()).length, 7);
  await assert.rejects(readdir(file + '.lock'), { code: 'ENOENT' });
});

test('an owner from another host is not recovered using this host PID checks', async (t) => {
  const { file } = await fixture(t);
  await mkdir(file + '.lock');
  await writeFile(
    join(file + '.lock', '2147483647-00000000-0000-0000-0000-000000000000.owner'),
    JSON.stringify({ host: 'another-host' }),
  );
  await assert.rejects(
    withFileLock(file, () => assert.fail('must not acquire'), { timeoutMs: 60 }),
    {
      status: 503,
    },
  );
  assert.equal((await readdir(file + '.lock')).length, 1);
});

test('release failure does not reject a committed operation', async (t) => {
  const { file } = await fixture(t);
  const warnings = [];
  const original = console.error;
  console.error = (...args) => warnings.push(args);
  try {
    const result = await withFileLock(file, async () => {
      await writeFile(file, 'committed');
      // Simulate external interference after commit and before release.
      const [name] = await readdir(file + '.lock');
      await unlink(join(file + '.lock', name));
      return 'success';
    });
    assert.equal(result, 'success');
    assert.equal(await readFile(file, 'utf8'), 'committed');
    assert.equal(warnings.length, 1);
  } finally {
    console.error = original;
  }
});

test('live locks are never stolen based on age and timeout leaves data unchanged', async (t) => {
  const { file } = await fixture(t);
  const entered = deferred(),
    resume = deferred();
  const held = withFileLock(file, async () => {
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  const old = new Date(0);
  await utimes(file + '.lock', old, old);
  await assert.rejects(
    withFileLock(file, () => assert.fail('must not acquire'), { timeoutMs: 70 }),
    { status: 503 },
  );
  resume.resolve();
  await held;
  assert.equal(await withFileLock(file, () => 'released'), 'released');
});

test('unknown locks fail closed, and failed writes release the lock and remove temporary files', async (t) => {
  const { file, dir, repository } = await fixture(t);
  await mkdir(file + '.lock');
  await assert.rejects(
    withFileLock(file, () => assert.fail('must not acquire'), { timeoutMs: 60 }),
    { status: 503 },
  );
  await rmdir(file + '.lock');
  await repository.login('person@example.test');
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    repository.change((data) => {
      data.circular = data;
    }),
    TypeError,
  );
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await repository.listUsers()).length, 1);
  assert.equal(
    (await readdir(dir)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
    false,
  );
});

test('concurrent legacy migration creates one source copy per entry', async (t) => {
  const { file, dir } = await fixture(t);
  await writeFile(
    file,
    JSON.stringify({
      users: [{ id: 'user', email: 'person@example.test', role: 'user', active: true }],
      algorithms: [{ id: 'algorithm', ownerId: 'user', source: 'legacy-code' }],
      history: [
        {
          id: 'history',
          ownerId: 'user',
          source: 'legacy-match',
          playedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const repositories = Array.from({ length: 6 }, () => new FileAccountRepository(file));
  await Promise.all(repositories.map((repository) => repository.listUsers()));
  assert.equal((await readdir(join(dir, 'sources'))).length, 2);
  assert.equal((await repositories[0].get('user', 'algorithm')).source, 'legacy-code');
  assert.equal((await repositories[0].historyEntry('user', 'history')).source, 'legacy-match');
});
