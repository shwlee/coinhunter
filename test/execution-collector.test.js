import test from 'node:test';
import assert from 'node:assert/strict';
import { EventCollector } from '../backend/node/src/execution/jsonl-collector.js';

function memoryStorage(overrides = {}) {
  return {
    chunks: [],
    synced: 0,
    complete: null,
    async initialize() {},
    async append(buffer) {
      this.chunks.push(buffer);
    },
    async sync() {
      this.synced++;
    },
    async close(complete) {
      this.complete = complete;
    },
    ...overrides,
  };
}
test('collector persists every event in sequence, independently of bounded screen logs', async () => {
  const storage = memoryStorage();
  const collector = new EventCollector(storage);
  await collector.initialize();
  for (let i = 0; i < 500; i++)
    collector.record('algorithm-result', { player: i % 4, turn: i, value: -1 });
  const receipt = await collector.finish();
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.durableThroughSeq, 500);
  const rows = Buffer.concat(storage.chunks).toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 500);
  rows.forEach((row, index) => assert.equal(row.seq, index + 1));
  assert.equal(storage.complete, true);
});
test('slow storage is bounded and overflow explicitly fails recording instead of dropping silently', async () => {
  let release;
  const wait = new Promise((resolveWait) => {
    release = resolveWait;
  });
  let failure;
  const storage = memoryStorage({
    async append(buffer) {
      await wait;
      this.chunks.push(buffer);
    },
  });
  const collector = new EventCollector(storage, {
    maxQueueBytes: 1024,
    onFailure: (error) => {
      failure = error;
    },
  });
  await collector.initialize();
  for (let i = 0; i < 30; i++) collector.record('result', { output: 'a'.repeat(100) });
  assert.ok(failure);
  assert.equal(collector.status, 'failed');
  assert.ok(collector.bytes <= 1024);
  release();
  const receipt = await collector.finish();
  assert.equal(receipt.status, 'failed');
  assert.equal(storage.complete, false);
});
test('disk-full and sync failure never return a complete/durable receipt', async () => {
  for (const method of ['append', 'sync']) {
    let observed = false;
    const storage = memoryStorage({
      async [method]() {
        throw Object.assign(new Error('disk-full'), { code: 'ENOSPC' });
      },
    });
    const collector = new EventCollector(storage, {
      onFailure: () => {
        observed = true;
      },
    });
    await collector.initialize();
    collector.record('finished', { reason: 'test' });
    const receipt = await collector.finish();
    assert.equal(observed, true);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.durableThroughSeq, 0);
    assert.equal(storage.complete, false);
  }
});
test('separate bursts continue draining after previous asynchronous batches finish', async () => {
  const storage = memoryStorage();
  const collector = new EventCollector(storage);
  await collector.initialize();
  for (let i = 0; i < 10; i++) {
    collector.record('event', { i });
    await new Promise((resolveWait) => setImmediate(resolveWait));
  }
  assert.equal(collector.durableThroughSeq, 10);
  assert.equal((await collector.finish()).status, 'complete');
});
