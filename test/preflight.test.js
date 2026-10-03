import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAlgorithm } from '../src/runtime/preflight.js';

const source = (move = 'return -1;', initialize = 'this.turn = 0;', name = "return '테스트';") =>
  `module.exports = class Player {
    initialize(number, columns, rows) { ${initialize} }
    getName() { ${name} }
    moveNext(map, position, items) { ${move} }
  };`;
const check = (code) => validateAlgorithm(code, 'preflight-test');

test('preflight executes persistent player instances, permits declared Korean identifiers and -1', async () => {
  const result = await check(
    source('const 방향 = -1; if (++this.turn > 3) throw new Error(); return 방향;'),
  );
  assert.deepEqual(result, { ok: true, calls: 24 });
});

test('preflight finds unresolved names even after return and reports exact location', async () => {
  const code = source('return -1;', '', "return '길찾기'; ㅂㅈㄷ");
  const result = await check(code);
  assert.match(result.error, /ㅂㅈㄷ/);
  assert.equal(result.diagnostic.offset, code.indexOf('ㅂㅈㄷ'));
  assert.equal(result.diagnostic.line, 3);
  assert.match((await check(source('쟁.ㅁㄴㅇ; return -1;'))).error, /쟁/);
});

test('preflight rejects invalid contracts, runtime exceptions, late calls and unsupported APIs', async () => {
  for (const [code, pattern] of [
    ['const broken = ;', /Unexpected token/],
    ['module.exports = class {};', /로딩 실패/],
    [source('return -1;', 'throw new Error();'), /initialize 실패/],
    [source('return -1;', '', 'return 123;'), /getName 실패/],
    [source('return 9;'), /반환값/],
    [source('return map.missing.call();'), /예외/],
    [source('if (++this.turn === 2) throw new Error(); return -1;'), /2회 호출/],
    [source('fetch("https://example.com"); return -1;'), /fetch/],
  ])
    assert.match((await check(code)).error, pattern);
});

test('preflight enforces 500ms and permits subsequent validation', async () => {
  assert.match((await check(source('while (true) {}'))).error, /500ms/);
  assert.equal((await check(source())).ok, true);
});

test('preflight rejects overlapping requests from one account', async () => {
  const first = check(source('while (true) {}'));
  await assert.rejects(check(source()), (error) => error.status === 429);
  await first;
});
