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
  assert.equal(await page.locator('#file-step').isVisible(), true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/wizard-file.png', fullPage: true });
  assert.equal(await page.locator('#file-next').isDisabled(), true);
  await page
    .locator('#algorithm-file')
    .setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  assert.equal(await page.locator('#file-next').isDisabled(), true);
  await page
    .locator('#algorithm-file')
    .setInputFiles(fileURLToPath(new URL('../examples/nearest-coin.js', import.meta.url)));
  await page.locator('#file-next').click();
  assert.equal(await page.locator('#settings-step').isVisible(), true);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('#arena-overlay').evaluate((overlay) => ({
      verticalOverflow: overlay.scrollHeight - overlay.clientHeight,
      horizontalOverflow: overlay.scrollWidth - overlay.clientWidth,
    }));
    assert.ok(layout.verticalOverflow <= 1, `Settings must not scroll vertically at ${width}px`);
    assert.ok(
      layout.horizontalOverflow <= 1,
      `Settings must not scroll horizontally at ${width}px`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: 'artifacts/wizard-settings.png', fullPage: true });
  await page.locator('#black-matter').check();
  await page.locator('#file-back').click();
  assert.equal(await page.locator('#file-label').textContent(), 'nearest-coin.js');
  await page.locator('#file-next').click();
  assert.equal(await page.locator('#black-matter').isChecked(), true);
  await page.locator('#settings-next').click();
  assert.equal(await page.locator('#arena-overlay .character-options').isVisible(), true);
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
  await page.locator('#position-next').click();
  assert.equal(await page.locator('.character-options').isVisible(), false);
  await page.getByRole('radio', { name: '오른쪽 아래' }).check();
  await page.screenshot({ path: 'artifacts/desktop-position.png', fullPage: true });
  await page.locator('#start-button').click();
  await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
  assert.equal(await page.locator('.character-options').isVisible(), false);
  await page.locator('.score-card .score').filter({ hasText: /[1-9]/ }).first().waitFor();
  await page.screenshot({ path: 'artifacts/desktop-playing.png', fullPage: true });
  assert.equal(await page.locator('.score-card').count(), 4);
  assert.equal(await page.locator('.score-card[data-character="lumi"]').count(), 1);
  assert.equal(await page.locator('.score-card[data-character="kobi"]').count(), 3);
  assert.equal(await page.locator('input[name="character"][value="pengko"]').isDisabled(), true);
  await page.reload();
  await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
  assert.equal(await page.locator('input[name="character"][value="lumi"]').isChecked(), true);
  assert.equal(await page.locator('input[name="start-slot"][value="3"]').isChecked(), true);
  await page.locator('#stop-button').click();
  await page.locator('#game-status').filter({ hasText: '경기 종료' }).waitFor();
  assert.equal(await page.locator('#arena-overlay').isVisible(), true);
  assert.equal(await page.locator('#file-step').isVisible(), false);
  assert.equal(await page.locator('#setup-progress').isVisible(), false);
  assert.equal(
    await page.locator('#arena-message').innerText(),
    '경기를 종료했습니다\n\n알고리즘을 바꾸고 새로운 전략에 도전하세요.',
  );
  await page.locator('#play-again').click();
  assert.equal(await page.locator('#file-step').isVisible(), true);
  assert.equal(await page.locator('#play-again').isVisible(), false);
  await page
    .locator('#algorithm-file')
    .setInputFiles(fileURLToPath(new URL('../examples/nearest-coin.js', import.meta.url)));
  await page.locator('#file-next').click();
  await page.locator('#settings-next').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.character-card.dino').click();
  assert.equal(await page.getByRole('radio', { name: '디노', exact: true }).isChecked(), true);
  const overlayBounds = await page.locator('#arena-overlay').boundingBox();
  const choicesBounds = await page.locator('.character-options').boundingBox();
  assert.ok(choicesBounds.y >= overlayBounds.y);
  assert.ok(choicesBounds.y + choicesBounds.height <= overlayBounds.y + overlayBounds.height);
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  await page.locator('#position-next').click();
  await page.getByRole('radio', { name: '왼쪽 아래' }).check();
  await page.locator('#character-back').click();
  assert.equal(await page.getByRole('radio', { name: '디노', exact: true }).isChecked(), true);
  await page.locator('#position-next').click();
  assert.equal(await page.getByRole('radio', { name: '왼쪽 아래' }).isChecked(), true);
  await page.screenshot({ path: 'artifacts/mobile-position.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  for (const step of ['position', 'character']) {
    if (step === 'character') await page.locator('#character-back').click();
    const fits = await page.locator('#arena-overlay').evaluate((overlay) => {
      const bounds = overlay.getBoundingClientRect();
      return [...overlay.children]
        .filter((child) => !child.hidden)
        .every((child) => {
          const rect = child.getBoundingClientRect();
          return (
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.left >= bounds.left &&
            rect.right <= bounds.right
          );
        });
    });
    assert.equal(fits, true, `${step} must fit the 320px overlay`);
    await page.screenshot({ path: `artifacts/mobile-320-${step}.png`, fullPage: true });
  }
  await page.locator('#position-next').click();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  // A timed-out turn must recover without terminating or reinitializing the player.
  const timeoutSource = `module.exports=class {
    initialize(){this.calls=0;} getName(){return '회복 확인';}
    moveNext(){this.calls++;if(this.calls===1)while(true){};debug.print('회복',this.calls);return 2;}
  }`;
  await page.locator('#character-back').click();
  await page.locator('#settings-back').click();
  await page.locator('#file-back').click();
  await page.locator('#algorithm-file').setInputFiles({
    name: 'timeout.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from(timeoutSource),
  });
  await page.screenshot({ path: 'artifacts/wizard-mobile-file.png', fullPage: true });
  await page.locator('#file-next').click();
  const nextBounds = await page.locator('#settings-next').boundingBox();
  const panelBounds = await page.locator('#arena-overlay').boundingBox();
  assert.ok(nextBounds.y + nextBounds.height <= panelBounds.y + panelBounds.height);
  await page.screenshot({ path: 'artifacts/wizard-mobile-settings.png', fullPage: true });
  await page.locator('#dummy-count').selectOption('0');
  await page.locator('#settings-next').click();
  await page.locator('#position-next').click();
  await page.locator('#start-button').click();
  await page.locator('#debug-output').filter({ hasText: 'timeout' }).waitFor();
  await page.locator('#debug-output').filter({ hasText: '회복 2' }).waitFor();
  assert.equal(await page.locator('.score-card[data-character="dino"]').count(), 1);
  await page.locator('#stop-button').click();
  await page.locator('#game-status').filter({ hasText: '경기 종료' }).waitFor();
  assert.equal(await page.locator('#setup-form').isVisible(), false);
  await page.locator('#play-again').click();
  assert.equal(await page.locator('#file-label').textContent(), 'timeout.js');
  assert.equal(await page.locator('#file-next').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: upload, four players, scoring, reconnect, stop, mobile layout, timeout recovery.',
  );
} finally {
  await browser?.close();
  await close();
}
