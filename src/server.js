import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { mapRepository } from './game/map-repository.js';
import { Match } from './game/match.js';
import { DEFAULT_CHARACTER, isPlayableCharacter } from '../public/characters.js';
import { validateSource } from './runtime/policy.js';
import { createAuthoring } from './authoring-api.js';
import { diskSpace, hasUploadSpace } from './persistence/disk-space.js';
import { cleanupOrphanUploads } from './persistence/upload-cleanup.js';

const sampleSource = await readFile(
  new URL('../examples/nearest-coin.js', import.meta.url),
  'utf8',
);
const assets = new Map([
  ['/', ['home.html', 'text/html; charset=utf-8']],
  ['/game', ['index.html', 'text/html; charset=utf-8']],
  ['/signin', ['auth.html', 'text/html; charset=utf-8']],
  ['/signup', ['auth.html', 'text/html; charset=utf-8']],
  ['/entry.css', ['entry.css', 'text/css; charset=utf-8']],
  ['/coin-hunter-icon.svg', ['coin-hunter-icon.svg', 'image/svg+xml']],
  ['/assets/login-gameplay.mp4', ['assets/login-gameplay.mp4', 'video/mp4']],
  ['/assets/login-gameplay.jpg', ['assets/login-gameplay.jpg', 'image/jpeg']],
  ['/algorithm-braces.svg', ['algorithm-braces.svg', 'image/svg+xml']],
  ['/entry.js', ['entry.js', 'text/javascript; charset=utf-8']],
  ['/editor', ['editor.html', 'text/html; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/code-editor.js', ['generated/code-editor.js', 'text/javascript; charset=utf-8']],
  ['/strategy-templates.js', ['strategy-templates.js', 'text/javascript; charset=utf-8']],
  ['/editor.css', ['editor.css', 'text/css; charset=utf-8']],
  ['/account.js', ['account.js', 'text/javascript; charset=utf-8']],
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

const SMALL_JSON_BYTES = 64 * 1024;
const LEGACY_SOURCE_JSON_BYTES = 2 * 1024 * 1024;
const isSourceUpload = (request) => request.headers['content-type']?.split(';')[0] === 'text/plain';

async function readJson(request, limit = SMALL_JSON_BYTES) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw Object.assign(new Error('JSON 요청이 필요합니다.'), { status: 415 });
  if (Number(request.headers['content-length']) > limit)
    throw Object.assign(new Error('JSON 요청 크기가 허용 범위를 넘었습니다.'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error('JSON 요청 크기가 허용 범위를 넘었습니다.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('잘못된 JSON 요청입니다.'), { status: 400 });
  }
}

export function createGameServer({
  maps = mapRepository,
  authoring = createAuthoring(),
  uploadDirectory = resolve(process.env.SOURCE_UPLOAD_DIR || 'data/uploads'),
} = {}) {
  const matches = new Map();
  const pendingOwners = new Set();
  const streams = new Set();
  let closing = false;
  let activeUploads = 0;
  const uploadCleanup = cleanupOrphanUploads(uploadDirectory).catch((error) => {
    console.error('임시 코드 파일 정리 실패:', error);
  });
  const temporarySourcePath = (directory) =>
    resolve(directory, `${process.pid}-${randomUUID()}.js`);
  async function snapshotStoredSource(ownerId, algorithmId) {
    const directory = resolve(uploadDirectory);
    const path = temporarySourcePath(directory);
    try {
      await uploadCleanup;
      await mkdir(directory, { recursive: true });
      return await authoring.accounts.snapshotSource(ownerId, algorithmId, path);
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
  }
  async function readSourceFile(request) {
    if (!isSourceUpload(request))
      throw Object.assign(new Error('JavaScript 코드 요청이 필요합니다.'), { status: 415 });
    if (activeUploads >= 4)
      throw Object.assign(new Error('동시 코드 업로드 한도에 도달했습니다.'), { status: 429 });
    activeUploads++;
    const directory = resolve(uploadDirectory);
    const path = temporarySourcePath(directory);
    try {
      await uploadCleanup;
      await mkdir(directory, { recursive: true });
      const initialSpace = await diskSpace(directory);
      if (!hasUploadSpace(initialSpace.free, initialSpace.device))
        throw Object.assign(new Error('코드 저장 공간이 부족합니다.'), { status: 507 });
      let bytesSinceCheck = 0;
      const diskGuard = new Transform({
        transform(chunk, encoding, callback) {
          bytesSinceCheck += chunk.length;
          if (bytesSinceCheck < 8 * 1024 * 1024) {
            callback(null, chunk);
            return;
          }
          bytesSinceCheck = 0;
          diskSpace(directory).then(({ free, device }) => {
            if (!hasUploadSpace(free, device))
              callback(Object.assign(new Error('코드 저장 공간이 부족합니다.'), { status: 507 }));
            else callback(null, chunk);
          }, callback);
        },
      });
      await pipeline(request, diskGuard, createWriteStream(path, { flags: 'wx' }));
      return path;
    } catch (error) {
      await unlink(path).catch(() => {});
      if (error.code === 'ENOSPC')
        throw Object.assign(new Error('코드 저장 공간이 부족합니다.'), { status: 507 });
      throw error;
    } finally {
      activeUploads--;
    }
  }
  const json = (response, status, data) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(data));
  };
  const server = http.createServer(async (request, response) => {
    const styleNonce = randomUUID();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
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
      const user = await authoring.current(request);
      if (user) owner = `user:${user.id}`;
      const revoke = async (id) => {
        for (const record of matches.values())
          if (record.owner === `user:${id}`) {
            await record.match.stop('account-ended');
            for (const stream of record.streams || []) stream.end();
          }
      };
      if (request.method === 'GET' && url.pathname === '/api/history' && user) {
        for (const record of matches.values()) {
          if (record.owner !== owner || !record.match.stopping) continue;
          if (!record.finishedAt)
            await new Promise((resolve) => record.match.once('closed', resolve));
          if (record.archivePromise) await record.archivePromise;
        }
      }
      if (
        await authoring.route(request, response, url, user, readJson, json, revoke, readSourceFile)
      )
        return;
      if (request.method === 'GET' && url.pathname === '/' && !user) {
        response.writeHead(302, { Location: '/signin' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/editor' && !user) {
        response.writeHead(302, { Location: '/signin?next=%2Feditor' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        const content = await readFile(new URL('../public/' + file, import.meta.url));
        response.end(
          file === 'editor.html'
            ? content.toString('utf8').replace('__STYLE_NONCE__', styleNonce)
            : content,
        );
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
        const raw = isSourceUpload(request);
        let input;
        if (raw) {
          const options = request.headers['x-coinhunter-options'];
          if (typeof options !== 'string' || options.length > 4096)
            throw Object.assign(new Error('경기 설정을 확인하세요.'), { status: 400 });
          try {
            input = JSON.parse(options);
          } catch {
            throw Object.assign(new Error('경기 설정을 확인하세요.'), { status: 400 });
          }
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            input.algorithmId !== undefined ||
            input.source !== undefined
          )
            throw Object.assign(new Error('경기 설정을 확인하세요.'), { status: 400 });
        } else input = await readJson(request, LEGACY_SOURCE_JSON_BYTES);
        if (input.algorithmId !== undefined) {
          authoring.requireUser(user);
          if (input.source !== undefined)
            throw new Error('파일과 저장 알고리즘 중 하나만 선택하세요.');
        }
        const mode = input.mode ?? 'practice';
        let opponentSourcePath = null;
        if (mode === 'duel') {
          authoring.requireUser(user);
          if (input.opponentSource !== undefined || input.opponentAlgorithmId !== undefined)
            throw new Error('이전 경기 기록을 선택하세요.');
          if (typeof input.opponentHistoryId !== 'string')
            throw new Error('이전 경기 기록을 선택하세요.');
          opponentSourcePath = await authoring.accounts.historySourcePath(
            user.id,
            input.opponentHistoryId,
          );
        }
        if (
          !['practice', 'duel'].includes(mode) ||
          (mode === 'duel' && input.dummyCount !== 0) ||
          (mode === 'practice' &&
            (input.opponentHistoryId !== undefined ||
              input.opponentSource !== undefined ||
              input.opponentAlgorithmId !== undefined))
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
        if (!raw && input.algorithmId === undefined) validateSource(input.source);
        const active = [...matches.values()].filter(
          (record) => record.initializing || !record.match.stopping,
        );
        if (pendingOwners.has(owner) || active.some((record) => record.owner === owner)) {
          json(response, 409, { error: '진행 중인 경기를 먼저 종료하세요.' });
          return;
        }
        if (active.length + pendingOwners.size >= 4) {
          json(response, 429, { error: '동시 경기 한도에 도달했습니다.' });
          return;
        }
        pendingOwners.add(owner);
        let sourcePath;
        let sourceOwnedByMatch = false;
        try {
          const uploadPath = raw ? await readSourceFile(request) : null;
          const snapshotPath =
            input.algorithmId !== undefined
              ? await snapshotStoredSource(user.id, input.algorithmId)
              : null;
          sourcePath = uploadPath || snapshotPath;
          const primarySource = sourcePath ? { path: sourcePath } : input.source;
          const id = randomUUID();
          const match = new Match(
            map,
            mode === 'duel'
              ? [primarySource, { path: opponentSourcePath }]
              : [primarySource, ...Array(input.dummyCount).fill(sampleSource)],
            {
              mode,
              blackMatter: input.blackMatter,
              destroyWalls: input.destroyWalls,
              characterId,
              startSlot,
            },
          );
          const record = {
            owner,
            match,
            initializing: true,
            createdAt: Date.now(),
            streams: new Set(),
          };
          matches.set(id, record);
          pendingOwners.delete(owner);
          sourceOwnedByMatch = true;
          match.once('closed', () => {
            record.finishedAt = Date.now();
            if (
              user &&
              match.state &&
              !['server-shutdown', 'account-ended', 'runtime-failure'].includes(match.state.reason)
            ) {
              const player = match.state.players[0];
              record.archivePromise = authoring.accounts
                .recordMatch(user.id, {
                  matchId: id,
                  mapId: map.id,
                  mapName: map.name,
                  algorithmName: player.name,
                  characterId: player.characterId,
                  score: player.score,
                  reason: match.state.reason,
                  mode,
                  ...(sourcePath ? { sourcePath } : { source: input.source }),
                })
                .catch((error) => {
                  console.error('경기 기록 저장 실패:', error);
                })
                .finally(() => (sourcePath ? unlink(sourcePath).catch(() => {}) : undefined));
            } else if (sourcePath) {
              record.cleanupPromise = unlink(sourcePath).catch(() => {});
            }
          });
          try {
            await match.start();
          } catch (error) {
            matches.delete(id);
            if (sourcePath) await unlink(sourcePath).catch(() => {});
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
        } finally {
          pendingOwners.delete(owner);
          if (sourcePath && !sourceOwnedByMatch) await unlink(sourcePath).catch(() => {});
        }
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
          record.streams.add(response);
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
          const heartbeat = setInterval(async () => {
            try {
              if (user && !(await authoring.current(request))) {
                response.end();
                return;
              }
              response.write(': heartbeat\n\n');
            } catch {
              response.end();
            }
          }, 15000);
          response.on('close', () => {
            clearInterval(heartbeat);
            record.match.off('snapshot', send);
            streams.delete(response);
            record.streams.delete(response);
          });
          return;
        }
        if (request.method === 'DELETE' && !route[2]) {
          await record.match.stop();
          if (record.archivePromise) await record.archivePromise;
          if (record.cleanupPromise) await record.cleanupPromise;
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
    await uploadCleanup;
    await Promise.all([...matches.values()].map((record) => record.match.stop('server-shutdown')));
    await Promise.all([...matches.values()].map((record) => record.archivePromise));
    await Promise.all([...matches.values()].map((record) => record.cleanupPromise));
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
