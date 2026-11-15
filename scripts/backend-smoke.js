import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDotnet, serviceEnvironment } from './backend-tools.js';
import {
  EngineFrameDecoder,
  encodeEngineFrame,
  ENGINE_MAX_FRAME_BYTES,
  ENGINE_CONTRACT_VERSION,
} from '../backend/node/src/execution/engine-protocol.js';
const root = fileURLToPath(new URL('../', import.meta.url));

export async function verifyBackend() {
  let checks = 0;
  const check = async (name, action) => {
    await action();
    checks++;
    console.log(`PASS ${name}`);
  };
  const fixture = JSON.parse(
    await readFile(resolve(root, 'backend/contracts/initialize.example.json'), 'utf8'),
  );
  await check('Host environment excludes unrelated credentials and application settings', () => {
    const env = serviceEnvironment(
      { COINHUNTER_INTERNAL_KEY: 'test-only' },
      {
        Path: 'test-path',
        GOOGLE_CLIENT_SECRET: 'not-forwarded',
        OPENAI_API_KEY: 'not-forwarded',
        DATABASE_URL: 'not-forwarded',
        Backend__ListenUrl: 'http://127.0.0.1:3101',
      },
    );
    assert.equal(env.Path, 'test-path');
    assert.equal(env.Backend__ListenUrl, 'http://127.0.0.1:3101');
    assert.equal(env.COINHUNTER_INTERNAL_KEY, 'test-only');
    for (const key of ['GOOGLE_CLIENT_SECRET', 'OPENAI_API_KEY', 'DATABASE_URL'])
      assert.equal(env[key], undefined);
  });
  await check('Shared protocol manifest agrees with Node constants/message types', async () => {
    const spec = JSON.parse(
      await readFile(resolve(root, 'backend/contracts/engine-protocol-v1.json'), 'utf8'),
    );
    assert.equal(spec.contractVersion, ENGINE_CONTRACT_VERSION);
    assert.equal(spec.maxFrameBytes, ENGINE_MAX_FRAME_BYTES);
    for (const type of spec.messageTypes)
      assert.ok(encodeEngineFrame({ ...fixture, type }).length > 4);
  });
  await check('Node frame fragments, coalescing, unicode and closed decoder', () => {
    const unicode = {
      ...fixture,
      type: 'snapshot',
      payload: { name: '코인 🪙', text: '<script>\n' },
    };
    const frame = encodeEngineFrame(unicode);
    const decoder = new EngineFrameDecoder();
    const messages = [];
    for (let i = 0; i < frame.length; i++) messages.push(...decoder.push(frame.subarray(i, i + 1)));
    messages.push(...decoder.push(Buffer.concat([frame, frame])));
    decoder.end();
    assert.deepEqual(messages, [unicode, unicode, unicode]);
    assert.throws(() => [...decoder.push(frame)], /closed/);
  });
  await check('Node rejects lengths, versions, malformed JSON and unknown fields', () => {
    for (const length of [0, ENGINE_MAX_FRAME_BYTES + 1, 0xffffffff]) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      const decoder = new EngineFrameDecoder();
      assert.throws(() => [...decoder.push(header)]);
      assert.throws(() => decoder.end());
    }
    assert.throws(() => encodeEngineFrame({ ...fixture, contractVersion: 2 }));
    assert.throws(() => encodeEngineFrame({ ...fixture, unexpected: true }));
    for (const payload of [Buffer.from('{'), Buffer.from([255])]) {
      const frame = Buffer.alloc(payload.length + 4);
      frame.writeUInt32BE(payload.length);
      payload.copy(frame, 4);
      assert.throws(() => [...new EngineFrameDecoder().push(frame)]);
    }
    const partial = new EngineFrameDecoder();
    assert.deepEqual([...partial.push(encodeEngineFrame(fixture).subarray(0, 7))], []);
    assert.throws(() => partial.end(), /Truncated/);
    let nested = {};
    for (let i = 0; i < 66; i++) nested = { nested };
    assert.throws(() => encodeEngineFrame({ ...fixture, payload: nested }), /nesting/);
  });
  await check('.NET -> Node and Node -> .NET real wire interoperability', async () => {
    const decoder = new EngineFrameDecoder();
    const messages = [
      ...decoder.push(await readFile(resolve(root, 'artifacts/dotnet-engine-fixture.bin'))),
    ];
    decoder.end();
    assert.deepEqual(messages, [fixture]);
    const target = resolve(root, 'artifacts/node-engine-fixture.bin');
    await writeFile(target, encodeEngineFrame(fixture));
    await runDotnet(
      [
        'run',
        '--project',
        'tests/CoinHunter.Backend.Checks',
        '--no-build',
        '--no-launch-profile',
        '--',
        root,
        'verify-frame',
        target,
      ],
      { quiet: true },
    );
  });

  const { verifySplitBackend } = await import('./backend-integration.js');
  await verifySplitBackend();
  console.log(`Protocol integration: ${checks} checks passed.`);
}
