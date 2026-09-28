export function createMap(columns = 12, rows = 10) {
  const tiles = Array(columns * rows).fill(10);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const dx = Math.min(x, columns - 1 - x);
      const dy = Math.min(y, rows - 1 - y);
      const index = y * columns + x;
      if ((dx === 2 && dy === 1) || (dx === 4 && dy === 3)) tiles[index] = -1;
      else if (dx >= 3 && dy >= 2) tiles[index] = dx === 5 ? 200 : 100;
      else if (dx === 1 && dy === 2) tiles[index] = 30;
      if (dx === 0 && dy === 0) tiles[index] = 0;
    }
  }
  return {
    id: 'crossroads',
    name: '대칭 정원',
    columns,
    rows,
    tiles,
    settings: {
      actionMs: 400,
      runningTimeMs: 120000,
      itemFirstMs: 5000,
      itemIntervalMs: 15000,
      itemDuration: 3,
      blackMatterIntervalMs: 15000,
      destroyWallIntervalMs: 3000,
    },
  };
}

export const MAPS = [createMap()];

export function validateMap(map) {
  if (
    !Number.isInteger(map.columns) ||
    !Number.isInteger(map.rows) ||
    map.columns < 4 ||
    map.rows < 4 ||
    map.columns > 40 ||
    map.rows > 30 ||
    map.tiles.length !== map.columns * map.rows
  )
    throw new Error('잘못된 맵 크기');
  if (!map.tiles.every((value) => [-1, 0, 10, 30, 100, 200, 500].includes(value)))
    throw new Error('잘못된 타일');
  const starts = [0, map.columns - 1, map.columns * (map.rows - 1), map.tiles.length - 1];
  if (starts.some((index) => map.tiles[index] !== 0))
    throw new Error('시작점은 빈칸이어야 합니다.');
}
