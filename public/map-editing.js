export const COIN_VALUES = [10, 30, 100, 200, 500];
export const starts = (columns, rows) => [0, columns - 1, columns * (rows - 1), columns * rows - 1];

export function placementIndices(columns, rows, index, symmetry) {
  const x = index % columns,
    y = Math.floor(index / columns);
  return [
    ...new Set(
      symmetry
        ? [
            index,
            y * columns + columns - 1 - x,
            (rows - 1 - y) * columns + x,
            (rows - 1 - y) * columns + columns - 1 - x,
          ]
        : [index],
    ),
  ];
}

export function applyTile(map, index, value, symmetry) {
  const indices = placementIndices(map.columns, map.rows, index, symmetry);
  const protectedTiles = starts(map.columns, map.rows);
  if (value !== 0 && indices.some((i) => protectedTiles.includes(i))) return [];
  const changes = indices
    .filter((i) => map.tiles[i] !== value)
    .map((i) => ({ index: i, before: map.tiles[i], after: value }));
  for (const change of changes) map.tiles[change.index] = change.after;
  return changes;
}

export function inspectMap(map) {
  const { columns, rows, tiles } = map;
  const asymmetric = tiles.flatMap((tile, i) =>
    placementIndices(columns, rows, i, true).some((p) => tiles[p] !== tile) ? [i] : [],
  );
  const seen = new Set([0]),
    queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head],
      x = i % columns,
      y = Math.floor(i / columns);
    for (const n of [
      x > 0 ? i - 1 : -1,
      x < columns - 1 ? i + 1 : -1,
      y > 0 ? i - columns : -1,
      y < rows - 1 ? i + columns : -1,
    ]) {
      if (n >= 0 && tiles[n] !== -1 && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  const isolated = tiles.flatMap((tile, i) => (tile !== -1 && !seen.has(i) ? [i] : []));
  return {
    asymmetric,
    isolated,
    coins: tiles.filter((tile) => tile > 0).length,
    score: tiles.reduce((sum, tile) => sum + Math.max(0, tile), 0),
    walls: tiles.filter((tile) => tile === -1).length,
  };
}
