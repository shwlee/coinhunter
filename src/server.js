import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mapRepository } from './game/map-repository.js';
import { Match } from './game/match.js';
import { DEFAULT_CHARACTER, isPlayableCharacter } from '../public/characters.js';
import { MAX_SOURCE_BYTES, validateSource } from './runtime/policy.js';

const sampleSource = await readFile(
  new URL('../examples/nearest-coin.js', import.meta.url),
  'utf8',
);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/coin-renderer.js', ['coin-renderer.js', 'text/javascript; charset=utf-8']],
  ['/podium.js', ['podium.js', 'text/javascript; charset=utf-8']],
  ['/result-analysis.js', ['result-analysis.js', 'text/javascript; charset=utf-8']],
  ['/leaderboard.js', ['leaderboard.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/characters.js', ['characters.js', 'text/javascript; charset=utf-8']],
  ['/character-renderer.js', ['character-renderer.js', 'text/javascript; charset=utf-8']],
  ['/assets/characters/atlas.png', ['assets/characters/atlas.png', 'image/png']],
  ['/assets/characters/atlas-hammer.png', ['assets/characters/atlas-hammer.png', 'image/png']],
]);
for (const direction of ['left', 'up', 'right', 'down'])
  assets.set(`/assets/characters/${direction}.png`, [
    `assets/characters/${direction}.png`,
    'image/png',
  ]);
