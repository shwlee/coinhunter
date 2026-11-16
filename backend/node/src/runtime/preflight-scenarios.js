import { readFile } from 'node:fs/promises';

export const PREFLIGHT_FIXTURE_VERSION = '2.0.0';

export async function preflightScenarios() {
  const scenarios = [];
  for (const filename of ['crossroads', 'four-courtyards']) {
    const map = JSON.parse(
      await readFile(new URL(`../../maps/samples/${filename}.json`, import.meta.url), 'utf8'),
    );
    scenarios.push({ ...map, scenario: filename, players: [0, 1, 2, 3] });
  }
  const base = scenarios[0];
  scenarios.push({
    ...base,
    scenario: 'no-targets',
    absentItems: true,
    tiles: base.tiles.map((x) => (x > 0 ? 0 : x)),
    players: [0],
  });
  // Valid tile vocabulary and outer starts; a goal isolated by walls.
  const enclosed = Array(36).fill(0);
  enclosed[14] = 500;
  for (const p of [8, 13, 15, 20]) enclosed[p] = -1;
  scenarios.push({
    scenario: 'unreachable-goal',
    columns: 6,
    rows: 6,
    tiles: enclosed,
    players: [0],
  });
  for (const dense of [false, true]) {
    const columns = 40,
      rows = 30; // Current map editor maxima, not a new product cap.
    const tiles = Array(columns * rows).fill(0);
    for (let i = 1; i < tiles.length - 1; i++)
      if (dense || i % 97 === 0) tiles[i] = [10, 30, 100, 200, 500][i % 5];
    for (const p of [0, columns - 1, columns * (rows - 1), tiles.length - 1]) tiles[p] = 0;
    scenarios.push({
      scenario: dense ? 'maximum-dense' : 'maximum-sparse',
      columns,
      rows,
      tiles,
      players: [0],
    });
  }
  return scenarios;
}
