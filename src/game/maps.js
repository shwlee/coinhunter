export function validateMap(map) {
  if (
    !Number.isInteger(map.columns) ||
    !Number.isInteger(map.rows) ||
    map.columns < 4 ||
    map.rows < 4 ||
    map.columns > 40 ||
    map.rows > 30 ||
    !Array.isArray(map.tiles) ||
    map.tiles.length !== map.columns * map.rows
  )
    throw new Error('잘못된 맵 크기');
  if (!map.tiles.every((value) => [-1, 0, 10, 30, 100, 200, 500].includes(value)))
    throw new Error('잘못된 타일');
  const starts = [0, map.columns - 1, map.columns * (map.rows - 1), map.tiles.length - 1];
  if (starts.some((index) => map.tiles[index] !== 0))
    throw new Error('시작점은 빈칸이어야 합니다.');
}

export const DEFAULT_HURRY_UP_REMOVAL_INTERVAL_MS = Object.freeze({
  10: 300,
  30: 700,
  100: 1000,
  200: 1300,
  500: 1300,
});

export function validateMapDocument(map, { published = true } = {}) {
  if (
    !map ||
    map.schemaVersion !== 1 ||
    typeof map.id !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(map.id) ||
    typeof map.name !== 'string' ||
    !map.name.trim() ||
    map.name.length > 100 ||
    typeof map.description !== 'string' ||
    map.description.length > 2000 ||
    !Number.isSafeInteger(map.revision) ||
    map.revision < 1
  )
    throw new Error('잘못된 맵 메타데이터');
  validateMap(map);
  const limits = {
    actionMs: [50, 10000],
    runningTimeMs: [1000, 3600000],
    itemFirstMs: [0, 3600000],
    itemIntervalMs: [100, 3600000],
    itemDuration: [1, 100],
    blackMatterIntervalMs: [100, 3600000],
    destroyWallIntervalMs: [100, 3600000],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const value = map.settings?.[key];
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`잘못된 맵 옵션: ${key}`);
  }
  const removal = map.settings.hurryUpRemovalIntervalMs;
  if (removal !== undefined) {
    if (!removal || typeof removal !== 'object' || Array.isArray(removal))
      throw new Error('잘못된 맵 옵션: hurryUpRemovalIntervalMs');
    for (const [score, interval] of Object.entries(removal)) {
      if (
        !Object.hasOwn(DEFAULT_HURRY_UP_REMOVAL_INTERVAL_MS, score) ||
        !Number.isInteger(interval) ||
        interval < 100 ||
        interval > 60000
      )
        throw new Error(`잘못된 코인 소멸 간격: ${score}`);
    }
  }
  if (!published) return;
  const { columns, rows, tiles } = map;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const tile = tiles[y * columns + x];
      if (
        tile !== tiles[y * columns + columns - 1 - x] ||
        tile !== tiles[(rows - 1 - y) * columns + x]
      )
        throw new Error('맵은 상하좌우 대칭이어야 합니다.');
    }
  if (!tiles.some((tile) => tile > 0)) throw new Error('코인을 하나 이상 배치하세요.');
  const visited = new Set([0]);
  const queue = [0];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i],
      x = p % columns,
      y = Math.floor(p / columns);
    const neighbors = [
      x > 0 ? p - 1 : -1,
      x + 1 < columns ? p + 1 : -1,
      y > 0 ? p - columns : -1,
      y + 1 < rows ? p + columns : -1,
    ];
    for (const next of neighbors)
      if (next >= 0 && tiles[next] !== -1 && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
  }
  if (tiles.some((tile, index) => tile !== -1 && !visited.has(index)))
    throw new Error('시작점과 모든 이동 가능 공간이 연결되어야 합니다.');
}
