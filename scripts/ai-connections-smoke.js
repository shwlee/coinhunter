import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/server.js';
import { createAuthoring } from '../src/authoring-api.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { readAiConfig } from '../src/ai/config.js';
import { createAiProviders } from '../src/ai/providers.js';

async function wait(page, predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('AI browser state did not settle');
}

const dir = await mkdtemp(join(tmpdir(), 'coin-ai-browser-'));
const providers = createAiProviders({
  fetchImpl: async (_, options) => {
    const key =
      options.headers.Authorization?.replace('Bearer ', '') ||
      options.headers['x-api-key'] ||
      options.headers['x-goog-api-key'];
    if (key === 'invalid-fixture')
      return new Response('{"error":"invalid-fixture"}', { status: 401 });
    return new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-5', display_name: 'Model A' },
          { id: 'gpt-5-mini' },
          { id: 'gpt-5-2025-08-07' },
          { id: 'gpt-image-1' },
          { id: 'text-embedding-3-small' },
        ],
        has_more: false,
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Model A',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    );
  },
});
const authoring = createAuthoring({
  accounts: new FileAccountRepository(join(dir, 'accounts.json')),
  authConfig: { mode: 'mock' },
  aiConfig: readAiConfig({
    AI_ENABLED: 'true',
    AI_ALLOW_STORED_CREDENTIALS: 'true',
    AI_CONNECTION_COOLDOWN_MS: '1',
  }),
  aiEnv: {
    AI_DATA_DIR: join(dir, 'ai'),
    AI_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
    AI_CREDENTIAL_KEY_ID: 'fixture',
  },
  aiProviders: providers,
});
const { server, close } = createGameServer({ authoring });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.COINHUNTER_BROWSER ||
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(base + '/api/auth/mock', {
    data: { email: 'developer@company.test' },
  });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/editor');
  await page.locator('#ai-manage:enabled').waitFor();
  const original = await page.locator('#code').inputValue();
  await page.locator('#ai-manage').click();
  await page.locator('#ai-dialog[open]').waitFor();
  await page.locator('#ai-provider').selectOption('openai');
  await page.locator('#ai-setup-next').click();
  await page.locator('#ai-guide-step').waitFor({ state: 'visible' });
  assert.match(await page.locator('#ai-guide-title').textContent(), /OpenAI/);
  assert.equal(await page.locator('#ai-guide-instructions li').count(), 5);
  assert.equal(await page.locator('#ai-api-key').isVisible(), false);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ai-key-guide-desktop.png', fullPage: true });
  await page.locator('#ai-setup-next').click();
  await page.locator('#ai-connection-name').fill('My OpenAI');
  await page.locator('#ai-credential-mode').selectOption('stored');
  await page.locator('#ai-api-key').fill('invalid-fixture');
  await page.locator('#ai-submit-connection').click();
  await wait(page, () => document.getElementById('ai-dialog-status').dataset.error === 'true');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  assert.match(await page.locator('#ai-error-help').textContent(), /키 원문/);
  assert.equal(await page.locator('#ai-connection option').count(), 1);
  await page.locator('#ai-api-key').fill('valid-fixture');
  await page.locator('#ai-submit-connection').click();
  await wait(page, () =>
    document.getElementById('ai-dialog-status').textContent.includes('연결 확인을 마쳤습니다'),
  );
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  await page.locator('#ai-model-step').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ai-setup-finish').isDisabled(), true);
  assert.deepEqual(await page.locator('#ai-setup-model option').allTextContents(), [
    '모델 선택',
    'GPT-5',
    'GPT-5 Mini',
  ]);
  await page.locator('#ai-setup-model').selectOption('gpt-5-mini');
  await page.locator('#ai-setup-finish').click();
  await page.locator('#ai-dialog').waitFor({ state: 'hidden' });
  await page.locator('#ai-model:enabled').waitFor();
  await page.locator('#ai-model').selectOption('gpt-5-mini');
  await wait(
    page,
    async () =>
      (await (await fetch('/api/ai/connections')).json()).preference.modelId === 'gpt-5-mini',
  );
  const id = await page.locator('#ai-connection').inputValue();
  await page.reload();
  await wait(page, () => document.getElementById('ai-model').value === 'gpt-5-mini');
  assert.equal(await page.locator('#ai-connection').inputValue(), id);
  await page.locator('#ai-manage').click();
  await page.locator('#ai-dialog[open]').waitFor();
  assert.equal(await page.locator('#ai-provider').isDisabled(), true);
  await page.locator('#ai-connection-name').fill('Renamed OpenAI');
  await page.locator('#ai-save-name').click();
  await wait(page, () =>
    document.getElementById('ai-dialog-status').textContent.includes('이름을 저장'),
  );
  await page.locator('#ai-api-key').fill('invalid-fixture');
  await page.locator('#ai-submit-connection').click();
  await wait(page, () => document.getElementById('ai-dialog-status').dataset.error === 'true');
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  await page.locator('#ai-check-connection').click();
  await wait(page, () =>
    document.getElementById('ai-dialog-status').textContent.includes('모델 목록 조회를 마쳤습니다'),
  );
  await page.locator('#ai-add-connection').click();
  await page.locator('#ai-provider').selectOption('gemini');
  await page.locator('#ai-setup-next').click();
  assert.match(await page.locator('#ai-guide-title').textContent(), /Gemini/);
  assert.equal(
    await page.locator('#ai-key-console').getAttribute('href'),
    'https://aistudio.google.com/apikey',
  );
  await page.locator('#ai-setup-next').click();
  await page.locator('#ai-connection-name').fill('My Gemini');
  await page.locator('#ai-api-key').fill('second-fixture');
  await page.locator('#ai-submit-connection').click();
  await wait(page, () =>
    document.getElementById('ai-dialog-status').textContent.includes('연결 확인을 마쳤습니다'),
  );
  await page.locator('#ai-setup-model').selectOption('gemini-2.5-pro');
  await page.locator('#ai-setup-finish').click();
  await page.locator('#ai-dialog').waitFor({ state: 'hidden' });
  await page.locator('#ai-model:enabled').waitFor();
  assert.equal(await page.locator('#ai-model option').count(), 2);
  await page.locator('#ai-model').selectOption('gemini-2.5-pro');
  await wait(
    page,
    async () =>
      (await (await fetch('/api/ai/connections')).json()).preference.modelId === 'gemini-2.5-pro',
  );
  await page.locator('#ai-refresh-models').click();
  await page.locator('#ai-refresh-models:enabled').waitFor();
  assert.equal(await page.locator('#code').inputValue(), original);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ai-connections-desktop.png', fullPage: true });
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
  assert.equal(
    (
      await second.request.post(base + '/api/auth/mock', {
        data: { email: 'developer@company.test' },
      })
    ).status(),
    200,
  );
  const mobile = await second.newPage();
  await mobile.goto(base + '/editor');
  await mobile.locator('#ai-manage:enabled').waitFor();
  assert.equal(
    await mobile.locator('#ai-connection option').count(),
    2,
    'Only persistent connection is shared across logins',
  );
  await mobile.locator('#ai-manage').click();
  await mobile.locator('#ai-dialog[open]').waitFor();
  await mobile.locator('#ai-managed-connection').selectOption(id);
  await mobile.locator('#ai-close-dialog').click();
  await mobile.locator('#ai-connection').selectOption(id);
  await mobile.locator('#ai-refresh-models').click();
  await mobile.locator('#ai-model:enabled').waitFor();
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mobile.locator('#ai-manage').click();
  await mobile.locator('#ai-dialog[open]').waitFor();
  await mobile.screenshot({ path: 'artifacts/ai-connections-mobile.png', fullPage: true });
  await mobile.locator('#ai-add-connection').click();
  await mobile.locator('#ai-provider').selectOption('anthropic');
  await mobile.locator('#ai-setup-next').click();
  assert.match(await mobile.locator('#ai-guide-title').textContent(), /Claude/);
  const nextBounds = await mobile.locator('#ai-setup-next').boundingBox();
  assert.ok(
    nextBounds && nextBounds.y + nextBounds.height <= 844,
    'Wizard navigation stays visible while instructions scroll',
  );
  await mobile.screenshot({ path: 'artifacts/ai-key-guide-mobile.png', fullPage: true });
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mobile.locator('#ai-setup-next').click();
  await mobile.locator('#ai-api-key').fill('abandoned-fixture');
  await mobile.locator('#ai-setup-back').click();
  assert.equal(await mobile.locator('#ai-api-key').inputValue(), '');
  await mobile.locator('#ai-close-dialog').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#ai-manage').click();
  await page.locator('#ai-dialog[open]').waitFor();
  await page.locator('#ai-delete-connection').click();
  await wait(page, () =>
    document.getElementById('ai-dialog-status').textContent.includes('삭제했습니다'),
  );
  assert.equal(await page.locator('#ai-api-key').inputValue(), '');
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) => /credential|api.?key|connection/i.test(key)),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'AI connection browser smoke passed: verify, add, rename, key failure preservation, models, preferences, session isolation, delete and mobile. Provider transport was replaced.',
  );
} finally {
  await browser.close();
  await close();
  await rm(dir, { recursive: true, force: true });
}
