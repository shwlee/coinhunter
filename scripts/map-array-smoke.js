import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository } from '../src/game/map-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { readAiConfig } from '../src/ai/config.js';
import { parseMapArray } from '../public/map-array.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-map-array-ui-'));
const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
await accounts.bootstrapAdmin('admin@company.test');
const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
const original = await maps.saveDraft({
  ...maps.getPublished('crossroads'),
  id: 'array-original',
  name: '배열 원본 맵',
  settings: { ...maps.getPublished('crossroads').settings, actionMs: 800 },
});
await maps.publish(original.id, original.revision);
const { server, close } = createGameServer({
  maps,
  uploadDirectory: join(dir, 'uploads'),
  authoring: createAuthoring({
    accounts,
    authConfig: { mode: 'mock' },
    domain: 'company.test',
    aiConfig: readAiConfig({ AI_ENABLED: 'false' }),
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const poll = async (check) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Array transfer did not settle');
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
  await context.addInitScript(() => {
    window.__denyCopy = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.__denyCopy) throw new Error('test denial');
          window.__copied = text;
        },
      },
    });
  });
  assert.equal(
    (
      await context.request.post(base + '/api/auth/mock', { data: { email: 'admin@company.test' } })
    ).status(),
    200,
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/admin/maps/editor?mapId=' + original.id);
  await page.locator('#export-array:enabled').waitFor();
  const labels = () =>
    page
      .locator('.map-cell')
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('aria-label')));
  const originalLabels = await labels();
  const unchangedOriginal = () => {
    assert.deepEqual(maps.getDraft(original.id), original);
    assert.deepEqual(maps.getPublished(original.id), original);
  };
  await page.locator('#export-array').click();
  await page.locator('#array-export-dialog[open]').waitFor();
  const numeric = await page.locator('#array-output').inputValue();
  assert.deepEqual(parseMapArray(numeric), original.tiles);
  assert.match(await page.locator('#array-export-info').textContent(), /12 × 10/);
  await page.locator('#array-format').selectOption('csharp');
  const csharp = await page.locator('#array-output').inputValue();
  assert.match(csharp, /^new int\[\]/);
  assert.deepEqual(parseMapArray(csharp), original.tiles);
  await page.locator('#copy-array').click();
  await page.locator('#array-export-status').filter({ hasText: '복사했습니다' }).waitFor();
  assert.equal(await page.evaluate(() => window.__copied), csharp);
  await page.evaluate(() => {
    window.__denyCopy = true;
  });
  await page.locator('#copy-array').click();
  await page
    .locator('#array-export-status')
    .filter({ hasText: '자동 복사를 사용할 수 없습니다' })
    .waitFor();
  assert.equal(
    await page
      .locator('#array-output')
      .evaluate((node) => node.selectionEnd - node.selectionStart === node.value.length),
    true,
  );
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-array').click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /12x10\.txt$/);
  assert.equal(await readFile(await download.path(), 'utf8'), csharp);
  await page.locator('[data-close="array-export-dialog"]').click();
  assert.equal(await page.locator('#dirty-state').textContent(), '저장됨');
  unchangedOriginal();
  const open = async () => {
    await page.locator('#import-array:enabled').click();
    await page.locator('#array-import-dialog[open]').waitFor();
  };
  const dimensions = async (columns, rows) => {
    await page.locator('#array-columns').fill(String(columns));
    await page.locator('#array-rows').fill(String(rows));
  };
  const submit = async () => {
    await page.locator('#confirm-array-import:enabled').click();
    await page.locator('#confirm-array-import:enabled').waitFor();
  };
  await open();
  await dimensions(4, 4);
  await page.locator('#array-input').fill(numeric);
  await submit();
  assert.match(await page.locator('#array-import-error').textContent(), /배열 길이/);
  for (const [tiles, message] of [
    [Array(16).fill(20), /타일/],
    [Array(16).fill(-1), /시작점/],
  ]) {
    await page.locator('#array-input').fill(JSON.stringify(tiles));
    await submit();
    assert.match(await page.locator('#array-import-error').textContent(), message);
  }
  await page.locator('#array-input').fill('[globalThis.compromised = true]');
  await submit();
  assert.match(await page.locator('#array-import-error').textContent(), /정수/);
  assert.equal(await page.evaluate(() => window.compromised), undefined);
  await page.locator('#array-file').setInputFiles({
    name: 'oversize.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(65537, 32),
  });
  await page.locator('#array-import-error').filter({ hasText: '64 KiB' }).waitFor();
  assert.deepEqual(await labels(), originalLabels);
  await page.locator('[data-close="array-import-dialog"]').click();
  // A late file read cannot refill a cancelled modal or overwrite newly pasted input.
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === 'delayed.txt')
        return new Promise((resolve) => {
          window.__releaseFile = () => original.call(this).then(resolve);
        });
      return original.call(this);
    };
  });
  await open();
  await page
    .locator('#array-file')
    .setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from(numeric) });
  await poll(() => page.evaluate(() => !!window.__releaseFile));
  await page.locator('[data-close="array-import-dialog"]').click();
  await open();
  await page.locator('#array-input').fill('[0]');
  await page.evaluate(async () => {
    await window.__releaseFile();
  });
  await page.waitForTimeout(40);
  assert.equal(await page.locator('#array-input').inputValue(), '[0]');
  const asymmetric = Array(16).fill(0);
  asymmetric[5] = 100;
  await dimensions(4, 4);
  await page.locator('#array-file').setInputFiles({
    name: 'array.cs',
    mimeType: 'text/plain',
    buffer: Buffer.from('\uFEFFnew int[] {' + asymmetric.join(',') + '};'),
  });
  await poll(async () => (await page.locator('#array-input').inputValue()).includes('new int[]'));
  await page.locator('#confirm-array-import:enabled').click();
  await page.locator('#array-import-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.map-cell').count(), 16);
  assert.match(await page.locator('#map-validation').textContent(), /대칭 불일치/);
  assert.equal(await page.locator('#show-issues').isChecked(), true);
  assert.equal(await page.locator('#publish-map').isDisabled(), true);
  assert.equal(new URL(page.url()).searchParams.has('mapId'), false);
  assert.equal(maps.registry().filter((entry) => entry.source === 'custom').length, 1);
  await page.locator('#edit-options').click();
  await page.locator('#save-options:enabled').waitFor();
  assert.equal(await page.locator('#option-actionMs').inputValue(), '400');
  await page.locator('#close-options').click();
  const symmetric = Array(16).fill(0);
  for (const p of [5, 6, 9, 10]) symmetric[p] = 10;
  await open();
  await page.locator('#array-input').fill(JSON.stringify(symmetric));
  page.once('dialog', (dialog) => dialog.dismiss());
  await submit();
  assert.match(await page.locator('#map-validation').textContent(), /대칭 불일치/);
  assert.equal(await page.locator('#array-import-dialog').isVisible(), true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#confirm-array-import').click();
  await page.locator('#array-import-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#map-validation').textContent(), /게시 검사 통과/);
  await page.locator('#save-map').click();
  assert.equal(await page.locator('#map-save-mode').isVisible(), false);
  await page.locator('#map-name').fill('배열 왕복 테스트');
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  const savedId = new URL(page.url()).searchParams.get('mapId');
  assert.notEqual(savedId, original.id);
  assert.deepEqual(maps.getDraft(savedId).tiles, symmetric);
  await page.locator('#publish-map:enabled').click();
  await page.locator('#confirm-publish').click();
  await page.locator('#publish-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(maps.getPublished(savedId).tiles, symmetric);
  assert.equal(
    (await (await context.request.get(base + '/api/maps')).json()).maps.some(
      (map) => map.id === savedId,
    ),
    true,
  );
  unchangedOriginal();
  await page.locator('#coin-value').selectOption('100');
  await page.locator('.map-cell[data-index="5"]').click();
  await page.locator('#export-array').click();
  await page.locator('#array-export-dialog[open]').waitFor();
  const edited = parseMapArray(await page.locator('#array-output').inputValue());
  assert.equal(edited[5], 100);
  assert.equal(maps.getDraft(savedId).tiles[5], 10);
  await page.locator('[data-close="array-export-dialog"]').click();
  const editedLabels = await labels();
  await page.setViewportSize({ width: 390, height: 640 });
  await open();
  const fits = (id) =>
    page.locator(id).evaluate((dialog) => {
      const r = dialog.getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.right <= innerWidth &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        document.documentElement.scrollWidth <= innerWidth
      );
    });
  assert.equal(await fits('#array-import-dialog'), true);
  const actionsVisible = (selector) =>
    page.locator(selector).evaluate((button) => {
      const r = button.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
  assert.equal(await actionsVisible('#confirm-array-import'), true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/map-array-import-mobile.png' });
  await page.locator('[data-close="array-import-dialog"]').click();
  assert.deepEqual(await labels(), editedLabels);
  await page.locator('#export-array').click();
  await page.locator('#array-export-dialog[open]').waitFor();
  assert.equal(await fits('#array-export-dialog'), true);
  assert.equal(await actionsVisible('#download-array'), true);
  await page.screenshot({ path: 'artifacts/map-array-export-mobile.png' });
  await page.locator('[data-close="array-export-dialog"]').click();
  await open();
  await page.locator('#array-input').fill(JSON.stringify(symmetric));
  await page.route('**/api/admin/maps/validate-array', (route) =>
    route.fulfill({ status: 401, json: { error: '다시 로그인하세요.' } }),
  );
  await submit();
  assert.match(await page.locator('#array-import-error').textContent(), /다시 로그인/);
  assert.deepEqual(await labels(), editedLabels);
  await page.locator('[data-close="array-import-dialog"]').click();
  unchangedOriginal();
  assert.deepEqual(errors, []);
  console.log(
    'Map array browser passed: real server validation, numeric/C# formats, clipboard fallback, file download, invalid/cancel preservation, late file reads, defaults, save/publish, unsaved export and mobile. Clipboard and expired-session response were replaced.',
  );
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
