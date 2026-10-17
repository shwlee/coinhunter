import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { readAiConfig } from '../src/ai/config.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-code-import-'));
const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
const uploads = join(dir, 'uploads');
const { server, close } = createGameServer({
  uploadDirectory: uploads,
  authoring: createAuthoring({
    accounts,
    authConfig: { mode: 'mock' },
    aiConfig: readAiConfig({ AI_ENABLED: 'false' }),
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const poll = async (check) => {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Code import state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 20));
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
  const login = await context.request.post(base + '/api/auth/mock', {
    data: { email: 'developer@company.test' },
  });
  const { user } = await login.json();
  const original = await readFile(new URL('../examples/nearest-coin.js', import.meta.url), 'utf8');
  const saved = await accounts.save(user.id, null, { name: '가져오기 원본', source: original });
  const candidate = original + '\n// 가져온 알고리즘';
  const page = await context.newPage();
  const errors = [],
    aiRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/ai/')) aiRequests.push(request.url());
  });
  let validationCalls = 0,
    gate = null,
    responseMode = null;
  await page.route('**/api/algorithms/validate', async (route) => {
    validationCalls++;
    const held = gate,
      mode = responseMode;
    if (held) {
      await held;
      await route
        .fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
        .catch(() => {});
    } else if (mode)
      await route.fulfill({
        status: mode === 'expired' ? 401 : 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            mode === 'expired'
              ? '다시 로그인하세요.'
              : '코드 검사가 진행 중입니다. 다시 검사하세요.',
        }),
      });
    else await route.continue();
  });
  await page.goto(base + '/editor?algorithmId=' + saved.id);
  await page.locator('#document-title').filter({ hasText: '가져오기 원본' }).waitFor();
  const open = async () => {
    await page.locator('#open-code-import:enabled').click();
    await page.locator('#code-import-dialog[open]').waitFor();
  };
  const fill = (source) => page.locator('#imported-code').fill(source);
  const check = async (success) => {
    await page.locator('#check-imported-code:enabled').click();
    await page
      .locator(`#import-code-status[data-state="${success ? 'success' : 'error'}"]`)
      .waitFor();
  };
  await open();
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  assert.equal(await page.locator('#check-imported-code').isDisabled(), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
  await fill('module.exports = class {');
  await check(false);
  assert.equal(await page.locator('#code').inputValue(), original);
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  assert.match(await page.locator('#import-code-status').textContent(), /줄/);
  await fill(
    'module.exports=class { initialize(){} getName(){ return 누락변수; } moveNext(){ return -1; } };',
  );
  await check(false);
  assert.match(await page.locator('#import-code-status').textContent(), /누락변수/);
  const callsBeforeAmbiguous = validationCalls;
  await fill('```js\n' + candidate + '\n```\n```js\n' + original + '\n```');
  await check(false);
  assert.equal(validationCalls, callsBeforeAmbiguous);
  assert.match(await page.locator('#import-code-status').textContent(), /블록 하나/);
  await fill('```javascript\n' + candidate + '\n```');
  await check(true);
  assert.equal(await page.locator('#code').inputValue(), original);
  assert.equal((await accounts.get(user.id, saved.id)).source, original);
  await fill(candidate + '\n// 수정됨');
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  await check(true);
  await page.locator('#cancel-code-import').click();
  await open();
  assert.equal(await page.locator('#imported-code').inputValue(), '');
  for (const mode of ['expired', 'busy']) {
    responseMode = mode;
    await fill(candidate);
    await check(false);
    assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  }
  responseMode = null;
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await fill(candidate);
  await page.locator('#check-imported-code').click();
  await page.locator('#import-code-status[data-state="pending"]').waitFor();
  await fill(candidate + '\n// 검사 중 변경');
  release();
  gate = null;
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  assert.equal(await page.locator('#import-code-status').getAttribute('data-state'), 'changed');
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.locator('#check-imported-code').click();
  await page.locator('#import-code-status[data-state="pending"]').waitFor();
  await page.locator('#cancel-code-import').click();
  release();
  gate = null;
  await open();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  assert.equal(await page.locator('#imported-code').inputValue(), '');
  await fill(candidate);
  await check(true);
  const changedEditor = original + '\n// 모달을 연 뒤 편집됨';
  await page.evaluate((source) => {
    const code = document.getElementById('code');
    code.value = source;
    code.dispatchEvent(new Event('input'));
  }, changedEditor);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#apply-imported-code').click();
  assert.equal(await page.locator('#code-import-dialog').isVisible(), true);
  assert.equal(await page.locator('#code').inputValue(), changedEditor);
  await mkdir('artifacts', { recursive: true });
  assert.equal(
    await page.locator('#apply-imported-code').evaluate((button) => {
      const r = button.getBoundingClientRect(),
        d = button.closest('dialog').getBoundingClientRect();
      return r.top >= d.top && r.bottom <= d.bottom && r.bottom <= innerHeight;
    }),
    true,
  );
  await page.screenshot({ path: 'artifacts/code-import-desktop.png' });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#apply-imported-code').click();
  await page.locator('#code-import-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#code').inputValue(), candidate);
  assert.equal(await page.locator('#document-title').textContent(), '가져오기 원본');
  assert.match(await page.locator('#document-origin').textContent(), /내 저장 코드/);
  assert.equal((await accounts.get(user.id, saved.id)).source, original);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#code').inputValue(), changedEditor);
  await page.locator('#redo').click();
  assert.equal(await page.locator('#code').inputValue(), candidate);
  await page.locator('#save').click();
  assert.equal(await page.locator('[name="save-kind"][value="overwrite"]').isChecked(), true);
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal((await accounts.get(user.id, saved.id)).source, candidate);
  await page.locator('#save').click();
  await page.locator('[name="save-kind"][value="copy"]').check();
  await page.locator('#name').fill('가져온 코드 새 이름');
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal((await accounts.list(user.id)).length, 2);
  // Cancelling a real unbounded validation stops its disposable process and clears uploads.
  await open();
  await fill(
    'module.exports=class { initialize(){ while(true){} } getName(){return "test";} moveNext(){return -1;} };',
  );
  await page.locator('#check-imported-code').click();
  await poll(async () => (await readdir(uploads).catch(() => [])).length > 0);
  await page.locator('#cancel-code-import').click();
  await poll(async () => (await readdir(uploads).catch(() => [])).length === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await fill('```js\n' + candidate + '\n```');
  await check(true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page.locator('#code-import-dialog').evaluate((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }),
    true,
  );
  await page.screenshot({ path: 'artifacts/code-import-mobile.png' });
  await page.locator('#cancel-code-import').click();
  // A pending result cannot apply after a new editor document replaces the original.
  await open();
  await fill(candidate);
  gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.locator('#check-imported-code').click();
  await page.locator('#import-code-status[data-state="pending"]').waitFor();
  await page.evaluate(() => document.getElementById('new').click());
  release();
  gate = null;
  await page.locator('#code-import-dialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(80);
  assert.match(await page.locator('#code').inputValue(), /getName\(\) \{\s*\}/);
  assert.equal(await page.locator('#apply-imported-code').isDisabled(), true);
  assert.deepEqual(aiRequests, []);
  assert.deepEqual(errors, []);
  await poll(async () => (await readdir(uploads).catch(() => [])).length === 0);
  console.log(
    'Code import smoke passed: actual validation, fences, errors, cancel/stale guards, confirmation, undo, original save/copy and mobile. Delayed responses and session/quota errors were replaced.',
  );
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
