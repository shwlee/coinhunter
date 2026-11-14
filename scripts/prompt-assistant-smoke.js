import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { promptContentVersion } from '../src/algorithm-assistant/contract.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-prompt-browser-'));
const { server, close } = createGameServer({
  authoring: createAuthoring({
    accounts: new FileAccountRepository(join(dir, 'accounts.json')),
    authConfig: { mode: 'mock' },
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const parseRequest = (text) =>
  JSON.parse(
    text.slice(
      text.indexOf('[요청 데이터 — JSON]\n') + '[요청 데이터 — JSON]\n'.length,
      text.lastIndexOf('\n\n[출력 형식]\n'),
    ),
  );
const wait = async (page, predicate) => {
  const end = Date.now() + 8000;
  while (!(await page.evaluate(predicate))) {
    if (Date.now() > end) throw new Error('Prompt UI did not settle');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__copyMode = 'success';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          const mode = window.__copyMode;
          if (window.__copyMode === 'deny')
            throw new DOMException('fixture denial', 'NotAllowedError');
          window.__copiedText = text;
          if (mode === 'wait' || mode === 'wait-deny')
            await new Promise((resolve) => {
              window.__releaseCopy = resolve;
            });
          if (mode === 'wait-deny') throw new DOMException('delayed denial', 'NotAllowedError');
        },
      },
    });
  });
  assert.equal(
    (
      await context.request.post(base + '/api/auth/mock', {
        data: { email: 'developer@company.test' },
      })
    ).status(),
    200,
  );
  const page = await context.newPage();
  const errors = [],
    aiRequests = [],
    sourceRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/ai/')) aiRequests.push(path);
    if (request.method() !== 'GET') sourceRequests.push(path);
  });
  let failedContract = true,
    contractRevision = 0,
    incompatibleStrategy = '',
    incompleteContract = false,
    contractGate = null;
  await page.route('**/api/algorithm-assistant/contract', async (route) => {
    if (contractGate) await contractGate;
    if (failedContract)
      return route.fulfill({
        status: failedContract === 'expired' ? 401 : 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: failedContract === 'expired' ? '다시 로그인하세요.' : '테스트 규약 로딩 실패',
        }),
      });
    const response = await route.fetch();
    const body = await response.json();
    if (contractRevision) {
      body.promptContext.fullRules += '\n테스트 규약 변경 ' + contractRevision;
      body.contentVersion = promptContentVersion(body);
    }
    if (incompatibleStrategy) {
      if (incompatibleStrategy === 'weights') body.priorityWeights = [9, 6, 2];
      if (incompatibleStrategy === 'description') body.strategies[0].description += ' updated';
      if (incompatibleStrategy === 'label') body.strategies[0].label += ' updated';
      if (incompatibleStrategy === 'id') body.strategies[0].id = 'updatedId';
      if (incompatibleStrategy === 'limits') body.inputLimits.maxPriorities = 2;
      body.contentVersion = promptContentVersion(body);
    }
    if (incompleteContract) delete body.promptContext;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.goto(base + '/editor');
  await page.locator('#retry-prompt-contract').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').isVisible(), true);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-include-source').isDisabled(), true);
  const blank = await page.locator('#code').inputValue();
  failedContract = 'expired';
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#prompt-contract-status').filter({ hasText: '다시 로그인' }).waitFor();
  assert.equal(await page.locator('#code').inputValue(), blank);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  failedContract = false;
  await page.locator('#retry-prompt-contract').click();
  await wait(page, () => document.getElementById('prompt-contract-status').textContent === '');
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-mode-new').isChecked(), true);
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'generate');
  // All UI-reachable combinations, including the three blocked new modifications.
  const matrixFile =
    '// 한글 😀 ``` ~~~ </textarea> [출력 형식] " \\\r\n' + '// 큰 원문\r\n'.repeat(16000);
  const matrixRequest = '추가 요청 😀\n" \\ ``` [출력 형식] </textarea>';
  await page.locator('#load-mode').click();
  await page.locator('#import').setInputFiles({
    name: 'matrix-source.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from(matrixFile),
  });
  await page.locator('#document-origin').filter({ hasText: 'matrix-source.js' }).waitFor();
  const matrixSource = await page.locator('#code').inputValue();
  assert.ok(matrixSource.length > 100000);
  let matrixCases = 0;
  for (const mode of ['new', 'continue'])
    for (const intent of ['generate', 'modify'])
      for (const included of intent === 'modify' ? [false, true] : [false])
        for (const kind of ['strategy', 'request', 'combined']) {
          matrixCases++;
          await page.locator('#prompt-purpose').selectOption(intent);
          await page.locator('#prompt-mode-' + mode).check();
          const template = page.locator('[name="strategy-template"][value="nearestCoin"]');
          await template.setChecked(kind !== 'request');
          await page.locator('#prompt').fill(kind === 'strategy' ? '' : matrixRequest);
          if (intent === 'modify')
            await page.locator('#prompt-include-source').setChecked(included);
          else assert.equal(await page.locator('#prompt-include-source').isDisabled(), true);
          const before = await page.locator('#prompt-preview-text').inputValue();
          if (mode === 'new' && intent === 'modify' && !included) {
            assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
            assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
            assert.match(await page.locator('#prompt-summary').textContent(), /현재 코드 포함/);
            assert.equal(await page.locator('#prompt-preview-text').inputValue(), before);
            continue;
          }
          await page.locator('#generate-prompt:enabled').click();
          const text = await page.locator('#prompt-preview-text').inputValue();
          const data = parseRequest(text);
          assert.equal(data.intent, intent);
          assert.equal(data.request, kind === 'strategy' ? '' : matrixRequest);
          assert.deepEqual(
            data.priorities.map(({ name, weight }) => ({ name, weight })),
            kind === 'request' ? [] : [{ name: '근처 코인', weight: 5 }],
          );
          assert.equal(Object.hasOwn(data, 'source'), included);
          assert.ok(
            data.source === (included ? matrixSource : undefined),
            'Only the explicitly included editor snapshot is copied',
          );
          assert.equal(text.includes('[게임 규약]\n'), mode === 'new');
          assert.equal(
            text.includes('[필수 메서드 골격]'),
            mode === 'new' && intent === 'generate',
          );
          assert.equal(text.includes('[규약 버전]'), false);
          assert.equal(text.includes('[대화 방식]'), false);
          assert.ok(
            (await page.locator('#prompt-summary').textContent()).includes(
              text.length.toLocaleString('ko-KR') + '자',
            ),
          );
          assert.equal(await page.locator('#prompt-size-note').isVisible(), included);
          await page.locator('#copy-prompt:enabled').click();
          await page.locator('#prompt-copy-status[data-state="copied"]').waitFor();
          assert.equal(await page.evaluate(() => window.__copiedText), text);
          assert.ok(
            (await page.locator('#code').inputValue()) === matrixSource,
            'Prompt actions never alter the editor',
          );
        }
  assert.equal(matrixCases, 18);
  await page.locator('#new').click();
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  await page.locator('[name="strategy-template"][value="nearestCoin"]').check();
  assert.equal(await page.locator('#generate-prompt').isEnabled(), true);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  await page.locator('#generate-prompt').click();
  let strategyOnly = await page.locator('#prompt-preview-text').inputValue();
  assert.equal(parseRequest(strategyOnly).request, '');
  assert.equal(parseRequest(strategyOnly).priorities[0].name, '근처 코인');
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  await page.locator('#prompt-mode-continue').check();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), strategyOnly);
  assert.equal(await page.locator('#code').inputValue(), blank);
  await page.locator('#generate-prompt').click();
  assert.equal(
    parseRequest(await page.locator('#prompt-preview-text').inputValue()).intent,
    'generate',
  );
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'generate');
  await page.locator('#prompt-purpose').selectOption('modify');
  await page.locator('#generate-prompt').click();
  const continuation = await page.locator('#prompt-preview-text').inputValue();
  assert.ok(continuation.length < strategyOnly.length);
  assert.equal(parseRequest(continuation).intent, 'modify');
  assert.equal(Object.hasOwn(parseRequest(continuation), 'source'), false);
  assert.match(continuation, /이전 대화에서 작성한 코드를 기준/);
  assert.equal(continuation.includes('[게임 규약]\n'), false);
  assert.equal(continuation.includes('[필수 메서드 골격]'), false);
  assert.match(
    await page.locator('#prompt-summary').textContent(),
    /후속 요청.*규약 요약.*이전 대화 코드 사용/,
  );
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  await page.locator('#copy-prompt').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  assert.equal(await page.locator('#prompt-mode-continue').isChecked(), true);
  assert.equal(await page.evaluate(() => window.__copiedText), continuation);
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#retry-prompt-contract:enabled').waitFor();
  assert.equal(await page.locator('#prompt-mode-continue').isChecked(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), continuation);
  assert.equal(
    await page.locator('#copy-prompt').isEnabled(),
    true,
    'An unchanged rules reload keeps the snapshot usable',
  );
  for (const copyMode of ['wait', 'wait-deny']) {
    await page.evaluate((mode) => {
      window.__copyMode = mode;
      window.__releaseCopy = null;
    }, copyMode);
    await page.locator('#copy-prompt').click();
    await wait(page, () => !!window.__releaseCopy);
    let releaseContract;
    contractGate = new Promise((resolve) => {
      releaseContract = resolve;
    });
    try {
      await page.locator('#retry-prompt-contract').click();
      assert.equal(await page.locator('#retry-prompt-contract').isDisabled(), true);
      await page.evaluate(() => window.__releaseCopy());
      await wait(
        page,
        () => document.getElementById('copy-prompt').getAttribute('aria-busy') === 'false',
      );
      assert.notEqual(
        await page.locator('#prompt-copy-status').getAttribute('data-state'),
        'copied',
      );
      assert.match(
        await page.locator('#prompt-copy-status').textContent(),
        /규약.*확인.*다시 복사/,
      );
      assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
      assert.equal(await page.locator('#select-prompt').isDisabled(), true);
      assert.equal(await page.locator('#prompt-preview-text').inputValue(), continuation);
    } finally {
      contractGate = null;
      releaseContract();
      await page.locator('#retry-prompt-contract:enabled').waitFor();
    }
    assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  }
  await page.evaluate(() => {
    window.__copyMode = 'success';
  });
  await page.locator('#prompt-mode-continue').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('#prompt-mode-new').isChecked(), true);
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'modify');
  assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
  assert.match(await page.locator('#prompt-summary').textContent(), /현재 코드 포함/);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#prompt-mode-continue').isChecked(), true);
  await page.evaluate(() => {
    window.__copyMode = 'wait';
    window.__releaseCopy = null;
  });
  await page.locator('#copy-prompt:enabled').click();
  await wait(page, () => !!window.__releaseCopy);
  contractRevision++;
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#retry-prompt-contract:enabled').waitFor();
  assert.equal(await page.locator('#prompt-mode-new').isChecked(), true);
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'modify');
  assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
  assert.match(await page.locator('#prompt-summary').textContent(), /현재 코드 포함/);
  assert.match(await page.locator('#prompt-context-notice').textContent(), /규약이 변경/);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), continuation);
  assert.equal(await page.locator('#code').inputValue(), blank);
  await page.evaluate(() => window.__releaseCopy());
  await page.locator('#prompt-copy-status').filter({ hasText: '입력이 변경' }).waitFor();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  await page.evaluate(() => {
    window.__copyMode = 'success';
  });
  // Only an explicit purpose change can turn the blocked modification into generation.
  await page.locator('#prompt-purpose').selectOption('generate');
  await page.locator('#generate-prompt').click();
  strategyOnly = await page.locator('#prompt-preview-text').inputValue();
  assert.ok(strategyOnly.includes('테스트 규약 변경 1'));
  assert.equal(parseRequest(strategyOnly).intent, 'generate');
  // Authentication/shape failures must not leave a previously valid snapshot copyable.
  failedContract = 'expired';
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#retry-prompt-contract:enabled').waitFor();
  assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), strategyOnly);
  failedContract = false;
  incompleteContract = true;
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#retry-prompt-contract:enabled').waitFor();
  assert.match(await page.locator('#prompt-contract-status').textContent(), /규약 형식/);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  incompleteContract = false;
  await page.locator('#retry-prompt-contract').click();
  await page.locator('#retry-prompt-contract:enabled').waitFor();
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  const checkIncompatibleStrategy = async (changed) => {
    const previousPreview = await page.locator('#prompt-preview-text').inputValue();
    const previousCode = await page.locator('#code').inputValue();
    incompatibleStrategy = changed;
    await page.locator('#retry-prompt-contract').click();
    await page.locator('#retry-prompt-contract:enabled').waitFor();
    assert.match(
      await page.locator('#prompt-contract-status').textContent(),
      /저장하거나 내보낸 뒤 페이지를 새로고침/,
    );
    assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
    assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
    assert.equal(await page.locator('#select-prompt').isDisabled(), true);
    assert.equal(await page.locator('#prompt-preview-text').inputValue(), previousPreview);
    assert.equal(await page.locator('#code').inputValue(), previousCode);
    incompatibleStrategy = '';
    await page.locator('#retry-prompt-contract').click();
    await page.locator('#retry-prompt-contract:enabled').waitFor();
    assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  };
  for (const changed of ['weights', 'description', 'label', 'id', 'limits'])
    await checkIncompatibleStrategy(changed);
  await page.locator('[name="strategy-template"][value="valuableCoin"]').check();
  await page.getByRole('button', { name: '고액 코인 우선순위 올리기' }).click();
  await page.locator('#prompt').fill('코인 요청 <img src=x onerror=alert(1)>');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), strategyOnly);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#select-prompt').isDisabled(), true);
  assert.match(await page.locator('#prompt-summary').textContent(), /다시 생성/);
  await page.locator('#generate-prompt').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  let copied = await page.evaluate(() => window.__copiedText);
  assert.equal(copied, await page.locator('#prompt-preview-text').inputValue());
  assert.equal(await page.locator('#copy-prompt-label').textContent(), '복사 완료');
  assert.equal(await page.locator('#prompt-preview #copy-prompt').count(), 1);
  let request = parseRequest(copied);
  assert.equal(request.intent, 'generate');
  assert.equal(Object.hasOwn(request, 'source'), false);
  assert.deepEqual(
    request.priorities.map((entry) => entry.name),
    ['고액 코인', '근처 코인'],
  );
  assert.deepEqual(
    request.priorities.map((entry) => entry.weight),
    [5, 3],
  );
  assert.equal(copied.includes('developer@company.test'), false);
  assert.equal(copied.includes('Return JSON with source'), false);
  assert.equal(await page.locator('#prompt-preview-text').isVisible(), true);
  const code =
    (await readFile(new URL('../examples/nearest-coin.js', import.meta.url), 'utf8')) +
    '\n// source-ONLY-MARKER';
  await page.locator('#code-editor .cm-content').fill(code);
  assert.equal(await page.locator('#prompt-include-source').isDisabled(), true);
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.__copiedText)).includes('source-ONLY-MARKER'),
    false,
  );
  await page.locator('#prompt-mode-continue').check();
  await page.locator('#prompt-purpose').selectOption('modify');
  await page.locator('#generate-prompt').click();
  const omittedSource = await page.locator('#prompt-preview-text').inputValue();
  assert.equal(parseRequest(omittedSource).intent, 'modify');
  assert.equal(Object.hasOwn(parseRequest(omittedSource), 'source'), false);
  await page.locator('#code-editor .cm-content').fill(code + '\n// locally edited but excluded');
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), omittedSource);
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  assert.match(await page.locator('#prompt-source-help').textContent(), /코드를 바꿨다면/);
  await page.locator('#code-editor .cm-content').fill(code);
  await page.locator('#prompt-include-source').check();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  await page.locator('#generate-prompt').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  request = parseRequest(await page.evaluate(() => window.__copiedText));
  assert.equal(request.intent, 'modify');
  assert.equal(request.source, code);
  assert.equal(await page.locator('#prompt-mode-continue').isChecked(), true);
  assert.equal(await page.locator('#code').inputValue(), code);
  await checkIncompatibleStrategy('weights');
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'modify');
  assert.equal(await page.locator('#prompt-include-source').isChecked(), true);
  await page.locator('#code-editor .cm-content').fill(code + '\n// latest-code');
  await page.locator('#prompt').fill('최신 요청');
  assert.equal(
    parseRequest(await page.locator('#prompt-preview-text').inputValue()).request,
    '코인 요청 <img src=x onerror=alert(1)>',
  );
  await page.locator('#generate-prompt').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  request = parseRequest(await page.evaluate(() => window.__copiedText));
  assert.equal(request.source, code + '\n// latest-code');
  assert.equal(request.request, '최신 요청');
  await page.evaluate(() => {
    window.__copyMode = 'deny';
  });
  await page.locator('#copy-prompt').click();
  await page
    .locator('#prompt-copy-status')
    .filter({ hasText: '자동 복사를 사용할 수 없습니다' })
    .waitFor();
  assert.equal(await page.locator('#prompt-preview-text').getAttribute('readonly'), '');
  assert.equal(await page.locator('#prompt-preview-text').isVisible(), true);
  assert.equal(
    await page
      .locator('#prompt-preview-text')
      .evaluate((node) => node.selectionEnd - node.selectionStart === node.value.length),
    true,
  );
  await page.locator('#prompt').fill('수동 복사도 최신 요청');
  assert.equal(await page.locator('#select-prompt').isDisabled(), true);
  await page.locator('#generate-prompt').click();
  await page.locator('#select-prompt:enabled').click();
  assert.equal(
    parseRequest(await page.locator('#prompt-preview-text').inputValue()).request,
    '수동 복사도 최신 요청',
  );
  await page.evaluate(() => {
    window.__copyMode = 'wait';
    window.__releaseCopy = null;
  });
  await page.locator('#copy-prompt').click();
  await wait(page, () => !!window.__releaseCopy);
  const beforeModeChange = await page.locator('#prompt-preview-text').inputValue();
  await page.locator('#prompt-mode-new').check();
  await page.evaluate(() => window.__releaseCopy());
  await page.locator('#prompt-copy-status').filter({ hasText: '입력이 변경' }).waitFor();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), beforeModeChange);
  await page.locator('#prompt-mode-continue').check();
  await page.locator('#generate-prompt').click();
  await page.evaluate(() => {
    window.__copyMode = 'wait';
    window.__releaseCopy = null;
  });
  await page.locator('#copy-prompt').click();
  await wait(page, () => !!window.__releaseCopy);
  await page.locator('#prompt').fill('복사 대기 중 변경');
  await page.evaluate(() => window.__releaseCopy());
  await page.locator('#prompt-copy-status').filter({ hasText: '입력이 변경' }).waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
  );
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(
    parseRequest(await page.locator('#prompt-preview-text').inputValue()).request,
    '수동 복사도 최신 요청',
  );
  await page.locator('#generate-prompt').click();
  await page.locator('#copy-prompt:enabled').click();
  await page
    .locator('#prompt-copy-status')
    .filter({ hasText: '자동 복사를 사용할 수 없습니다' })
    .waitFor();
  assert.equal(
    parseRequest(await page.locator('#prompt-preview-text').inputValue()).request,
    '복사 대기 중 변경',
  );
  await mkdir('artifacts', { recursive: true });
  const checkGenerationLayout = async () => {
    await page.locator('#generate-prompt').scrollIntoViewIfNeeded();
    assert.equal(
      await page.locator('#prompt-conversation-mode').evaluate((mode) => {
        const choice = mode.getBoundingClientRect();
        const button = document.getElementById('generate-prompt').getBoundingClientRect();
        return (
          choice.top >= 0 &&
          choice.bottom <= button.top &&
          button.top - choice.bottom < 48 &&
          button.bottom <= innerHeight
        );
      }),
      true,
      'Mode choices stay directly above the generation button in the viewport',
    );
  };
  await checkGenerationLayout();
  await page.screenshot({ path: 'artifacts/prompt-assistant-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkGenerationLayout();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page.locator('#copy-prompt').evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const preview = document.getElementById('prompt-preview').getBoundingClientRect();
      return bounds.left >= preview.left && bounds.right <= preview.right;
    }),
    true,
  );
  await page.locator('#select-prompt').click();
  assert.equal(
    await page
      .locator('#prompt-preview-text')
      .evaluate((node) => node.selectionEnd === node.value.length),
    true,
  );
  await page.screenshot({ path: 'artifacts/prompt-assistant-mobile.png', fullPage: true });
  await page.locator('[name="strategy-template"][value="valuableCoin"]').uncheck();
  await page.locator('[name="strategy-template"][value="hammer"]').check();
  await page.locator('[name="strategy-template"][value="avoidHammer"]').check();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#generate-prompt').isDisabled(), true);
  assert.match(await page.locator('#prompt-summary').textContent(), /획득과 회피/);
  await page.locator('[name="strategy-template"][value="avoidHammer"]').uncheck();
  await page.locator('#prompt-mode-continue').check();
  await page.locator('#generate-prompt').click();
  await page.evaluate(() => {
    window.__releaseCopy = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise((resolve) => {
            window.__releaseCopy = resolve;
          }),
      },
    });
  });
  await page.locator('#copy-prompt:enabled').click();
  await wait(page, () => !!window.__releaseCopy);
  page.once('dialog', (dialog) => dialog.accept('버리기'));
  await page.locator('#new').click();
  await page.evaluate(async () => {
    window.__releaseCopy();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(await page.locator('#code').inputValue(), blank);
  assert.equal(await page.locator('#prompt-mode-new').isChecked(), true);
  assert.equal(await page.locator('#prompt-purpose').inputValue(), 'generate');
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  assert.equal(await page.locator('#prompt-include-source').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').isVisible(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-copy-status').textContent(), '');
  await page.locator('#prompt-mode-continue').check();
  await page.locator('#load-mode').click();
  await page
    .locator('#import')
    .setInputFiles({ name: 'external.js', mimeType: 'text/javascript', buffer: Buffer.from(code) });
  await page.locator('#document-origin').filter({ hasText: 'external.js' }).waitFor();
  assert.equal(await page.locator('#code').inputValue(), code);
  assert.equal(await page.locator('#prompt-mode-new').isChecked(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  assert.deepEqual(aiRequests, []);
  assert.deepEqual(
    sourceRequests,
    [],
    'Copying a prompt must never upload source or create AI work',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Prompt assistant smoke passed: 18 UI combinations, large exact source, explicit generation/copy, mode/version/clipboard races, failures/recovery, document resets and desktop/mobile layout. Clipboard writes were replaced.',
  );
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
