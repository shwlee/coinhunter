import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPlayers } from '../public/podium.js';

test('podium ranks scores without changing players and shares tied ranks', () => {
  const players = [
    { id: 0, score: 10 },
    { id: 1, score: 200 },
    { id: 2, score: 200 },
    { id: 3, score: 30 },
  ];
  const original = structuredClone(players);
  const ranked = rankPlayers(players);
  assert.deepEqual(
    ranked.map((p) => [p.id, p.rank, p.tied]),
    [
      [1, 1, true],
      [2, 1, true],
      [3, 3, false],
      [0, 4, false],
    ],
  );
  assert.deepEqual(players, original);
  assert.equal(rankPlayers([{ id: 0, score: 0 }])[0].rank, 1);
  assert.deepEqual(rankPlayers([]), []);
  assert.ok(
    rankPlayers(players.map((p) => ({ ...p, score: 0 }))).every((p) => p.rank === 1 && p.tied),
  );
});
