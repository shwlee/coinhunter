import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/server.js';
import { GameState } from '../src/game/state.js';
import { MAPS } from '../src/game/map-repository.js';

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
const arenaLayout = (page) =>
  page.evaluate(() =>
    ['.arena.panel', '.canvas-wrap', '.match-toolbar', '#rank-panel'].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/game`);
  await page.waitForSelector('#map-select option', { state: 'attached' });
  const duelPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  duelPage.on('pageerror', (error) => errors.push(error.message));
  await duelPage.goto(`http://127.0.0.1:${server.address().port}/game`);
  await duelPage.waitForSelector('#map-select option', { state: 'attached' });
  await duelPage.selectOption('#match-mode', 'duel');
  await duelPage.setInputFiles('#algorithm-file', 'examples/nearest-coin.js');
  assert.equal(await duelPage.locator('#file-next').isDisabled(), true);
  await duelPage.setInputFiles('#opponent-file', 'examples/hammer-test.js');
  await duelPage.waitForFunction(() => !document.getElementById('file-next').disabled);
  for (const width of [1440, 768, 390, 320]) {
    await duelPage.setViewportSize({ width, height: 1000 });
    assert.equal(
      await duelPage.evaluate(() => {
        const panel = document.querySelector('.canvas-wrap').getBoundingClientRect();
        const next = document.getElementById('file-next').getBoundingClientRect();
        const overlay = document.getElementById('arena-overlay');
        return next.bottom <= panel.bottom && overlay.scrollHeight <= overlay.clientHeight + 1;
      }),
      true,
      `Duel file selection fits at ${width}px`,
    );
  }
  await duelPage.setViewportSize({ width: 1440, height: 1100 });
  await duelPage.click('#file-next');
  assert.equal(await duelPage.locator('#dummy-count').isVisible(), false);
  await duelPage.click('#settings-next');
  await duelPage.click('#position-next');
  const duelCreated = duelPage.waitForResponse(
    (response) => response.url().endsWith('/api/matches') && response.request().method() === 'POST',
  );
  await duelPage.click('#start-button');
  const duelResponse = await duelCreated;
  assert.equal(duelResponse.status(), 201);
  const duelId = (await duelResponse.json()).id;
  await duelPage.waitForFunction(() =>
    document.getElementById('scoreboard').textContent.includes('이전 ·'),
  );
  await duelPage.request.delete(`http://127.0.0.1:${server.address().port}/api/matches/${duelId}`);
  await duelPage.locator('#analysis-toggle').waitFor({ state: 'visible' });
  await duelPage.click('#analysis-toggle');
  assert.match(await duelPage.locator('#result-analysis').textContent(), /현재 ·/);
  assert.match(await duelPage.locator('#result-analysis').textContent(), /이전 ·/);
  await duelPage.click('#play-again');
  assert.equal(await duelPage.locator('#file-next').isEnabled(), true);
  await duelPage.close();
  const helmetChecks = await page.evaluate(async () => {
    const { loadCharacters, drawCharacter } = await import('/character-renderer.js');
    await loadCharacters();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const frame = (id, pose, hammer) => {
      ctx.clearRect(0, 0, 128, 128);
      drawCharacter(ctx, id, 64, 128, 128, pose, false, hammer);
      return canvas.toDataURL();
    };
    const blank = canvas.toDataURL();
    return ['kobi', 'pengko', 'nyangtami', 'dino', 'lumi'].every((id) => {
      const idle = frame(id, 0, true);
      const walk = frame(id, 1, true);
      const normal = frame(id, 0, false);
      const restored = frame(id, 0, true) === idle && frame(id, 0, false) === normal;
      frame(id, 0, true);
      const transparent = ctx.getImageData(64, 1, 1, 1).data[3] === 0;
      return (
        idle !== blank &&
        walk !== blank &&
        idle !== walk &&
        idle !== normal &&
        restored &&
        transparent
      );
    });
  });
  assert.equal(helmetChecks, true, 'All five helmets render both poses and switch back to normal');
  const directionChecks = await page.evaluate(async () => {
    const { drawDirectionalCharacter } = await import('/character-renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const blank = canvas.toDataURL();
    return ['kobi', 'pengko', 'nyangtami', 'dino', 'lumi'].every((id) => {
      const frames = new Set();
      for (let direction = 0; direction < 4; direction++) {
        for (const hammer of [false, true]) {
          for (let pose = 0; pose < 2; pose++) {
            ctx.clearRect(0, 0, 128, 128);
            drawDirectionalCharacter(ctx, id, 64, 120, 100, direction, pose, hammer);
            const image = canvas.toDataURL();
            if (image === blank || ctx.getImageData(0, 0, 1, 1).data[3] !== 0) return false;
            frames.add(image);
          }
        }
      }
      return frames.size === 16;
    });
  });
  assert.equal(
    directionChecks,
    true,
    'All 80 directional costume/pose sprites must be distinct and visible',
  );
  const coinChecks = await page.evaluate(async () => {
    const { loadCoins, drawCoin, drawCoinPickup } = await import('/coin-renderer.js');
    await loadCoins();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d');
    const frame = (value, time, bornAt) => {
      ctx.clearRect(0, 0, 96, 96);
      drawCoin(ctx, value, 48, 48, time, 0, bornAt);
      return canvas.toDataURL();
    };
    const blank = canvas.toDataURL();
    const visible = [10, 30, 100, 200, 500].every((value) => frame(value, 0) !== blank);
    const animated = [10, 30, 100, 200, 500].every(
      (value) => frame(value, 0) !== frame(value, 180),
    );
    const appearance = frame(500, 50, 0) !== frame(500, 50);
    ctx.clearRect(0, 0, 96, 96);
    drawCoinPickup(
      ctx,
      { coinBurstAt: 0, coinBurstPosition: 0, coinBurstValue: 100, coinBurstBoosted: true },
      100,
      1,
      64,
      16,
    );
    return { visible, animated, appearance, pickup: canvas.toDataURL() !== blank };
  });
  assert.deepEqual(coinChecks, { visible: true, animated: true, appearance: true, pickup: true });
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
  assert.equal(await page.locator('#start-button').textContent(), '게임 시작 →');
  const preparedLayout = await arenaLayout(page);
  let startsDuringCountdown = 0;
  const countStarts = (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/matches')
      startsDuringCountdown++;
  };
  page.on('request', countStarts);
  await page.locator('#start-button').click();
  for (const number of ['3', '2', '1', '시작!']) {
    await page
      .locator('#countdown-number')
      .filter({ hasText: new RegExp(`^${number}$`) })
      .waitFor();
    assert.equal(startsDuringCountdown, 0, 'Server must not start the game during countdown');
    assert.deepEqual(
      await arenaLayout(page),
      preparedLayout,
      'Countdown must preserve the prepared layout',
    );
    assert.equal(await page.locator('#start-button').isDisabled(), true);
  }
  await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
  assert.deepEqual(
    await arenaLayout(page),
    preparedLayout,
    'Playing must preserve the prepared layout',
  );
  page.off('request', countStarts);
  assert.equal(startsDuringCountdown, 1);
  assert.equal(await page.locator('#start-countdown').isVisible(), false);
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
  assert.equal(await page.locator('#game-over').isVisible(), true);
  assert.equal(await page.locator('#result-podium').isVisible(), false);
  assert.equal(await page.locator('#play-again').isVisible(), false);
  const gameOverAt = Date.now();
  await page.screenshot({ path: 'artifacts/game-over.png', fullPage: true });
  await page.locator('#result-podium').waitFor({ state: 'visible' });
  assert.ok(
    Date.now() - gameOverAt >= 2700,
    'Game-over message must remain for about three seconds',
  );
  assert.equal(await page.locator('#game-over').isVisible(), false);
  assert.equal(await page.locator('#arena-overlay').isVisible(), true);
  assert.equal(await page.locator('#file-step').isVisible(), false);
  assert.equal(await page.locator('#setup-progress').isVisible(), false);
  assert.equal(await page.locator('#result-podium .podium-player').count(), 4);
  const resultScores = await page.locator('#result-podium .podium-score').allTextContents();
  assert.equal(resultScores.length, 4);
  const podiumBounds = await page.locator('#result-podium').boundingBox();
  assert.deepEqual(
    await arenaLayout(page),
    preparedLayout,
    'Results must preserve the prepared layout',
  );
  const replayBounds = await page.locator('#play-again').boundingBox();
  assert.ok(replayBounds.y >= podiumBounds.y + podiumBounds.height);
  await page.screenshot({ path: 'artifacts/podium-desktop.png', fullPage: true });
  const resultLayout = await arenaLayout(page);
  await page.locator('#analysis-toggle').click();
  assert.equal(await page.locator('#result-analysis').isVisible(), true);
  assert.equal(await page.locator('#result-podium').isVisible(), false);
  assert.equal(await page.locator('#result-analysis thead th').count(), 5);
  assert.ok((await page.locator('#result-analysis').textContent()).includes('평균 계산 시간'));
  assert.deepEqual(await arenaLayout(page), resultLayout);
  await page.screenshot({ path: 'artifacts/result-analysis-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: 'artifacts/result-analysis-mobile.png', fullPage: true });
  const analysisBounds = await page.locator('#result-analysis').boundingBox();
  assert.ok(analysisBounds.x >= 0 && analysisBounds.x + analysisBounds.width <= 390);
  await page.locator('#analysis-toggle').click();
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/podium-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  assert.equal(await page.locator('#arena-message').innerText(), '경기를 종료했습니다');
  // Exercise distinct ranks: the live smoke match may finish with four tied scores.
  await page.evaluate(async () => {
    const { renderPodium } = await import('/podium.js');
    renderPodium(document.getElementById('result-podium'), [
      { id: 0, name: 'First', characterId: 'lumi', score: 12340 },
      { id: 1, name: 'Second', characterId: 'kobi', score: 9500 },
      { id: 2, name: 'Third', characterId: 'kobi', score: 6800 },
      { id: 3, name: 'Fourth', characterId: 'kobi', score: 3500 },
    ]);
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.locator('#result-podium').evaluate((podium) => {
      const overlay = podium.parentElement;
      return (
        overlay.scrollHeight <= overlay.clientHeight + 1 &&
        [...podium.querySelectorAll('.podium-block')].every((block) => {
          const bounds = block.getBoundingClientRect();
          const score = block.querySelector('.podium-score').getBoundingClientRect();
          return score.bottom <= bounds.bottom && score.top >= bounds.top;
        })
      );
    });
    assert.equal(fits, true, `All podium scores must fit at ${width}px`);
    await page.screenshot({ path: `artifacts/podium-ranks-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#play-again').click();
  assert.equal(await page.locator('#game-status').textContent(), '준비');
  assert.equal(await page.locator('#log-count').textContent(), '0 EVENTS');
  assert.ok(
    (await page.locator('.score-card .score').allTextContents()).every((score) => score === '0'),
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem('coinhunter-match')), null);
  assert.equal(await page.locator('#file-step').isVisible(), true);
  assert.equal(await page.locator('#play-again').isVisible(), false);
  assert.equal(await page.locator('#replay-hint').isVisible(), false);
  assert.equal(await page.locator('#result-podium').isVisible(), false);
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
  await page.locator('#result-podium').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#setup-form').isVisible(), false);
  assert.equal(await page.locator('#result-podium .podium-player').count(), 1);
  await page.locator('#play-again').click();
  assert.equal(await page.locator('#file-label').textContent(), 'timeout.js');
  assert.equal(await page.locator('#file-next').isEnabled(), true);
  assert.deepEqual(errors, []);
  // Exercise the actual snapshot-to-scoreboard path, including dummy equipment changes.
  const equipmentPage = await browser.newPage();
  await equipmentPage.addInitScript(() => {
    sessionStorage.setItem('coinhunter-match', 'equipment-fixture');
    window.EventSource = class {
      addEventListener(name, handler) {
        if (name === 'snapshot')
          window.sendEquipmentSnapshot = (game) =>
            handler({ data: JSON.stringify({ game, logs: [] }) });
      }
      close() {}
    };
  });
  await equipmentPage.route('**/api/matches/equipment-fixture', (route) =>
    route.fulfill({ json: {} }),
  );
  await equipmentPage.goto(`http://127.0.0.1:${server.address().port}/game`);
  await equipmentPage.waitForSelector('#map-select option', { state: 'attached' });
  const equipmentGame = new GameState(MAPS[0], ['User', 'Dummy']);
  equipmentGame.start(0);
  const portraits = [];
  for (const type of [null, 1, 0, 1, null]) {
    equipmentGame.players[1].effect = type === null ? null : { type, remaining: 3, id: 1 };
    await equipmentPage.evaluate(
      (game) => window.sendEquipmentSnapshot(game),
      equipmentGame.snapshot(0),
    );
    portraits.push(
      await equipmentPage
        .locator('.score-card[data-character="kobi"] canvas')
        .evaluate((canvas) => canvas.toDataURL()),
    );
  }
  assert.notEqual(
    portraits[0],
    portraits[1],
    'Dummy portrait must wear a helmet after hammer pickup',
  );
  assert.equal(portraits[0], portraits[2], 'Replacing hammer removes the helmet');
  assert.equal(portraits[1], portraits[3], 'Reacquiring hammer restores the helmet');
  assert.equal(portraits[0], portraits[4], 'Hammer expiration removes the helmet');
  equipmentGame.players[1].score = 30;
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(0),
  );
  assert.deepEqual(
    await equipmentPage
      .locator('#scoreboard .score-card')
      .evaluateAll((cards) => cards.map((card) => Number(card.dataset.player))),
    [1, 0],
  );
  equipmentGame.players[0].score = 30;
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(0),
  );
  assert.deepEqual(
    await equipmentPage
      .locator('#scoreboard .score-card')
      .evaluateAll((cards) => cards.map((card) => Number(card.dataset.player))),
    [1, 0],
  );
  assert.deepEqual(await equipmentPage.locator('#scoreboard .live-rank').allTextContents(), [
    '공동 1위',
    '공동 1위',
  ]);
  equipmentGame.players[0].score = 100;
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(0),
  );
  assert.deepEqual(
    await equipmentPage
      .locator('#scoreboard .score-card')
      .evaluateAll((cards) => cards.map((card) => Number(card.dataset.player))),
    [0, 1],
  );
  await equipmentPage.waitForTimeout(300);
  for (const width of [1440, 390]) {
    await equipmentPage.setViewportSize({ width, height: 1100 });
    const panel = await equipmentPage.locator('#rank-panel').boundingBox();
    const arena = await equipmentPage.locator('.arena.panel').boundingBox();
    assert.ok(
      width === 1440 ? panel.x + panel.width <= arena.x : panel.y >= arena.y + arena.height,
    );
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
    await equipmentPage.screenshot({ path: `artifacts/live-ranks-${width}.png`, fullPage: true });
  }
  const beforeHurry = await arenaLayout(equipmentPage);
  equipmentGame.update(equipmentGame.settings.runningTimeMs);
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(equipmentGame.settings.runningTimeMs),
  );
  assert.equal(await equipmentPage.locator('#hurry-banner').isVisible(), true);
  assert.equal(await equipmentPage.locator('#game-status').textContent(), 'HURRY UP');
  assert.equal(await equipmentPage.locator('#arena-overlay').isVisible(), false);
  assert.deepEqual(await arenaLayout(equipmentPage), beforeHurry);
  await equipmentPage.screenshot({ path: 'artifacts/hurry-up.png', fullPage: true });
  await equipmentPage.locator('#hurry-banner').waitFor({ state: 'hidden' });
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(equipmentGame.settings.runningTimeMs + 100),
  );
  assert.equal(await equipmentPage.locator('#hurry-banner').isVisible(), false);
  equipmentGame.finish('user-stopped');
  await equipmentPage.evaluate(
    (game) => window.sendEquipmentSnapshot(game),
    equipmentGame.snapshot(0),
  );
  assert.equal(await equipmentPage.locator('#rank-panel').isVisible(), true);
  assert.equal(await equipmentPage.locator('#rank-heading').textContent(), '최종 순위');
  await equipmentPage.close();
  console.log(
    'Browser smoke passed: upload, four players, scoring, reconnect, stop, mobile layout, timeout recovery.',
  );
} finally {
  await browser?.close();
  await close();
}
