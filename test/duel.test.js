import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../src/server.js';
import { GameState } from '../src/game/state.js';
import { MAPS } from '../src/game/map-repository.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  'duel uses a completed match from the same account and keeps its source private',
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'coinhunter-duel-'));
    const { server, close } = createGameServer({
      authoring: createAuthoring({
        accounts: new FileAccountRepository(join(dir, 'accounts.json')),
      }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await close();
      await rm(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/maps');
    const login = async (email) => {
      const result = await fetch(base + '/api/auth/mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(result.status, 200);
      return result.headers.get('set-cookie').split(';')[0];
    };
    const cookie = await login('developer@company.test');
    const other = await login('tester@company.test');
    const guestCookie = response.headers.get('set-cookie').split(';')[0];
    const maps = (await response.json()).maps;
    const code = (name) =>
      `module.exports = class { initialize() { this.n = 0; } getName() { return '${name}'; } moveNext() { this.n++; return -1; } }`;
    const input = {
      source: code('new-code'),
      opponentHistoryId: 'missing',
      mode: 'duel',
      dummyCount: 0,
      mapId: maps[0].id,
      blackMatter: false,
      destroyWalls: false,
    };
    const post = (overrides, auth = cookie) =>
      fetch(base + '/api/matches', {
        method: 'POST',
        headers: { cookie: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, ...overrides }),
      });
    assert.equal((await post({}, guestCookie)).status, 401);
    assert.equal(
      (await fetch(base + '/api/history', { headers: { cookie: guestCookie } })).status,
      401,
    );
    assert.equal((await post({})).status, 404);
    const savedResponse = await fetch(base + '/api/algorithms', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'old strategy', source: code('old-code') }),
    });
    const saved = await savedResponse.json();
    const first = await post({
      mode: 'practice',
      opponentHistoryId: undefined,
      source: undefined,
      algorithmId: saved.id,
    });
    assert.equal(first.status, 201);
    const firstId = (await first.json()).id;
    assert.equal(
      (await fetch(`${base}/api/matches/${firstId}`, { method: 'DELETE', headers: { cookie } }))
        .status,
      200,
    );
    const changed = await fetch(`${base}/api/algorithms/${saved.id}`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'changed strategy',
        source: code('changed-code'),
        revision: saved.revision,
      }),
    });
    assert.equal(changed.status, 200);
    const list = await (await fetch(base + '/api/history', { headers: { cookie } })).json();
    assert.equal(list.history.length, 1);
    assert.equal(list.history[0].algorithmName, 'old-code');
    assert.ok(!JSON.stringify(list).includes('module.exports'));
    const account = await (await fetch(base + '/api/session', { headers: { cookie } })).json();
    const reopened = new FileAccountRepository(join(dir, 'accounts.json'));
    assert.equal(
      (await reopened.historyEntry(account.user.id, list.history[0].id)).source,
      code('old-code'),
    );
    input.opponentHistoryId = list.history[0].id;
    assert.equal((await post({}, other)).status, 404);
    for (const overrides of [
      { opponentSource: code('injected') },
      { opponentAlgorithmId: 'x' },
      { dummyCount: 1 },
      { mode: 'practice' },
    ])
      assert.equal((await post(overrides)).status, 400);
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
    const after = await (await fetch(base + '/api/history', { headers: { cookie } })).json();
    assert.equal(after.history.length, 2);
  },
);
