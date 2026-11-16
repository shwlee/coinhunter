import { readFile } from 'node:fs/promises';
import { analyze } from 'eslint-scope';
import { validateSource } from './policy.js';
import { randomUUID } from 'node:crypto';
import { JavaScriptArtifacts } from './javascript-artifacts.js';
import { createJavaScriptRegistry } from './runner-registry.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from './policy.js';
import { validationDiagnostic } from './validation-diagnostic.js';
import { inspectAuthoring, AUTHORING_PROFILE } from './authoring-inspection.js';
import { preflightScenarios, PREFLIGHT_FIXTURE_VERSION } from './preflight-scenarios.js';

let currentRunner,
  cancelled = false,
  started = false;
function checkCancellation() {
  if (cancelled) throw new Error('코드 검사가 취소되었습니다.');
}

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
  let tree;
  try {
    tree = validateSource(source);
    inspectAuthoring(tree);
  } catch (error) {
    error.validation ||= { stage: error.loc ? 'syntax' : 'policy' };
    throw error;
  }
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
    error.validation = { stage: 'references' };
    throw error;
  }
  let calls = 0;
  const artifacts = new JavaScriptArtifacts();
  const artifact = await artifacts.register(source);
  const registry = createJavaScriptRegistry({
    resolveArtifact: artifacts.resolve,
    diagnostics: true,
  });
  for (const map of await preflightScenarios()) {
    const starts = [0, map.columns - 1, map.columns * (map.rows - 1), map.tiles.length - 1];
    for (const player of map.players) {
      let runner,
        checkedTurn = null;
      try {
        checkCancellation();
        const context = {
          contractVersion: 1,
          gameId: randomUUID(),
          playerId: player,
          runId: randomUUID(),
          language: 'javascript',
          artifact,
          limits: { turnMs: 500, algorithmMemoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES },
        };
        runner = registry.create(context);
        currentRunner = runner;
        await runner.initialize({ playerNumber: player, columns: map.columns, rows: map.rows });
        let position = starts[player];
        const tiles = [...map.tiles];
        for (let turn = 0; turn < 3; turn++) {
          checkCancellation();
          checkedTurn = turn + 1;
          // Include both absent items and present items, plus a coin-free board.
          if (turn === 2) for (let i = 0; i < tiles.length; i++) if (tiles[i] > 0) tiles[i] = 0;
          const items = turn === 1 && !map.absentItems ? [...starts] : [-1, -1, -1, -1];
          const result = await runner.move({
            contractVersion: 1,
            gameId: context.gameId,
            playerId: player,
            runId: context.runId,
            callId: turn + 1,
            map: [...tiles],
            myPosition: position,
            items,
          });
          if (result.status !== 'ok') {
            const reason =
              {
                timeout: '실행 시간 500ms 초과',
                exception: '실행 중 예외 발생',
                'invalid-result': '반환값은 정수 -1, 0, 1, 2, 3 중 하나여야 합니다',
              }[result.status] || result.status;
            const error = new Error(
              `moveNext 검사 실패 · ${map.columns}×${map.rows}, 플레이어 ${player + 1}, ${turn + 1}회 호출: ${reason}`,
            );
            error.validation = {
              stage: 'moveNext',
              status: result.status,
              detail: runner.lastExceptionMessage || reason,
              logs: [...result.logs],
              droppedLogs: result.droppedLogs,
              elapsedMs: result.timings.executionMs,
              limitMs: 500,
              code:
                result.status === 'timeout'
                  ? 'AR012'
                  : result.status === 'invalid-result'
                    ? 'AR013'
                    : 'AX002',
            };
            throw error;
          }
          calls++;
          const direction = result.direction;
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
      } catch (error) {
        if (error.validation && error.code === 'initialization-failed') {
          const info = error.validation;
          error.message = `${info.stage === 'load' ? '코드 로딩' : info.stage} 실패: ${info.status}${info.detail ? ' · ' + info.detail : ''}`;
        }
        error.validation = {
          ...error.validation,
          context: {
            columns: map.columns,
            rows: map.rows,
            player: player + 1,
            call: checkedTurn,
            scenario: map.scenario,
          },
        };
        throw error;
      } finally {
        await runner?.close();
        currentRunner = null;
      }
    }
  }
  return {
    ok: true,
    calls,
    profileVersion: AUTHORING_PROFILE,
    fixtureVersion: PREFLIGHT_FIXTURE_VERSION,
  };
}

process.on('message', async ({ source, sourcePath, cancel }) => {
  if (cancel) {
    cancelled = true;
    await currentRunner?.close().catch(() => {});
    return;
  }
  if (started) return;
  started = true;
  let result;
  try {
    result = await inspect(sourcePath ? await readFile(sourcePath, 'utf8') : source);
  } catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('E'))
      error = new Error('검사 환경 또는 검사 대상 파일을 준비하지 못했습니다.');
    result = {
      error: String(error.message).slice(0, 500),
      diagnostic: validationDiagnostic(error),
    };
  }
  process.send?.(result, () => process.disconnect());
});
process.on('disconnect', () => process.exit(0));
