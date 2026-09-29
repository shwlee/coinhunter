import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game/state.js';
import { Match } from '../src/game/match.js';
import { MAPS } from '../src/game/map-repository.js';

function state(count = 1) {
  const map = structuredClone(MAPS[0]);
  map.tiles.fill(0);
  map.tiles[map.columns * 2] = 10;
  const g = new GameState(map, Array(count).fill('test'));
  g.start(0);
  return g;
}
function step(g, direction, now) {
  const action = g.beginAction(0, { status: 'ok', value: direction }, now);
  g.completeAction(0, action.endsAt);
  return action.endsAt;
}
test('coin counts and x2 bonus reconcile with score; replaced effects use correct counters', () => {
  const g = state();
  g.items[2] = 1;
  g.tiles[2] = 100;
  g.items[0] = 2;
  let now = step(g, 2, 0);
  now = step(g, 2, now);
  const s = g.players[0].stats;
  assert.equal(s.coins[100], 1);
  assert.equal(s.bonusScore, 100);
  assert.equal(g.players[0].score, 200);
  assert.deepEqual(s.itemsAcquired, [1, 0, 1, 0]);
  assert.deepEqual(s.itemsUsed, [0, 0, 1, 0]);
  g.tiles[3] = -1;
  now = step(g, 2, now);
  step(g, -1, now);
  assert.equal(s.moves, 2);
  assert.equal(s.wallCollisions, 1);
  assert.equal(s.penalties, 1);
  assert.equal(s.itemsUsed[0], 2);
  assert.equal(s.completedTurns, 4);
  const snapshot = g.snapshot(now);
  snapshot.players[0].stats.coins[100] = 99;
  assert.equal(s.coins[100], 1);
});
test('competing wall destruction counts once and interrupted actions are excluded', () => {
  const g = state(2);
  g.tiles[1] = -1;
  for (const p of g.players) {
    p.position = 0;
    p.effect = { type: 1, remaining: 3, id: p.id + 1 };
    g.beginAction(p.id, { status: 'ok', value: 2 }, 0);
  }
  g.completeAction(0, 400);
  g.completeAction(1, 400);
  assert.equal(g.players[0].stats.wallsBroken, 1);
  assert.equal(g.players[1].stats.wallsBroken, 0);
  assert.equal(g.players[1].stats.itemsUsed[1], 0);
  g.beginAction(0, { status: 'ok', value: 2 }, 400);
  g.finish('user-stopped');
  g.completeAction(0, 800);
  assert.equal(g.players[0].stats.completedTurns, 1);
});
test('runtime results count without debug logs, and random jump skips computation statistics', async () => {
  const match = new Match(MAPS[0], ['unused']);
  match.state = state();
  match.runners = [
    {
      move: async () => ({
        status: 'timeout',
        value: -1,
        elapsedMs: 500,
        logs: [],
        droppedLogs: 0,
      }),
    },
  ];
  await match.requestTurn(0);
  const p = match.state.players[0];
  match.state.completeAction(0, p.action.endsAt);
  assert.equal(p.stats.timeouts, 1);
  assert.equal(p.stats.algorithmTotalMs, 500);
  match.runners[0].move = async () => ({
    status: 'ok',
    value: 2,
    elapsedMs: 2,
    logs: [],
    droppedLogs: 0,
  });
  await match.requestTurn(0);
  match.state.completeAction(0, p.action.endsAt);
  assert.equal(p.stats.algorithmCalls, 2);
  assert.equal(p.stats.algorithmTotalMs / 2, 251);
  p.effect = { type: 3, remaining: 3, id: 1 };
  await match.requestTurn(0);
  match.state.completeAction(0, p.action.endsAt);
  assert.equal(p.stats.algorithmCalls, 2);
  assert.equal(p.stats.itemsUsed[3], 1);
});
