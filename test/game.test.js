import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game/state.js';
import { Match } from '../src/game/match.js';

function map() {
  const tiles = Array(36).fill(0);
  tiles[14] = 100;
  tiles[21] = 10;
  return {
    columns: 6,
    rows: 6,
    tiles,
    settings: {
      actionMs: 300,
      runningTimeMs: 10000,
      itemFirstMs: 1000,
      itemIntervalMs: 1000,
      itemDuration: 3,
      blackMatterIntervalMs: 1000,
      destroyWallIntervalMs: 1000,
    },
  };
}
function state(count = 1) {
  const game = new GameState(map(), Array(count).fill('test'), {}, () => 0);
  game.start(0);
  return game;
}
function effect(game, type, remaining = 3) {
  game.players[0].effect = { type, remaining, id: ++game.effectSequence };
}

test('all start slots place the user at the selected corner and dummies at unique remaining corners', () => {
  const corners = [0, 5, 30, 35];
  for (let slot = 0; slot < 4; slot++) {
    for (let count = 1; count <= 4; count++) {
      const g = new GameState(map(), Array(count).fill('test'), { startSlot: slot });
      assert.equal(g.players[0].position, corners[slot]);
      assert.equal(g.players[0].id, 0);
      assert.equal(g.players[0].startSlot, slot);
      assert.equal(new Set(g.players.map((p) => p.position)).size, count);
      assert.ok(g.players.every((p) => corners.includes(p.position)));
    }
  }
});

test('algorithm identity stays fixed while first move receives the selected start position', async (t) => {
  const source = `module.exports = class {
    initialize(number, columns, rows) { this.number = number; this.columns = columns; this.rows = rows; }
    getName() { return 'identity-' + this.number; }
    moveNext(map, position) { debug.print(this.number, this.columns, this.rows, position); return -1; }
  }`;
  const match = new Match(map(), [source, source], { startSlot: 3 });
  t.after(() => match.stop());
  await match.start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      match.off('snapshot', check);
      reject(new Error('First move logs missing'));
    }, 3000);
    function check() {
      if (![0, 1].every((id) => match.logs.some((log) => log.player === id && log.turn === 1)))
        return;
      clearTimeout(timer);
      match.off('snapshot', check);
      resolve();
    }
    match.on('snapshot', check);
    check();
  });
  assert.deepEqual(
    match.state.players.map((p) => p.name),
    ['identity-0', 'identity-1'],
  );
  assert.deepEqual(match.logs.find((log) => log.player === 0 && log.turn === 1).lines, [
    '0 6 6 35',
  ]);
  assert.deepEqual(match.logs.find((log) => log.player === 1 && log.turn === 1).lines, ['1 6 6 0']);
});

test('-1 consumes only current action; normal movement resumes next turn', () => {
  const g = state();
  g.beginAction(0, { status: 'ok', value: -1 }, 0);
  assert.equal(g.players[0].action.type, 'penalty');
  assert.equal(g.completeAction(0, 299), false);
  g.completeAction(0, 300);
  assert.equal(g.players[0].position, 0);
  g.beginAction(0, { status: 'ok', value: 2 }, 300);
  g.completeAction(0, 600);
  assert.equal(g.players[0].position, 1);
});

test('wall confusion, timeout penalty and regular movement have equal durations', () => {
  const g = state();
  g.tiles[1] = -1;
  for (const result of [
    { status: 'ok', value: 2 },
    { status: 'timeout', value: -1 },
    { status: 'ok', value: 3 },
  ]) {
    const action = g.beginAction(0, result, 0);
    assert.equal(action.endsAt, 300);
    g.completeAction(0, 300);
  }
});

test('shoes halve action time, failures count, effect lasts exactly three turns', () => {
  const g = state();
  effect(g, 0);
  for (let turn = 0; turn < 3; turn++) {
    const action = g.beginAction(0, { status: 'ok', value: -1 }, turn * 150);
    assert.equal(action.endsAt - action.startedAt, 150);
    g.completeAction(0, (turn + 1) * 150);
  }
  assert.equal(g.players[0].effect, null);
  assert.equal(g.beginAction(0, { status: 'ok', value: 2 }, 450).endsAt, 750);
});

