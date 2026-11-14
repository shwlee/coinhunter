import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadAlgorithmContract,
  promptContentVersion,
} from '../src/algorithm-assistant/contract.js';
import { TURN_LIMIT_MS, ALGORITHM_MEMORY_LIMIT_BYTES } from '../src/runtime/policy.js';
import { validateAlgorithm } from '../src/runtime/preflight.js';
import { AlgorithmSandbox } from '../src/runtime/sandbox.js';
import { DEFAULT_MAP_SETTINGS, validateMap } from '../src/game/maps.js';
import { GameState } from '../src/game/state.js';
import { buildCopyablePrompt, validatePromptContract } from '../public/prompt-builder.js';

test('authoring sections separate full rules, a short continuation reminder and a runnable skeleton', async () => {
  const contract = await loadAlgorithmContract();
  const { fullRules, continuationRules, starterSource } = contract.promptContext;
  const template = await readFile(
    new URL('../docs/algorithm-authoring-rules.md', import.meta.url),
    'utf8',
  );
  assert.equal(
    fullRules,
    template
      .replace(/\r\n?/g, '\n')
      .trim()
      .replaceAll('{{TURN_LIMIT_MS}}', String(TURN_LIMIT_MS))
      .replaceAll('{{MEMORY_LIMIT_MIB}}', String(ALGORITHM_MEMORY_LIMIT_BYTES / (1024 * 1024))),
  );
  for (const text of [fullRules, continuationRules]) {
    assert.ok(text.includes(`${TURN_LIMIT_MS}ms`));
    assert.ok(text.includes(`${ALGORITHM_MEMORY_LIMIT_BYTES / (1024 * 1024)}MiB`));
    for (const method of ['initialize', 'getName', 'moveNext']) assert.ok(text.includes(method));
    for (const keyword of [
      'myPosition',
      'import',
      'async',
      'generator',
      'static',
      'eval',
      'Function',
    ])
      assert.ok(text.includes(keyword), keyword);
    assert.equal(/\{\{[A-Z_]+\}\}/.test(text), false);
    assert.equal(text.includes(contract.outputInstructions.api), false);
  }
  assert.ok(continuationRules.includes('앞서 전달한'));
  assert.ok(continuationRules.length < fullRules.length);
  assert.ok(fullRules.length + starterSource.length < contract.instructions.length);
  assert.equal(continuationRules.includes(starterSource), false);
  assert.equal(
    fullRules.includes(starterSource),
    false,
    'The example is optional, not embedded in rules',
  );
  assert.match(fullRules, /getName은 문자열/);
  assert.match(fullRules, /myNumber는 0~3의 고정 식별 번호이며 시작 모서리가 아니다/);
  assert.match(fullRules, /사본.*수정해도 게임판은 바뀌지 않는다/);
  assert.match(fullRules, /한 번만 획득/);
  assert.match(fullRules, /자신의 효과 잔량.*인자로 제공되지 않는다/);
  assert.match(fullRules, /알고리즘 계산 시간은 빨라지지 않는다/);
  assert.match(fullRules, /그 턴에 벽 칸으로 진입하지 않고/);
  assert.match(fullRules, /효과 중 moveNext를 호출하지 않고/);
  assert.match(fullRules, /다음 턴까지 추가 소모하지 않는다/);
  assert.match(fullRules, /지속 턴·파괴 벽 수·코인 수는 관리자 설정/);
  assert.match(fullRules, /시작 전 한 번/);
  assert.match(fullRules, /같은 인스턴스는 경기 종료까지 유지/);
});

test('content versions are deterministic across loads, line endings and irrelevant transport fields', async () => {
  const contract = await loadAlgorithmContract();
  assert.match(contract.contentVersion, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.contentVersion, promptContentVersion(contract));
  assert.equal(contract.contentVersion, (await loadAlgorithmContract()).contentVersion);
  const equivalent = structuredClone(contract);
  for (const key of Object.keys(equivalent.promptContext))
    equivalent.promptContext[key] =
      '\r\n' + equivalent.promptContext[key].replaceAll('\n', '\r\n') + '\r\n';
  equivalent.outputInstructions.prompt += '\r\n';
  equivalent.schemaVersion = 99;
  equivalent.instructions = 'Legacy text is not the new authoring contract.';
  equivalent.outputInstructions.api = 'Legacy API transport is not the copy format.';
  equivalent.contentVersion = 'an old digest';
  equivalent.ownerId = 'not part of the contract';
  equivalent.createdAt = new Date().toISOString();
  assert.equal(promptContentVersion(equivalent), contract.contentVersion);
});

