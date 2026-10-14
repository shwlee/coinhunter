import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
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
  assert.equal(await page.locator('#publish-map').isDisabled(), true);
  assert.equal(await page.locator('#edit-options').isDisabled(), true);
  await page.locator('#columns').fill('5');
  await page.locator('#rows').fill('5');
  await page.locator('#create-map button[type="submit"]').click();
  assert.equal(await page.locator('.map-cell').count(), 25);
  await page.locator('#edit-options').click();
  await page.locator('#save-options:enabled').waitFor();
  await page.locator('#option-actionMs').fill('650');
  await page.locator('#save-options').click();
  await page.locator('#options-dialog').waitFor({ state: 'hidden' });
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 0);
  await page.locator('#account-bar button').waitFor();
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
  assert.equal(await page.locator('#publish-map').isDisabled(), true);
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
  assert.equal(await page.locator('#map-save-mode').isVisible(), false);
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
  await page.locator('#publish-map:enabled').click();
  await page.locator('#confirm-publish').click();
  await page.locator('#confirm-publish:enabled').waitFor();
  assert.match(await page.locator('#publish-error').textContent(), /대칭/);
  assert.equal(
    maps.getPublished(maps.registry().find((entry) => entry.source === 'custom').id),
    null,
  );
  await page.locator('[data-close="publish-dialog"]').click();
  await page.locator('#open-maps').click();
  await page.locator('.saved-map').click();
  await page.locator('#load-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.map-cell img').count(), 5);
  assert.equal(await warnsOnExit(), false);
  // Another administrator saves a newer revision while this page still edits v1.
  const entry = maps.registry().find((entry) => entry.source === 'custom');
  assert.equal(maps.getDraft(entry.id).settings.actionMs, 650);
  await tile(13).click();
  const unsavedTiles = await page.locator('.map-cell img').count();
  await page.locator('#edit-options').click();
  await page.locator('#save-options:enabled').waitFor();
  assert.equal(await page.locator('#option-actionMs').inputValue(), '650');
  await page.locator('#option-actionMs').fill('700');
  await page.locator('#save-options').click();
  await page.locator('#options-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.map-cell img').count(), unsavedTiles);
  assert.equal(maps.getDraft(entry.id).settings.actionMs, 650);
  assert.equal(await warnsOnExit(), true);
  await page.locator('#save-map').click();
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(maps.getDraft(entry.id).settings.actionMs, 700);
  assert.equal(await warnsOnExit(), false);
  await maps.saveDraft(
    { ...maps.getDraft(entry.id), name: '다른 관리자 수정' },
    { expectedRevision: 2 },
  );
  await tile(14).click();
  assert.equal(await warnsOnExit(), true);
  await page.locator('#save-map').click();
  await page.locator('#confirm-save').click();
  await page.locator('#confirm-save:enabled').waitFor();
  assert.match(await page.locator('#save-error').textContent(), /최신 버전/);
  assert.equal(await page.locator('.map-cell img').count(), 7);
  await page.locator('[data-close="save-dialog"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#columns').fill('40');
  await page.locator('#rows').fill('30');
  await page.locator('#create-map button[type="submit"]').click();
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
  await page.locator('#create-map button[type="submit"]').click();
  await page.locator('#symmetry').check();
  await tile(14).click();
  await page.locator('[data-tool="wall"]').click();
  await tile(28).click();
  await page.screenshot({ path: 'artifacts/map-editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/map-editor-mobile.png', fullPage: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#create-map button[type="submit"]').click();
  await page.locator('[data-tool="coin"]').click();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const mobileEmptyLayout = await layout();
  await tile(14).click();
  assert.deepEqual(
    await layout(),
    mobileEmptyLayout,
    'First mobile asset preserves layout when validation text shortens',
  );
  await page.locator('#edit-options').click();
  await page.locator('#save-options:enabled').waitFor();
  await page.locator('#option-actionMs').fill('800');
  await page.locator('#save-options').click();
  await page.locator('#options-dialog').waitFor({ state: 'hidden' });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.columns, 12);
  assert.equal(exported.settings.actionMs, 800);
  assert.equal(exported.tiles.filter((value) => value > 0).length, 4);
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 1);
  const uploadJson = async (content) => {
    await page.locator('#map-json-file').setInputFiles({
      name: 'transfer.json',
      mimeType: 'application/json',
      buffer: Buffer.from(content),
    });
    await page.locator('#import-json:enabled').waitFor();
  };
  await uploadJson('{broken');
  assert.match(await page.locator('#map-feedback').textContent(), /가져오기 실패/);
  assert.equal(await page.locator('.map-cell img').count(), 4);
  await uploadJson(JSON.stringify({ ...exported, tiles: [0] }));
  assert.match(await page.locator('#map-feedback').textContent(), /가져오기 실패/);
  assert.equal(await page.locator('.map-cell').count(), 120);
  page.once('dialog', (dialog) => dialog.dismiss());
  await uploadJson(JSON.stringify({ ...exported, columns: 5, rows: 5, tiles: Array(25).fill(0) }));
  assert.equal(await page.locator('.map-cell').count(), 120);
  page.once('dialog', (dialog) => dialog.accept());
  await uploadJson('\uFEFF' + JSON.stringify({ ...exported, name: '가져온 맵' }));
  assert.equal(await page.locator('#map-identity').textContent(), '가져온 맵');
  assert.equal(await page.locator('.map-cell img').count(), 4);
  await page.locator('#save-map').click();
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  const imported = maps
    .registry()
    .filter((item) => item.source === 'custom' && item.id !== entry.id);
  assert.equal(imported.length, 1);
  assert.equal(maps.getDraft(imported[0].id).settings.actionMs, 800);
  assert.deepEqual(maps.getDraft(imported[0].id).tiles, exported.tiles);
  assert.equal(maps.getPublished(imported[0].id), null);
  // Random generation remains local until the administrator explicitly saves.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const oldLabels = await page
    .locator('.map-cell')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  await page.locator('#open-random').click();
  for (const [id, wall, coin, score] of [
    ['high-score', '25', '50', 'mixed-high'],
    ['more-space', '15', '25', 'mixed'],
    ['less-space', '15', '90', 'mixed'],
    ['more-walls', '45', '50', 'mixed'],
    ['less-walls', '10', '50', 'mixed'],
    ['low-score', '25', '50', 'mixed'],
  ]) {
    await page.locator('#random-template').selectOption(id);
    assert.equal(await page.locator('#wall-density').inputValue(), wall);
    assert.equal(await page.locator('#coin-density').inputValue(), coin);
    assert.equal(await page.locator('#random-coin-value').inputValue(), score);
  }
  await page.locator('#wall-density').fill('20');
  assert.equal(await page.locator('#random-template').inputValue(), 'custom');
  await page.locator('#random-template').selectOption('low-score');
  await page.locator('#random-columns').fill('20');
  await page.locator('[data-close="random-dialog"]').click();
  assert.deepEqual(
    await page
      .locator('.map-cell')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label'))),
    oldLabels,
  );
  await page.locator('#open-random').click();
  await page.locator('#random-columns').fill('20');
  await page.locator('#random-rows').fill('16');
  await page.locator('#wall-density').fill('25');
  await page.locator('#coin-density').fill('50');
  await page.locator('#random-coin-value').selectOption('100');
  await page.locator('#confirm-random').click();
  await page.locator('#random-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.map-cell').count(), 320);
  assert.equal(await page.locator('#symmetry').isChecked(), true);
  assert.ok(page.url().includes(imported[0].id));
  assert.match(await page.locator('#map-identity').textContent(), /가져온 맵/);
  assert.equal(await warnsOnExit(), true);
  assert.deepEqual(maps.getDraft(imported[0].id).tiles, exported.tiles);
  assert.match(await page.locator('#map-validation').textContent(), /게시 검사 통과/);
  assert.match(await page.locator('#map-feedback').textContent(), /실제 벽 밀도/);
  assert.equal(maps.registry().filter((item) => item.source === 'custom').length, 2);
  const randomLabels = await page
    .locator('.map-cell')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  await page.locator('#open-random').click();
  await page.locator('#wall-density').fill('61');
  await page.locator('#confirm-random').click();
  assert.equal(await page.locator('#random-dialog').isVisible(), true);
  assert.deepEqual(
    await page
      .locator('.map-cell')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label'))),
    randomLabels,
  );
  await page.locator('#wall-density').fill('0');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#confirm-random').click();
  assert.deepEqual(
    await page
      .locator('.map-cell')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label'))),
    randomLabels,
  );
  await page.locator('[data-close="random-dialog"]').click();
  await page.screenshot({ path: 'artifacts/map-random-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-random').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const dialogFits = await page.locator('#random-dialog').evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    return (
      bounds.left >= 0 &&
      bounds.right <= innerWidth &&
      bounds.top >= 0 &&
      bounds.bottom <= innerHeight
    );
  });
  assert.equal(dialogFits, true);
  await page.screenshot({ path: 'artifacts/map-random-mobile.png', fullPage: true });
  await page.locator('[data-close="random-dialog"]').click();
  await page.locator('#save-map').click();
  await page.locator('#map-name').fill('대칭 랜덤 테스트');
  assert.equal(await page.locator('#map-save-mode').isVisible(), true);
  await page.locator('[name="map-save-kind"][value="new"]').check();
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  const generated = maps
    .registry()
    .filter(
      (item) => item.source === 'custom' && item.id !== entry.id && item.id !== imported[0].id,
    )[0];
  const generatedDraft = maps.getDraft(generated.id);
  assert.equal(generatedDraft.columns, 20);
  assert.equal(generatedDraft.rows, 16);
  assert.equal(generatedDraft.settings.actionMs, 800);
  assert.ok(generatedDraft.tiles.some((tile) => tile === -1));
  assert.ok(generatedDraft.tiles.filter((tile) => tile > 0).every((tile) => tile === 100));
  assert.equal(maps.getPublished(generated.id), null);
  await page.locator('#publish-map:enabled').click();
  await page.locator('[data-close="publish-dialog"]').click();
  assert.equal(maps.getPublished(generated.id), null);
  await page.locator('#publish-map:enabled').click();
  await page.locator('#confirm-publish').click();
  await page.locator('#publish-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#publish-map').textContent(), '게시 완료');
  assert.equal(await page.locator('#publish-map').isDisabled(), true);
  assert.match(await page.locator('#publication-state').textContent(), /노출 중/);
  assert.deepEqual(maps.getPublished(generated.id).tiles, generatedDraft.tiles);
  await page.locator('#open-maps').click();
  await page.locator('.saved-map').filter({ hasText: '대칭 랜덤 테스트' }).click();
  await page.locator('#load-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page
      .locator('.map-cell')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label'))),
    randomLabels,
  );
  // Save the current unsaved layout and settings as a separate map, preserving its source.
  const originalDraft = maps.getDraft(generated.id);
  const originalPublished = maps.getPublished(generated.id);
  await page.locator('[data-tool="coin"]').click();
  await page.locator('#coin-value').selectOption('500');
  await tile(originalDraft.tiles.findIndex((tile) => tile > 0)).click();
  await page.locator('#edit-options').click();
  await page.locator('#save-options:enabled').waitFor();
  await page.locator('#option-actionMs').fill('777');
  await page.locator('#save-options').click();
  await page.locator('#options-dialog').waitFor({ state: 'hidden' });
  await page.locator('#save-map').click();
  assert.equal(await page.locator('#map-save-mode').isVisible(), true);
  assert.equal(await page.locator('[name="map-save-kind"][value="overwrite"]').isChecked(), true);
  await page.locator('[name="map-save-kind"][value="new"]').check();
  await page.locator('[data-close="save-dialog"]').click();
  assert.deepEqual(maps.getDraft(generated.id), originalDraft);
  assert.equal(await warnsOnExit(), true);
  await page.locator('#save-map').click();
  await page.locator('[name="map-save-kind"][value="new"]').check();
  await page.locator('#map-name').fill('다른 이름으로 저장한 맵');
  const oldIds = maps.registry().map((entry) => entry.id);
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  const newEntry = maps.registry().find((entry) => !oldIds.includes(entry.id));
  assert.ok(newEntry);
  const newDraft = maps.getDraft(newEntry.id);
  assert.equal(newDraft.revision, 1);
  assert.equal(newDraft.settings.actionMs, 777);
  assert.ok(newDraft.tiles.includes(500));
  assert.deepEqual(maps.getDraft(generated.id), originalDraft);
  assert.deepEqual(maps.getPublished(generated.id), originalPublished);
  assert.equal(maps.getPublished(newEntry.id), null);
  assert.ok(page.url().includes(newEntry.id));
  assert.equal(await warnsOnExit(), false);
  await page.locator('#save-map').click();
  assert.match(await page.locator('#map-overwrite-label').textContent(), /다른 이름으로 저장한 맵/);
  assert.equal(await page.locator('[name="map-save-kind"][value="overwrite"]').isChecked(), true);
  await page.screenshot({ path: 'artifacts/map-save-mode-mobile.png', fullPage: true });
  await page.locator('[data-close="save-dialog"]').click();
  // Loading another saved map restores its identity and uses the same edit/save modes.
  await page.locator('#open-maps').click();
  await page.locator('.saved-map').filter({ hasText: '대칭 랜덤 테스트' }).click();
  await page.locator('#load-dialog').waitFor({ state: 'hidden' });
  assert.ok(page.url().includes(generated.id));
  assert.equal(await warnsOnExit(), false);
  await page.locator('#open-random').click();
  assert.match(await page.locator('#random-save-note').textContent(), /현재 맵/);
  await page.locator('#wall-density').fill('0');
  await page.locator('#coin-density').fill('100');
  await page.locator('#random-coin-value').selectOption('30');
  await page.locator('#confirm-random').click();
  await page.locator('#random-dialog').waitFor({ state: 'hidden' });
  assert.ok(page.url().includes(generated.id));
  assert.equal(await warnsOnExit(), true);
  assert.deepEqual(maps.getDraft(generated.id), originalDraft);
  await page.locator('#coin-value').selectOption('200');
  await tile(originalDraft.tiles.findIndex((tile) => tile > 0)).click();
  await page.locator('#save-map').click();
  assert.equal(await page.locator('#map-save-mode').isVisible(), true);
  assert.match(await page.locator('#map-overwrite-label').textContent(), /대칭 랜덤 테스트/);
  assert.equal(await page.locator('[name="map-save-kind"][value="overwrite"]').isChecked(), true);
  const loadedIds = maps.registry().map((entry) => entry.id);
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(
    maps.registry().map((entry) => entry.id),
    loadedIds,
  );
  assert.equal(maps.getDraft(generated.id).revision, originalDraft.revision + 1);
  assert.ok(maps.getDraft(generated.id).tiles.includes(200));
  assert.equal(maps.getDraft(generated.id).settings.actionMs, 800);
  assert.equal(maps.getDraft(generated.id).tiles.filter((tile) => tile === -1).length, 0);
  assert.deepEqual(maps.getPublished(generated.id), originalPublished);
  assert.deepEqual(maps.getDraft(newEntry.id), newDraft);
  assert.equal(await warnsOnExit(), false);
  // Publishing rejects a concurrent visibility change, then preserves hidden state on retry.
  assert.equal(await page.locator('#publish-map').textContent(), '게시 갱신');
  await page.locator('#publish-map:enabled').click();
  await maps.setEnabled(generated.id, false);
  await page.locator('#confirm-publish').click();
  await page.locator('#confirm-publish:enabled').waitFor();
  assert.match(await page.locator('#publish-error').textContent(), /다시 불러온/);
  assert.equal(
    maps.registry().find((item) => item.id === generated.id).publishedRevision,
    originalDraft.revision,
  );
  await page.locator('[data-close="publish-dialog"]').click();
  await page.locator('#open-maps').click();
  await page.locator('.saved-map').filter({ hasText: '대칭 랜덤 테스트' }).click();
  await page.locator('#load-dialog').waitFor({ state: 'hidden' });
  await page.locator('#publish-map:enabled').click();
  assert.match(await page.locator('#publish-description').textContent(), /비노출 상태/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/map-editor-publish-mobile.png', fullPage: true });
  await page.locator('#confirm-publish').click();
  await page.locator('#publish-dialog').waitFor({ state: 'hidden' });
  const hiddenState = maps.registry().find((item) => item.id === generated.id);
  assert.equal(hiddenState.enabled, false);
  assert.equal(hiddenState.publishedRevision, hiddenState.draftRevision);
  assert.equal(maps.getPublished(generated.id), null);
  assert.match(await page.locator('#publication-state').textContent(), /비노출/);
  assert.equal(await warnsOnExit(), false);
  assert.deepEqual(errors, []);
  console.log('Map editor browser smoke passed');
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
