import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSymmetricMap,
  inspectMap,
  starts,
  COIN_VALUES,
  RANDOM_MAP_TEMPLATES,
} from '../public/map-editing.js';
import { validateMapDocument, DEFAULT_MAP_SETTINGS } from '../src/game/maps.js';
import { MapRepository } from '../src/game/map-repository.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test('random maps retain reflection, valid coin values and connected starts across sizes and densities', () => {
  for (const [columns, rows] of [
    [4, 4],
    [5, 5],
    [5, 6],
    [20, 16],
    [40, 30],
  ])
    for (const wallDensity of [0, 25, 60])
      for (const coinDensity of [1, 50, 100]) {
        const map = generateSymmetricMap(
          { columns, rows, wallDensity, coinDensity },
          seeded(columns * rows + coinDensity),
        );
        const report = inspectMap(map);
        assert.deepEqual(report.asymmetric, []);
        assert.deepEqual(report.isolated, []);
        assert.ok(report.coins > 0);
        assert.ok(starts(columns, rows).every((i) => map.tiles[i] === 0));
        assert.ok(map.tiles.every((tile) => [-1, 0, ...COIN_VALUES].includes(tile)));
        assert.ok(!map.tiles.includes(500), 'Mixed generation excludes black matter');
        if (!wallDensity) assert.equal(report.walls, 0);
        if (coinDensity === 100) assert.equal(report.coins + report.walls, columns * rows - 4);
        validateMapDocument({
          ...map,
          schemaVersion: 1,
          id: 'random-test',
          revision: 1,
          name: '랜덤 맵',
          settings: DEFAULT_MAP_SETTINGS,
        });
      }
});

test('density settings, fixed coin score and randomness affect the generated draft', () => {
  const settings = { columns: 20, rows: 16, wallDensity: 25, coinDensity: 50, coinValue: 100 };
  const first = generateSymmetricMap(settings, seeded(1));
  assert.deepEqual(first, generateSymmetricMap(settings, seeded(1)));
  assert.notDeepEqual(first.tiles, generateSymmetricMap(settings, seeded(2)).tiles);
  assert.ok(first.tiles.filter((t) => t > 0).every((t) => t === 100));
  const report = inspectMap(first);
  assert.ok(Math.abs(report.walls - 316 * 0.25) <= 4);
  assert.ok(Math.abs(report.coins - (316 - report.walls) * 0.5) <= 4);
  const few = generateSymmetricMap({ ...settings, coinDensity: 10 }, seeded(1));
  assert.ok(inspectMap(few).coins < report.coins);
});

test('invalid generation options fail before returning a draft', () => {
  const defaults = { columns: 12, rows: 10 };
  for (const changes of [
    { columns: 3 },
    { columns: 41 },
    { rows: 31 },
    { rows: 4.5 },
    { wallDensity: -1 },
    { wallDensity: 61 },
    { wallDensity: NaN },
    { coinDensity: 0 },
    { coinDensity: 101 },
    { coinDensity: 10.5 },
    { coinValue: 20 },
    { coinValue: '100' },
  ])
    assert.throws(() => generateSymmetricMap({ ...defaults, ...changes }));
});

test('mixed templates alter score, empty space and walls while preserving playable symmetry without black matter', () => {
  const reports = {};
  for (const preset of RANDOM_MAP_TEMPLATES) {
    const map = generateSymmetricMap({ columns: 20, rows: 16, ...preset }, seeded(17));
    const report = inspectMap(map);
    assert.equal(report.asymmetric.length, 0);
    assert.equal(report.isolated.length, 0);
    assert.ok(!map.tiles.includes(500));
    reports[preset.id] = { ...report, empty: map.tiles.filter((tile) => tile === 0).length };
  }
  assert.equal(reports['high-score'].coins, reports['low-score'].coins);
  assert.equal(reports['high-score'].walls, reports['low-score'].walls);
  assert.ok(reports['high-score'].score > reports['low-score'].score);
  assert.ok(reports['more-space'].empty > reports['low-score'].empty);
  assert.ok(reports['less-space'].empty < reports['low-score'].empty);
  assert.ok(reports['more-walls'].walls > reports['low-score'].walls);
  assert.ok(reports['less-walls'].walls < reports['low-score'].walls);
});

test('generated map saves as a draft, restores and publishes through the existing repository', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'coinhunter-random-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maps = new MapRepository({ dataDirectory: dir });
  const input = generateSymmetricMap({ columns: 20, rows: 16 }, seeded(42));
  const saved = await maps.saveDraft({
    ...input,
    id: 'random-test',
    name: '랜덤 맵',
    settings: DEFAULT_MAP_SETTINGS,
  });
  assert.equal(maps.getPublished(saved.id), null);
  const restored = new MapRepository({ dataDirectory: dir });
  assert.deepEqual(restored.getDraft(saved.id).tiles, input.tiles);
  await restored.publish(saved.id, saved.revision);
  assert.deepEqual(restored.getPublished(saved.id).tiles, input.tiles);
});
