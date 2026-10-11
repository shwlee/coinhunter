import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository, MAPS } from '../src/game/map-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-maps-ui-'));
const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
await accounts.bootstrapAdmin('admin@company.test');
const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
await maps.saveDraft({ ...structuredClone(MAPS[0]), id: 'ui-map', name: '관리 테스트 맵' });
const invalid = structuredClone(MAPS[0]);
invalid.tiles[1] = 0;
await maps.saveDraft({ ...invalid, id: 'invalid', name: '검사 실패 맵' });
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
  await page.goto(base + '/admin/maps');
  await page.locator('#authenticate:enabled').waitFor();
  await page.locator('#identity').selectOption('admin@company.test');
  await page.locator('#authenticate').click();
  await page.waitForURL(base + '/admin/maps');
  await page.locator('.map-card').first().waitFor();
  const card = () => page.locator('.map-card[data-id="ui-map"]');
  const state = () => maps.registry().find((entry) => entry.id === 'ui-map');
  const perform = async (action) => {
    await card().locator(`[data-action="${action}"]`).click();
    await page.locator('#confirm').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
    await page.locator('#refresh:enabled').waitFor();
  };
  assert.equal(await page.locator('.map-card').count(), 4);
  await perform('publish');
  assert.equal(state().enabled, true);
  await perform('visibility');
  assert.equal(state().enabled, false);
  await card().getByRole('link', { name: '편집', exact: true }).click();
  await page.locator('#save-map:enabled').waitFor();
  assert.match(await page.locator('#publication-state').textContent(), /비노출/);
  assert.equal(await page.locator('.map-cell').count(), 120);
  await page.locator('#save-map').click();
  await page.locator('#map-name').fill('관리 테스트 맵 수정');
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#publication-state').textContent(), /수정본 미게시/);
  await page.getByRole('link', { name: '← 맵 관리', exact: true }).click();
  await card().waitFor();
  await perform('publish');
  assert.equal(state().publishedRevision, 2);
  assert.equal(state().enabled, false);
  await perform('visibility');
  assert.equal(state().enabled, true);
  await maps.saveDraft(
    { ...maps.getDraft('ui-map'), name: '미게시 수정본' },
    { expectedRevision: 2 },
  );
  await page.locator('#refresh').click();
  await page.locator('#refresh:enabled').waitFor();
  await perform('visibility');
  await perform('visibility');
  assert.equal(state().publishedRevision, 2);
  await page.locator('#filter').selectOption('changed');
  assert.equal(await page.locator('.map-card').count(), 1);
  await page.locator('#search').fill('없는 이름');
  assert.equal(await page.locator('.map-card').count(), 0);
  await page.locator('#search').fill('');
  await page.locator('#filter').selectOption('all');
  await page.locator('.map-card[data-id="invalid"] [data-action="publish"]').click();
  await page.locator('#confirm').click();
  await page.locator('#action-error').filter({ hasText: '대칭' }).waitFor();
  assert.equal(maps.registry().find((entry) => entry.id === 'invalid').publishedRevision, null);
  await page.locator('#cancel').click();
  await card().locator('[data-action="visibility"]').click();
  await maps.setEnabled('ui-map', false);
  await page.locator('#confirm').click();
  await page.locator('#action-error').filter({ hasText: '변경되었습니다' }).waitFor();
  await page.locator('#cancel').click();
  assert.match(await card().locator('.map-status').textContent(), /비노출/);
  await perform('visibility'); // Opening another action after a failure must re-enable confirmation.
  await card().locator('[data-action="settings"]').click();
  await page.locator('#save-options:enabled').waitFor();
  await page.locator('#option-actionMs').fill('777');
  await page.locator('#save-options').click();
  await page.locator('#options-dialog').waitFor({ state: 'hidden' });
  assert.equal(maps.getDraft('ui-map').settings.actionMs, 777);
  assert.equal(state().publishedRevision, 2);
  assert.equal(state().draftRevision, 4);
  await card().locator('[data-action="settings"]').click();
  await page.locator('#save-options:enabled').waitFor();
  await page.locator('#option-actionMs').fill('888');
  await maps.saveDraft(
    { ...maps.getDraft('ui-map'), name: '다른 관리자 변경' },
    { expectedRevision: 4 },
  );
  await page.locator('#save-options').click();
  await page.locator('#options-error').filter({ hasText: '최신 버전' }).waitFor();
  assert.equal(await page.locator('#option-actionMs').inputValue(), '888');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#reload-options').click();
  await page.locator('#save-options:enabled').waitFor();
  assert.equal(await page.locator('#option-actionMs').inputValue(), '777');
  await page.locator('#close-options').click();
  await page.locator('.map-card[data-id="crossroads"] [data-action="settings"]').click();
  await page.locator('#option-actionMs:disabled').waitFor();
  assert.equal(await page.locator('#save-options').isHidden(), true);
  await page.locator('#close-options:enabled').click();
  await page.locator('.map-preview canvas').first().waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/map-management-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/map-management-mobile.png', fullPage: true });
  await page.locator('.map-card[data-id="crossroads"] [data-action="settings"]').click();
  await page.locator('#option-actionMs:disabled').waitFor();
  const options = page.locator('#options-dialog');
  const backgroundScroll = await page.evaluate(() => scrollY);
  const wheelAt = async (x, y, delta) => {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => scrollY), backgroundScroll);
  };
  const inputBounds = await page.locator('#option-actionMs').boundingBox();
  await wheelAt(inputBounds.x + 10, inputBounds.y + 10, 250);
  assert.ok(await options.evaluate((dialog) => dialog.scrollTop > 0));
  const bounds = await options.boundingBox();
  await options.evaluate((dialog) => (dialog.scrollTop = 0));
  await wheelAt(bounds.x + 8, bounds.y + 8, -500);
  await options.evaluate((dialog) => (dialog.scrollTop = dialog.scrollHeight));
  await wheelAt(bounds.x + 8, bounds.y + bounds.height - 8, 500);
  await wheelAt(2, 2, 500);
  await page.locator('#close-options:enabled').click();
  await page.mouse.move(2, 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => scrollY > 0));
  await card().locator('[data-action="settings"]').click();
  await page.locator('#save-options:enabled').waitFor();
  assert.equal(
    await page
      .locator('#options-dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    true,
  );
  await page.screenshot({ path: 'artifacts/map-options-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'artifacts/map-options-desktop.png', fullPage: true });
  await page.locator('#close-options').click();
  assert.deepEqual(errors, []);
  console.log('Map management browser smoke passed');
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