test('hammer breaks internal wall without entering, boundary cannot consume hammer', () => {
  const g = state();
  effect(g, 1);
  g.tiles[1] = -1;
  g.beginAction(0, { status: 'ok', value: 0 }, 0);
  g.completeAction(0, 300);
  assert.equal(g.players[0].effect.remaining, 3);
  g.beginAction(0, { status: 'ok', value: 2 }, 300);
  g.completeAction(0, 600);
  assert.equal(g.tiles[1], 0);
  assert.equal(g.players[0].position, 0);
  assert.equal(g.players[0].effect.remaining, 2);
  g.beginAction(0, { status: 'ok', value: 2 }, 600);
  g.completeAction(0, 900);
  assert.equal(g.players[0].position, 1);
});

test('same coin is awarded once under simultaneous arrivals', () => {
  const g = state(2);
  g.players[1].position = 2;
  g.tiles[1] = 100;
  g.beginAction(0, { status: 'ok', value: 2 }, 0);
  g.beginAction(1, { status: 'ok', value: 0 }, 0);
  g.completeAction(0, 300);
  g.completeAction(1, 300);
  assert.equal(g.players[0].score + g.players[1].score, 100);
});

test('x2 consumes coins only; acquiring another effect replaces without decrementing new effect', () => {
  const g = state();
  effect(g, 2);
  g.tiles[1] = 30;
  g.items[0] = 2;
  g.beginAction(0, { status: 'ok', value: 2 }, 0);
  g.completeAction(0, 300);
  assert.equal(g.players[0].score, 60);
  assert.equal(g.players[0].effect.remaining, 2);
  g.beginAction(0, { status: 'ok', value: 2 }, 300);
  g.completeAction(0, 600);
  assert.equal(g.players[0].effect.type, 0);
  assert.equal(g.players[0].effect.remaining, 3);
  assert.equal(g.items[0], -1);
});

test('new same-kind shoes reset count and are not charged for acquisition turn', () => {
  const g = state();
  effect(g, 0, 1);
  g.items[0] = 1;
  g.beginAction(0, { status: 'ok', value: 2 }, 0);
  g.completeAction(0, 150);
  assert.equal(g.players[0].effect.remaining, 3);
});

test('last doubled coin retains its animation marker after effect expires', () => {
  const g = state();
  effect(g, 2, 1);
  g.tiles[1] = 30;
  g.beginAction(0, { status: 'ok', value: 2 }, 0);
  g.completeAction(0, 300);
  assert.equal(g.players[0].effect, null);
  assert.equal(g.players[0].score, 60);
  assert.equal(g.players[0].coinBurstBoosted, true);
});

test('spawn exclusions are orthogonal, apply to every player, and keep four unique items', () => {
  const g = state(4);
  const spaces = g.eligibleSpaces();
  assert.equal(spaces.includes(0), false);
  assert.equal(spaces.includes(1), false);
  assert.equal(spaces.includes(2), false);
  assert.equal(spaces.includes(6), false);
  assert.equal(spaces.includes(12), false);
  assert.equal(spaces.includes(7), true);
  g.update(1000);
  assert.equal(new Set(g.items).size, 4);
  assert.ok(g.items.every((i) => i >= 0));
  const items = [...g.items];
  g.items[0] = -1;
  g.update(2000);
  assert.deepEqual(g.items, [-1, ...items.slice(1)]);
});

test('insufficient four empty spaces spawns nothing; jump failure consumes one effect turn', () => {
  const g = state();
  g.tiles = g.tiles.map(() => 10);
  g.tiles[0] = 0;
  effect(g, 3);
  g.update(1000);
  assert.deepEqual(g.items, [-1, -1, -1, -1]);
  const action = g.beginAction(0, { status: 'ok', value: 0 }, 1000);
  assert.equal(action.type, 'jump-failed');
  g.completeAction(0, 1300);
  assert.equal(g.players[0].effect.remaining, 2);
  assert.equal(g.players[0].position, 0);
});

test('item schedule remains active during HurryUp', () => {
  const g = state();
  g.settings.runningTimeMs = 500;
  g.update(1000);
  assert.equal(g.status, 'hurryup');
  assert.ok(g.items.every((index) => index >= 0));
});

test('random jump turn does not invoke user runtime at all', async () => {
  const m = new Match(map(), ['unused']);
  m.state = state();
  effect(m.state, 3);
  m.runners = [
    {
      move() {
        assert.fail('move must not be called during jump');
      },
    },
  ];
  await m.requestTurn(0);
  assert.equal(m.state.players[0].action.type, 'jump');
  assert.equal(m.state.players[0].turn, 1);
});
