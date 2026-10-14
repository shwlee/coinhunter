export const COIN_VALUES = [10, 30, 100, 200, 500];
export const RANDOM_MAP_TEMPLATES = [
  { id: 'low-score', name: '낮은 점수 위주', wallDensity: 25, coinDensity: 50, coinValue: 'mixed' },
  {
    id: 'high-score',
    name: '높은 점수 위주',
    wallDensity: 25,
    coinDensity: 50,
    coinValue: 'mixed-high',
  },
  { id: 'more-space', name: '공백 많이', wallDensity: 15, coinDensity: 25, coinValue: 'mixed' },
  { id: 'less-space', name: '공백 적게', wallDensity: 15, coinDensity: 90, coinValue: 'mixed' },
  { id: 'more-walls', name: '벽 많이', wallDensity: 45, coinDensity: 50, coinValue: 'mixed' },
  { id: 'less-walls', name: '벽 적게', wallDensity: 10, coinDensity: 50, coinValue: 'mixed' },
];
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

// Build whole reflection groups so odd central axes also retain equal coin values.
export function generateSymmetricMap(
  { columns, rows, wallDensity = 25, coinDensity = 50, coinValue = 'mixed' },
  random = Math.random,
) {
  if (
    !Number.isInteger(columns) ||
    columns < 4 ||
    columns > 40 ||
    !Number.isInteger(rows) ||
    rows < 4 ||
    rows > 30
  )
    throw new Error('맵 크기는 열 4~40, 행 4~30의 정수로 입력하세요.');
  if (!Number.isInteger(wallDensity) || wallDensity < 0 || wallDensity > 60)
    throw new Error('벽 밀도는 0~60%의 정수로 입력하세요.');
  if (!Number.isInteger(coinDensity) || coinDensity < 1 || coinDensity > 100)
    throw new Error('코인 밀도는 1~100%의 정수로 입력하세요.');
  if (!['mixed', 'mixed-high'].includes(coinValue) && !COIN_VALUES.includes(coinValue))
    throw new Error('코인 점수를 선택하세요.');
  const map = { columns, rows, tiles: Array(columns * rows).fill(0), name: '', description: '' };
  const protectedTiles = new Set(starts(columns, rows));
  const groups = [];
  for (let y = 0; y < Math.ceil(rows / 2); y++)
    for (let x = 0; x < Math.ceil(columns / 2); x++) {
      const group = placementIndices(columns, rows, y * columns + x, true);
      if (!group.some((i) => protectedTiles.has(i))) groups.push(group);
    }
  const shuffle = (values) => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };
  const eligible = map.tiles.length - protectedTiles.size;
  const targetWalls = Math.round((eligible * wallDensity) / 100);
  let walls = 0;
  for (const group of shuffle(groups)) {
    if (Math.abs(targetWalls - walls - group.length) >= Math.abs(targetWalls - walls)) continue;
    for (const i of group) map.tiles[i] = -1;
    // Reject walls that disconnect any floor, including any of the four starts.
    if (inspectMap(map).isolated.length) {
      for (const i of group) map.tiles[i] = 0;
    } else walls += group.length;
  }
  const targetCoins = Math.max(1, Math.round(((eligible - walls) * coinDensity) / 100));
  const mixed =
    coinValue === 'mixed-high' ? [10, 30, 100, 100, 200, 200, 200] : [10, 10, 10, 30, 30, 100, 200];
  let coins = 0;
  for (const group of shuffle(groups.filter((group) => map.tiles[group[0]] === 0))) {
    if (coins && Math.abs(targetCoins - coins - group.length) >= Math.abs(targetCoins - coins))
      continue;
    const value =
      typeof coinValue === 'string' ? mixed[Math.floor(random() * mixed.length)] : coinValue;
    for (const i of group) map.tiles[i] = value;
    coins += group.length;
  }
  const report = inspectMap(map);
  if (!report.coins || report.isolated.length || report.asymmetric.length)
    throw new Error('플레이 가능한 대칭 맵을 만들지 못했습니다. 밀도를 낮춰 다시 시도하세요.');
  return map;
}
