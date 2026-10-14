import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createGameServer } from '../src/server.js';
import { createAuthoring } from '../src/authoring-api.js';
import { FileAccountRepository } from '../src/persistence/file-account-repository.js';
import { readAiConfig } from '../src/ai/config.js';
import { createAiProviders } from '../src/ai/providers.js';
import { createOpenAiGeneration } from '../src/ai/openai-generation.js';
import { openAiStreamResponse } from './fixtures/openai-stream.js';

async function wait(page, predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('AI browser state did not settle');
}

const dir = await mkdtemp(join(tmpdir(), 'coin-ai-browser-'));
const generatedSource = await readFile(
  new URL('../examples/nearest-coin.js', import.meta.url),
  'utf8',
);
let generationCalls = 0,
  badCandidate = false,
  heldGeneration = null,
  lastGenerationInput;
const generationProvider = createOpenAiGeneration({
  fetchImpl: async (_, options) => {
    generationCalls++;
    lastGenerationInput = JSON.parse(JSON.parse(options.body).input);
    return openAiStreamResponse(
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  source: badCandidate
                    ? 'module.exports = class Player { getName(){ return missingName; } }'
                    : generatedSource,
                  explanation: '테스트 응답 · 가까운 코인 전략',
                }),
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      },
      { gate: heldGeneration, delayMs: generationCalls === 1 ? 1600 : 10 },
    );
  },
});
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
  aiGenerationProviders: { openai: generationProvider },
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
  assert.equal(await page.locator('#ai-openai-notice').isVisible(), true);
  assert.match(await page.locator('#ai-openai-notice').textContent(), /ChatGPT 구독과 별도 과금/);
  await page.locator('#ai-setup-next').click();
  await page.locator('#ai-guide-step').waitFor({ state: 'visible' });
  assert.match(await page.locator('#ai-guide-title').textContent(), /OpenAI/);
  assert.equal(await page.locator('#ai-guide-instructions li').count(), 5);
  assert.equal(await page.locator('#ai-api-key').isVisible(), false);
  assert.equal(await page.locator('#ai-openai-billing-step').isVisible(), true);
  assert.equal(
    await page.locator('#ai-openai-billing').getAttribute('href'),
    'https://platform.openai.com/settings/organization/billing/overview',
  );
  assert.equal(
    await page
      .locator('#ai-openai-billing')
      .evaluate(
        (node) =>
          !!(
            node.compareDocumentPosition(document.getElementById('ai-key-console')) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
    true,
  );
  assert.equal(await page.locator('#ai-setup-next').textContent(), 'API 키 입력으로');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ai-key-guide-desktop.png', fullPage: true });
  await page.locator('#ai-setup-next').click();
  assert.equal(await page.locator('#ai-openai-notice').isVisible(), true);
  assert.equal(await page.locator('#ai-openai-key-help').isVisible(), true);
  assert.equal(await page.locator('#ai-key-label').textContent(), 'OpenAI API 키');
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
  await page
    .locator('#prompt')
    .fill('가까운 코인을 우선해서 길을 찾고 debug.print로 목표를 표시하세요.');
  await page.locator('#ai-generate:enabled').waitFor();
  await page.locator('#ai-generate').click();
  await wait(page, () =>
    document.getElementById('ai-generation-status').textContent.includes('수신하고 있습니다'),
  );
  assert.equal(await page.locator('#ai-generation-progress').getAttribute('data-active'), 'true');
  assert.match(
    await page.locator('#ai-generation-received').textContent(),
    /응답 [1-9][\d,]*자 수신/,
  );
  assert.equal(await page.locator('#candidate').isVisible(), false);
  assert.equal(await page.locator('#code').inputValue(), original);
  assert.equal(await page.locator('[data-stage="receive"]').getAttribute('aria-current'), 'step');
  await wait(
    page,
    () => document.getElementById('ai-generation-elapsed').textContent !== '경과 0초',
  );
  await page.screenshot({ path: 'artifacts/ai-streaming-progress-desktop.png', fullPage: true });
  await page.locator('#candidate').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ai-generation-progress').getAttribute('data-active'), 'false');
  const elapsedAfterFinish = await page.locator('#ai-generation-elapsed').textContent();
  await page.waitForTimeout(1100);
  assert.equal(
    await page.locator('#ai-generation-elapsed').textContent(),
    elapsedAfterFinish,
    'Elapsed clock stops at completion',
  );
  assert.equal(
    await page.locator('#code').inputValue(),
    original,
    'Generation must preserve editor code',
  );
  assert.equal(await page.locator('#candidate-code').textContent(), generatedSource);
  assert.match(await page.locator('#candidate-info').textContent(), /검사 통과.*30/);
  await page.locator('#apply').click();
  assert.equal(await page.locator('#code').inputValue(), generatedSource);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#code').inputValue(), original);
  await page.locator('#ai-modify:enabled').waitFor();
  await page.locator('#ai-modify').click();
  await wait(page, () =>
    document.getElementById('ai-generation-status').textContent.includes('생성·검사 완료'),
  );
  assert.equal(lastGenerationInput.source, original, 'Modify uses request-time source snapshot');
  assert.equal(lastGenerationInput.intent, 'modify');
  assert.equal(await page.locator('#code').inputValue(), original);
  await page.reload();
  await wait(page, () => document.getElementById('ai-model').value === 'gpt-5-mini');
  await page.locator('#candidate').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#candidate-code').textContent(), generatedSource);
  assert.match(await page.locator('#notice').textContent(), /후보를 복원/);
  assert.equal(generationCalls, 2, 'Restoring a candidate must not call the provider again');
  await page.locator('#prompt').fill('가까운 코인을 수집하세요.');
  badCandidate = true;
  await page.locator('#ai-generate:enabled').waitFor();
  await page.locator('#ai-generate').click();
  await wait(page, () =>
    document.getElementById('ai-generation-status').textContent.includes('실행 검사 실패'),
  );
  await page.locator('#candidate').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#apply').isDisabled(), true);
  assert.equal(await page.locator('#code').inputValue(), original);
  badCandidate = false;
  let releaseGeneration;
  heldGeneration = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  await page.locator('#ai-generate:enabled').waitFor();
  await page.locator('#ai-generate').click();
  await wait(page, () =>
    document.getElementById('ai-generation-status').textContent.includes('수신하고 있습니다'),
  );
  await page.locator('#cancel-ai').click();
  releaseGeneration();
  heldGeneration = null;
  await page.waitForTimeout(300);
  assert.equal(
    await page.locator('#candidate').isVisible(),
    false,
    'Late cancelled result must not appear',
  );
  assert.equal(await page.locator('#ai-generation-progress').isVisible(), false);
  assert.equal(await page.locator('#code').inputValue(), original);
  assert.equal(generationCalls, 4);
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
  assert.equal(await page.locator('#ai-generate').isDisabled(), true);
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
  await mobile.locator('#ai-model').selectOption('gpt-5-mini');
  await mobile.locator('#prompt').fill('벽을 피하고 가까운 코인을 수집하세요.');
  let releaseMobile;
  heldGeneration = new Promise((resolve) => {
    releaseMobile = resolve;
  });
  await mobile.locator('#ai-generate:enabled').waitFor();
  await mobile.locator('#ai-generate').click();
  await wait(mobile, () =>
    document.getElementById('ai-generation-status').textContent.includes('수신하고 있습니다'),
  );
  await mobile.locator('#ai-generation-progress').scrollIntoViewIfNeeded();
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mobile.screenshot({ path: 'artifacts/ai-streaming-progress-mobile.png' });
  await mobile.locator('#cancel-ai').click();
  releaseMobile();
  heldGeneration = null;
  assert.equal(await mobile.locator('#ai-generation-progress').isVisible(), false);
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mobile.locator('#ai-manage').click();
  await mobile.locator('#ai-dialog[open]').waitFor();
  await mobile.screenshot({ path: 'artifacts/ai-connections-mobile.png', fullPage: true });
  await mobile.locator('#ai-add-connection').click();
  await mobile.locator('#ai-provider').selectOption('openai');
  await mobile.locator('#ai-setup-next').click();
  assert.equal(await mobile.locator('#ai-openai-notice').isVisible(), true);
  const billingBounds = await mobile.locator('#ai-openai-billing').boundingBox();
  const navigationBounds = await mobile.locator('#ai-setup-next').boundingBox();
  assert.ok(
    billingBounds &&
      navigationBounds &&
      billingBounds.y + billingBounds.height <= navigationBounds.y,
    'Billing action is visible before scrolling on mobile',
  );
  await mobile.locator('#ai-connection-form').evaluate((form) => {
    form.scrollTop = form.scrollHeight;
  });
  const noticeBounds = await mobile.locator('#ai-openai-notice').boundingBox();
  assert.ok(
    noticeBounds && noticeBounds.y >= 0 && noticeBounds.y + noticeBounds.height <= 844,
    'Billing notice stays visible while guide scrolls',
  );
  await mobile.locator('#ai-connection-form').evaluate((form) => {
    form.scrollTop = 0;
  });
  await mobile.screenshot({ path: 'artifacts/ai-openai-billing-mobile.png', fullPage: true });
  await mobile.locator('#ai-setup-back').click();
  await mobile.locator('#ai-provider').selectOption('anthropic');
  assert.equal(await mobile.locator('#ai-openai-notice').isVisible(), false);
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
