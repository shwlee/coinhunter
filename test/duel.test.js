import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../src/server.js';
import { GameState } from '../src/game/state.js';
import { MAPS } from '../src/game/map-repository.js';

test('duel uses opposite corners and distinct playable characters for every start', () => {
  for (let startSlot = 0; startSlot < 4; startSlot++) {
    const game = new GameState(MAPS[0], ['same', 'same'], {
      mode: 'duel',
      startSlot,
      characterId: 'lumi',
    });
    assert.deepEqual(
      game.players.map((p) => p.startSlot),
      [startSlot, 3 - startSlot],
    );
    assert.deepEqual(
      game.players.map((p) => p.role),
      ['current', 'previous'],
    );
    assert.deepEqual(
      game.players.map((p) => p.name),
      ['현재 · same', '이전 · same'],
    );
    assert.notEqual(game.players[1].characterId, 'kobi');
    assert.notEqual(game.players[0].characterId, game.players[1].characterId);
  }
});

test(
  'duel validates both uploads and executes separate algorithms without exposing code',
  { timeout: 20000 },
  async (t) => {
    const { server, close } = createGameServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(close);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/maps');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const maps = (await response.json()).maps;
    const code = (name) =>
      `module.exports = class { initialize() { this.n = 0; } getName() { return '${name}'; } moveNext() { this.n++; return -1; } }`;
    const input = {
      source: code('new-code'),
      opponentSource: code('old-code'),
      mode: 'duel',
      dummyCount: 0,
      mapId: maps[0].id,
      blackMatter: false,
      destroyWalls: false,
    };
    const post = (overrides) =>
      fetch(base + '/api/matches', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, ...overrides }),
      });
    for (const overrides of [
      { opponentSource: null },
      { opponentSource: 'x'.repeat(65537) },
      { opponentSource: 'async function forbidden() {}' },
      { dummyCount: 1 },
      { mode: 'unknown' },
      { mode: 'practice' },
    ]) {
      assert.equal((await post(overrides)).status, 400);
    }
    const created = await post({});
    assert.equal(created.status, 201);
    const { id } = await created.json();
    await new Promise((resolve) => setTimeout(resolve, 750));
    const snapshot = await (
      await fetch(`${base}/api/matches/${id}`, { headers: { cookie } })
    ).json();
    assert.deepEqual(
      snapshot.game.players.map((p) => p.name),
      ['현재 · new-code', '이전 · old-code'],
    );
    assert.ok(snapshot.game.players.every((p) => p.stats.algorithmCalls > 0));
    assert.ok(!JSON.stringify(snapshot).includes('module.exports'));
    assert.equal(
      (await fetch(`${base}/api/matches/${id}`, { method: 'DELETE', headers: { cookie } })).status,
      200,
    );
  },
);
