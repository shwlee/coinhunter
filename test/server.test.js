import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../src/server.js';

test(
  'guest upload/start, ownership, invalid origin, stop and cleanup',
  { timeout: 20000 },
  async (t) => {
    const { server, close } = createGameServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(close);
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/maps');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const maps = (await response.json()).maps;
    const source = await (await fetch(base + '/api/example')).text();
    const invalid = await fetch(base + '/api/matches', {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalid.status, 403);
    for (const startSlot of [-1, 4, 1.5, '1', null]) {
      const badSlot = await fetch(base + '/api/matches', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          mapId: maps[0].id,
          dummyCount: 1,
          blackMatter: false,
          destroyWalls: false,
          startSlot,
        }),
      });
      assert.equal(badSlot.status, 400);
    }
    for (const characterId of ['kobi', 'unknown', null]) {
      const badCharacter = await fetch(base + '/api/matches', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          mapId: maps[0].id,
          dummyCount: 1,
          blackMatter: false,
          destroyWalls: false,
          characterId,
        }),
      });
      assert.equal(badCharacter.status, 400);
    }
    const created = await fetch(base + '/api/matches', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        characterId: 'lumi',
        startSlot: 3,
        mapId: maps[0].id,
        dummyCount: 1,
        blackMatter: false,
        destroyWalls: false,
      }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const forbidden = await fetch(base + '/api/matches/' + id);
    assert.equal(forbidden.status, 404);
    const own = await fetch(base + '/api/matches/' + id, { headers: { cookie } });
    assert.equal(own.status, 200);
    const players = (await own.json()).game.players;
    assert.equal(players.length, 2);
    assert.equal(players[0].startSlot, 3);
    assert.equal(players[1].startSlot, 0);
    assert.deepEqual(
      players.map((p) => p.characterId),
      ['lumi', 'kobi'],
    );
    const duplicate = await fetch(base + '/api/matches', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        mapId: maps[0].id,
        dummyCount: 0,
        blackMatter: false,
        destroyWalls: false,
      }),
    });
    assert.equal(duplicate.status, 409);
    const stopped = await fetch(base + '/api/matches/' + id, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(stopped.status, 200);
    const after = await (await fetch(base + '/api/matches/' + id, { headers: { cookie } })).json();
    assert.equal(after.game.status, 'finished');
    assert.equal(after.game.reason, 'user-stopped');
  },
);
