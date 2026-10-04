import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

const dir = await mkdtemp(join(tmpdir(), 'coinhunter-editor-'));
const { server, close } = createGameServer({
  authoring: createAuthoring({
    accounts: new FileAccountRepository(join(dir, 'store.json')),
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.COINHUNTER_BROWSER ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1550, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const warnsOnExit = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  const expectNoDialog = async (action) => {
    const dialogs = [];
    const onDialog = (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    };
    page.on('dialog', onDialog);
    try {
      await action();
    } finally {
      page.off('dialog', onDialog);
    }
    assert.deepEqual(dialogs, []);
  };
  await page.goto(base + '/');
  await page.waitForURL(base + '/signin');
  await page.locator('#guest-link').waitFor({ state: 'visible' });
  assert.match(await page.locator('#destination').textContent(), /홈 화면/);
  assert.equal(await page.locator('.choices').count(), 0);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/signin-desktop.png', fullPage: true });
  await page.click('#guest-link');
  await page.waitForURL(base + '/game');
  await page.goto(base + '/');
  await page.waitForURL(base + '/signin');
  await page.click('#signup-tab');
  await page.waitForURL(base + '/signup?next=%2F');
  await page.locator('#authenticate:enabled').waitFor();
  await page.screenshot({ path: 'artifacts/signup-desktop.png', fullPage: true });
  await page.click('#authenticate');
  await page.waitForURL(base + '/');
  await page.locator('#go-editor[href="/editor"]').waitFor();
  assert.equal(await page.locator('#go-editor img').getAttribute('src'), '/algorithm-braces.svg');
  assert.equal(
    await page.locator('#go-editor img').evaluate((image) => image.naturalWidth > 0),
    true,
  );
  for (const choice of ['#go-editor', '#go-game'])
    assert.equal(
      await page.locator(`${choice} .symbol`).evaluate((icon) => {
        const symbol = icon.getBoundingClientRect();
        const title = icon.closest('.choice-title').querySelector('h2').getBoundingClientRect();
        return Math.abs((symbol.top + symbol.bottom - title.top - title.bottom) / 2) < 1;
      }),
      true,
      `${choice} icon and title share a row`,
    );
  await page.screenshot({ path: 'artifacts/entry-desktop.png', fullPage: true });
  await page.click('#go-editor');
  await page.waitForSelector('#workbench', { state: 'visible' });
  assert.equal(await warnsOnExit(), false, 'The new document does not warn on exit');
  assert.equal(
    await page.locator('#document-origin').textContent(),
    '새 문서 · 아직 저장하지 않음',
  );
  const initialBlank = await page.locator('#code').inputValue();
  assert.match(initialBlank, /initialize\(myNumber, column, row\) \{\s*\}/);
  assert.match(initialBlank, /getName\(\) \{\s*\}/);
  assert.match(initialBlank, /moveNext\(map, myPosition, items\) \{\s*\}/);
  assert.equal(await page.locator('#save-state').textContent(), '미저장');
  for (const [href, label] of [
    ['/', '시작 화면'],
    ['/game', '게임 플레이'],
  ]) {
    const link = page.locator(`.header-nav a[href="${href}"]`);
    assert.equal(await link.getAttribute('aria-label'), label);
    assert.equal(await link.getAttribute('data-tooltip'), label);
    assert.equal(await link.locator('svg use').count(), 1);
    assert.equal((await link.textContent()).trim(), '');
  }
  assert.equal(
    await page.locator('header h1').evaluate((title) => {
      const box = title.getBoundingClientRect();
      return Math.abs((box.left + box.right) / 2 - innerWidth / 2) < 1;
    }),
    true,
    'Workbench title is centered in its own header row',
  );
  assert.equal(await page.locator('header h1 img').getAttribute('src'), '/algorithm-braces.svg');
  assert.equal(
    await page.locator('header h1 img').evaluate((image) => image.naturalWidth > 0),
    true,
  );
  for (const id of [
    'new',
    'load-mode',
    'undo',
    'redo',
    'validate',
    'find',
    'save',
    'open',
    'export',
  ]) {
    const button = page.locator(`#${id}`);
    assert.ok(await button.getAttribute('aria-label'));
    assert.ok(await button.getAttribute('data-tooltip'));
    assert.equal(await button.locator('svg use').count(), 1);
  }
  await page.locator('#undo').hover();
  assert.equal(
    await page
      .locator('#undo')
      .evaluate((button) => getComputedStyle(button, '::after').visibility),
    'visible',
  );
  assert.equal(
    await page
      .locator('#save')
      .evaluate(
        (button) =>
          button.compareDocumentPosition(document.querySelector('#code-editor')) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ),
    2,
  );
  await page.click('#save');
  await page.locator('#save-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#overwrite-option').isVisible(), false);
  assert.match(await page.locator('#save-source').textContent(), /새 문서/);
  await page.click('#cancel-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#save-state').textContent(), '미저장');
  await page
    .locator('.cm-content')
    .fill(await (await page.request.get(base + '/api/example')).text());
  await page.click('#save');
  await page.locator('#name').fill('브라우저 저장 테스트');
  const initialSource = await page.locator('#code').inputValue();
  const exported = page.waitForEvent('download');
  await page.click('#export');
  const download = await exported;
  assert.equal(download.suggestedFilename(), '브라우저_저장_테스트.js');
  assert.equal(await readFile(await download.path(), 'utf8'), initialSource);
  assert.equal(await page.locator('#save-dialog').isVisible(), true);
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  await page
    .locator('#save-state')
    .filter({ hasText: /^저장됨$/ })
    .waitFor();
  assert.equal(
    await page.locator('#document-origin').textContent(),
    '내 계정에 저장됨 · 브라우저 저장 테스트',
  );
  assert.equal(await warnsOnExit(), false, 'Saving the current code clears the exit warning');
  assert.equal(await page.locator('#ai-panel').isVisible(), true);
  assert.equal(await page.locator('#toggle-ai').getAttribute('aria-expanded'), 'true');
  assert.equal(
    await page.locator('#toggle-ai').getAttribute('aria-label'),
    'AI 스크립팅 사이드바 접기',
  );
  assert.equal(
    await page.locator('#toggle-ai').getAttribute('data-tooltip'),
    'AI 스크립팅 사이드바 접기',
  );
  assert.equal(await page.locator('#toggle-ai svg use').getAttribute('href'), '#icon-ai');
  assert.equal((await page.locator('#toggle-ai').textContent()).trim(), '›');
  await page.locator('#toggle-ai').hover();
  assert.equal(
    await page
      .locator('#toggle-ai')
      .evaluate((button) => getComputedStyle(button, '::after').visibility),
    'visible',
  );
  const openEditorWidth = await page
    .locator('#code-panel')
    .evaluate((panel) => panel.getBoundingClientRect().width);
  assert.equal(await page.locator('#ai-panel').isVisible(), true);
  assert.equal(await page.locator('#code-editor').isVisible(), true);
  assert.equal(
    await page.locator('#ai-panel').evaluate((panel) => {
      const code = document.querySelector('#code-panel').getBoundingClientRect();
      return panel.getBoundingClientRect().left > code.right;
    }),
    true,
  );
  await page.click('#toggle-ai');
  assert.equal(await page.locator('#ai-panel').isVisible(), false);
  assert.equal(await page.locator('#toggle-ai').getAttribute('aria-expanded'), 'false');
  assert.equal(
    await page.locator('#toggle-ai').getAttribute('data-tooltip'),
    'AI 스크립팅 사이드바 펼치기',
  );
  assert.equal((await page.locator('#toggle-ai').textContent()).trim(), '‹');
  await page.waitForTimeout(220);
  assert.ok(
    await page
      .locator('#code-panel')
      .evaluate((panel, width) => panel.getBoundingClientRect().width > width, openEditorWidth),
  );
  const original = await page.locator('#code').inputValue();
  await page.locator('.cm-content').fill('const broken = ;');
  assert.equal(await warnsOnExit(), true, 'Editing saved code warns on exit');
  await page.click('#validate');
  await page.locator('#code-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#code-error').textContent(), /1줄 16열/);
  assert.equal(await page.locator('.cm-code-error').count(), 1);
  await page
    .locator('.cm-content')
    .fill(original.replace('this.turn++;', '쟁.ㅁㄴㅇ; this.turn++;'));
  await page.click('#validate');
  await page.locator('#code-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#code-error').textContent(), /선언되지.*쟁/);
  await page
    .locator('.cm-content')
    .fill(original.replace('this.turn++;', 'map.missing.call(); this.turn++;'));
  await page.click('#validate');
  await page.locator('#validation-status[data-state="error"]').waitFor();
  assert.match(await page.locator('#validation-status').textContent(), /moveNext 검사 실패.*예외/);
  await page.locator('.cm-content').fill(original + '\n// edit');
  assert.equal(await warnsOnExit(), true);
  assert.equal(await page.locator('.cm-code-error').count(), 0);
  assert.equal(await page.locator('#code-error').isVisible(), false);
  await page.click('#validate');
  await page.locator('#validation-status[data-state="success"]').waitFor();
  assert.match(await page.locator('#validation-status').textContent(), /검사 통과/);
  assert.equal(await page.locator('#validate').isEnabled(), true);
  await page.click('#toggle-ai');
  await page.click('#generate');
  await page.waitForSelector('#candidate', { state: 'visible' });
  await page.click('#apply');
  assert.equal(await page.locator('#code').inputValue(), original);
  assert.equal(await warnsOnExit(), false, 'Restoring saved code clears the exit warning');
  await page.click('#undo');
  assert.equal(await page.locator('#code').inputValue(), original + '\n// edit');
  await page.click('#save');
  await page.locator('#save-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('input[name="save-kind"]:checked').inputValue(), 'overwrite');
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  await page
    .locator('#save-state')
    .filter({ hasText: /^저장됨$/ })
    .waitFor();
  assert.equal(await warnsOnExit(), false, 'Saving edited code clears the exit warning');
  await page.click('#save');
  await page.locator('input[name="save-kind"][value="copy"]').check();
  await page.locator('#name').fill('브라우저 저장 테스트 복사본');
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#document-title').textContent(), '브라우저 저장 테스트 복사본');
  assert.equal(
    await page.locator('#document-origin').textContent(),
    '내 계정에 저장됨 · 브라우저 저장 테스트 복사본',
  );
  await page.click('#load-mode');
  await page.locator('#load-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.load-options label').count(), 0);
  assert.equal(
    await page.locator('#import').getAttribute('aria-label'),
    '내 PC에서 JavaScript 파일 가져오기',
  );
  assert.equal(
    await page.locator('#library').evaluate((select) => {
      const saved = select.getBoundingClientRect();
      const local = document.querySelector('#import').getBoundingClientRect();
      return Math.abs(saved.top - local.top) < 1 && Math.abs(saved.height - local.height) < 1;
    }),
    true,
    'Saved-code and PC-file controls align',
  );
  await page.screenshot({ path: 'artifacts/editor-load-modal-desktop.png', fullPage: true });
  assert.equal(await page.locator('#create-workspace').isVisible(), true);
  await page.click('#cancel-load');
  await page.locator('#load-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#document-title').textContent(), '브라우저 저장 테스트 복사본');
  await page.click('#load-mode');
  await page.locator('#load-panel').waitFor({ state: 'visible' });
  await page.click('#open');
  await page.locator('#load-error').filter({ hasText: '선택하세요' }).waitFor({ state: 'visible' });
  await page.locator('#import').setInputFiles({
    name: 'local-test.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from(original),
  });
  await page.locator('#load-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#document-title').textContent(), 'local-test');
  assert.equal(
    await page.locator('#document-origin').textContent(),
    '내 PC 파일에서 가져옴 · local-test.js',
  );
  await page.click('#save');
  assert.equal(await page.locator('#overwrite-option').isVisible(), false);
  await page.click('#cancel-save');
  await page.click('#load-mode');
  await page.locator('#load-panel').waitFor({ state: 'visible' });
  await page.locator('#library').selectOption({ label: '브라우저 저장 테스트' });
  await expectNoDialog(() => page.click('#open'));
  await page.locator('#load-panel').waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('#document-origin').textContent(),
    '내 저장 코드에서 불러옴 · 브라우저 저장 테스트',
  );
  assert.equal(await page.locator('#code').inputValue(), original + '\n// edit');
  await page.click('#save');
  assert.equal(await page.locator('#overwrite-option').isVisible(), true);
  assert.match(
    await page.locator('#save-source').textContent(),
    /내 저장 코드에서 불러옴 · 브라우저 저장 테스트/,
  );
  assert.equal(
    await page.locator('#overwrite-label').textContent(),
    '원본 “브라우저 저장 테스트”에 덮어쓰기',
  );
  assert.equal(await page.locator('input[name="save-kind"]:checked').inputValue(), 'overwrite');
  assert.equal(await page.locator('input[name="save-kind"][value="copy"]').isVisible(), true);
  await page.click('#cancel-save');
  assert.equal(await page.locator('#code-editor').isVisible(), true);
  assert.equal(await page.locator('.testing').isVisible(), false);
  assert.equal(await page.locator('#game').getAttribute('src'), null);
  assert.equal(await page.locator('#writing-view').count(), 0);
  assert.equal(
    await page.locator('#testing-view').getAttribute('aria-label'),
    '현재 코드로 테스트',
  );
  assert.equal(
    await page.locator('#testing-view').getAttribute('data-tooltip'),
    '현재 코드로 테스트',
  );
  assert.equal(
    await page.locator('#testing-view').evaluate((button) => {
      const save = document.querySelector('#save').getBoundingClientRect();
      return button.getBoundingClientRect().right < save.left;
    }),
    true,
    'Play and save buttons sit at opposite ends of the editor footer',
  );
  const game = page.frameLocator('#game');
  await page.click('#testing-view');
  await page.locator('.testing').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#test').count(), 0);
  assert.equal(await page.locator('.writing').isVisible(), false);
  assert.equal(await page.locator('.testing h2').count(), 0);
  for (const width of [1550, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(
      await page.locator('#test-info').evaluate((description) => {
        const back = document.querySelector('#back-to-editor').getBoundingClientRect();
        const text = description.getBoundingClientRect();
        return text.left >= back.right && text.top < back.bottom && text.bottom > back.top;
      }),
      true,
      `Test description shares the back-button row at ${width}px`,
    );
    await page
      .locator('.testing-header')
      .screenshot({ path: `artifacts/editor-test-header-${width}.png` });
  }
  await page.setViewportSize({ width: 1550, height: 1100 });
  await game.locator('#settings-step').waitFor({ state: 'visible' });
  assert.equal(
    await game.locator('#start-button').evaluate((button) => {
      const board = document.querySelector('.canvas-wrap').getBoundingClientRect();
      return button.getBoundingClientRect().bottom <= board.bottom;
    }),
    true,
    'Test start button fits inside the board',
  );
  assert.equal(await game.locator('#dummy-count').isVisible(), false);
  for (const selector of [
    '#algorithm-file',
    '#character-step',
    '#black-matter',
    '#destroy-walls',
    '#rank-panel',
    '.legend',
  ])
    assert.equal(await game.locator(selector).isVisible(), false);
  await game.locator('input[name="start-slot"][value="3"]').check();
  await page.route('**/api/matches', async (route) => {
    if (route.request().method() === 'POST')
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/matches') && r.request().method() === 'POST',
  );
  await game.locator('#start-button').click();
  assert.deepEqual(
    await game.locator('#arena-overlay').evaluate((overlay) => ({
      hidden: overlay.hidden,
      background: getComputedStyle(overlay).backgroundColor,
      countingDown: overlay.classList.contains('counting-down'),
    })),
    { hidden: false, background: 'rgb(12, 20, 32)', countingDown: false },
    'The test board stays covered while the match starts',
  );
  const response = await created;
  assert.equal(response.status(), 201);
  const input = response.request().postDataJSON();
  assert.equal(input.startSlot, 3);
  assert.equal(input.dummyCount, 0);
  assert.equal(input.mode, 'practice');
  assert.equal(input.blackMatter, false);
  assert.equal(input.destroyWalls, false);
  assert.ok(['pengko', 'nyangtami', 'dino', 'lumi'].includes(input.characterId));
  const { id } = await response.json();
  await page
    .locator('#testing-view[aria-label="진행 중 테스트 보기"]')
    .waitFor({ state: 'attached' });
  await page.click('#back-to-editor');
  assert.equal(await page.locator('.testing').isVisible(), false);
  await page.locator('.cm-content').fill(original + '\n// changed during test');
  await page.locator('#test-code-state').waitFor({ state: 'visible' });
  assert.match(await page.locator('#test-code-state').textContent(), /실행 중인 코드와 다릅니다/);
  await page.click('#testing-view');
  assert.equal(await page.locator('.testing').isVisible(), true);
  assert.equal(
    await game.locator('body').evaluate(() => sessionStorage.getItem('coinhunter-test-match')),
    id,
    'Returning to the test keeps the same running match',
  );
  await game.locator('#stop-button').waitFor({ state: 'visible' });
  await game.locator('#debug-output').filter({ hasText: '목표' }).waitFor();
  await game.locator('#log-autoscroll').uncheck();
  assert.equal(await game.locator('#log-autoscroll').isChecked(), false);
  await game.locator('#clear-logs').click();
  assert.equal(await game.locator('#log-count').textContent(), '0 EVENTS');
  await page.waitForTimeout(200);
  assert.equal(await game.locator('#log-count').textContent(), '0 EVENTS');
  await page.request.delete(`${base}/api/matches/${id}`);
  await game.locator('#arena-message strong').filter({ hasText: '테스트 종료' }).waitFor();
  assert.equal(
    await page.locator('#testing-view').getAttribute('aria-label'),
    '현재 코드로 테스트',
  );
  assert.equal(await game.locator('#result-podium').isVisible(), false);
  assert.equal(await game.locator('#map-select').isVisible(), true);
  await page.click('#back-to-editor');
  assert.equal(await page.locator('.testing').isVisible(), false);
  assert.equal(await page.locator('.writing').isVisible(), true);
  await page.locator('.cm-content').fill(original + '\n// next test');
  await page.locator('#test-code-state').waitFor({ state: 'visible' });
  assert.match(
    await page.locator('#test-code-state').textContent(),
    /플레이 버튼을 눌러 다시 테스트/,
  );
  await page.click('#testing-view');
  await page.locator('#test-code-state').waitFor({ state: 'hidden' });
  await game.locator('#settings-step').waitFor({ state: 'visible' });
  await page.click('#back-to-editor');
  await page.locator('.cm-content').fill(original + '\n// edit');
  await page.locator('#test-code-state').waitFor({ state: 'visible' });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(
    await page.locator('header h1').evaluate((title) => {
      const box = title.getBoundingClientRect();
      const nav = document.querySelector('.header-nav').getBoundingClientRect();
      return Math.abs((box.left + box.right) / 2 - innerWidth / 2) < 1 && box.top > nav.bottom;
    }),
    true,
    'Mobile workbench title remains centered below navigation',
  );
  assert.equal(
    await page
      .locator('#new')
      .evaluate(
        (button) =>
          Math.round(button.getBoundingClientRect().top) ===
          Math.round(document.querySelector('#load-mode').getBoundingClientRect().top),
      ),
    true,
  );
  if ((await page.locator('#toggle-ai').getAttribute('aria-expanded')) === 'false')
    await page.click('#toggle-ai');
  assert.equal(await page.locator('#ai-panel').isVisible(), true);
  assert.equal(await page.locator('#code-editor').isVisible(), true);
  assert.equal(
    await page.locator('#testing-view').evaluate((button) => {
      const save = document.querySelector('#save').getBoundingClientRect();
      return button.getBoundingClientRect().right < save.left;
    }),
    true,
    'Play and save buttons remain separated on mobile',
  );
  assert.equal(
    await page.locator('#ai-panel').evaluate((panel) => {
      const code = document.querySelector('#code-panel').getBoundingClientRect();
      return panel.getBoundingClientRect().bottom <= code.top;
    }),
    true,
  );
  await page.click('#load-mode');
  await page.locator('#load-panel').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/editor-load-modal-mobile.png', fullPage: true });
  await page.click('#cancel-load');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/editor-mobile.png', fullPage: true });
  await page.locator('#prompt').fill('이전 요청 내용');
  await page.click('#new');
  assert.equal(await page.locator('#document-title').textContent(), '새 알고리즘');
  assert.equal(await warnsOnExit(), false, 'An unsaved new document does not warn on exit');
  const blank = await page.locator('#code').inputValue();
  assert.match(blank, /initialize\(myNumber, column, row\) \{\s*\}/);
  assert.match(blank, /getName\(\) \{\s*\}/);
  assert.match(blank, /moveNext\(map, myPosition, items\) \{\s*\}/);
  assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(await page.locator('#test-code-state').isVisible(), false);
  await expectNoDialog(() => page.click('#new'));
  assert.equal(await page.locator('#code').inputValue(), blank);
  await page.locator('.cm-content').fill(blank + '\n// modified');
  page.once('dialog', (dialog) => {
    assert.match(dialog.message(), /미저장 변경/);
    void dialog.accept('버리기');
  });
  await page.click('#new');
  assert.equal(await page.locator('#code').inputValue(), blank);
  await page.click('#undo');
  assert.equal(await page.locator('#code').inputValue(), blank);
  await page.click('#save');
  assert.equal(await page.locator('#overwrite-option').isVisible(), false);
  await page.click('#cancel-save');
  const second = await browser.newPage();
  await second.goto(base + '/editor');
  await second.waitForURL(/\/signin\?next=%2Feditor/);
  await second.locator('#authenticate:enabled').waitFor();
  await second.click('#authenticate');
  await second.waitForSelector('#library option[value]:not([value=""])', { state: 'attached' });
  assert.ok((await second.locator('#library').textContent()).includes('브라우저 저장 테스트'));
  const guest = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await guest.goto(base + '/signin?next=https%3A%2F%2Fevil.example');
  await guest.locator('#authenticate:enabled').waitFor();
  assert.ok((await guest.locator('#destination').textContent()).includes('홈 화면'));
  assert.equal(
    await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await guest.click('#authenticate');
  await guest.waitForURL(base + '/');
  await guest.locator('#go-editor[href="/editor"]').waitFor();
  await guest.screenshot({ path: 'artifacts/entry-mobile.png', fullPage: true });
  guest.once('dialog', (dialog) => dialog.accept());
  await guest.click('#account-bar button');
  await guest.waitForURL(base + '/signin');
  assert.deepEqual(errors, []);
  console.log(
    'Authoring smoke passed: login, save, AI mock undo, simplified solo test, mobile, second session.',
  );
} finally {
  await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
