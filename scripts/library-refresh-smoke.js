import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { createAuthoring } from '../src/authoring-api.js';
import { createGameServer } from '../src/server.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const dir = await mkdtemp(join(tmpdir(), 'coinhunter-library-'));
const accounts = new FileAccountRepository(join(dir, 'store.json'));
const user = await accounts.bootstrapAdmin('library@company.test');
const first = await accounts.save(user.id, null, { name: 'first', source: '// first' });
const second = await accounts.save(user.id, null, { name: 'second', source: '// second' });
const app = createGameServer({
  authoring: createAuthoring({ accounts, authConfig: { mode: 'mock' } }),
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const gates = [];
try {
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext();
  const login = await context.request.post(base + '/api/auth/mock', {
    headers: { origin: base },
    data: { email: user.email },
  });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/editor');
  await page.locator('#workbench').waitFor({ state: 'visible' });
  await page.locator('#library').evaluate((select, id) => {
    select.value = id;
  }, first.id);
  const queue = [];
  await page.route('**/api/algorithms', async (route) => {
    const gate = queue.shift();
    assert.ok(gate, 'Every library request has a controlled response');
    gate.entered.resolve();
    await gate.release.promise;
    await route.fulfill({
      status: gate.status,
      contentType: 'application/json',
      body: JSON.stringify(gate.body),
    });
  });
  async function startRefresh(key, algorithms, status = 200) {
    const gate = {
      entered: deferred(),
      release: deferred(),
      status,
      body: status === 200 ? { algorithms } : { error: '목록 갱신 실패' },
    };
    gates.push(gate);
    queue.push(gate);
    await page.evaluate((key) => {
      const dialog = document.querySelector('#load-panel');
      if (dialog.open) dialog.close();
      window[key] = document.querySelector('#load-mode').onclick();
    }, key);
    await gate.entered.promise;
    return async () => {
      gate.release.resolve();
      await page.evaluate((key) => window[key], key);
    };
  }

  const finish = await startRefresh('selectionRefresh', [first, second]);
  await page.locator('#library').selectOption(second.id);
  await finish();
  assert.equal(await page.locator('#library').inputValue(), second.id);
  await page.click('#open');
  await page.locator('#document-title').filter({ hasText: second.name }).waitFor();
  assert.equal(await page.locator('#code').inputValue(), second.source);

  const old = await startRefresh('oldRefresh', [first]);
  const latest = await startRefresh('latestRefresh', [first, { ...second, name: 'latest' }]);
  await latest();
  await old();
  assert.equal(await page.locator('#library').inputValue(), second.id);
  assert.equal(await page.locator(`#library option[value="${second.id}"]`).textContent(), 'latest');

  const staleFailure = await startRefresh('staleFailure', [], 503);
  const successful = await startRefresh('successfulRefresh', [first, second]);
  await successful();
  await staleFailure();
  assert.equal(await page.locator('#load-error').isVisible(), false);
  assert.equal(await page.locator('#library').inputValue(), second.id);

  const failure = await startRefresh('failedRefresh', [], 503);
  await page.locator('#library').selectOption(first.id);
  await failure();
  assert.equal(await page.locator('#load-error').isVisible(), true);
  assert.equal(await page.locator('#library').inputValue(), first.id);
  assert.equal(await page.locator('#library option').count(), 3);

  const deleted = await startRefresh('deletedRefresh', [second]);
  await deleted();
  assert.equal(await page.locator('#library').inputValue(), '');
  await page.click('#open');
  assert.match(await page.locator('#load-error').textContent(), /선택하세요/);
  assert.equal(await page.locator('#code').inputValue(), second.source);
  assert.deepEqual(errors, []);
  console.log(
    'Library refresh smoke passed: selection, loaded source, response ordering, failures, removed selection.',
  );
} finally {
  for (const gate of gates) gate.release.resolve();
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
