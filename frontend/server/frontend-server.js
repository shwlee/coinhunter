import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { assets } from './asset-catalog.js';

const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function cleanHeaders(headers) {
  const excluded = new Set([
    ...hopHeaders,
    ...(headers.connection || '').split(',').map((value) => value.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        !excluded.has(key.toLowerCase()) && !/^(forwarded|x-forwarded-|x-original-)/i.test(key),
    ),
  );
}
export function createFrontendServer({ operationsUrl, publicUrl }) {
  const operations = new URL(operationsUrl),
    external = new URL(publicUrl);
  if (operations.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(operations.hostname))
    throw new Error('Operations proxy target must use loopback HTTP.');
  const sockets = new Set();
  const upstreams = new Set();
  let closing = false;
  const json = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error }));
  };
  const forwardHeaders = (req) => ({
    ...cleanHeaders(req.headers),
    host: operations.host,
    'x-forwarded-for': req.socket.remoteAddress.replace(/^::ffff:/, ''),
    'x-forwarded-host': external.host,
    'x-forwarded-proto': external.protocol.slice(0, -1),
  });
  async function session(req) {
    return new Promise((resolve, reject) => {
      const upstream = http.request(
        new URL('/api/session', operations),
        { headers: forwardHeaders(req), timeout: 2000 },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
            if (body.length > 65536) response.destroy(new Error('Session response too large'));
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error('Session unavailable');
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      upstream.once('timeout', () => upstream.destroy(new Error('Session timeout')));
      upstream.once('error', reject);
      upstream.end();
    });
  }
  function proxy(req, res) {
    const upstream = http.request(
      new URL(req.url, operations),
      { method: req.method, headers: forwardHeaders(req), timeout: 60000 },
      (response) => {
        res.writeHead(response.statusCode, cleanHeaders(response.headers));
        void pipeline(response, res).catch(() => upstream.destroy());
      },
    );
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.once('timeout', () => upstream.destroy(new Error('Backend timeout')));
    upstream.once('error', () => {
      if (!res.headersSent) json(res, 503, '서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
      else res.destroy();
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (closing) {
        json(res, 503, '서버 종료 중입니다.');
        return;
      }
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
        json(res, 400, '잘못된 요청 주소입니다.');
        return;
      }
      if (
        Object.keys(req.headers).some((key) => /^(forwarded$|x-forwarded-|x-original-)/i.test(key))
      ) {
        json(res, 403, '전달 헤더를 직접 지정할 수 없습니다.');
        return;
      }
      if (req.headers.host !== external.host) {
        const alternate = new URL(external);
        alternate.hostname = alternate.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        if (
          ['localhost', '127.0.0.1'].includes(external.hostname) &&
          req.headers.host === alternate.host
        ) {
          res.writeHead(302, { Location: new URL(req.url, external).href });
          res.end();
          return;
        }
        json(res, 403, '허용되지 않은 호스트입니다.');
        return;
      }
      if (req.headers.origin && req.headers.origin !== external.origin) {
        json(res, 403, '동일한 사이트에서 요청해야 합니다.');
        return;
      }
      // Never resolve an absolute client URL as the upstream target (SSRF/open proxy).
      if (!req.url.startsWith('/') || req.url.startsWith('//')) {
        json(res, 400, '잘못된 요청 주소입니다.');
        return;
      }
      const path = new URL(req.url, external).pathname;
      if (path === '/api' || path.startsWith('/api/')) {
        proxy(req, res);
        return;
      }
      if (req.method !== 'GET' || !assets.has(path)) {
        json(res, 404, '페이지를 찾을 수 없습니다.');
        return;
      }
      const admin =
        path === '/admin' ||
        path.startsWith('/admin/') ||
        ['/admin.js', '/map-editor.js', '/map-management.js'].includes(path);
      if (path === '/' || path === '/editor' || admin) {
        const current = await session(req);
        if (!current.user) {
          res.writeHead(302, {
            Location: '/signin?next=' + encodeURIComponent(path.endsWith('.js') ? '/admin' : path),
          });
          res.end();
          return;
        }
        if (admin && current.user.role !== 'admin') {
          json(res, 403, '관리자 권한이 필요합니다.');
          return;
        }
      }
      const nonce = randomUUID();
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
      );
      const [file, type] = assets.get(path);
      const content = await readFile(new URL('../public/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type });
      res.end(
        file === 'editor.html'
          ? content.toString('utf8').replace('__STYLE_NONCE__', nonce)
          : content,
      );
    } catch {
      if (!res.headersSent) json(res, 503, '서버에 연결할 수 없습니다.');
      else res.destroy();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return {
    server,
    async close() {
      closing = true;
      for (const upstream of upstreams) upstream.destroy();
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