test('each effective authoring change invalidates the version and returned objects are detached', async () => {
  const original = await loadAlgorithmContract();
  for (const change of [
    (c) => {
      c.promptContext.fullRules += '\nChanged rule.';
    },
    (c) => {
      c.promptContext.continuationRules += ' Changed reminder.';
    },
    (c) => {
      c.promptContext.starterSource += '\n// changed skeleton';
    },
    (c) => {
      c.outputInstructions.prompt += ' Changed output.';
    },
    (c) => {
      c.limits.turnMs++;
    },
    (c) => {
      c.limits.memoryBytes++;
    },
    (c) => {
      c.inputLimits.maxPriorities++;
    },
    (c) => {
      c.inputLimits.maxPromptCharacters++;
    },
    (c) => {
      c.language = 'another-language';
    },
    (c) => {
      c.strategies[0].description += ' changed';
    },
    (c) => {
      c.priorityWeights.reverse();
    },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    assert.notEqual(promptContentVersion(changed), original.contentVersion);
  }
  original.promptContext.fullRules = 'changed';
  original.limits.turnMs = -1;
  const next = await loadAlgorithmContract();
  assert.notEqual(next.promptContext.fullRules, 'changed');
  assert.equal(next.limits.turnMs, TURN_LIMIT_MS);
  assert.equal(next.contentVersion, promptContentVersion(next));
});

test('minimal starter passes the real preflight and returns a valid explicit penalty', async () => {
  const { promptContext } = await loadAlgorithmContract();
  const { starterSource } = promptContext;
  assert.deepEqual(await validateAlgorithm(starterSource, 'prompt-contract-starter'), {
    ok: true,
    calls: 24,
  });
  const sandbox = await AlgorithmSandbox.create(starterSource, 3, 20, 16);
  try {
    assert.equal(typeof sandbox.name, 'string');
    assert.ok(sandbox.name.length > 0);
    const result = sandbox.invoke('moveNext', [Array(320).fill(0), 319, [-1, -1, -1, -1]]);
    assert.equal(result.status, 'ok');
    assert.equal(result.value, -1);
  } finally {
    sandbox.dispose();
  }
});

test('documented tile values, directions, item order and configurable duration match the actual engine', async () => {
  const {
    promptContext: { fullRules },
  } = await loadAlgorithmContract();
  assert.match(fullRules, /10\/30\/100\/200\/500/);
  assert.match(fullRules, /0 왼쪽, 1 위, 2 오른쪽, 3 아래/);
  assert.match(fullRules, /순서는 신발·망치·x2·랜덤점프/);
  const map = {
    columns: 6,
    rows: 6,
    tiles: Array(36).fill(0),
    settings: { ...DEFAULT_MAP_SETTINGS, itemDuration: 7 },
  };
  map.tiles[14] = 100;
  const game = new GameState(map, ['test']);
  assert.deepEqual(
    [0, 1, 2, 3].map((d) => game.neighbor(14, d)),
    [13, 8, 15, 20],
  );
  assert.equal(game.neighbor(6, 0), -1);
  assert.equal(game.neighbor(11, 2), -1);
  for (const tile of [-1, 0, 10, 30, 100, 200, 500]) {
    const candidate = structuredClone(map);
    candidate.tiles[7] = tile;
    assert.doesNotThrow(() => validateMap(candidate));
  }
  for (let item = 0; item < 4; item++) {
    const state = new GameState(map, ['test']);
    state.start(0);
    state.players[0].position = 7;
    state.items[item] = 8;
    state.beginAction(0, { status: 'ok', value: 2 }, 0);
    state.completeAction(0, map.settings.actionMs);
    assert.equal(state.items[item], -1);
    assert.equal(state.players[0].effect.type, item);
    assert.equal(state.players[0].effect.remaining, 7);
  }
});

test('additive sections preserve the old schema and exact existing copy behaviour for stage one', async () => {
  const contract = await loadAlgorithmContract();
  assert.equal(contract.schemaVersion, 1);
  assert.doesNotThrow(() => validatePromptContract(contract));
  const legacy = structuredClone(contract);
  delete legacy.promptContext;
  delete legacy.contentVersion;
  const strategy = { intent: 'generate', prompt: '', priorities: ['nearestCoin'] };
  assert.deepEqual(buildCopyablePrompt(contract, strategy), buildCopyablePrompt(legacy, strategy));
});
