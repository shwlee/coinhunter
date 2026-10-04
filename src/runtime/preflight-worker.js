import { readFile } from 'node:fs/promises';
import { analyze } from 'eslint-scope';
import { validateSource } from './policy.js';
import { AlgorithmSandbox } from './sandbox.js';

// Only globals available to player.js; host APIs and disabled dynamic execution are excluded.
const globals = new Set(
  `module exports debug globalThis undefined NaN Infinity
Object Array Boolean Number String BigInt Symbol Math JSON Date RegExp
Error EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError
Map Set WeakMap WeakSet ArrayBuffer SharedArrayBuffer DataView
Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array
Float32Array Float64Array BigInt64Array BigUint64Array Reflect Proxy Atomics
parseInt parseFloat isNaN isFinite decodeURI decodeURIComponent encodeURI encodeURIComponent
escape unescape`.split(/\s+/),
);

async function inspect(source) {
  const tree = validateSource(source);
  const scope = analyze(tree, {
    ecmaVersion: 2022,
    sourceType: 'script',
    nodejsScope: true,
    impliedStrict: true,
  });
  const missing = scope.globalScope.through
    .map((reference) => reference.identifier)
    .filter((identifier) => !globals.has(identifier.name))
    .sort((a, b) => a.start - b.start)[0];
  if (missing) {
    const error = new Error(`선언되지 않았거나 사용할 수 없는 이름: ${missing.name}`);
    error.pos = missing.start;
    error.loc = missing.loc.start;
    throw error;
  }
  let calls = 0;
  for (const filename of ['crossroads', 'four-courtyards']) {
    const map = JSON.parse(
      await readFile(new URL(`../../maps/samples/${filename}.json`, import.meta.url), 'utf8'),
    );
    const starts = [0, map.columns - 1, map.columns * (map.rows - 1), map.tiles.length - 1];
    for (let player = 0; player < 4; player++) {
      const sandbox = await AlgorithmSandbox.create(source, player, map.columns, map.rows);
      try {
        let position = starts[player];
        const tiles = [...map.tiles];
        for (let turn = 0; turn < 3; turn++) {
          // Include both absent items and present items, plus a coin-free board.
          if (turn === 2) for (let i = 0; i < tiles.length; i++) if (tiles[i] > 0) tiles[i] = 0;
          const items = turn === 1 ? [...starts] : [-1, -1, -1, -1];
          const result = sandbox.invoke('moveNext', [tiles, position, items]);
          if (result.status !== 'ok') {
            const reason =
              {
                timeout: '실행 시간 500ms 초과',
                exception: '실행 중 예외 발생',
                'invalid-result': '반환값은 정수 -1, 0, 1, 2, 3 중 하나여야 합니다',
              }[result.status] || result.status;
            throw new Error(
              `moveNext 검사 실패 · ${map.columns}×${map.rows}, 플레이어 ${player + 1}, ${turn + 1}회 호출: ${reason}`,
            );
          }
          calls++;
          const direction = result.value;
          const next = position + [-1, -map.columns, 1, map.columns][direction];
          if (
            direction !== -1 &&
            next >= 0 &&
            next < tiles.length &&
            tiles[next] !== -1 &&
            !(direction === 0 && position % map.columns === 0) &&
            !(direction === 2 && position % map.columns === map.columns - 1)
          ) {
            position = next;
            tiles[position] = 0;
          }
        }
      } finally {
        sandbox.dispose();
      }
    }
  }
  return { ok: true, calls };
}

process.once('message', async ({ source, sourcePath }) => {
  let result;
  try {
    result = await inspect(sourcePath ? await readFile(sourcePath, 'utf8') : source);
  } catch (error) {
    result = {
      error: String(error.message).slice(0, 500),
      diagnostic:
        Number.isInteger(error.pos) && error.loc
          ? { offset: error.pos, line: error.loc.line, column: error.loc.column + 1 }
          : null,
    };
  }
  process.send?.(result, () => process.disconnect());
});
process.on('disconnect', () => process.exit(0));
