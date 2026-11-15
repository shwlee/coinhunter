import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceAssembly, serviceEnvironment } from './backend-tools.js';
import { createFrontendServer } from '../frontend/server/frontend-server.js';
import { DEFAULT_MAP_SETTINGS, validateMapDocument } from '../backend/node/src/game/maps.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
export function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers, timeout: 45000 },
      (res) => {
        const buffers = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) res.destroy(new Error('Unexpected response size'));
          else buffers.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          const text = Buffer.concat(buffers).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            /* source/HTML/SSE */
          }
          resolveRequest({ status: res.statusCode, headers: res.headers, text, body: json });
        });
      },
    );
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('Integration timeout')));
    req.end(body);
  });
}
export async function launchSplit({ browser = false } = {}) {
  const parent = resolve(root, 'artifacts');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'backend-integration-'));
  const operationsPort = await freePort(),
    executionPort = await freePort(),
    publicPort = await freePort();
  const key = randomBytes(32).toString('base64url');
  const adminId = randomUUID();
  await mkdir(join(directory, 'operations/accounts'), { recursive: true });
  await writeFile(
    join(directory, 'operations/accounts/store.json'),
    JSON.stringify({
      users: [{ id: adminId, email: 'admin@company.test', active: true, role: 'admin' }],
      identities: [],
      algorithms: [],
      history: [],
      matches: [],
    }),
  );
  const hosts = [];
  async function launch(name, port) {
    const child = spawn('dotnet', [serviceAssembly(name)], {
      cwd: join(root, 'backend'),
      windowsHide: true,
      env: serviceEnvironment({
        ASPNETCORE_ENVIRONMENT: 'Development',
        DOTNET_ENVIRONMENT: 'Development',
        COINHUNTER_INTERNAL_KEY: key,
        AUTH_MODE: 'mock',
        Backend__RepositoryRoot: root,
        Backend__DataRoot: join(directory, 'operations'),
        Backend__ExchangeRoot: join(directory, 'exchange'),
        Backend__ExecutionRoot: join(directory, 'execution'),
        Backend__ListenUrl: `http://127.0.0.1:${port}`,
        Backend__ExecutionUrl: `http://127.0.0.1:${executionPort}`,
        Backend__PublicUrl: `http://127.0.0.1:${publicPort}`,
        Backend__UseStdinControl: 'true',
        ...(name.includes('Operations') ? { Backend__TrustedProxies__0: '127.0.0.1' } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-16000);
      });
    child.stdin.on('error', () => {});
    const exited = new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    const host = { child, exited, port, output: () => output.replaceAll(key, '[internal-key]') };
    hosts.push(host);
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(host.output());
      try {
        if ((await request(port, '/health/live')).status === 200) return host;
      } catch {
        /* starting */
      }
      await wait(100);
    }
    throw new Error('Host startup failed: ' + host.output());
  }
  let web;
  const stopHost = async (host) => {
    if (host.child.exitCode !== null || host.child.signalCode !== null) return;
    host.child.stdin.end('shutdown\n');
    const timer = setTimeout(() => host.child.kill(), 15000);
    try {
      assert.equal(await host.exited, 0, host.output());
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async ({ keep = false } = {}) => {
    if (web) await web.close();
    for (const host of [...hosts].reverse()) await stopHost(host);
    if (
      (!keep && directory.startsWith(parent + '\\')) ||
      (!keep && directory.startsWith(parent + '/'))
    )
      await rm(directory, { recursive: true, force: true });
  };
  try {
    const execution = await launch('CoinHunter.Execution.Host', executionPort);
    const operations = await launch('CoinHunter.Operations.Api', operationsPort);
    web = createFrontendServer({
      operationsUrl: `http://127.0.0.1:${operationsPort}`,
      publicUrl: `http://127.0.0.1:${publicPort}`,
    });
    await new Promise((resolveListen) => web.server.listen(publicPort, '127.0.0.1', resolveListen));
    function client() {
      const jar = new Map();
      return async (path, options = {}) => {
        const response = await request(publicPort, path, {
          ...options,
          headers: {
            cookie: [...jar].map(([name, value]) => name + '=' + value).join('; '),
            ...options.headers,
          },
        });
        for (const cookie of response.headers['set-cookie'] || []) {
          const [name, value] = cookie.split(';')[0].split('=');
          jar.set(name, value);
        }
        return response;
      };
    }
    return {
      directory,
      key,
      adminId,
      operations,
      execution,
      publicPort,
      client,
      close,
      stopHost,
      launch,
      hosts,
      browser,
    };
  } catch (error) {
    await close({ keep: true });
    throw error;
  }
}

export async function verifySplitBackend() {
  const app = await launchSplit();
  let checks = 0;
  const check = async (name, action) => {
    await action();
    console.log('PASS ' + name);
    checks++;
  };
  const admin = app.client(),
    guest = app.client(),
    other = app.client();
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const expect = (response, status) => {
    assert.equal(response.status, status, response.text.slice(0, 1000));
    return response.body;
  };
  const example = await readFile(join(root, 'backend/node/examples/nearest-coin.js'), 'utf8');
  let algorithm, map, state, matchId;
  const sharedRequestKey = randomUUID();
  try {
    await check('Business readiness and internal/browser authorization boundaries', async () => {
      expect(await request(app.operations.port, '/health/ready'), 200);
      expect(await request(app.execution.port, '/internal/v1/status'), 401);
      expect(
        await request(app.execution.port, '/internal/v1/status', {
          headers: { authorization: 'Bearer ' + app.key, origin: 'http://example.invalid' },
        }),
        403,
      );
      expect(await guest('/api/algorithms'), 401);
      expect(await guest('/api/admin/users'), 401);
      expect(await guest('/api/ai/connections'), 410);
      assert.equal((await guest('/editor')).status, 302);
    });
    await check(
      'Proxy rejects Host, Origin and forwarding spoofing; preserves opaque paths',
      async () => {
        expect(
          await request(app.publicPort, '/api/session', { headers: { host: 'example.invalid' } }),
          403,
        );
        expect(await guest('/api/session', { headers: { origin: 'http://example.invalid' } }), 403);
        expect(await guest('/api/session', { headers: { 'x-forwarded-for': '1.2.3.4' } }), 403);
        expect(await guest('/.env'), 404);
      },
    );
    await check('Login cookie and admin state from the sole C# store', async () => {
      const result = expect(
        await admin('/api/auth/mock', json({ email: 'admin@company.test' })),
        200,
      );
      assert.equal(result.user.id, app.adminId);
      assert.equal(result.user.role, 'admin');
      assert.equal(expect(await admin('/api/session'), 200).user.id, app.adminId);
      expect(await other('/api/auth/mock', json({ email: 'tester@company.test' })), 200);
      expect(await other('/api/admin/users'), 403);
      expect(
        await admin('/api/admin/users/' + app.adminId, {
          ...json({ active: false, role: 'user' }),
          method: 'PUT',
        }),
        409,
      );
    });
    await check(
      'Algorithm file streaming, immutable revisions, private ownership and 409',
      async () => {
        algorithm = expect(
          await admin('/api/algorithms?name=sample', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: example,
          }),
          201,
        );
        assert.equal(algorithm.revision, 1);
        const source = await admin(`/api/algorithms/${algorithm.id}/source`);
        assert.equal(source.text, example);
        assert.equal(
          JSON.parse(decodeURIComponent(source.headers['x-coinhunter-metadata'])).id,
          algorithm.id,
        );
        expect(await other(`/api/algorithms/${algorithm.id}/source`), 404);
        const updated = expect(
          await admin(`/api/algorithms/${algorithm.id}?name=sample&revision=1`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: example + '\n// revision2',
          }),
          200,
        );
        assert.equal(updated.revision, 2);
        expect(
          await admin(`/api/algorithms/${algorithm.id}?name=sample&revision=1`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: example,
          }),
          409,
        );
        const metadata = JSON.parse(
          await readFile(join(app.directory, 'operations/accounts/store.json'), 'utf8'),
        );
        assert.equal(metadata.algorithms[0].source, undefined);
        assert.ok(metadata.algorithms[0].sourceKey);
      },
    );
    await check(
      'Real QuickJS preflight passes valid code and returns Korean unresolved diagnostics',
      async () => {
        expect(
          await admin('/api/algorithms/validate', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: example,
          }),
          200,
        );
        const failure = await admin('/api/algorithms/validate', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: example.replace('this.turn++;', 'undeclaredName++;'),
        });
        expect(failure, 400);
        assert.ok(failure.body.error);
        assert.ok(failure.body.diagnostic);
      },
    );
    await check('Prompt content/version generated from JS authority', async () => {
      const contract = expect(await admin('/api/algorithm-assistant/contract'), 200);
      const { loadAlgorithmContract } =
        await import('../backend/node/src/algorithm-assistant/contract.js');
      assert.deepEqual(contract, await loadAlgorithmContract());
    });
    await check('Map draft/version/publish validation and published visibility', async () => {
      const tiles = Array(16).fill(0);
      for (const i of [5, 6, 9, 10]) tiles[i] = 10;
      const result = expect(
        await admin(
          '/api/admin/maps',
          json({
            name: 'integration',
            columns: 4,
            rows: 4,
            tiles,
            settings: {
              ...DEFAULT_MAP_SETTINGS,
              actionMs: 50,
              runningTimeMs: 1000,
              hurryUpRemovalIntervalMs: { 10: 100 },
            },
          }),
        ),
        201,
      );
      map = result.map;
      state = result.state;
      validateMapDocument(map, { published: true });
      const publish = expect(
        await admin(`/api/admin/maps/${map.id}/publish`, json({ revision: 1, expected: state })),
        200,
      );
      state = publish.state;
      assert.ok(expect(await guest('/api/maps'), 200).maps.some((item) => item.id === map.id));
      expect(
        await admin(
          `/api/admin/maps/${map.id}/publish`,
          json({ revision: 1, expected: { ...state, enabled: false } }),
        ),
        409,
      );
      expect(
        await admin(`/api/admin/maps/${map.id}/draft`, {
          ...json({ ...map, expectedRevision: 0 }),
          method: 'PUT',
        }),
        400,
      );
    });
    await check(
      'Map copy name conflicts, settings versions, array import and order CAS',
      async () => {
        const copy = expect(
          await admin(
            `/api/admin/maps/${map.id}/copy`,
            json({ name: 'integration copy', sourceRevision: 1 }),
          ),
          201,
        );
        expect(
          await admin(
            `/api/admin/maps/${map.id}/copy`,
            json({ name: 'integration copy', sourceRevision: 1 }),
          ),
          409,
        );
        expect(
          await admin(
            '/api/admin/maps/validate-array',
            json({ columns: 4, rows: 4, source: 'new int[] {' + map.tiles.join(',') + '};' }),
          ),
          200,
        );
        const setting = await admin(`/api/admin/maps/${copy.map.id}/settings`, {
          ...json({ settings: map.settings, expectedRevision: 1 }),
          method: 'PUT',
        });
        expect(setting, 200);
        assert.equal(setting.body.map.revision, 2);
        const list = expect(await admin('/api/admin/maps?includeSamples=1'), 200).maps.map(
          (item) => item.id,
        );
        expect(
          await admin('/api/admin/maps/order', {
            ...json({ ids: [...list].reverse(), expectedIds: list }),
            method: 'PUT',
          }),
          200,
        );
        expect(
          await admin('/api/admin/maps/order', {
            ...json({ ids: list, expectedIds: list }),
            method: 'PUT',
          }),
          409,
        );
      },
    );
    await check(
      'Account match, idempotent retry, SSE completion and automatic history',
      async () => {
        const options = {
          algorithmId: algorithm.id,
          mapId: map.id,
          dummyCount: 1,
          blackMatter: false,
          destroyWalls: false,
          startSlot: 0,
          characterId: 'pengko',
        };
        const key = sharedRequestKey;
        matchId = expect(
          await admin('/api/matches', {
            ...json(Object.fromEntries(Object.entries(options).reverse())),
            headers: { 'content-type': 'application/json', 'idempotency-key': key },
          }),
          201,
        ).id;
        assert.equal(
          expect(
            await admin('/api/matches', {
              ...json(options),
              headers: { 'content-type': 'application/json', 'idempotency-key': key },
            }),
            201,
          ).id,
          matchId,
        );
        expect(await other(`/api/matches/${matchId}`), 404);
        const events = await admin(`/api/matches/${matchId}/events`);
        expect(events, 200);
        assert.match(events.text, /event: snapshot/);
        assert.match(events.text, /finished/);
        const history = expect(await admin('/api/history'), 200).history;
        assert.equal(history.length, 1);
        assert.equal(history[0].matchId, matchId);
      },
    );
    await check('Complete JSONL contains every judgement/action and receipt agrees', async () => {
      const recording = await admin(`/api/matches/${matchId}/recording`);
      expect(recording, 200);
      const rows = recording.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(rows.some((row) => row.type === 'algorithm-result'));
      assert.ok(rows.some((row) => row.type === 'action-completed'));
      assert.ok(rows.some((row) => row.type === 'finished'));
      for (let i = 0; i < rows.length; i++) assert.equal(rows[i].seq, i + 1);
      const result = expect(
        await request(app.execution.port, `/internal/v1/matches/${matchId}`, {
          headers: { authorization: 'Bearer ' + app.key },
        }),
        200,
      );
      assert.equal(result.result.recording.status, 'complete');
      assert.equal(result.result.recording.durableThroughSeq, rows.length);
      assert.equal(result.acknowledged, true);
      assert.equal(recording.text.includes(example), false);
    });
    await check('Guest practice and signed-in historical duel preserve ownership', async () => {
      const options = { mapId: map.id, dummyCount: 0, blackMatter: false, destroyWalls: false };
      const id = expect(
        await guest('/api/matches', {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'x-coinhunter-options': JSON.stringify(options),
            'idempotency-key': sharedRequestKey,
          },
          body: example,
        }),
        201,
      ).id;
      expect(await guest(`/api/matches/${id}`, { method: 'DELETE' }), 200);
      expect(await guest('/api/history'), 401);
      expect(
        await guest(
          '/api/matches',
          json({ ...options, mode: 'duel', opponentHistoryId: matchId, source: example }),
        ),
        400,
      );
      const duel = expect(
        await admin(
          '/api/matches',
          json({ ...options, mode: 'duel', opponentHistoryId: matchId, algorithmId: algorithm.id }),
        ),
        201,
      ).id;
      const snapshot = expect(await admin(`/api/matches/${duel}`), 200);
      assert.equal(snapshot.game.players.length, 2);
      expect(await admin(`/api/matches/${duel}`, { method: 'DELETE' }), 200);
    });
    await check(
      'Operations outage/restart retains engine progress and applies final once',
      async () => {
        const id = expect(
          await admin(
            '/api/matches',
            json({
              mapId: map.id,
              dummyCount: 0,
              blackMatter: false,
              destroyWalls: false,
              algorithmId: algorithm.id,
            }),
          ),
          201,
        ).id;
        await app.stopHost(app.operations);
        await wait(1500);
        const restarted = await app.launch('CoinHunter.Operations.Api', app.operations.port);
        app.operations = restarted;
        // Memory sessions deliberately require login after restart.
        assert.equal(expect(await admin('/api/session'), 200).user, null);
        expect(await admin('/api/auth/mock', json({ email: 'admin@company.test' })), 200);
        const history = expect(await admin('/api/history'), 200).history;
        assert.equal(history.filter((item) => item.matchId === id).length, 1);
        expect(await admin('/api/history'), 200);
      },
    );
    await check(
      'Real maintenance CLI is offline-only and accepts inspect/grant arguments',
      async () => {
        async function maintenance(args) {
          const child = spawn(
            'dotnet',
            [serviceAssembly('CoinHunter.Operations.Api'), 'maintenance', ...args],
            {
              cwd: join(root, 'backend'),
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: serviceEnvironment({
                Backend__RepositoryRoot: root,
                Backend__DataRoot: join(app.directory, 'operations'),
                Backend__ExchangeRoot: join(app.directory, 'exchange'),
                Backend__ExecutionRoot: join(app.directory, 'execution'),
              }),
            },
          );
          let output = '';
          for (const stream of [child.stdout, child.stderr])
            stream.on('data', (chunk) => {
              output = (output + chunk).slice(-4000);
            });
          const code = await new Promise((resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', resolveExit);
          });
          return { code, output };
        }
        assert.notEqual(
          (await maintenance(['inspect'])).code,
          0,
          'An active Operations writer blocks maintenance',
        );
        await app.stopHost(app.operations);
        for (const args of [
          ['inspect'],
          ['grant', app.adminId],
          ['bootstrap', 'admin@company.test', 'mock'],
          ['reconcile'],
        ]) {
          const result = await maintenance(args);
          assert.equal(result.code, 0, result.output);
        }
      },
    );
    console.log(`Split backend: ${checks} integration groups passed.`);
  } catch (error) {
    console.error('Integration fixtures retained at ' + app.directory);
    for (const host of app.hosts) {
      if (/fail:|Unhandled exception/.test(host.output()))
        console.error(host.output().slice(-6000));
    }
    await app.close({ keep: true });
    throw error;
  }
  await app.close();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifySplitBackend();
