import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
if (!executablePath) throw new Error('COINHUNTER_BROWSER에 Chromium 실행 경로를 지정하세요.');

const ffmpeg = process.env.COINHUNTER_FFMPEG || 'ffmpeg';
const output = fileURLToPath(new URL('../public/assets/login-gameplay.mp4', import.meta.url));
const poster = fileURLToPath(new URL('../public/assets/login-gameplay.jpg', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'coinhunter-login-video-'));
const { server, close } = createGameServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  const recordMatch = async (mapId, character) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto(base + '/game');
    await page.locator(`#map-select option[value="${mapId}"]`).waitFor({ state: 'attached' });
    await page
      .locator('#algorithm-file')
      .setInputFiles(fileURLToPath(new URL('../examples/nearest-coin.js', import.meta.url)));
    await page.locator('#file-next').click();
    await page.locator('#map-select').selectOption(mapId);
    await page.locator('#settings-next').click();
    await page.locator(`.character-card.${character}`).click();
    await page.locator('#position-next').click();
    await page.locator('#start-button').click();
    await page.locator('#game-status').filter({ hasText: '진행 중' }).waitFor();
    await page.waitForTimeout(800);
    const base64 = await page.locator('#board').evaluate(async (canvas) => {
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) throw new Error('브라우저가 WebM 녹화를 지원하지 않습니다.');
      const stream = canvas.captureStream(24);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1200000 });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const finished = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = reject;
      });
      recorder.start(1000);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      recorder.stop();
      await finished;
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: mimeType });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    });
    const recording = join(temporary, `${mapId}.webm`);
    await writeFile(recording, Buffer.from(base64, 'base64'));
    await page.close();
    return recording;
  };
  const first = await recordMatch('crossroads', 'lumi');
  const second = await recordMatch('four-courtyards', 'dino');
  await mkdir(fileURLToPath(new URL('../public/assets/', import.meta.url)), { recursive: true });
  let size;
  for (const quality of [32, 34, 36, 38, 40]) {
    const encode = spawnSync(
      ffmpeg,
      [
        '-y',
        '-i',
        first,
        '-i',
        second,
        '-an',
        '-filter_complex',
        '[0:v]fps=15,scale=960:800,setsar=1,format=yuv420p[first];[1:v]fps=15,scale=960:800,setsar=1,format=yuv420p[second];[first][second]concat=n=2:v=1:a=0[out]',
        '-map',
        '[out]',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        String(quality),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        output,
      ],
      { encoding: 'utf8' },
    );
    if (encode.status !== 0) throw new Error(encode.stderr || encode.error?.message);
    size = (await stat(output)).size;
    if (size <= 1_000_000) break;
  }
  if (size > 1_000_000) throw new Error(`로그인 영상이 1MB를 초과합니다: ${size} bytes`);
  const frame = spawnSync(
    ffmpeg,
    ['-y', '-ss', '2', '-i', output, '-frames:v', '1', '-q:v', '3', poster],
    { encoding: 'utf8' },
  );
  if (frame.status !== 0) throw new Error(frame.stderr || frame.error?.message);
  console.log(`Recorded real gameplay: ${output} (${size} bytes)`);
} finally {
  if (browser) await browser.close();
  await close();
  await rm(temporary, { recursive: true, force: true });
}