for (const file of [
  'Coins.png',
  'Diamond.png',
  'blackmatter.png',
  'appear_blackmatter.png',
  'frames.json',
])
  assets.set('/assets/coins/' + file, [
    'assets/coins/' + file,
    file.endsWith('.json') ? 'application/json' : 'image/png',
  ]);

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw Object.assign(new Error('JSON 요청이 필요합니다.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // JSON can represent a single source byte with up to six escaped bytes.
    if (size > MAX_SOURCE_BYTES * 6 * 2 + 8192)
      throw Object.assign(new Error('업로드 크기를 초과했습니다.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('잘못된 JSON 요청입니다.'), { status: 400 });
  }
}

export function createGameServer({ maps = mapRepository } = {}) {
  const matches = new Map();
  const streams = new Set();
  let closing = false;
  const json = (response, status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(data));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    const address = server.address();
    const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    if (!allowedHosts.has(request.headers.host)) {
      json(response, 403, { error: '허용되지 않은 호스트입니다.' });
      return;
    }
    if (request.headers.origin) {
      let origin;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        /* malformed or opaque origin */
      }
      if (!origin || origin.protocol !== 'http:' || !allowedHosts.has(origin.host)) {
        json(response, 403, { error: '동일한 사이트에서 요청해야 합니다.' });
        return;
      }
    }
    let owner = request.headers.cookie?.match(/(?:^|;\s*)coinhunter=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (!owner) {
      owner = randomUUID();
      response.setHeader('Set-Cookie', `coinhunter=${owner}; HttpOnly; SameSite=Strict; Path=/`);
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(new URL('../public/' + file, import.meta.url)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/maps') {
        json(response, 200, { maps: maps.listPublished() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/example') {
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="nearest-coin.js"',
        });
        response.end(sampleSource);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/matches') {
        if (closing) {
          json(response, 503, { error: '서버 종료 중입니다.' });
          return;
        }
        const input = await readJson(request);
        const mode = input.mode ?? 'practice';
        if (
          !['practice', 'duel'].includes(mode) ||
          (mode === 'duel' && input.dummyCount !== 0) ||
          (mode === 'practice' && input.opponentSource !== undefined)
        ) {
          json(response, 400, { error: '대결 모드에서는 이전 알고리즘 1개만 참가할 수 있습니다.' });
          return;
        }
        const startSlot = input.startSlot === undefined ? 0 : input.startSlot;
        if (!Number.isInteger(startSlot) || startSlot < 0 || startSlot > 3) {
          json(response, 400, { error: '시작 위치를 확인하세요.' });
          return;
        }
        const characterId = input.characterId === undefined ? DEFAULT_CHARACTER : input.characterId;
        if (!isPlayableCharacter(characterId)) {
          json(response, 400, { error: '선택할 수 없는 캐릭터입니다.' });
          return;
        }
        const map = maps.getPublished(input.mapId);
        if (
          !map ||
          !Number.isInteger(input.dummyCount) ||
          input.dummyCount < 0 ||
          input.dummyCount > 3 ||
          typeof input.blackMatter !== 'boolean' ||
          typeof input.destroyWalls !== 'boolean'
        ) {
          json(response, 400, { error: '맵과 더미·기믹 설정을 확인하세요.' });
          return;
        }
        validateSource(input.source);
        if (mode === 'duel') validateSource(input.opponentSource);
        const active = [...matches.values()].filter(
          (record) => record.initializing || !record.match.stopping,
        );
        if (active.some((record) => record.owner === owner)) {
          json(response, 409, { error: '진행 중인 경기를 먼저 종료하세요.' });
          return;
        }
        if (active.length >= 4) {
          json(response, 429, { error: '동시 경기 한도에 도달했습니다.' });
          return;
        }
        const id = randomUUID();
        const match = new Match(
          map,
          mode === 'duel'
            ? [input.source, input.opponentSource]
            : [input.source, ...Array(input.dummyCount).fill(sampleSource)],
          {
            mode,
            blackMatter: input.blackMatter,
            destroyWalls: input.destroyWalls,
            characterId,
            startSlot,
          },
        );
        const record = { owner, match, initializing: true, createdAt: Date.now() };
        matches.set(id, record);
        match.once('closed', () => {
          record.finishedAt = Date.now();
        });
        try {
          await match.start();
        } catch (error) {
          matches.delete(id);
          throw error;
        }
        record.initializing = false;
        if (closing) {
          await match.stop('server-shutdown');
          json(response, 503, { error: '서버 종료 중입니다.' });
          return;
        }
        json(response, 201, { id });
        return;
      }
      const route = url.pathname.match(/^\/api\/matches\/([a-f0-9-]+)(?:\/(events))?$/);
      if (route) {
        const record = matches.get(route[1]);
        if (!record || record.owner !== owner) {
          json(response, 404, { error: '경기를 찾을 수 없습니다.' });
          return;
        }
        if (request.method === 'GET' && route[2] === 'events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'keep-alive',
          });
          streams.add(response);
          const send = (snapshot) => {
            if (response.writableLength > 256 * 1024) {
              response.destroy();
              return;
            }
            response.write(
              'id: ' +
                snapshot.sequence +
                '\nevent: snapshot\ndata: ' +
                JSON.stringify(snapshot) +
                '\n\n',
            );
          };
          if (record.match.latest) send(record.match.latest);
          record.match.on('snapshot', send);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
          response.on('close', () => {
            clearInterval(heartbeat);
            record.match.off('snapshot', send);
            streams.delete(response);
          });
          return;
        }
        if (request.method === 'DELETE' && !route[2]) {
          await record.match.stop();
          json(response, 200, { ok: true });
          return;
        }
        if (request.method === 'GET' && !route[2]) {
          json(response, 200, record.match.latest);
          return;
        }
      }
      json(response, 404, { error: '요청을 찾을 수 없습니다.' });
    } catch (error) {
      if (!response.headersSent)
        json(response, error.status || 400, { error: String(error.message).slice(0, 500) });
      else response.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const prune = setInterval(() => {
    for (const [id, record] of matches)
      if (record.finishedAt && Date.now() - record.finishedAt > 300000) matches.delete(id);
  }, 30000);
  prune.unref();
  const close = async () => {
    closing = true;
    clearInterval(prune);
    await Promise.all([...matches.values()].map((record) => record.match.stop('server-shutdown')));
    for (const stream of streams) stream.end();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, close } = createGameServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Coin Hunter: http://127.0.0.1:${port}`));
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await close();
    });
}
