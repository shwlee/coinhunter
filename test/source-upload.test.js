import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

test('large source uses file upload while JSON bodies stay bounded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-upload-'));
  const uploads = join(directory, 'uploads');
  const accounts = new FileAccountRepository(join(directory, 'accounts.json'));
  const { server, close } = createGameServer({
    authoring: createAuthoring({ accounts }),
    uploadDirectory: uploads,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'developer@company.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const user = (await login.json()).user;
  const sample =
    'module.exports = class { initialize() {} getName() { return "upload"; } moveNext() { return -1; } };';
  const tooLargeJson = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x'.repeat(70_000) }),
  });
  assert.equal(tooLargeJson.status, 413);
  const chunkedJson = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ email: 'y'.repeat(70_000) })));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal(chunkedJson.status, 413);
  const legacy = await fetch(base + '/api/algorithms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ name: 'legacy', source: sample + '/*' + 'x'.repeat(2_100_000) + '*/' }),
  });
  assert.equal(legacy.status, 413);

  const largeSource = sample + '\n/*' + 'x'.repeat(2_100_000) + '*/';
  const saved = await fetch(base + '/api/algorithms?name=large', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', cookie },
    body: largeSource,
  });
  assert.equal(saved.status, 201);
  const item = await saved.json();
  assert.equal((await accounts.get(user.id, item.id)).source, largeSource);
  const metadata = await fetch(base + `/api/algorithms/${item.id}?metadata=1`, {
    headers: { cookie },
  });
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).name, 'large');
  const sourceFile = await fetch(base + `/api/algorithms/${item.id}/source`, {
    headers: { cookie },
  });
  assert.equal(sourceFile.status, 200);
  assert.equal(await sourceFile.text(), largeSource);
  assert.equal((await fetch(base + `/api/algorithms/${item.id}/source`)).status, 401);
  assert.equal(
    (await fetch(base + `/api/algorithms/${item.id}`, { headers: { cookie } })).status,
    413,
  );
  assert.deepEqual(await readdir(uploads), []);

  const invalidSave = await fetch(base + '/api/algorithms?name=', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', cookie },
    body: sample,
  });
  assert.equal(invalidSave.status, 400);
  assert.deepEqual(await readdir(uploads), []);

  const checked = await fetch(base + '/api/algorithms/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', cookie },
    body: sample,
  });
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).ok, true);
  assert.deepEqual(await readdir(uploads), []);

  const maps = (await (await fetch(base + '/api/maps')).json()).maps;
  const options = JSON.stringify({
    mapId: maps[0].id,
    dummyCount: 0,
    blackMatter: false,
    destroyWalls: false,
  });
  const invalidMatch = await fetch(base + '/api/matches', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Coinhunter-Options': options },
    body: 'module.exports = ;',
  });
  assert.equal(invalidMatch.status, 400);
  assert.deepEqual(await readdir(uploads), []);
  const created = await fetch(base + '/api/matches', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Coinhunter-Options': options,
    },
    body: largeSource,
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const guestCookie = created.headers.get('set-cookie').split(';')[0];
  const stopped = await fetch(base + `/api/matches/${id}`, {
    method: 'DELETE',
    headers: { cookie: guestCookie },
  });
  assert.equal(stopped.status, 200);
  for (let attempt = 0; attempt < 20 && (await readdir(uploads)).length; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await readdir(uploads), []);
});

test('concurrent starts from one account reserve a single match slot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'coinhunter-start-slot-'));
  const accounts = new FileAccountRepository(join(directory, 'accounts.json'));
  const { server, close } = createGameServer({
    authoring: createAuthoring({ accounts }),
    uploadDirectory: join(directory, 'uploads'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'concurrent@company.test' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const maps = (await (await fetch(base + '/api/maps')).json()).maps;
  const options = JSON.stringify({
    mapId: maps[0].id,
    dummyCount: 0,
    blackMatter: false,
    destroyWalls: false,
  });
  const source =
    'module.exports = class { initialize() {} getName() { return "race"; } moveNext() { return -1; } };';
  const start = () =>
    fetch(base + '/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Coinhunter-Options': options, cookie },
      body: source,
    });
  const results = await Promise.all([start(), start()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const created = results.find((response) => response.status === 201);
  const { id } = await created.json();
  const stopped = await fetch(base + `/api/matches/${id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(stopped.status, 200);
});
