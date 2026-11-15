import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { launchSplit } from './backend-integration.js';

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
const source = `module.exports=class{initialize(n,c){this.c=c;this.d=2;}getName(){return 'motion-probe';}moveNext(map,p){if(p%this.c===this.c-1)this.d=0;else if(p%this.c===0)this.d=2;return this.d;}}`;
const app = await launchSplit();
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const base = 'http://127.0.0.1:' + app.publicPort;
  const cases = [];
  for (const mapId of ['crossroads', 'four-courtyards']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.motionTrace = { snapshots: [], frames: [] };
      const add = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, listener, ...rest) {
        if (type !== 'snapshot') return add.call(this, type, listener, ...rest);
        return add.call(
          this,
          type,
          function (event) {
            const data = JSON.parse(event.data);
            window.motionTrace.snapshots.push({ at: performance.now(), game: data.game });
            return listener.call(this, event);
          },
          ...rest,
        );
      };
    });
    await page.goto(base + '/signin');
    if (page.url().includes('/signin')) {
      await page.locator('#authenticate:enabled').waitFor();
      await page.selectOption('#identity', 'admin@company.test');
      await page.click('#authenticate');
      await page.waitForURL(base + '/');
    }
    await page.goto(base + '/game');
    await page.locator('#map-select option').first().waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      const { GamePresentation } = await import('/game-presentation.js');
      const sample = GamePresentation.prototype.sample;
      GamePresentation.prototype.sample = function (now) {
        const view = sample.call(this, now);
        if (view && ['playing', 'hurryup'].includes(view.game.status)) {
          const p = view.game.players[0],
            a = p.action;
          window.motionTrace.frames.push({
            at: now,
            turn: p.turn,
            thinking: p.thinking,
            action: a?.type,
            startedAt: a?.startedAt,
            progress: a
              ? Math.max(0, Math.min(1, (view.time - a.startedAt) / (a.endsAt - a.startedAt)))
              : 0,
          });
        }
        return view;
      };
    });
    await page.setInputFiles('#algorithm-file', {
      name: 'motion.js',
      mimeType: 'text/plain',
      buffer: Buffer.from(source),
    });
    await page.click('#file-next');
    await page.locator('#settings-step').waitFor({ state: 'visible' });
    await page.selectOption('#map-select', mapId);
    await page.selectOption('#dummy-count', '3');
    await page.click('#settings-next');
    await page.click('#position-next');
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/matches') && response.request().method() === 'POST',
    );
    await page.click('#start-button');
    const response = await created;
    assert.equal(response.status(), 201, await response.text());
    const id = (await response.json()).id;
    await page.waitForTimeout(6500);
    const trace = await page.evaluate(() => window.motionTrace);
    await page.request.delete(base + '/api/matches/' + id);
    const arrivals = trace.snapshots.filter((row) => row.game.status === 'playing');
    const seen = new Set(),
      ages = [];
    for (const row of arrivals) {
      const action = row.game.players[0].action;
      if (action?.type === 'move' && !seen.has(action.startedAt)) {
        seen.add(action.startedAt);
        ages.push(row.game.serverTime - action.startedAt);
      }
    }
    let backsteps = 0,
      run = 0;
    const holds = [];
    for (let i = 0; i < trace.frames.length; i++) {
      const frame = trace.frames[i],
        previous = trace.frames[i - 1];
      if (
        previous &&
        previous.startedAt === frame.startedAt &&
        frame.progress < previous.progress - 0.001
      )
        backsteps++;
      if ((frame.action === 'move' && frame.progress >= 1) || (!frame.action && frame.thinking))
        run++;
      else if (run) {
        holds.push(run);
        run = 0;
      }
    }
    if (run) holds.push(run);
    const report = {
      mapId,
      frames: trace.frames.length,
      snapshotIntervalMs: stats(arrivals.slice(1).map((row, i) => row.at - arrivals[i].at)),
      frameIntervalMs: stats(trace.frames.slice(1).map((row, i) => row.at - trace.frames[i].at)),
      newMoveFirstSnapshotAgeMs: stats(ages),
      holdRunFrames: stats(holds),
      sameActionProgressBacksteps: backsteps,
      heldFrames: trace.frames.filter(
        (frame) =>
          (frame.action === 'move' && frame.progress >= 1) || (!frame.action && frame.thinking),
      ).length,
    };
    assert.deepEqual(errors, []);
    assert.equal(backsteps, 0);
    assert.ok(ages.length >= 6, 'enough actual move transitions');
    assert.ok(report.snapshotIntervalMs.p50 < 45, 'SSE must no longer wait for a fixed 60ms poll');
    cases.push(report);
    console.log('PASS motion ' + JSON.stringify(report));
    await page.close();
  }
  let baseline = null;
  try {
    baseline = JSON.parse(await readFile('artifacts/motion-diagnosis.json', 'utf8')).browser;
  } catch {
    /* optional previous local measurement */
  }
  await writeFile(
    'artifacts/game-motion-report.json',
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        renderDelayMs: 40,
        cases,
        baseline,
        limitations:
          'Local synthetic browser reference; real algorithm computation and OS scheduling gaps remain authoritative.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await app.close();
}
