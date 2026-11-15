import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../backend/node/src/server.js';
import { createAuthoring } from '../backend/node/src/authoring-api.js';
import { FileAccountRepository } from '../backend/node/src/persistence/file-account-repository.js';

async function snapshot(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(path) : await readFile(path, 'hex');
  }
  return result;
}

test('retired AI endpoints stay unavailable with legacy settings and leave old credential files untouched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-ai-retired-'));
  const aiDirectory = join(dir, 'ai');
  await mkdir(join(aiDirectory, 'credentials'), { recursive: true });
  await mkdir(join(aiDirectory, 'requests'), { recursive: true });
  await writeFile(join(aiDirectory, 'connections.json'), 'existing-connection-data');
  await writeFile(join(aiDirectory, 'credentials', 'existing.json'), 'existing-encrypted-data');
  await writeFile(join(aiDirectory, 'requests', 'existing.js'), '// existing candidate');
  const before = await snapshot(aiDirectory);
  const environment = {
    AI_ENABLED: 'true',
    AI_ALLOW_STORED_CREDENTIALS: 'true',
    AI_DATA_DIR: aiDirectory,
    AI_CREDENTIAL_KEY: 'obsolete-invalid-key',
    AI_CREDENTIAL_KEY_ID: 'old-key',
    AI_MAX_RUNNING: 'obsolete-invalid-limit',
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  let app;
  t.after(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  await accounts.bootstrapAdmin('admin@company.test');
  app = createGameServer({
    authoring: createAuthoring({ accounts, authConfig: { mode: 'mock' } }),
    uploadDirectory: join(dir, 'uploads'),
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const nativeFetch = globalThis.fetch;
  let externalCalls = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!String(url).startsWith(base + '/')) {
      externalCalls++;
      throw new Error('External requests are forbidden');
    }
    return nativeFetch(url, options);
  });
  const cookies = [''];
  for (const email of ['developer@company.test', 'admin@company.test']) {
    const response = await fetch(base + '/api/auth/mock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(response.status, 200);
    cookies.push(response.headers.get('set-cookie').split(';')[0]);
  }
  for (const cookie of cookies)
    for (const [path, method] of [
      ['/api/ai', 'GET'],
      ['/api/ai/providers', 'GET'],
      ['/api/ai/connections', 'GET'],
      ['/api/ai/connections', 'POST'],
      ['/api/ai/connections/old/models/refresh', 'POST'],
      ['/api/ai/connections/old', 'DELETE'],
      ['/api/ai/preferences', 'PUT'],
      ['/api/ai/requests', 'POST'],
      ['/api/ai/requests/old/source', 'PUT'],
      ['/api/ai/requests/old/start', 'POST'],
      ['/api/ai/requests/old/events', 'GET'],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: { cookie, Origin: base, 'Content-Type': 'application/json' },
        ...(!['GET', 'DELETE'].includes(method) ? { body: '{}' } : {}),
      });
      assert.equal(response.status, 410, `${method} ${path}`);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.text();
      assert.match(body, /프롬프트/);
      assert.equal(body.includes('existing-encrypted-data'), false);
    }
  const contract = await fetch(base + '/api/algorithm-assistant/contract', {
    headers: { cookie: cookies[1] },
  });
  assert.equal(contract.status, 200);
  assert.equal((await contract.json()).language, 'javascript');
  assert.equal(externalCalls, 0);
  assert.deepEqual(
    await snapshot(aiDirectory),
    before,
    'Startup and requests never readjust legacy files',
  );
  for (const cookie of cookies.slice(1))
    assert.equal(
      (await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie } })).status,
      200,
    );
  assert.deepEqual(await snapshot(aiDirectory), before, 'Logout preserves the retired files');
});

test('workbench serves prompt tools but no direct AI UI or browser modules', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-prompt-only-'));
  const app = createGameServer({
    authoring: createAuthoring({
      accounts: new FileAccountRepository(join(dir, 'accounts.json')),
      authConfig: { mode: 'mock' },
    }),
    uploadDirectory: join(dir, 'uploads'),
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'developer@company.test' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(base + '/editor', { headers: { cookie } })).text();
  for (const id of ['generate-prompt', 'copy-prompt', 'validate', 'testing-view', 'save'])
    assert.ok(html.includes(`id="${id}"`));
  for (const id of [
    'assistant-api-tab',
    'assistant-prompt-tab',
    'ai-dialog',
    'ai-model',
    'ai-connection',
    'open-code-import',
    'code-import-dialog',
    'generate',
    'cancel-ai',
    'candidate',
    'apply',
  ])
    assert.equal(html.includes(`id="${id}"`), false);
  const script = await (await fetch(base + '/editor.js', { headers: { cookie } })).text();
  assert.equal(/initializeAi|ai-scripting|ai-connections|assistant-panel/.test(script), false);
  for (const path of [
    '/ai-connections.js',
    '/ai-provider-guides.js',
    '/ai-scripting.js',
    '/assistant-panel.js',
    '/code-import-dialog.js',
    '/algorithm-code-import.js',
  ])
    assert.equal((await fetch(base + path, { headers: { cookie } })).status, 404, path);
  assert.equal((await fetch(base + '/prompt-assistant.js')).status, 200);
});
