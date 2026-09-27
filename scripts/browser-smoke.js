import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/server.js';

const candidates = [
  process.env.COINHUNTER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const executablePath = candidates.find((path) => path && existsSync(path));
if (!executablePath)
  throw new Error('COINHUNTER_BROWSER에 Chromium 계열 브라우저 실행 경로를 지정하세요.');
const { server, close } = createGameServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#map-select option', { state: 'attached' });
  assert.equal(await page.locator('#start-button').isDisabled(), true);
  assert.equal(await page.locator('input[name="character"]').count(), 4);
  await page.locator('.character-card.lumi').click();
  assert.equal(await page.getByRole('radio', { name: '루미', exact: true }).isChecked(), true);
  const spritePixels = await page.locator('.lumi canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) opaque++;
    return { corner: pixels[3], opaque };
  });
  assert.equal(spritePixels.corner, 0);
  assert.ok(spritePixels.opaque > 1000, 'Character portrait must be rendered');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-ready.png', fullPage: true });
  await page
    .locator('#algorithm-file')
    .setInputFiles(fileURLToPath(new URL('../examples/nearest-coin.js', import.meta.url)));
  await page.locator('#start-button').click();
  await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
  await page.locator('.score-card .score').filter({ hasText: /[1-9]/ }).first().waitFor();
  await page.screenshot({ path: 'artifacts/desktop-playing.png', fullPage: true });
  assert.equal(await page.locator('.score-card').count(), 4);
  assert.equal(await page.locator('.score-card[data-character="lumi"]').count(), 1);
  assert.equal(await page.locator('.score-card[data-character="kobi"]').count(), 3);
  assert.equal(await page.getByRole('radio', { name: '펭코', exact: true }).isDisabled(), true);
  await page.reload();
  await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: '루미', exact: true }).isChecked(), true);
  await page.locator('#stop-button').click();
  await page.locator('#game-status').filter({ hasText: '경기 종료' }).waitFor();
  assert.equal(await page.locator('#arena-overlay').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  // A timed-out turn must recover without terminating or reinitializing the player.
  const timeoutSource = `module.exports=class {
    initialize(){this.calls=0;} getName(){return '회복 확인';}
    moveNext(){this.calls++;if(this.calls===1)while(true){};debug.print('회복',this.calls);return 2;}
  }`;
  await page.locator('#algorithm-file').setInputFiles({
    name: 'timeout.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from(timeoutSource),
  });
  await page.locator('#dummy-count').selectOption('0');
  await page.locator('#start-button').click();
  await page.locator('#debug-output').filter({ hasText: 'timeout' }).waitFor();
  await page.locator('#debug-output').filter({ hasText: '회복 2' }).waitFor();
  await page.locator('#stop-button').click();
  await page.locator('#game-status').filter({ hasText: '경기 종료' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: upload, four players, scoring, reconnect, stop, mobile layout, timeout recovery.',
  );
} finally {
  await browser?.close();
  await close();
}
