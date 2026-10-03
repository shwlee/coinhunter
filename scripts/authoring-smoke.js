import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Accounts } from '../src/accounts.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-editor-'));
const { server, close } = createGameServer({
  authoring: createAuthoring({ accounts: new Accounts(join(dir, 'store.json')) }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.COINHUNTER_BROWSER ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/editor');
  await page.waitForSelector('#account-bar button');
  assert.equal(await page.locator('#workbench').isVisible(), false);
  await page.getByRole('button', { name: '목업 로그인', exact: true }).click();
  await page.waitForSelector('#workbench', { state: 'visible' });
  await page.locator('#name').fill('브라우저 저장 테스트');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page
    .locator('#save-state')
    .filter({ hasText: /^저장됨$/ })
    .waitFor();
  await page.click('#code-tab');
  const original = await page.locator('#code').inputValue();
  await page.locator('.cm-content').fill(original + '\n// edit');
  await page.click('#ai-tab');
  await page.click('#generate');
  await page.waitForSelector('#candidate', { state: 'visible' });
  await page.click('#apply');
  assert.equal(await page.locator('#code').inputValue(), original);
  await page.click('#undo');
  assert.equal(await page.locator('#code').inputValue(), original + '\n// edit');
  await page.click('#save');
  await page
    .locator('#save-state')
    .filter({ hasText: /^저장됨$/ })
    .waitFor();
  await page.locator('#test:enabled').waitFor();
  const game = page.frameLocator('#game');
  await game.locator('#refresh-library').click();
  const stored = (await (await page.request.get(base + '/api/algorithms')).json()).algorithms[0];
  await game.locator(`#saved-opponent option[value="${stored.id}"]`).waitFor({ state: 'attached' });
  await game.locator('#saved-opponent').selectOption(stored.id);
  await game.locator('#match-mode option[value="duel"]:checked').waitFor({ state: 'attached' });
  await page.click('#test');
  await game.locator('#settings-step').waitFor({ state: 'visible' });
  assert.equal(await game.locator('#dummy-count').isVisible(), false);
  await game.locator('#settings-next').click();
  await game.locator('#position-next').click();
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/matches') && r.request().method() === 'POST',
  );
  await game.locator('#start-button').click();
  const response = await created;
  assert.equal(response.status(), 201);
  const { id } = await response.json();
  await page.request.delete(`${base}/api/matches/${id}`);
  await game.locator('#analysis-toggle').waitFor({ state: 'visible' });
  await game.locator('#analysis-toggle').click();
  assert.equal(await game.locator('#result-analysis').isVisible(), true);
  assert.match(await game.locator('#result-analysis').textContent(), /이전 ·/);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/editor-mobile.png', fullPage: true });
  const second = await browser.newPage();
  await second.goto(base + '/editor');
  await second.getByRole('button', { name: '목업 로그인', exact: true }).click();
  await second.waitForSelector('#library option[value]:not([value=""])', { state: 'attached' });
  assert.ok((await second.locator('#library').textContent()).includes('브라우저 저장 테스트'));
  assert.deepEqual(errors, []);
  console.log(
    'Authoring smoke passed: login, save, AI mock undo, game, analysis, mobile, second session.',
  );
} finally {
  await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
