import test from 'node:test';
import assert from 'node:assert/strict';
import { playerVisuals } from '../public/player-layout.js';

test('overlapping dummies remain distinguishable without changing their game state', () => {
  const players = Array.from({ length: 4 }, (_, id) => ({ id, position: 12, action: null }));
  players[1].effect = { type: 1, remaining: 3 };
  const before = structuredClone(players);
  const visuals = playerVisuals(players, 10, 0);
  assert.equal(new Set(visuals.map((p) => p.offset)).size, 4);
  assert.ok(visuals.every((p) => p.scale > 0.5 && p.scale < 1));
  assert.deepEqual(players, before);
  const reversed = playerVisuals([...players].reverse(), 10, 0).reverse();
  assert.deepEqual(visuals, reversed);
});

test('separation tapers off during movement and returns to normal size away from others', () => {
  const players = [
    { id: 0, position: 12, action: null },
    { id: 1, position: 12, action: { type: 'move', to: 13, startedAt: 0, endsAt: 100 } },
  ];
  const start = playerVisuals(players, 10, 0);
  const moving = playerVisuals(players, 10, 25);
  const apart = playerVisuals(players, 10, 100);
  assert.ok(moving[1].offset > 0 && moving[1].offset < start[1].offset);
  assert.equal(apart[1].x, 3);
  assert.ok(apart.every((p) => p.offset === 0 && p.scale === 1));
});
