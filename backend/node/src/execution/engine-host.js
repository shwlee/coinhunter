import { randomUUID, createHash } from 'node:crypto';
import { readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Match } from '../game/match.js';
import { EngineFrameDecoder, encodeEngineFrame } from './engine-protocol.js';
import { EventCollector, FileJournalStorage } from './jsonl-collector.js';

let match,
  matchId,
  collector,
  closed = false,
  sending = false,
  latest;
const commands = [];
async function send(type, payload, correlationId) {
  const message = {
    contractVersion: 1,
    matchId,
    messageId: randomUUID(),
    type,
    payload,
    ...(correlationId ? { correlationId } : {}),
  };
  if (type === 'snapshot') latest = message;
  else {
    if (commands.length >= 32) throw new Error('control-overflow');
    commands.push(message);
  }
  if (sending) return;
  sending = true;
  try {
    while (commands.length || latest) {
      const next = commands.shift() || latest;
      if (next === latest) latest = null;
      if (!process.stdout.write(encodeEngineFrame(next))) await once(process.stdout, 'drain');
    }
  } finally {
    sending = false;
  }
}
async function finish(reason = 'manager-disconnected') {
  if (closed) return;
  closed = true;
  if (match) await match.stop(reason);
  const recording = collector
    ? await collector.finish()
    : { status: 'failed', durableThroughSeq: 0 };
  recording.key = matchId;
  const finalReason = match?.state?.reason || reason;
  const outcome =
    finalReason === 'coins-collected'
      ? 'finished'
      : ['user-stopped', 'account-ended', 'server-shutdown'].includes(finalReason)
        ? 'aborted'
        : 'failed';
  const payload = {
    contractVersion: 1,
    matchId,
    resultVersion: 1,
    outcome,
    reason: finalReason,
    scores: (match?.state?.players || []).map((player) => ({
      playerId: player.id,
      score: player.score,
    })),
    snapshot: match?.latest || null,
    recording,
  };
  if (matchId && collector) {
    const path = join(process.env.COINHUNTER_ENGINE_LOGS, matchId + '.result.json');
    try {
      const file = await open(path + '.tmp', 'wx');
      try {
        await file.writeFile(JSON.stringify({ contractVersion: 1, matchId, payload }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(path + '.tmp', path);
    } catch {
      payload.recording = { ...recording, receiptStatus: 'failed' };
    }
  }
  if (matchId && !process.stdout.destroyed) await send('closed', payload);
  process.stdin.destroy();
}
async function handle(message) {
  if (matchId && message.matchId !== matchId) throw new Error('match-mismatch');
  matchId = message.matchId;
  if (message.type === 'initialize') {
    if (match) throw new Error('already-initialized');
    const request = message.payload;
    if (request.matchId !== matchId || request.contractVersion !== 1)
      throw new Error('invalid-request');
    const sources = [];
    for (const participant of request.participants) {
      const source = participant.source;
      if (!/^[a-f0-9-]{36}$/.test(source.sourceKey)) throw new Error('invalid-source');
      const path = join(process.env.COINHUNTER_ENGINE_SOURCES, source.sourceKey + '.js');
      const bytes = await readFile(path);
      if (
        bytes.length !== source.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== source.sha256
      )
        throw new Error('source-integrity');
      sources.push({ path });
    }
    collector = new EventCollector(
      new FileJournalStorage(process.env.COINHUNTER_ENGINE_LOGS, matchId),
      {
        onFailure: () => {
          void finish('recording-failure');
        },
      },
    );
    await collector.initialize();
    collector.record('execution-created', {
      matchId,
      requestId: request.requestId,
      participants: request.participants,
      map: request.map,
    });
    match = new Match(request.map, sources, {
      ...request.options,
      startSlot: request.participants[0].startSlot,
      characterId: request.participants[0].characterId,
      playerStartSlots: request.participants.map((player) => player.startSlot),
      playerCharacters: request.participants.map((player) => player.characterId),
      record: (type, payload) => collector.record(type, payload),
    });
    match.on('snapshot', (snapshot) => {
      void send('snapshot', snapshot).catch(() => finish('transport-failure'));
    });
    match.once('closed', () => {
      void finish(match.state?.reason);
    });
    await match.prepare();
    await send(
      'prepared',
      {
        players: match.runners.map((runner, i) => ({
          playerId: i,
          runId: request.participants[i].runId,
          name: runner.name,
        })),
      },
      message.messageId,
    );
  } else if (message.type === 'start') {
    if (!match?.prepared) throw new Error('not-prepared');
    if (!match.running) match.run();
    await send('ack', { state: 'running' }, message.messageId);
  } else if (message.type === 'stop') await finish(message.payload.reason || 'user-stopped');
  else throw new Error('unexpected-command');
}
const decoder = new EngineFrameDecoder();
let chain = Promise.resolve();
process.stdin.on('data', (chunk) => {
  try {
    for (const message of decoder.push(chunk)) chain = chain.then(() => handle(message));
    chain = chain.catch(async () => {
      if (matchId)
        await send('failed', {
          code: 'engine-failure',
          stage: 'execution',
          message: 'Game engine failed.',
        }).catch(() => {});
      await finish('runtime-failure');
    });
  } catch {
    void finish('protocol-failure');
  }
});
process.stdin.on('end', () => {
  void chain.finally(() => finish());
});
process.stdout.on('error', () => {
  void finish('manager-disconnected');
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void finish('server-shutdown');
  });
