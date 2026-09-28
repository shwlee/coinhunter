import test from 'node:test';
import assert from 'node:assert/strict';
import { rankLivePlayers } from '../public/leaderboard.js';

test('live ranks use competition ranks and preserve prior order on ties', () => {
  const players = [
    { id: 0, score: 10 },
    { id: 1, score: 30 },
    { id: 2, score: 30 },
    { id: 3, score: 0 },
  ];
  const before = structuredClone(players);
  const ranked = rankLivePlayers(players, [2, 0, 1, 3]);
  assert.deepEqual(
    ranked.map((p) => p.id),
    [2, 1, 0, 3],
  );
  assert.deepEqual(
    ranked.map((p) => p.rank),
    [1, 1, 3, 4],
  );
  assert.deepEqual(
    ranked.map((p) => p.tied),
    [true, true, false, false],
  );
  assert.deepEqual(players, before);
  assert.deepEqual(
    rankLivePlayers(players).map((p) => p.id),
    [1, 2, 0, 3],
  );
  assert.deepEqual(rankLivePlayers([]), []);
});
