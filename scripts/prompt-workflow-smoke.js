import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { MapRepository } from '../src/game/map-repository.js';
import { DEFAULT_MAP_SETTINGS } from '../src/game/maps.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';
import { readAiConfig } from '../src/ai/config.js';

// Exercise the real local pipeline. External AI output and the OS clipboard are fixtures.
const dir = await mkdtemp(join(tmpdir(), 'coinhunter-prompt-workflow-'));
const accounts = new FileAccountRepository(join(dir, 'accounts.json'));
const maps = new MapRepository({ dataDirectory: join(dir, 'maps') });
const uploads = join(dir, 'uploads');
const map = await maps.saveDraft({
  schemaVersion: 1,
  id: 'prompt-workflow',
  name: '프롬프트 통합 검사',
  description: '네 개의 코인을 모두 수집하는 통합 검사 전용 맵',
  revision: 1,
  columns: 4,
  rows: 4,
  tiles: [0, 0, 0, 0, 0, 10, 10, 0, 0, 10, 10, 0, 0, 0, 0, 0],
  settings: { ...DEFAULT_MAP_SETTINGS, actionMs: 400, itemFirstMs: 60000 },
});
await maps.publish(map.id, map.revision);
const { server, close } = createGameServer({
  maps,
  uploadDirectory: uploads,
  authoring: createAuthoring({
    accounts,
    authConfig: { mode: 'mock' },
    aiConfig: readAiConfig({ AI_ENABLED: 'false' }),
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const parseRequest = (text) =>
  JSON.parse(
    text.slice(
      text.indexOf('[요청 데이터 — JSON]\n') + '[요청 데이터 — JSON]\n'.length,
      text.lastIndexOf('\n\n[출력 형식]\n'),
    ),
  );
const poll = async (check) => {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Prompt workflow did not settle');
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.__copiedText = text;
        },
      },
    });
  });
  const login = await context.request.post(base + '/api/auth/mock', {
    data: { email: 'developer@company.test' },
  });
  assert.equal(login.status(), 200);
  const { user } = await login.json();
  const errors = [],
    aiRequests = [],
    externalRequests = [],
    writes = [];
  const guardRequest = async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== base) {
      externalRequests.push(url.origin);
      await route.abort();
      return;
    }
    if (url.pathname.startsWith('/api/ai/')) aiRequests.push(url.pathname);
    if (request.method() !== 'GET' && /^\/api\/algorithms(?:\/[a-f0-9-]+)?$/.test(url.pathname))
      writes.push({ method: request.method(), path: url.pathname });
    await route.continue();
  };
  const monitor = async (ctx) => {
    ctx.on('page', (opened) => opened.on('pageerror', (error) => errors.push(error.message)));
    await ctx.route('**/*', guardRequest);
  };
  await monitor(context);
  const page = await context.newPage();
  await page.goto(base + '/editor');
  await page.locator('#open-code-import:enabled').waitFor();
  assert.equal(await page.locator('#assistant-prompt-tab').getAttribute('aria-selected'), 'true');
  await page.locator('[name="strategy-template"][value="nearestCoin"]').check();
  await page.locator('#prompt').fill('벽을 피해 코인을 모두 수집하세요.');
  await page.locator('#generate-prompt:enabled').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  let request = parseRequest(await page.evaluate(() => window.__copiedText));
  assert.equal(request.intent, 'generate');
  assert.deepEqual(
    request.priorities.map(({ name, weight }) => ({ name, weight })),
    [{ name: '근처 코인', weight: 5 }],
  );
  assert.equal(Object.hasOwn(request, 'source'), false);
  assert.equal((await accounts.list(user.id)).length, 0);

  const fixture = await readFile(new URL('../examples/nearest-coin.js', import.meta.url), 'utf8');
  // Return code is a known fixture, not a claim that any external AI generated it.
  const returned = fixture + '\n// 프롬프트 반환 코드 테스트 대역';
  const importSource = async (source) => {
    const before = await page.locator('#code').inputValue();
    await page.locator('#open-code-import').click();
    await page.locator('#imported-code').fill('```javascript\n' + source + '\n```');
    await page.locator('#check-imported-code').click();
    await page.locator('#import-code-status[data-state="success"]').waitFor();
    assert.equal(await page.locator('#code').inputValue(), before);
    await page.locator('#apply-imported-code:enabled').click();
    await page.locator('#code-import-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#code').inputValue(), source);
  };
  await importSource(returned);
  assert.equal(writes.length, 0, 'Import and apply must not save');
  let releaseGame;
  const gameScript = new Promise((resolve) => {
    releaseGame = resolve;
  });
  await page.route('**/app.js', async (route) => {
    await gameScript;
    await route.continue();
  });
  await page.locator('#testing-view').click();
  const game = page.frameLocator('#game');
  try {
    await game.locator('#file-step').waitFor({ state: 'attached' });
    assert.equal(
      await page.locator('#game').isVisible(),
      false,
      'Initial file-selection markup cannot flash while the game script loads',
    );
    assert.equal(await page.locator('#test-preparing').isVisible(), true);
  } finally {
    releaseGame();
  }
  await page.locator('#game').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#test-preparing').isVisible(), false);
  assert.equal(await game.locator('#file-step').isVisible(), false);
  assert.equal(await game.locator('#character-step').isVisible(), false);
  await game.locator('#settings-step').waitFor({ state: 'visible' });
  assert.equal(await game.locator('#test-score').isVisible(), true);
  assert.equal(await game.locator('#test-score-value').textContent(), '0');
  await game.locator('#map-select').selectOption(map.id);
  await game.locator('input[name="start-slot"][value="3"]').check();
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/matches' && r.request().method() === 'POST',
  );
  await game.locator('#start-button').click();
  const response = await created;
  assert.equal(response.status(), 201);
  const { id: matchId } = await response.json();
  const options = JSON.parse(response.request().headers()['x-coinhunter-options']);
  assert.equal(options.mapId, map.id);
  assert.equal(options.startSlot, 3);
  assert.equal(options.dummyCount, 0);
  assert.equal(options.mode, 'practice');
  assert.equal(response.request().postData(), returned, 'The imported source is actually played');
  await game
    .locator('#test-score-value')
    .filter({ hasText: /^(10|20|30)$/ })
    .waitFor();
  assert.equal(await game.locator('#rank-panel').isVisible(), false);
  await game.locator('#arena-message strong').filter({ hasText: '테스트 종료' }).waitFor();
  const match = await (await context.request.get(`${base}/api/matches/${matchId}`)).json();
  assert.equal(match.game.status, 'finished');
  assert.equal(match.game.reason, 'coins-collected');
  const player = match.game.players[0];
  assert.equal(player.score, 40);
  assert.ok(player.stats.algorithmCalls > 0);
  assert.equal(player.stats.penalties, 0);
  assert.equal(player.stats.timeouts, 0);
  assert.equal(player.stats.exceptions, 0);
  assert.equal(await game.locator('#test-score-value').textContent(), String(player.score));
  await mkdir('artifacts', { recursive: true });
  const headerLayout = () =>
    game.locator('.arena-heading').evaluate((heading) => {
      const header = heading.getBoundingClientRect();
      const score = document.getElementById('test-score').getBoundingClientRect();
      const title = document.getElementById('arena-title').getBoundingClientRect();
      const status = document.getElementById('game-status').getBoundingClientRect();
      return (
        score.left >= header.left &&
        score.right <= header.right &&
        score.top >= header.top &&
        score.bottom <= header.bottom &&
        title.right <= score.left &&
        title.bottom <= status.top &&
        status.height < 30 &&
        document.documentElement.scrollWidth <= innerWidth
      );
    });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await headerLayout(), true, `Test score fits beside the title at ${width}px`);
    await game.locator('#test-score-value').evaluate((value) => {
      value.textContent = '1,200,000';
    });
    assert.equal(await headerLayout(), true, `Large scores fit without overflow at ${width}px`);
    await game.locator('#test-score-value').evaluate((value) => {
      value.textContent = '40';
    });
    await game
      .locator('.arena-heading')
      .screenshot({ path: `artifacts/test-score-header-${width}.png` });
  }
  await page.screenshot({ path: 'artifacts/test-score-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#back-to-editor').click();
  assert.equal(await page.locator('#code').inputValue(), returned);
  const expiredTestSession = async (route) => {
    if (route.request().frame().parentFrame())
      await route.fulfill({ status: 401, json: { error: '다시 로그인하세요.' } });
    else await route.continue();
  };
  await page.route('**/api/session', expiredTestSession);
  await page.locator('#testing-view').click();
  await page
    .locator('#test-preparing')
    .filter({ hasText: '테스트를 준비하지 못했습니다.' })
    .waitFor();
  assert.equal(await page.locator('#game').isVisible(), false);
  assert.equal(await page.locator('.testing').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#code').inputValue(), returned);
  await page.unroute('**/api/session', expiredTestSession);
  await page.locator('#back-to-editor').click();
  await page.locator('#testing-view').click();
  await page.locator('#game').waitFor({ state: 'visible' });
  await game.locator('#test-score-value').filter({ hasText: /^0$/ }).waitFor();
  await page.locator('#back-to-editor').click();
  assert.equal((await accounts.list(user.id)).length, 0, 'Test play must not save the document');
  await page.locator('#save').click();
  assert.equal(await page.locator('#save-options').isVisible(), false);
  await page.locator('#name').fill('프롬프트로 만든 코인 수집');
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  let saved = (await accounts.list(user.id))[0];
  assert.equal(writes.length, 1);
  assert.equal((await accounts.get(user.id, saved.id)).source, returned);

  // Fresh editor navigation retains the account document; modify its prompt and overwrite it.
  await page.goto(base + '/editor?algorithmId=' + saved.id);
  await page.locator('#document-title').filter({ hasText: saved.name }).waitFor();
  assert.equal(await page.locator('#code').inputValue(), returned);
  await page.locator('#prompt').fill('코인 수집을 유지하며 이름을 변경하세요.');
  await page.locator('#prompt-include-source:enabled').check();
  await page.locator('#generate-prompt:enabled').click();
  await page.locator('#copy-prompt:enabled').click();
  await page.locator('#prompt-copy-status').filter({ hasText: '복사했습니다' }).waitFor();
  request = parseRequest(await page.evaluate(() => window.__copiedText));
  assert.equal(request.intent, 'modify');
  assert.equal(request.source, returned);
  const modified = returned.replace("'길찾기 '", "'수집가 '");
  assert.notEqual(modified, returned);
  await importSource(modified);
  assert.equal(writes.length, 1);
  assert.equal((await accounts.get(user.id, saved.id)).source, returned);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#code').inputValue(), returned);
  await page.locator('#redo').click();
  assert.equal(await page.locator('#code').inputValue(), modified);
  await page.locator('#save').click();
  assert.equal(await page.locator('[name="save-kind"][value="overwrite"]').isChecked(), true);
  await page.locator('#confirm-save').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].method, 'PUT');
  assert.equal((await accounts.list(user.id)).length, 1);
  saved = await accounts.get(user.id, saved.id);
  assert.equal(saved.source, modified);
  assert.equal(saved.revision, 2);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await monitor(other);
  const otherLogin = await other.request.post(base + '/api/auth/mock', {
    data: { email: 'tester@company.test' },
  });
  assert.equal(otherLogin.status(), 200);
  const denied = await other.request.get(`${base}/api/algorithms/${saved.id}/source`);
  assert.equal(denied.status(), 404, 'Another account cannot read the imported saved code');
  const signedIn = await other.request.post(base + '/api/auth/mock', {
    data: { email: 'developer@company.test' },
  });
  assert.equal(signedIn.status(), 200);
  const mobile = await other.newPage();
  await mobile.goto(base + '/editor?algorithmId=' + saved.id);
  await mobile.locator('#document-title').filter({ hasText: saved.name }).waitFor();
  assert.equal(await mobile.locator('#code').inputValue(), modified);
  assert.equal(await mobile.locator('#save-state').textContent(), '저장됨');
  assert.equal(await mobile.locator('#prompt-include-source').isChecked(), false);
  assert.equal(await mobile.locator('#prompt-preview-text').isVisible(), true);
  assert.equal(await mobile.locator('#prompt-preview-text').inputValue(), '');
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await poll(async () => (await readdir(uploads).catch(() => [])).length === 0);
  assert.deepEqual(aiRequests, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    'Prompt workflow passed: strategy/copy, real import validation, apply, actual 40-point completed match, explicit save/reload, modify/undo/overwrite, account isolation and mobile restore. External AI output and clipboard are fixtures; AI disabled.',
  );
} finally {
  if (browser) await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
