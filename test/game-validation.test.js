import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../src/server.js';

test('guest gameplay validation executes code, reports locations and clears temporary uploads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-game-check-'));
  const { server, close } = createGameServer({ uploadDirectory: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base + '/api/maps')).headers.get('set-cookie').split(';')[0];
  const check = (source) =>
    fetch(base + '/api/game/validate', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'text/plain' },
      body: source,
    });
  const undefinedName = await check(
    "module.exports=class Player { initialize(){} getName(){return '이름'; ㅂㅈㄷ} moveNext(){return -1;} };",
  );
  assert.equal(undefinedName.status, 400);
  const error = await undefinedName.json();
  assert.match(error.error, /ㅂㅈㄷ/);
  assert.equal(error.diagnostic.line, 1);
  const exception = await check(
    "module.exports=class Player { initialize(){} getName(){return '이름';} moveNext(){throw new Error('실패');} };",
  );
  assert.equal(exception.status, 400);
  assert.match((await exception.json()).error, /예외/);
  const source = await readFile(new URL('../examples/nearest-coin.js', import.meta.url), 'utf8');
  const valid = await check(source);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).ok, true);
  assert.deepEqual(await readdir(dir), []);
});
