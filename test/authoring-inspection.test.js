import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSource } from '../backend/node/src/runtime/policy.js';
import { inspectAuthoring } from '../backend/node/src/runtime/authoring-inspection.js';
import { validateAlgorithm } from '../backend/node/src/runtime/preflight.js';
import { preflightScenarios } from '../backend/node/src/runtime/preflight-scenarios.js';

const inspect = (source) => inspectAuthoring(validateSource(source));
test('try/catch and try/finally are rejected with original locations before execution', () => {
  for (const source of ['try { throw 0; } catch(e) {}', '\ntry {} finally {}'])
    assert.throws(
      () => inspect(source),
      (error) =>
        error.validation.code === 'AR011' &&
        error.pos === source.indexOf('try') &&
        error.loc.column === 0,
    );
  assert.doesNotThrow(() => inspect(`const text='try {} catch(e) {}'; // try/catch\n`));
});
test('resolved direct/mutual methods, lexical helpers and const functions reject cycles', () => {
  for (const source of [
    'class P { a(){return this.a();} }',
    'class P { a(){return this["b"]();} b(){return this.a();} }',
    'function a(){ return b(); } function b(){ return a(); }',
    'const a = () => a();',
    'class P { a(){const x=()=>this.a(); return x();} }',
  ])
    assert.throws(
      () => inspect(source),
      (error) => error.validation.code === 'AR009',
    );
});
test('distinct lexical scopes, classes and normal nonrecursive helpers do not create false cycles', () => {
  for (const source of [
    'function a(){ function a(){return 0;} return a(); }',
    'class A { a(){return this.b();} b(){return 0;} } class B { b(){return this.a();} a(){return 0;} }',
    'class P { a(){let queue=[0]; while(queue.length) { queue.pop(); } return -1;} }',
    'class P { a(){ function independent(){return this.a();} return independent();} }',
    'function a(){return a();} a = () => 0;',
  ])
    assert.doesNotThrow(() => inspect(source));
});
test('expanded fixtures include stable maximum maps, absent goals and enclosed target', async () => {
  const scenarios = await preflightScenarios();
  assert.equal(scenarios.length, 6);
  assert.deepEqual(scenarios, await preflightScenarios());
  for (const map of scenarios) {
    assert.equal(map.tiles.length, map.columns * map.rows);
    assert.ok(map.tiles.every((x) => [-1, 0, 10, 30, 100, 200, 500].includes(x)));
  }
  assert.ok(scenarios.find((x) => x.scenario === 'no-targets').tiles.every((x) => x <= 0));
  const isolated = scenarios.find((x) => x.scenario === 'unreachable-goal');
  for (const i of [8, 13, 15, 20]) assert.equal(isolated.tiles[i], -1);
  assert.equal(scenarios.find((x) => x.scenario === 'maximum-dense').tiles.length, 1200);
});
test('real preflight rejects policy before malicious load and reports failing expanded scenario', async () => {
  const blocked = await validateAlgorithm(
    'while(true){}; try {} catch(e) {}',
    'authoring-integration',
  );
  assert.equal(blocked.diagnostic.code, 'AR011');
  assert.equal(blocked.diagnostic.stage, 'policy');
  const recursive = await validateAlgorithm(
    'module.exports=class {initialize(){} getName(){return "x";} moveNext(){return this.moveNext();}}',
    'authoring-integration',
  );
  assert.equal(recursive.diagnostic.code, 'AR009');
  const largeOnly =
    'module.exports=class {initialize(n,c,r){this.c=c;} getName(){return "x";} moveNext(){if(this.c===40) throw new Error("large-input"); return -1;}}';
  const failed = await validateAlgorithm(largeOnly, 'authoring-integration');
  assert.equal(failed.diagnostic.context.scenario, 'maximum-sparse');
  assert.equal(failed.diagnostic.detail, 'large-input');
  assert.equal(failed.diagnostic.context.call, 1);
});

test('real preflight reports measured timeout and cannot label a normal -1 as failure', async () => {
  const result = await validateAlgorithm(
    'module.exports=class { initialize(){} getName(){return "budget";} moveNext(){while(true){}}}',
    'authoring-budget',
  );
  assert.equal(result.diagnostic.code, 'AR012');
  assert.equal(result.diagnostic.limitMs, 500);
  assert.ok(result.diagnostic.elapsedMs >= 500);
  assert.equal(result.diagnostic.context.scenario, 'crossroads');
});
