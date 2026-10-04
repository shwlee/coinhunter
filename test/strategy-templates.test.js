import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateSource } from '../public/strategy-templates.js';
import { PlayerProcess } from '../src/runtime/player-process.js';

async function direction(t, priorities, map, items = [-1, -1, -1, -1]) {
  const player = new PlayerProcess();
  t.after(() => player.close());
  await player.initialize(buildTemplateSource(priorities), 0, 5, 5);
  const result = await player.move(map, 12, items);
  assert.equal(result.status, 'ok');
  return result.value;
}

test('template order changes coin and item target selection', async (t) => {
  const map = Array(25).fill(0);
  map[11] = 10;
  map[24] = 500;
  assert.equal(await direction(t, ['nearestCoin'], map), 0);
  assert.equal(await direction(t, ['valuableCoin'], map), 2);
  assert.equal(await direction(t, ['nearestCoin', 'valuableCoin'], map), 0);
  assert.equal(await direction(t, ['valuableCoin', 'nearestCoin'], map), 2);

  const closeCoin = Array(25).fill(0);
  closeCoin[11] = 10;
  assert.equal(await direction(t, ['shoes', 'nearestCoin'], closeCoin, [13, -1, -1, -1]), 2);
  assert.equal(await direction(t, ['nearestCoin', 'shoes'], closeCoin, [13, -1, -1, -1]), 0);
  for (const [id, index] of [
    ['hammer', 1],
    ['double', 2],
    ['jump', 3],
  ]) {
    const items = [-1, -1, -1, -1];
    items[index] = 13;
    assert.equal(await direction(t, [id], closeCoin, items), 2, id);
  }
});

test('template selection rejects more than three priorities and duplicates', () => {
  assert.throws(
    () => buildTemplateSource(['nearestCoin', 'valuableCoin', 'shoes', 'hammer']),
    /1~3개/,
  );
  assert.throws(() => buildTemplateSource(['jump', 'jump']), /우선순위/);
});

test('coin cluster prefers a group of coins over an isolated nearby coin', async (t) => {
  const map = Array(25).fill(0);
  map[11] = 10;
  for (const position of [14, 9, 19]) map[position] = 10;
  assert.equal(await direction(t, ['nearestCoin'], map), 0);
  assert.equal(await direction(t, ['coinCluster'], map), 2);
});

test('each avoidance template routes around its matching item', async (t) => {
  const map = Array(25).fill(0);
  map[10] = 10;
  map[14] = 10;
  for (const [id, index] of [
    ['avoidShoes', 0],
    ['avoidHammer', 1],
    ['avoidDouble', 2],
    ['avoidJump', 3],
  ]) {
    const items = [-1, -1, -1, -1];
    items[index] = 11;
    assert.equal(await direction(t, ['nearestCoin'], map, items), 0, `${id} baseline`);
    assert.equal(await direction(t, [id], map, items), 2, id);
  }
});
