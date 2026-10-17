import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMapArray, formatMapArray } from '../public/map-array.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository } from '../src/game/map-repository.js';
import { DEFAULT_MAP_SETTINGS, validateMapDocument } from '../src/game/maps.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { readAiConfig } from '../src/ai/config.js';

test('integer map arrays support bracket, C# initializer, BOM, line breaks and trailing commas', () => {
  for (const text of [
    '[0, -1, +10, 30,]',
    '{0, -1, 10, 30}',
    'new int[] { 0, -1, 10, 30 };',
    'int[] tiles = new int [] {0,-1,10,30};',
    '\uFEFF\r\n[0,\r\n -1, 10, 30]\r\n',
  ])
    assert.deepEqual(parseMapArray(text), [0, -1, 10, 30]);
});

test('array parser rejects executable source, non-integers, ambiguous blocks and excessive input', () => {
  for (const text of [
    null,
    '',
    '[]',
    '{}',
    '[1,,2]',
    '[1.5]',
    '[1e2]',
    '[NaN]',
    '[Infinity]',
    '["0"]',
    '[[0]]',
    '[true]',
    '[1+2]',
    '[0];[10]',
    '[0]\nexplanation',
    'new int[]{0}; process.exit()',
    '[globalThis.compromised = true]',
    '[0, /* comment */ 10]',
    '[9007199254740992]',
    '[' + ' '.repeat(65536) + '0]',
  ])
    assert.throws(() => parseMapArray(text));
});

test('both export formats preserve rectangular and maximum maps in row order', async () => {
  const sample = JSON.parse(
    await readFile(new URL('../maps/samples/four-courtyards.json', import.meta.url), 'utf8'),
  );
  const largest = {
    columns: 40,
    rows: 30,
    tiles: Array.from({ length: 1200 }, (_, i) => [-1, 0, 10, 30, 100, 200, 500][i % 7]),
  };
  for (const map of [sample, largest])
    for (const format of ['array', 'csharp']) {
      const before = structuredClone(map);
      const result = formatMapArray(map, format);
      assert.deepEqual(parseMapArray(result), map.tiles);
      assert.equal(result.trim().split('\n').length, map.rows + 2);
      assert.equal(result.split('\n')[1], '  ' + map.tiles.slice(0, map.columns).join(', ') + ',');
      assert.deepEqual(map, before);
    }
});

test('export rejects invalid map data and unsupported output format', () => {
  const map = { columns: 4, rows: 4, tiles: Array(16).fill(0) };
  for (const value of [
    null,
    { ...map, columns: 3 },
    { ...map, rows: 31 },
    { ...map, tiles: [0] },
    { ...map, tiles: Array(16) },
    { ...map, tiles: Array(16).fill(20) },
  ])
    assert.throws(() => formatMapArray(value));
  assert.throws(() => formatMapArray(map, 'javascript'));
});

test('admin array validation is read-only, enforces access and keeps draft/publication checks separate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-map-array-api-'));
  const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
  await accounts.bootstrapAdmin('admin@company.test');
  const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
  const { server, close } = createGameServer({
    maps,
    uploadDirectory: join(dir, 'uploads'),
    authoring: createAuthoring({
      accounts,
      authConfig: { mode: 'mock' },
      domain: 'company.test',
      aiConfig: readAiConfig({ AI_ENABLED: 'false' }),
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, input, cookie = '') =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(input),
    });
  const login = async (email) =>
    (await post('/api/auth/mock', { email })).headers.get('set-cookie').split(';')[0];
  const ordinary = await login('developer@company.test'),
    admin = await login('admin@company.test');
  const path = '/api/admin/maps/validate-array',
    tiles = Array(16).fill(0);
  const input = { columns: 4, rows: 4, source: JSON.stringify(tiles) };
  assert.equal((await post(path, input)).status, 401);
  assert.equal((await post(path, input, ordinary)).status, 403);
  const before = maps.registry();
  const result = await post(path, input, admin);
  assert.equal(result.status, 200);
  const empty = (await result.json()).map;
  assert.equal(Object.hasOwn(empty, 'id'), false);
  assert.equal(Object.hasOwn(empty, 'revision'), false);
  assert.equal(Object.hasOwn(empty, 'enabled'), false);
  assert.deepEqual(empty.settings, DEFAULT_MAP_SETTINGS);
  const document = { ...empty, id: 'array-draft', schemaVersion: 1, revision: 1 };
  validateMapDocument(document, { published: false });
  assert.throws(() => validateMapDocument(document), /코인/);
  tiles[5] = 100;
  const asymmetric = await post(path, { ...input, source: JSON.stringify(tiles) }, admin);
  assert.equal(asymmetric.status, 200);
  const asymmetricMap = (await asymmetric.json()).map;
  assert.throws(() => validateMapDocument({ ...document, ...asymmetricMap }), /대칭/);
  const isolated = Array(25).fill(0);
  for (const p of [7, 11, 13, 17]) isolated[p] = -1;
  isolated[12] = 500;
  const disconnected = await post(
    path,
    { columns: 5, rows: 5, source: JSON.stringify(isolated) },
    admin,
  );
  assert.equal(disconnected.status, 200);
  const disconnectedMap = (await disconnected.json()).map;
  assert.throws(() => validateMapDocument({ ...document, ...disconnectedMap }), /연결/);
  for (const invalid of [
    null,
    [],
    { ...input, columns: '4' },
    { ...input, columns: 41 },
    { ...input, rows: 3 },
    { ...input, source: '[0]' },
    { ...input, source: JSON.stringify(Array(16).fill(20)) },
    { ...input, source: JSON.stringify(Array(16).fill(-1)) },
    { ...input, settings: {} },
    { ...input, source: 'new int[]{eval("1")};' },
  ])
    assert.equal((await post(path, invalid, admin)).status, 400);
  assert.deepEqual(maps.registry(), before);
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 0);
});
