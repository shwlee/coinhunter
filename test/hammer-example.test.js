import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAPS } from '../src/game/map-repository.js';
import { GameState } from '../src/game/state.js';
import { PlayerProcess } from '../src/runtime/player-process.js';

test('hammer example collects hammer and breaks three walls in the real runtime', async (t) => {
  const source = await readFile(new URL('../examples/hammer-test.js', import.meta.url), 'utf8');
  const runner = new PlayerProcess();
  t.after(() => runner.close());
  const map = structuredClone(MAPS.find((map) => map.id === 'four-courtyards'));
  const game = new GameState(map, ['test'], {}, () => 0);
  game.start(0);
  await runner.initialize(source, 0, map.columns, map.rows);
  const waiting = await runner.move([...game.tiles], 0, [-1, -1, -1, -1]);
  assert.equal(waiting.value, -1);
  game.items = [-1, 1, -1, -1];
  game.tiles[1] = 0;
  const walls = game.tiles.filter((tile) => tile === -1).length;
  let now = 0,
    breaks = 0;
  for (let turn = 0; turn < 100 && breaks < 3; turn++) {
    const result = await runner.move([...game.tiles], game.players[0].position, [...game.items]);
    assert.equal(result.status, 'ok');
    const action = game.beginAction(0, result, now);
    if (action.type === 'break') breaks++;
    now = action.endsAt;
    game.completeAction(0, now);
  }
  assert.equal(breaks, 3);
  assert.equal(game.tiles.filter((tile) => tile === -1).length, walls - 3);
  assert.equal(game.players[0].effect, null);
});
