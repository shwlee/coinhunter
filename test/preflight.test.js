import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAlgorithm } from '../backend/node/src/runtime/preflight.js';
import { validateSource } from '../backend/node/src/runtime/policy.js';
import { AlgorithmSandbox } from '../backend/node/src/runtime/sandbox.js';
import { readFile } from 'node:fs/promises';

const source = (move = 'return -1;', initialize = 'this.turn = 0;', name = "return '테스트';") =>
  `module.exports = class Player {
    initialize(number, columns, rows) { ${initialize} }
    getName() { ${name} }
    moveNext(map, position, items) { ${move} }
  };`;
const check = (code) => validateAlgorithm(code, 'preflight-test');

test('source inspection and preflight handle large lists without argument overflow', async () => {
  const longSource = ';'.repeat(130000) + source();
  assert.doesNotThrow(() => validateSource(longSource));
  assert.throws(() => validateSource(longSource + 'async function forbidden() {}'), /비동기/);
  assert.equal((await check(longSource)).ok, true);
});

test('preflight executes persistent player instances, permits declared Korean identifiers and -1', async () => {
  const result = await check(
    source('const 방향 = -1; if (++this.turn > 3) throw new Error(); return 방향;'),
  );
  assert.deepEqual(result, {
    ok: true,
    calls: 36,
    profileVersion: 'javascript-preflight-v2',
    fixtureVersion: '2.0.0',
  });
});

test('preflight finds unresolved names even after return and reports exact location', async () => {
  const code = source('return -1;', '', "return '길찾기'; ㅂㅈㄷ");
  const result = await check(code);
  assert.match(result.error, /ㅂㅈㄷ/);
  assert.equal(result.diagnostic.offset, code.indexOf('ㅂㅈㄷ'));
  assert.equal(result.diagnostic.line, 3);
  assert.equal(result.diagnostic.stage, 'references');
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

test('validation explains export, required methods, name, initialization and return failures', async () => {
  const objectExport = `class Player { initialize() {} getName() { return 'test'; } moveNext() { return -1; } } module.exports = { Player };`;
  const exported = await check(objectExport);
  assert.equal(exported.diagnostic.stage, 'load');
  assert.match(exported.diagnostic.detail, /module.exports must be a class/);
  assert.match(exported.diagnostic.hint, /module.exports = Player;/);
  assert.match(exported.diagnostic.hint, /module.exports = \{ Player \}/);
  assert.equal(exported.diagnostic.offset, undefined);
  const missing = await check(
    'module.exports = class { initialize() {} getName() { return "test"; } };',
  );
  assert.match(missing.diagnostic.detail, /missing: moveNext/);
  assert.match(missing.diagnostic.hint, /moveNext\(map, myPosition, items\)/);
  const named = await check(source('return -1;', '', 'return 123;'));
  assert.equal(named.diagnostic.stage, 'getName');
  assert.match(named.diagnostic.hint, /문자열/);
  const initialized = await check(
    source('return -1;', 'debug.print("init"); throw new Error("bad initialization");'),
  );
  assert.equal(initialized.diagnostic.stage, 'initialize');
  assert.equal(initialized.diagnostic.detail, 'bad initialization');
  assert.deepEqual(initialized.diagnostic.logs, ['init']);
  const invalid = await check(source('return "2";'));
  assert.match(invalid.diagnostic.hint, /정수 -1, 0, 1, 2, 3/);
  const map = JSON.parse(
    await readFile(
      new URL('../backend/node/maps/samples/crossroads.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(invalid.diagnostic.context, {
    columns: map.columns,
    rows: map.rows,
    player: 1,
    call: 1,
    scenario: 'crossroads',
  });
});

test('runtime diagnostics preserve bounded failing-call messages, logs and context', async () => {
  const failed = await check(
    source(`if (++this.turn === 2) {
    for (let i=0; i<35; i++) debug.print('entry', i);
    throw new Error('오류 <img src=x> ' + 'x'.repeat(50000));
  } debug.print('previous-call'); return -1;`),
  );
  assert.equal(failed.diagnostic.stage, 'moveNext');
  assert.match(failed.diagnostic.detail, /^오류 <img src=x>/);
  assert.equal(failed.diagnostic.detail.length, 400);
  assert.equal(failed.diagnostic.logs.length, 30);
  assert.equal(failed.diagnostic.logs[0], 'entry 0');
  assert.equal(failed.diagnostic.logs.includes('previous-call'), false);
  assert.equal(failed.diagnostic.droppedLogs, 5);
  assert.equal(failed.diagnostic.context.call, 2);
  assert.match(failed.diagnostic.hint, /1차원 정수 배열/);
  assert.equal((await check(source('throw "문자열 오류";'))).diagnostic.detail, '문자열 오류');
});

test('diagnostics do not execute message getters, toJSON or overwritten formatting intrinsics', async () => {
  const failed = await check(
    source(`throw {
    get message() { debug.print('getter-ran'); while(true){} },
    toJSON() { while(true){} }, toString() { while(true){} }
  };`),
  );
  assert.match(failed.error, /실행 중 예외/);
  assert.deepEqual(failed.diagnostic.logs, []);
  const mutated = await check(
    source(`
    Object.getOwnPropertyDescriptor = () => { while(true){} };
    String.prototype.slice = () => { while(true){} };
    Reflect.apply = () => { while(true){} };
    throw new Error('safe captured message');`),
  );
  assert.equal(mutated.diagnostic.detail, 'safe captured message');
});

test(
  'proxy traps during diagnostics share the original interruption budget and preserve the next call',
  { timeout: 10000 },
  async () => {
    const sandbox = await AlgorithmSandbox.create(
      source(`
    if (++this.turn === 1) throw new Proxy({}, {
      getOwnPropertyDescriptor() { while(true){} }
    });
    return 2;`),
      0,
      6,
      6,
      { diagnostics: true },
    );
    try {
      const first = sandbox.invoke('moveNext', [Array(36).fill(0), 0, [-1, -1, -1, -1]]);
      assert.equal(first.status, 'timeout');
      assert.ok(first.elapsedMs >= 500);
      assert.equal(sandbox.invoke('moveNext', [Array(36).fill(0), 0, [-1, -1, -1, -1]]).value, 2);
    } finally {
      sandbox.dispose();
    }
  },
);

test('guest allocation failures remain diagnosable and do not block later validations', async () => {
  const result = await check(source('new Array(100000000).fill(1); return 0;'));
  assert.equal(result.diagnostic.stage, 'moveNext');
  assert.match(result.error, /실행 중 예외|500ms/);
  assert.equal((await check(source())).ok, true);
});
