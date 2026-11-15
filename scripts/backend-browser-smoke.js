import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { launchSplit } from './backend-integration.js';

const app = await launchSplit();
const base = `http://127.0.0.1:${app.publicPort}`;
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
  const failedRequests = [];
  page.on('response', (response) => {
    if (response.status() >= 500) failedRequests.push(response.url() + ':' + response.status());
  });
  await page.goto(base + '/');
  await page.waitForURL('**/signin**');
  await page.locator('#authenticate:enabled').waitFor();
  await page.selectOption('#identity', 'admin@company.test');
  await page.click('#authenticate');
  await page.waitForURL(base + '/');
  await page.locator('#go-admin').waitFor({ state: 'visible' });
  await page.goto(base + '/editor');
  await page.locator('#workbench').waitFor({ state: 'visible' });
  const example = await (await page.request.get(base + '/api/example')).text();
  await page.locator('.cm-content').fill(example);
  await page.click('#validate');
  await page
    .locator('#validation-status')
    .filter({ hasText: /통과|오류가 없습니다/ })
    .waitFor({ timeout: 40000 });
  await page.click('#save');
  await page.fill('#name', 'split backend browser');
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  await page
    .locator('#save-state')
    .filter({ hasText: /^저장됨$/ })
    .waitFor();
  assert.equal(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    false,
  );
  await page.click('#testing-view');
  const frame = page.frameLocator('#game');
  await frame.locator('#map-select option').first().waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#file-step').isVisible(), false);
  await frame.locator('#start-button:enabled').waitFor();
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/matches') && response.request().method() === 'POST',
  );
  await frame.locator('#start-button').click();
  const response = await created;
  assert.equal(response.status(), 201, await response.text());
  await frame.locator('#test-score').waitFor({ state: 'visible' });
  const matchId = (await response.json()).id;
  assert.equal((await page.request.delete(base + '/api/matches/' + matchId)).status(), 200);
  await page.click('#back-to-editor');
  await page.goto(base + '/admin/maps/editor');
  await page.fill('#columns', '4');
  await page.fill('#rows', '4');
  await page.click('#create-map button[type="submit"]');
  await page.locator('.map-cell[data-index="5"]').click();
  await page.click('#save-map');
  await page.fill('#map-name', 'split browser map');
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  await page.click('#publish-map');
  await page.click('#confirm-publish');
  await page.locator('#publish-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#publication-state').textContent(), /노출 중/);
  const maps = (await (await page.request.get(base + '/api/maps')).json()).maps;
  const custom = maps.find((map) => map.name === 'split browser map');
  assert.ok(custom);
  await page.goto(base + '/game');
  await page.locator('#map-select option').first().waitFor({ state: 'attached' });
  await page.setInputFiles('#algorithm-file', {
    name: 'nearest-coin.js',
    mimeType: 'text/plain',
    buffer: Buffer.from(example),
  });
  await page.click('#file-next');
  await page.locator('#settings-step').waitFor({ state: 'visible' });
  await page.selectOption('#map-select', custom.id);
  await page.click('#settings-next');
  await page.click('#position-next');
  const started = page.waitForResponse(
    (item) => item.url().endsWith('/api/matches') && item.request().method() === 'POST',
  );
  await page.click('#start-button');
  const startResponse = await started;
  assert.equal(startResponse.status(), 201, await startResponse.text());
  await page.locator('#scoreboard').waitFor({ state: 'visible' });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      `No horizontal overflow at ${width}`,
    );
  }
  await page.request.delete(base + '/api/matches/' + (await startResponse.json()).id);
  await page.locator('#result-podium').waitFor({ state: 'visible', timeout: 15000 });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/backend-browser-results.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  console.log(
    'PASS split browser: login -> editor/validate/save -> test iframe -> map edit/publish -> game/countdown/SSE/results; 3 viewport widths.',
  );
} finally {
  await browser?.close();
  await app.close();
}
