import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { algorithmHostEnvironment } from '../backend/node/src/runtime/player-process.js';

function child(t) {
  const process = spawn(
    globalThis.process.execPath,
    [
      fileURLToPath(new URL('../backend/node/src/execution/validation-host.js', import.meta.url)),
      randomUUID(),
    ],
    {
      env: {
        ...algorithmHostEnvironment(),
        COINHUNTER_REQUIRE_RESOURCE_GATE: '1',
        COINHUNTER_ENGINE_SOURCES: join(tmpdir(), 'missing-resource-gate-' + randomUUID()),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '',
    stderr = '';
  process.stdout.on('data', (b) => {
    stdout += b;
  });
  process.stderr.on('data', (b) => {
    stderr += b;
  });
  const closed = new Promise((resolve) => process.once('close', (code) => resolve(code)));
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await closed;
  });
  return { process, closed, output: () => stdout, error: () => stderr };
}
test(
  'validation host waits for resource authorization before reading the source',
  { timeout: 10000 },
  async (t) => {
    const p = child(t);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(p.output(), '');
    assert.equal(p.process.exitCode, null);
    p.process.stdin.end('start\n');
    assert.equal(await p.closed, 0);
    assert.ok(
      JSON.parse(p.output()).error,
      'Missing source must only be diagnosed after authorization',
    );
  },
);
test(
  'closed resource gate exits without loading an algorithm or starting validation',
  { timeout: 10000 },
  async (t) => {
    const p = child(t);
    p.process.stdin.end();
    assert.notEqual(await p.closed, 0);
    assert.equal(p.output(), '');
    assert.match(p.error(), /resource-gate-closed/);
  },
);
