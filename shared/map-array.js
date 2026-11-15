import { COIN_VALUES } from './map-editing.js';

export const MAP_ARRAY_MAX_BYTES = 64 * 1024;

// Parse data only: never execute pasted JavaScript or C# source.
export function parseMapArray(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('맵 배열을 입력하세요.');
  if (new TextEncoder().encode(source).length > MAP_ARRAY_MAX_BYTES)
    throw new Error('맵 배열은 64 KiB 이하로 입력하세요.');
  const text = source.replace(/^\uFEFF/, '').trim();
  const match =
    /^\[([\s\S]*)\]\s*;?$/.exec(text) ||
    /^(?:int\s*\[\s*\]\s+[A-Za-z_]\w*\s*=\s*)?(?:new\s+int\s*\[\s*\]\s*)?\{([\s\S]*)\}\s*;?$/.exec(
      text,
    );
  if (!match) throw new Error('[ ... ] 또는 new int[] { ... } 형태의 배열 하나를 입력하세요.');
  let body = match[1].trim();
  if (body.endsWith(',')) body = body.slice(0, -1).trimEnd();
  if (!body) throw new Error('맵 배열에 타일 값을 넣으세요.');
  return body.split(',').map((raw, index) => {
    const token = raw.trim();
    if (!/^[+-]?\d+$/.test(token) || !Number.isSafeInteger(Number(token)))
      throw new Error(`배열의 ${index + 1}번째 값이 정수가 아닙니다.`);
    return Number(token);
  });
}

export function formatMapArray(map, format = 'array') {
  const { columns, rows, tiles } = map || {};
  if (
    !Number.isInteger(columns) ||
    columns < 4 ||
    columns > 40 ||
    !Number.isInteger(rows) ||
    rows < 4 ||
    rows > 30 ||
    !Array.isArray(tiles) ||
    tiles.length !== columns * rows
  )
    throw new Error('맵 크기와 배열 길이가 일치하지 않습니다.');
  if (Array.from(tiles).some((tile) => ![-1, 0, ...COIN_VALUES].includes(tile)))
    throw new Error('지원하지 않는 타일 값입니다.');
  if (!['array', 'csharp'].includes(format)) throw new Error('지원하지 않는 출력 형식입니다.');
  const lines = [];
  for (let row = 0; row < rows; row++)
    lines.push('  ' + tiles.slice(row * columns, (row + 1) * columns).join(', '));
  return (
    (format === 'csharp' ? 'new int[] {\n' : '[\n') +
    lines.join(',\n') +
    (format === 'csharp' ? '\n};\n' : '\n]\n')
  );
}
