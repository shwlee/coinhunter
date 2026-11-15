import { open, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Collector/storage are injectable. Engine events never go through browser snapshots or Operations DB.
export class FileJournalStorage {
  constructor(directory, key) {
    this.directory = directory;
    this.key = key;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    this.handle = await open(join(this.directory, this.key + '.partial.jsonl'), 'wx');
  }
  async append(buffer) {
    await this.handle.writeFile(buffer);
  }
  async sync() {
    await this.handle.sync();
  }
  async close(complete) {
    await this.handle.close();
    if (complete)
      await rename(
        join(this.directory, this.key + '.partial.jsonl'),
        join(this.directory, this.key + '.jsonl'),
      );
  }
}

export class EventCollector {
  constructor(storage, { maxQueueBytes = 8 * 1024 * 1024, onFailure = () => {} } = {}) {
    this.storage = storage;
    this.maxQueueBytes = maxQueueBytes;
    this.onFailure = onFailure;
    this.seq = 0;
    this.durableThroughSeq = 0;
    this.queue = [];
    this.bytes = 0;
    this.status = 'opening';
  }
  async initialize() {
    await this.storage.initialize();
    this.status = 'recording';
  }
  record(type, payload) {
    if (this.status !== 'recording') return;
    const seq = this.seq + 1;
    const buffer = Buffer.from(
      JSON.stringify({ schemaVersion: 1, seq, timeMs: performance.now(), type, payload }) + '\n',
    );
    if (this.bytes + buffer.length > this.maxQueueBytes) {
      this.fail(new Error('recording-overflow'));
      return;
    }
    this.seq = seq;
    this.bytes += buffer.length;
    this.queue.push({ seq, buffer });
    this.startDrain();
  }
  startDrain() {
    if (!this.writing)
      this.writing = this.drain().finally(() => {
        this.writing = null;
        if (this.queue.length && this.status === 'recording') this.startDrain();
      });
  }
  fail(error) {
    if (this.status === 'failed') return;
    this.status = 'failed';
    this.failure = error;
    this.onFailure(error);
  }
  async drain() {
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0);
        const bytes = batch.reduce((sum, item) => sum + item.buffer.length, 0);
        await this.storage.append(Buffer.concat(batch.map((item) => item.buffer)));
        await this.storage.sync();
        this.bytes -= bytes;
        this.durableThroughSeq = batch.at(-1).seq;
      }
    } catch (error) {
      this.fail(error);
      this.queue.length = 0;
    }
  }
  async finish() {
    // No new producers after Match.close; include pending late/cancelled algorithm responses.
    if (this.writing) await this.writing;
    if (this.queue.length && this.status !== 'failed') await this.drain();
    const complete = this.status !== 'failed' && this.durableThroughSeq === this.seq;
    try {
      await this.storage.close(complete);
    } catch (error) {
      this.fail(error);
    }
    if (this.status !== 'failed') this.status = complete ? 'complete' : 'partial';
    return { status: this.status, durableThroughSeq: this.durableThroughSeq };
  }
}
