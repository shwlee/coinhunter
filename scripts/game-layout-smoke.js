import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/server.js';
import { GameState } from '../src/game/state.js';
import { MAPS } from '../src/game/map-repository.js';

const { server, close } = createGameServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    sessionStorage.setItem('coinhunter-match', 'layout-fixture');
    window.EventSource = class {
      addEventListener(name, handler) {
        if (name === 'snapshot')
          window.sendSnapshot = (game, logs = []) =>
            handler({ data: JSON.stringify({ game, logs }) });
      }
      close() {}
    };
  });
  await page.route('**/api/matches/layout-fixture', (route) => route.fulfill({ json: {} }));
  await page.goto(`http://127.0.0.1:${server.address().port}/game`);
  await page.locator('#map-select option').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(300);
  const game = new GameState(MAPS[0], ['User', 'Dummy', 'Dummy', 'Dummy']);
  game.start(0);
  const layout = () =>
    page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      boxes: [
        '.arena.panel',
        '.canvas-wrap',
        '#rank-panel',
        '.logs',
        '#debug-output',
        'footer',
      ].map((selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height };
      }),
    }));
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate((snapshot) => window.sendSnapshot(snapshot), game.snapshot(0));
    await page.waitForTimeout(300);
    const initial = await layout();
    const logs = Array.from({ length: 40 }, (_, turn) => ({
      player: turn % 4,
      turn: turn + 1,
      elapsedMs: 20,
      status: 'ok',
      direction: 0,
      lines: ['긴 디버그 출력 '.repeat(60)],
      dropped: 0,
    }));
    await page.evaluate(({ snapshot, logs }) => window.sendSnapshot(snapshot, logs), {
      snapshot: game.snapshot(0),
      logs,
    });
    assert.deepEqual(await layout(), initial, `Debug logs must preserve layout at ${width}px`);
    await page.locator('#clear-logs').click();
    assert.deepEqual(await layout(), initial, `Clearing logs must preserve layout at ${width}px`);
    game.players[3].score += 1000000;
    game.players[3].effect = { type: 1, remaining: 3, id: 1 };
    await page.evaluate((snapshot) => window.sendSnapshot(snapshot), game.snapshot(0));
    assert.deepEqual(await layout(), initial, `Rank animation must preserve layout at ${width}px`);
    await page.waitForTimeout(300);
    assert.deepEqual(await layout(), initial);
  }
  console.log('Game layout browser smoke passed');
} finally {
  if (browser) await browser.close();
  await close();
}
