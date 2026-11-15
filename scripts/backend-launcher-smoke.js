import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, request } from './backend-integration.js';
import { serviceEnvironment } from './backend-tools.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = resolve(root, 'artifacts');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'backend-launcher-'));
const operations = await freePort(),
  execution = await freePort(),
  frontend = await freePort();
const child = spawn('node', ['scripts/backend.js', 'web'], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...serviceEnvironment({
      AUTH_MODE: 'mock',
      COINHUNTER_INTERNAL_KEY: randomBytes(32).toString('base64url'),
      Backend__DataRoot: join(directory, 'operations'),
      Backend__ExchangeRoot: join(directory, 'exchange'),
      Backend__ExecutionRoot: join(directory, 'execution'),
    }),
    COINHUNTER_OPERATIONS_URL: `http://127.0.0.1:${operations}`,
    COINHUNTER_EXECUTION_URL: `http://127.0.0.1:${execution}`,
    COINHUNTER_PUBLIC_URL: `http://127.0.0.1:${frontend}`,
  },
});
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
const exited = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', resolveExit);
});
child.stdin.on('error', () => {});
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('Launcher failed: ' + output);
    try {
      const response = await request(frontend, '/api/session');
      if (response.status === 200) {
        assert.equal(response.body.mock, true);
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(ready, true, output);
  assert.equal((await request(frontend, '/signin')).status, 200);
  child.stdin.end('shutdown\n');
  const timer = setTimeout(() => child.kill(), 25000);
  try {
    assert.equal(await exited, 0, output);
  } finally {
    clearTimeout(timer);
  }
  for (const port of [frontend, operations, execution])
    await assert.rejects(request(port, '/health/live'));
  console.log(
    'PASS split launcher: builds, waits for readiness, serves UI/API and gracefully closes all three listeners.',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end('shutdown\n');
    await exited;
  }
  if (directory.startsWith(parent + '\\') || directory.startsWith(parent + '/'))
    await rm(directory, { recursive: true, force: true });
}
