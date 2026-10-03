import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-editor-'));
const { server, close } = createGameServer({
  authoring: createAuthoring({
    accounts: new FileAccountRepository(join(dir, 'store.json')),
  }),
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
  await page.goto(base + '/');
  await page.click('#go-game');
  await page.locator('#guest-link').waitFor({ state: 'visible' });
  await page.click('#guest-link');
  await page.waitForURL(base + '/game');
  await page.goto(base + '/');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/entry-desktop.png', fullPage: true });
  await page.click('#go-editor');
  await page.waitForURL(/\/signin\?next=%2Feditor/);
  assert.equal(await page.locator('#guest-link').isVisible(), false);
  await page.click('#signup-tab');
  await page.waitForURL(/\/signup\?next=%2Feditor/);
  await page.locator('#authenticate:enabled').waitFor();
  await page.screenshot({ path: 'artifacts/signup-desktop.png', fullPage: true });
  await page.click('#authenticate');
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
  assert.equal(await page.locator('.testing').isVisible(), false);
  assert.equal(await page.locator('#game').getAttribute('src'), null);
  const game = page.frameLocator('#game');
  await page.click('#testing-view');
  await page.locator('#test:enabled').waitFor();
  assert.equal(await page.locator('.writing').isVisible(), false);
  await game.locator('#settings-step').waitFor({ state: 'visible' });
  assert.equal(
    await game.locator('#start-button').evaluate((button) => {
      const board = document.querySelector('.canvas-wrap').getBoundingClientRect();
      return button.getBoundingClientRect().bottom <= board.bottom;
    }),
    true,
    'Test start button fits inside the board',
  );
  assert.equal(await game.locator('#dummy-count').isVisible(), false);
  for (const selector of [
    '#algorithm-file',
    '#character-step',
    '#black-matter',
    '#destroy-walls',
    '#rank-panel',
    '.legend',
  ])
    assert.equal(await game.locator(selector).isVisible(), false);
  await game.locator('input[name="start-slot"][value="3"]').check();
  await page.route('**/api/matches', async (route) => {
    if (route.request().method() === 'POST')
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/matches') && r.request().method() === 'POST',
  );
  await game.locator('#start-button').click();
  assert.deepEqual(
    await game.locator('#arena-overlay').evaluate((overlay) => ({
      hidden: overlay.hidden,
      background: getComputedStyle(overlay).backgroundColor,
      countingDown: overlay.classList.contains('counting-down'),
    })),
    { hidden: false, background: 'rgb(12, 20, 32)', countingDown: false },
    'The test board stays covered while the match starts',
  );
  const response = await created;
  assert.equal(response.status(), 201);
  const input = response.request().postDataJSON();
  assert.equal(input.startSlot, 3);
  assert.equal(input.dummyCount, 0);
  assert.equal(input.mode, 'practice');
  assert.equal(input.blackMatter, false);
  assert.equal(input.destroyWalls, false);
  assert.ok(['pengko', 'nyangtami', 'dino', 'lumi'].includes(input.characterId));
  const { id } = await response.json();
  await page.locator('#testing-view').filter({ hasText: '진행 중 테스트 보기' }).waitFor();
  await page.click('#writing-view');
  assert.equal(await page.locator('.testing').isVisible(), false);
  await page.click('#testing-view');
  assert.equal(await page.locator('.testing').isVisible(), true);
  assert.equal(await page.locator('#test').isDisabled(), true);
  assert.equal(
    await game.locator('body').evaluate(() => sessionStorage.getItem('coinhunter-test-match')),
    id,
    'Returning to the test keeps the same running match',
  );
  await game.locator('#stop-button').waitFor({ state: 'visible' });
  await page.request.delete(`${base}/api/matches/${id}`);
  await game.locator('#arena-message strong').filter({ hasText: '테스트 종료' }).waitFor();
  await page.locator('#test:enabled').waitFor();
  assert.equal(await page.locator('#testing-view').textContent(), '현재 코드로 테스트');
  assert.equal(await game.locator('#result-podium').isVisible(), false);
  assert.equal(await game.locator('#map-select').isVisible(), true);
  await page.click('#writing-view');
  assert.equal(await page.locator('.testing').isVisible(), false);
  assert.equal(await page.locator('.writing').isVisible(), true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/editor-mobile.png', fullPage: true });
  const second = await browser.newPage();
  await second.goto(base + '/editor');
  await second.waitForURL(/\/signin\?next=%2Feditor/);
  await second.locator('#authenticate:enabled').waitFor();
  await second.click('#authenticate');
  await second.waitForSelector('#library option[value]:not([value=""])', { state: 'attached' });
  assert.ok((await second.locator('#library').textContent()).includes('브라우저 저장 테스트'));
  const guest = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await guest.goto(base + '/signin?next=https%3A%2F%2Fevil.example');
  await guest.locator('#authenticate:enabled').waitFor();
  assert.ok((await guest.locator('#destination').textContent()).includes('시작 화면'));
  assert.equal(
    await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await guest.click('#authenticate');
  await guest.waitForURL(base + '/');
  await guest.locator('#go-editor[href="/editor"]').waitFor();
  await guest.screenshot({ path: 'artifacts/entry-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'Authoring smoke passed: login, save, AI mock undo, simplified solo test, mobile, second session.',
  );
} finally {
  await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
