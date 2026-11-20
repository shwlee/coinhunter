import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createFrontendServer } from '../frontend/server/frontend-server.js';
import { freePort } from './backend-integration.js';

// Browser component test with an in-memory Operations double. No compiler,
// game engine, OAuth provider or real account data is involved.
const content = JSON.parse(await readFile('backend/contracts/generated/game-content.json', 'utf8'));
const sample = await readFile('backend/samples/csharp/nearest-coin.cs', 'utf8');
const algorithms = new Map();
let csharpEnabled = false,
  invalid = false,
  validationLanguage = null,
  storedLanguage = null;
const mock = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/session')
      return json({ user: { id: randomUUID(), email: 'component@company.test', role: 'user' } });
    if (url.pathname === '/api/languages')
      return json({
        contractVersion: 1,
        languages: [
          { id: 'javascript', enabled: true },
          { id: 'csharp', enabled: csharpEnabled, requiresLogin: true },
        ],
      });
    if (url.pathname === '/api/algorithm-assistant/contract') return json(content.contract);
    if (url.pathname === '/api/maps')
      return json({ maps: content.samples.map((item) => item.document) });
    if (url.pathname === '/api/history') return json({ history: [] });
    if (url.pathname === '/api/algorithms' && req.method === 'GET')
      return json({ algorithms: [...algorithms.values()].map(({ source, ...item }) => item) });
    if (url.pathname === '/api/algorithms/validate') {
      validationLanguage = url.searchParams.get('language');
      req.resume();
      return invalid
        ? json(
            {
              error: 'C# 작성 규약 또는 컴파일 검사에 실패했습니다.',
              diagnostic: {
                stage: 'compile',
                details: [
                  { code: 'AX001', message: 'Invalid member declaration', line: 2, column: 3 },
                ],
              },
            },
            400,
          )
        : json({ ok: true, calls: 36 });
    }
    if (/^\/api\/algorithms\/[a-f0-9-]+\/source$/.test(url.pathname)) {
      const item = algorithms.get(url.pathname.split('/')[3]);
      const { source, ...metadata } = item;
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-coinhunter-metadata': encodeURIComponent(JSON.stringify(metadata)),
      });
      return res.end(source);
    }
    if (url.pathname === '/api/algorithms' && req.method === 'POST') {
      let source = '';
      for await (const chunk of req) source += chunk;
      storedLanguage = url.searchParams.get('language');
      const item = {
        id: randomUUID(),
        name: url.searchParams.get('name'),
        revision: 1,
        language: storedLanguage,
        source,
        validation: { state: 'passed', message: '저장됨 · C# 코드 검사 통과' },
      };
      algorithms.set(item.id, item);
      const { source: ignored, ...metadata } = item;
      return json(metadata, 201);
    }
    json({ error: 'Component endpoint not implemented' }, 404);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
let web, browser;
try {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  web = createFrontendServer({
    operationsUrl: `http://127.0.0.1:${mock.address().port}`,
    publicUrl: base,
  });
  await new Promise((resolve) => web.server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({
    executablePath:
      process.env.COINHUNTER_BROWSER ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept('버리기'));
  await page.goto(base + '/editor');
  await page.locator('#workbench').waitFor({ state: 'visible' });
  assert.equal(
    await page
      .locator('#algorithm-language option[value=csharp]')
      .evaluate((option) => option.disabled),
    true,
    await page.locator('#algorithm-language').innerHTML(),
  );
  csharpEnabled = true;
  await page.reload();
  await page.locator('#workbench').waitFor({ state: 'visible' });
  await page.selectOption('#algorithm-language', 'csharp');
  await page.locator('.cm-content[aria-label="C# 알고리즘 코드"]').waitFor();
  assert.match(await page.locator('.cm-content').innerText(), /public int MoveNext/);
  assert.equal(await page.locator('.ai-sidebar').isVisible(), false);
  await page.locator('.cm-content').fill('public class Player {\n  broken declaration\n}');
  invalid = true;
  await page.click('#validate');
  await page.locator('#code-error').waitFor({ state: 'visible' });
  assert.equal(validationLanguage, 'csharp');
  assert.match(await page.locator('#code-error').textContent(), /2줄 3열/);
  assert.match(
    await page.locator('#validation-report').inputValue(),
    /AX001.*Invalid member declaration/,
  );
  invalid = false;
  await page.locator('.cm-content').fill(sample);
  await page.click('#save');
  await page.fill('#name', 'component C#');
  await page.click('#confirm-save');
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(storedLanguage, 'csharp');
  assert.equal(await page.locator('#save-state').textContent(), '저장됨');
  await page.click('#new');
  await page.click('#load-mode');
  await page.selectOption('#library', [...algorithms.keys()][0]);
  await page.click('#open');
  await page.locator('#load-panel').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#algorithm-language').inputValue(), 'csharp');
  assert.match(await page.locator('.cm-content').innerText(), /C# nearest coin/);
  await page.click('#save');
  const download = page.waitForEvent('download');
  await page.click('#export');
  assert.match((await download).suggestedFilename(), /\.cs$/);
  await page.click('#cancel-save');
  await page.click('#testing-view');
  const frame = page.frameLocator('#game');
  await frame.locator('#start-button:enabled').waitFor();
  assert.match(await frame.locator('#algorithm-language-status').textContent(), /C#/);
  assert.equal(await frame.locator('#file-step').isVisible(), false);
  await page.click('#back-to-editor');
  await page.selectOption('#algorithm-language', 'javascript');
  await page.locator('.cm-content[aria-label="JavaScript 알고리즘 코드"]').waitFor();
  assert.equal(await page.locator('.ai-sidebar').isVisible(), true);
  assert.deepEqual(errors, []);
  await mkdir('artifacts/csharp-user-components', { recursive: true });
  await writeFile(
    'artifacts/csharp-user-components/editor.json',
    JSON.stringify(
      {
        passed: true,
        finalAcceptance: false,
        operations: 'in-memory-test-double',
        actualGameStarted: false,
        checks: [
          'disabled capability',
          'C# editor mode',
          'diagnostic source position',
          'language save/load',
          '.cs export',
          'iframe language handoff',
          'JS editor restoration',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'C# editor component smoke: 7 scenarios passed; test doubles only, actual game and final acceptance not run.',
  );
} finally {
  await browser?.close();
  await web?.close();
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
}
