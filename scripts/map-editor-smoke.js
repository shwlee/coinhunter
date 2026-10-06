import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository } from '../src/game/map-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-map-editor-'));
const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
await accounts.bootstrapAdmin('admin@company.test');
const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
const { server, close } = createGameServer({ maps, authoring: createAuthoring({ accounts }) });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/admin/maps/editor');
  await page.locator('#authenticate:enabled').waitFor();
  await page.locator('#identity').selectOption('admin@company.test');
  await page.locator('#authenticate').click();
  await page.waitForURL(base + '/admin/maps/editor');
  await page.locator('#account-bar button').waitFor();
  assert.equal(await page.locator('#save-map').isDisabled(), true);
  await page.locator('#columns').fill('5');
  await page.locator('#rows').fill('5');
  await page.locator('#create-map button').click();
  assert.equal(await page.locator('.map-cell').count(), 25);
  await page.waitForFunction(() => !!document.querySelector('#account-bar button'));
  const tile = (index) => page.locator(`.map-cell[data-index="${index}"]`);
  await page.locator('#coin-value').selectOption('100');
  await tile(6).scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const layout = () =>
    page.evaluate(() => {
      const ids = ['board', 'board-viewport', 'map-validation', 'map-feedback'];
      return {
        scroll: scrollY,
        height: document.documentElement.scrollHeight,
        boxes: Object.fromEntries(
          ids.map((id) => {
            const r = document.getElementById(id).getBoundingClientRect();
            return [id, [r.x, r.y, r.width, r.height]];
          }),
        ),
      };
    });
  const emptyLayout = await layout();
  await tile(6).click();
  assert.deepEqual(
    await layout(),
    emptyLayout,
    'First asset preserves board geometry and page scroll',
  );
  assert.equal(await page.locator('.map-cell img').count(), 4);
  await page.locator('#undo').click();
  assert.equal(await page.locator('.map-cell img').count(), 0);
  await page.locator('#redo').click();
  assert.equal(await page.locator('.map-cell img').count(), 4);
  await tile(0).click();
  assert.match(await page.locator('#map-feedback').textContent(), /시작 칸/);
  await page.locator('[data-tool="wall"]').click();
  await tile(12).click();
  assert.equal(await page.locator('.map-cell.wall').count(), 1);
  await page.locator('[data-tool="erase"]').click();
  await tile(12).click();
  await page.locator('#symmetry').uncheck();
  await page.locator('[data-tool="coin"]').click();
  await page.locator('#coin-value').selectOption('30');
  await tile(7).click();
  assert.match(await page.locator('#map-validation').textContent(), /대칭 불일치/);
  await page.locator('#show-issues').check();
  assert.ok((await page.locator('.map-cell.issue').count()) > 0);
  await page.locator('#save-map').click();
  await page.locator('#map-name').fill('브라우저 테스트 맵');
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#dirty-state').textContent(), '저장됨');
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 1);
  assert.equal(
    maps.getPublished(maps.registry().find((entry) => entry.source === 'custom').id),
    null,
  );
  const warnsOnExit = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  assert.equal(await warnsOnExit(), false);
  await page.locator('#open-maps').click();
  await page.locator('.saved-map').click();
  await page.locator('#load-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.map-cell img').count(), 5);
  assert.equal(await warnsOnExit(), false);
  // Another administrator saves a newer revision while this page still edits v1.
  const entry = maps.registry().find((entry) => entry.source === 'custom');
  await maps.saveDraft(
    { ...maps.getDraft(entry.id), name: '다른 관리자 수정' },
    { expectedRevision: 1 },
  );
  await tile(13).click();
  assert.equal(await warnsOnExit(), true);
  await page.locator('#save-map').click();
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() =>
    document.querySelector('#save-error').textContent.includes('최신 버전'),
  );
  assert.equal(await page.locator('.map-cell img').count(), 6);
  await page.locator('[data-close="save-dialog"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#columns').fill('40');
  await page.locator('#rows').fill('30');
  await page.locator('#create-map button').click();
  assert.equal(await page.locator('.map-cell').count(), 1200);
  await page.locator('[data-tool="wall"]').click();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const beforeFirstWall = await layout();
  await tile(41).click();
  assert.deepEqual(await layout(), beforeFirstWall, 'First wall also preserves layout');
  assert.equal(
    await page
      .locator('#board-viewport')
      .evaluate(
        (el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      ),
    true,
  );
  await page.locator('#zoom-in').click();
  await page.locator('#fit').click();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/map-editor-large.png', fullPage: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#columns').fill('12');
  await page.locator('#rows').fill('10');
  await page.locator('#create-map button').click();
  await page.locator('#symmetry').check();
  await tile(14).click();
  await page.locator('[data-tool="wall"]').click();
  await tile(28).click();
  await page.screenshot({ path: 'artifacts/map-editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/map-editor-mobile.png', fullPage: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#create-map button').click();
  await page.locator('[data-tool="coin"]').click();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const mobileEmptyLayout = await layout();
  await tile(14).click();
  assert.deepEqual(
    await layout(),
    mobileEmptyLayout,
    'First mobile asset preserves layout when validation text shortens',
  );
  assert.deepEqual(errors, []);
  console.log('Map editor browser smoke passed');
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
