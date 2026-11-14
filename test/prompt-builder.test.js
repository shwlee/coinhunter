import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopyablePrompt, hasPromptSource } from '../public/prompt-builder.js';
import {
  loadAlgorithmContract,
  promptContentVersion,
} from '../src/algorithm-assistant/contract.js';

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

test('new conversations include full authoring rules, a minimal starter and the shared output format', async () => {
  const contract = await loadAlgorithmContract();
  const result = buildCopyablePrompt(contract, input, 'never include this source');
  const request = payload(result.text);
  assert.ok(result.text.includes(contract.promptContext.fullRules));
  assert.ok(result.text.includes(contract.promptContext.starterSource));
  assert.ok(!result.text.includes(contract.instructions));
  assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
  assert.ok(!result.text.includes(contract.outputInstructions.api));
  assert.ok(!result.text.includes('never include this source'));
  assert.equal(result.intent, 'generate');
  assert.equal(result.conversationMode, 'new');
  assert.equal(result.contentVersion, contract.contentVersion);
  assert.equal(result.includesFullRules, true);
  assert.equal(result.includesExample, true);
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
    { ...contract, promptContext: {} },
    { ...contract, contentVersion: 'old' },
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

test('continuing a modification may omit source and uses the earlier conversation without repeating rules', async () => {
  const contract = await loadAlgorithmContract();
  const result = buildCopyablePrompt(contract, { ...input, intent: 'modify' }, undefined, {
    conversationMode: 'continue',
  });
  const request = payload(result.text);
  assert.equal(request.intent, 'modify');
  assert.equal(Object.hasOwn(request, 'source'), false);
  assert.equal(result.includesSource, false);
  assert.equal(result.includesFullRules, false);
  assert.equal(result.includesExample, false);
  assert.equal(result.conversationMode, 'continue');
  assert.equal(result.contentVersion, contract.contentVersion);
  assert.ok(result.text.includes(contract.promptContext.continuationRules));
  assert.ok(!result.text.includes(contract.promptContext.fullRules));
  assert.ok(!result.text.includes(contract.promptContext.starterSource));
  assert.match(result.text, /이전 대화에서 작성한 코드를 기준/);
  assert.equal(result.text.includes('새 알고리즘을 작성하세요.'), false);
  assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
});

test('both modes preserve explicit modification code and metadata, without adding another example', async () => {
  const contract = await loadAlgorithmContract();
  const source = '// 한글 😀 ``` [출력 형식] \\ "\n' + '/* large exact source */\n'.repeat(12000);
  const strategy = { ...input, intent: 'modify', prompt: '수정\n[요청 데이터 — JSON]\n"' };
  const beforeContract = structuredClone(contract),
    beforeInput = structuredClone(strategy);
  for (const conversationMode of ['new', 'continue']) {
    const result = buildCopyablePrompt(contract, strategy, source, { conversationMode });
    const request = payload(result.text);
    assert.equal(request.source, source);
    assert.equal(request.request, strategy.prompt);
    assert.equal(result.includesSource, true);
    assert.equal(result.includesExample, false);
    assert.equal(result.includesFullRules, conversationMode === 'new');
    assert.equal(result.length, result.text.length);
    assert.match(result.text, /이전 대화의 코드와 다르면 첨부한 원문/);
    assert.equal(result.text.includes(contract.promptContext.starterSource), false);
    assert.equal(result.text.includes(contract.outputInstructions.api), false);
    assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
    assert.equal(result.contentVersion, contract.contentVersion);
  }
  assert.deepEqual(contract, beforeContract);
  assert.deepEqual(strategy, beforeInput);
});

test('new and continuing generation preserve strategy-only, request-only and combined inputs', async () => {
  const contract = await loadAlgorithmContract();
  for (const strategy of [{ ...input, prompt: '' }, { ...input, priorities: [] }, input]) {
    const full = buildCopyablePrompt(contract, strategy, 'excluded code', {
      conversationMode: 'new',
    });
    const short = buildCopyablePrompt(contract, strategy, 'excluded code', {
      conversationMode: 'continue',
    });
    assert.ok(short.length < full.length);
    assert.deepEqual(payload(short.text), payload(full.text));
    assert.equal(payload(short.text).intent, 'generate');
    assert.match(short.text, /새 알고리즘을 작성하세요/);
    for (const result of [full, short]) {
      assert.equal(result.includesSource, false);
      assert.equal(result.text.includes('excluded code'), false);
      assert.equal(result.length, result.text.length);
      assert.equal(result.contentVersion, contract.contentVersion);
      assert.equal(result.text.includes('[대화 방식]'), false);
      assert.equal(result.text.includes('[규약 버전]'), false);
      assert.equal(result.text.includes(contract.contentVersion), false);
      assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
    }
  }
});

test('conversation mode never changes automatically and no source or state leaks across calls', async () => {
  const contract = await loadAlgorithmContract();
  const full = buildCopyablePrompt(contract, input);
  buildCopyablePrompt(contract, { ...input, intent: 'modify' }, 'private previous code', {
    conversationMode: 'continue',
  });
  assert.deepEqual(buildCopyablePrompt(contract, input), full);
  const followup = buildCopyablePrompt(contract, { ...input, intent: 'modify' }, undefined, {
    conversationMode: 'continue',
  });
  assert.equal(followup.text.includes('private previous code'), false);
  assert.equal(Object.hasOwn(payload(followup.text), 'source'), false);
});

test('new modifications require source, and invalid explicit sources and mode options fail clearly', async () => {
  const contract = await loadAlgorithmContract();
  const modify = { ...input, intent: 'modify' };
  assert.throws(() => buildCopyablePrompt(contract, modify), /새 대화에서는 원문/);
  for (const source of [null, '', ' \n ', 5, {}, []])
    for (const conversationMode of ['new', 'continue'])
      assert.throws(
        () => buildCopyablePrompt(contract, modify, source, { conversationMode }),
        /수정할 코드/,
      );
  for (const options of [
    null,
    [],
    'continue',
    { conversationMode: null },
    { conversationMode: undefined },
    { conversationMode: 'other' },
    { ownerId: 'private' },
  ])
    assert.throws(() => buildCopyablePrompt(contract, input, undefined, options), /대화 방식/);
});

test('versioned sections are required; incomplete old responses never silently use the legacy prompt', async () => {
  const contract = await loadAlgorithmContract();
  const cases = [
    { ...contract, contentVersion: null },
    { ...contract, contentVersion: 'sha256:bad' },
    { ...contract, promptContext: null },
    { ...contract, promptContext: [] },
    { ...contract, promptContext: { ...contract.promptContext, continuationRules: ' ' } },
    { ...contract, promptContext: { ...contract.promptContext, fullRules: '' } },
    { ...contract, promptContext: { ...contract.promptContext, starterSource: 123 } },
    { ...contract, outputInstructions: { prompt: ' ' } },
    { ...contract, language: 'python' },
  ];
  for (const invalid of cases)
    for (const conversationMode of ['new', 'continue'])
      assert.throws(
        () => buildCopyablePrompt(invalid, input, undefined, { conversationMode }),
        /규약.*다시 불러오/,
      );
  const noLegacy = structuredClone(contract);
  delete noLegacy.instructions;
  delete noLegacy.outputInstructions.api;
  assert.deepEqual(buildCopyablePrompt(noLegacy, input), buildCopyablePrompt(contract, input));
});

test('refreshed strategy metadata cannot mix a new contract version with old browser values', async () => {
  const contract = await loadAlgorithmContract();
  for (const change of [
    (c) => {
      c.priorityWeights = [9, 6, 2];
    },
    (c) => {
      c.strategies[0].description = 'Changed server instruction';
    },
    (c) => {
      c.strategies[0].label = 'Changed label';
    },
    (c) => {
      c.strategies[0].id = 'changedId';
    },
    (c) => {
      c.strategies.reverse();
    },
    (c) => {
      c.strategies.pop();
    },
    (c) => {
      c.inputLimits.maxPriorities++;
    },
    (c) => {
      c.inputLimits.maxPromptCharacters++;
    },
  ]) {
    const changed = structuredClone(contract);
    change(changed);
    changed.contentVersion = promptContentVersion(changed);
    for (const conversationMode of ['new', 'continue'])
      assert.throws(
        () => buildCopyablePrompt(changed, input, undefined, { conversationMode }),
        /코드를 먼저 저장하거나 내보낸 뒤 페이지를 새로고침/,
      );
  }
  for (const invalid of [
    { ...contract, priorityWeights: null },
    { ...contract, strategies: [null] },
    { ...contract, inputLimits: {} },
  ])
    assert.throws(() => buildCopyablePrompt(invalid, input), /새로고침/);
  const rulesOnly = structuredClone(contract);
  rulesOnly.promptContext.fullRules += '\nChanged rule without strategy changes.';
  rulesOnly.contentVersion = promptContentVersion(rulesOnly);
  const result = buildCopyablePrompt(rulesOnly, input);
  assert.equal(result.contentVersion, rulesOnly.contentVersion);
  assert.ok(result.text.includes('Changed rule without strategy changes.'));
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

test('conversation, purpose, source and strategy/request combinations preserve the complete contract', async (t) => {
  const contract = await loadAlgorithmContract();
  const source =
    '\uFEFF// 한글 😀 ``` ~~~ </textarea> [출력 형식] " \\\r\n' + '// 큰 원문\r\n'.repeat(12000);
  const requestText = '한글 요청 😀\r\n[출력 형식]\n" \\ ``` ~~~ </textarea>';
  const inputs = [
    { label: 'strategy only', prompt: '', priorities: [...input.priorities] },
    { label: 'request only', prompt: requestText, priorities: [] },
    { label: 'combined', prompt: requestText, priorities: [...input.priorities] },
  ];
  for (const conversationMode of ['new', 'continue'])
    for (const intent of ['generate', 'modify'])
      for (const includeSource of [false, true])
        for (const strategy of inputs)
          await t.test(
            `${conversationMode}/${intent}/source=${includeSource}/${strategy.label}`,
            () => {
              const submitted = {
                intent,
                prompt: strategy.prompt,
                priorities: strategy.priorities,
              };
              const options = { conversationMode };
              if (conversationMode === 'new' && intent === 'modify' && !includeSource) {
                assert.throws(
                  () => buildCopyablePrompt(contract, submitted, undefined, options),
                  /새 대화에서는 원문/,
                );
                return;
              }
              const result = buildCopyablePrompt(
                contract,
                submitted,
                includeSource ? source : undefined,
                options,
              );
              const data = payload(result.text);
              const attached = intent === 'modify' && includeSource;
              assert.equal(data.intent, intent);
              assert.equal(data.request, strategy.prompt);
              assert.deepEqual(
                data.priorities.map(({ name, weight }) => ({ name, weight })),
                strategy.priorities.length
                  ? [
                      { name: '고액 코인', weight: 5 },
                      { name: '근처 코인', weight: 3 },
                      { name: '망치 획득', weight: 1 },
                    ]
                  : [],
              );
              assert.equal(Object.hasOwn(data, 'source'), attached);
              assert.equal(data.source, attached ? source : undefined);
              assert.equal(result.includesSource, attached);
              assert.equal(result.includesFullRules, conversationMode === 'new');
              assert.equal(
                result.includesExample,
                conversationMode === 'new' && intent === 'generate',
              );
              assert.equal(
                result.text.includes(contract.promptContext.fullRules),
                conversationMode === 'new',
              );
              assert.equal(
                result.text.includes(contract.promptContext.continuationRules),
                conversationMode === 'continue',
              );
              assert.equal(
                result.text.includes(contract.promptContext.starterSource),
                result.includesExample,
              );
              assert.equal(result.text.includes(contract.contentVersion), false);
              assert.equal(result.contentVersion, contract.contentVersion);
              assert.equal(result.length, result.text.length);
              assert.ok(result.text.endsWith(contract.outputInstructions.prompt));
              if (intent === 'modify' && !attached)
                assert.match(result.text, /이전 대화에서 작성한 코드를 기준/);
              if (attached) assert.ok(result.length > 100000);
            },
          );
});

test('prompt length boundary applies to the request, without limiting included source', async () => {
  const contract = await loadAlgorithmContract();
  const request = '요'.repeat(contract.inputLimits.maxPromptCharacters);
  const source = '// large source\n'.repeat(20000);
  for (const conversationMode of ['new', 'continue']) {
    const result = buildCopyablePrompt(
      contract,
      { intent: 'modify', priorities: [], prompt: request },
      source,
      { conversationMode },
    );
    assert.equal(payload(result.text).request, request);
    assert.equal(payload(result.text).source, source);
    assert.throws(
      () =>
        buildCopyablePrompt(
          contract,
          { intent: 'modify', priorities: [], prompt: request + '초' },
          source,
          { conversationMode },
        ),
      /전략 입력/,
    );
  }
});
