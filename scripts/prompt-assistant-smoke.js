import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { readAiConfig } from '../src/ai/config.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-prompt-browser-'));
const { server, close } = createGameServer({
  authoring: createAuthoring({
    accounts: new FileAccountRepository(join(dir, 'accounts.json')),
    authConfig: { mode: 'mock' },
    aiConfig: readAiConfig({ AI_ENABLED: 'false' }),
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
          if (window.__copyMode === 'deny')
            throw new DOMException('fixture denial', 'NotAllowedError');
          window.__copiedText = text;
          if (window.__copyMode === 'wait')
            await new Promise((resolve) => {
              window.__releaseCopy = resolve;
            });
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
  let failedContract = true;
  await page.route('**/api/algorithm-assistant/contract', (route) =>
    failedContract
      ? route.fulfill({
          status: failedContract === 'expired' ? 401 : 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: failedContract === 'expired' ? '다시 로그인하세요.' : '테스트 규약 로딩 실패',
          }),
        })
      : route.continue(),
  );
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
  await page.locator('[name="strategy-template"][value="nearestCoin"]').check();
  assert.equal(await page.locator('#generate-prompt').isEnabled(), true);
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  await page.locator('#generate-prompt').click();
  const strategyOnly = await page.locator('#prompt-preview-text').inputValue();
  assert.equal(parseRequest(strategyOnly).request, '');
  assert.equal(parseRequest(strategyOnly).priorities[0].name, '근처 코인');
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
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
  await page.locator('#prompt-include-source:enabled').waitFor();
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.__copiedText)).includes('source-ONLY-MARKER'),
    false,
  );
  await page.locator('#prompt-include-source').check();
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  await page.locator('#generate-prompt').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  request = parseRequest(await page.evaluate(() => window.__copiedText));
  assert.equal(request.intent, 'modify');
  assert.equal(request.source, code);
  assert.equal(await page.locator('#code').inputValue(), code);
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
  await page.screenshot({ path: 'artifacts/prompt-assistant-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
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
  assert.equal(await page.locator('#prompt-include-source').isChecked(), false);
  assert.equal(await page.locator('#prompt-include-source').isDisabled(), true);
  assert.equal(await page.locator('#prompt-preview-text').isVisible(), true);
  assert.equal(await page.locator('#prompt-preview-text').inputValue(), '');
  assert.equal(await page.locator('#copy-prompt').isDisabled(), true);
  assert.equal(await page.locator('#prompt-copy-status').textContent(), '');
  assert.deepEqual(aiRequests, []);
  assert.deepEqual(
    sourceRequests,
    [],
    'Copying a prompt must never upload source or create AI work',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Prompt assistant smoke passed: explicit generation, stable visible preview, strategy-only, stale input guards, code opt-in, clipboard fallback, delayed copy, mobile and reset. Clipboard writes were replaced.',
  );
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
