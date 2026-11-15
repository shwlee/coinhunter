import test from 'node:test';
import assert from 'node:assert/strict';
import { GamePresentation } from '../frontend/public/game-presentation.js';

const snapshot = (sequence, serverTime, action = null, status = 'playing') => ({
  sequence,
  game: { serverTime, status, players: [{ position: 0, action }] },
});
test('render clock stays monotonic through network jitter, duplicate and reordered snapshots', () => {
  const clock = new GamePresentation();
  assert.equal(clock.sample(0), null);
  clock.push(snapshot(1, 1000), 100);
  clock.sample(100);
  clock.push(snapshot(2, 1020), 145);
  const before = clock.sample(160).time;
  clock.push(snapshot(3, 1040), 170);
  assert.ok(clock.sample(171).time >= before);
  assert.equal(clock.push(snapshot(3, 1040), 172), false);
  assert.equal(clock.push(snapshot(4, 1030), 180), false);
  const previous = clock.sample(200).time;
  assert.ok(clock.sample(190).time >= previous);
});
test('short render buffer selects confirmed action at display time without predicting moves or hiding thinking', () => {
  const clock = new GamePresentation();
  const move = { type: 'move', startedAt: 1000, endsAt: 1400, from: 0, to: 1 };
  clock.push(snapshot(1, 1000, move), 100);
  clock.push(snapshot(2, 1400, null), 500);
  const next = { type: 'move', startedAt: 1410, endsAt: 1810, from: 1, to: 2 };
  clock.push(snapshot(3, 1410, next), 510);
  assert.equal(clock.sample(520).game.players[0].action, move);
  assert.equal(clock.sample(540).game.players[0].action, null);
  assert.equal(clock.sample(550).game.players[0].action, next);
  // A slow computation is never replaced with an invented next action.
  const slow = new GamePresentation();
  slow.push(snapshot(1, 1400, null), 500);
  assert.equal(slow.sample(2000).game.players[0].action, null);
});
test('preview/new match resets sequence and timeline; final result is shown immediately and frozen', () => {
  const clock = new GamePresentation();
  const preview = { status: 'ready' };
  clock.reset(preview);
  assert.equal(clock.sample(100).game, preview);
  clock.push(snapshot(10, 1000), 100);
  const final = snapshot(11, 1010, null, 'finished');
  clock.push(final, 110);
  assert.equal(clock.sample(9999).game, final.game);
  assert.equal(clock.sample(9999).time, 1010);
  clock.reset();
  assert.equal(clock.push(snapshot(1, 20), 200), true);
  assert.equal(clock.sample(200).time, 20);
});
test('buffer remains bounded when a tab pauses and discards already displayed snapshots', () => {
  const clock = new GamePresentation({ capacity: 64 });
  for (let i = 0; i < 1000; i++) clock.push(snapshot(i, i * 20), i * 20);
  assert.ok(clock.snapshots.length <= 64);
  clock.sample(20000);
  assert.ok(clock.snapshots.length <= 3);
});
