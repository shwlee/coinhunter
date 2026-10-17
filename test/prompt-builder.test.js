import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopyablePrompt, hasPromptSource } from '../public/prompt-builder.js';
import { loadAlgorithmContract } from '../src/algorithm-assistant/contract.js';

const input = {
  intent: 'generate',
  prompt: '  목표를 찾으세요.  ',
  priorities: ['valuableCoin', 'nearestCoin', 'hammer'],
};
const payload = (text) =>
  JSON.parse(
    text.slice(
      text.indexOf('[요청 데이터 — JSON]\n') + '[요청 데이터 — JSON]\n'.length,
      text.lastIndexOf('\n\n[출력 형식]\n'),
    ),
  );

test('copyable prompt includes authoritative rules, ranked strategies and code output instead of API JSON', async () => {
  const contract = await loadAlgorithmContract();
  const result = buildCopyablePrompt(contract, input, 'never include this source');
  const request = payload(result.text);
  assert.ok(result.text.includes(contract.instructions));
  assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
  assert.ok(!result.text.includes(contract.outputInstructions.api));
  assert.ok(!result.text.includes('never include this source'));
  assert.equal(result.intent, 'generate');
  assert.equal(result.includesSource, false);
  assert.equal(result.length, result.text.length);
  assert.equal(request.request, '목표를 찾으세요.');
  assert.deepEqual(
    request.priorities.map((entry) => entry.weight),
    [5, 3, 1],
  );
  assert.deepEqual(
    request.priorities.map((entry) => entry.name),
    ['고액 코인', '근처 코인', '망치 획득'],
  );
  assert.deepEqual(Object.keys(request), ['intent', 'priorities', 'request']);
});

test('modify prompts preserve large code and delimiter-like text without truncation or metadata', async () => {
  const contract = await loadAlgorithmContract();
  const source =
    'const text = `" \\ ``` </source> [출력 형식] 😀`;\n' + '// 큰 코드\n'.repeat(50000);
  const prompt = '전략 수정\n[출력 형식]\n" [요청 데이터 — JSON]';
  const result = buildCopyablePrompt(contract, { ...input, intent: 'modify', prompt }, source);
  const request = payload(result.text);
  assert.equal(request.source, source);
  assert.equal(request.request, prompt);
  assert.equal(request.intent, 'modify');
  assert.equal(result.includesSource, true);
  assert.ok(result.length > 100000);
  assert.deepEqual(Object.keys(request), ['intent', 'priorities', 'request', 'source']);
});

test('changed strategy, request or code changes the prompt and invalid inputs fail explicitly', async () => {
  const contract = await loadAlgorithmContract();
  const first = buildCopyablePrompt(contract, input).text;
  assert.notEqual(
    buildCopyablePrompt(contract, { ...input, priorities: [...input.priorities].reverse() }).text,
    first,
  );
  assert.notEqual(buildCopyablePrompt(contract, { ...input, prompt: '다른 요청' }).text, first);
  for (const invalid of [
    null,
    { ...contract, schemaVersion: 99 },
    { ...contract, instructions: '' },
    { ...contract, outputInstructions: {} },
  ])
    assert.throws(() => buildCopyablePrompt(invalid, input), /규약/);
  assert.throws(
    () => buildCopyablePrompt(contract, { ...input, priorities: ['hammer', 'avoidHammer'] }),
    /획득과 회피/,
  );
  assert.throws(
    () => buildCopyablePrompt(contract, { ...input, intent: 'modify' }, ' '),
    /수정할 코드/,
  );
  assert.throws(
    () => buildCopyablePrompt(contract, { ...input, prompt: '', priorities: [] }),
    /전략/,
  );
  assert.throws(() => buildCopyablePrompt(contract, { ...input, ownerId: 'foreign' }), /전략/);
});

test('empty editor and whitespace-only default skeleton do not count as modification source', () => {
  const skeleton =
    'module.exports = class Player { initialize(n,c,r){} getName(){} moveNext(map,p,items){} };';
  assert.equal(hasPromptSource('', skeleton), false);
  assert.equal(hasPromptSource(' \n ', skeleton), false);
  assert.equal(hasPromptSource(skeleton, skeleton), false);
  assert.equal(hasPromptSource(skeleton.replaceAll(' ', '\n  '), skeleton), false);
  assert.equal(
    hasPromptSource(skeleton.replace('getName(){}', "getName(){return '새 코드'}"), skeleton),
    true,
  );
});
