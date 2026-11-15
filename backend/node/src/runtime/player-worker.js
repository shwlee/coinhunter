import { AlgorithmSandbox } from './sandbox.js';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

let sandbox, binding, instanceId;
let initialized = false,
  diagnostics = false;
const hostId = randomUUID();
let chain = Promise.resolve();
async function handle({ id, type, payload }) {
  try {
    let result;
    if (type === 'initialize') {
      if (initialized) throw new Error('이미 초기화된 프로세스입니다.');
      initialized = true;
      diagnostics = payload.diagnostics === true;
      const bytes = payload.sourcePath
        ? await readFile(payload.sourcePath)
        : Buffer.from(payload.source, 'utf8');
      if (
        payload.expectedSource &&
        (bytes.length !== payload.expectedSource.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== payload.expectedSource.sha256)
      )
        throw new Error('source-integrity');
      sandbox = await AlgorithmSandbox.create(
        bytes.toString('utf8'),
        payload.number,
        payload.columns,
        payload.rows,
        { diagnostics },
      );
      instanceId = randomUUID(); // Actual Player object was created successfully.
      binding = payload.binding;
      result = { name: sandbox.name, pid: process.pid, hostId, instanceId, ...binding };
    } else if (type === 'move') {
      result = {
        ...sandbox.invoke('moveNext', [payload.map, payload.position, payload.items]),
        pid: process.pid,
        hostId,
        instanceId,
        ...binding,
        callId: payload.callId,
      };
    } else if (type === 'close') {
      sandbox?.dispose();
      sandbox = null;
      process.send?.({ id, type, ok: true, result: { pid: process.pid } }, () =>
        process.disconnect(),
      );
      return;
    } else throw new Error('Unknown operation');
    process.send?.({ id, type, ok: true, result });
  } catch (error) {
    process.send?.({
      id,
      type,
      ok: false,
      ...(diagnostics && error.validation ? { validation: error.validation } : {}),
    });
  }
}
// Close cannot overtake asynchronous source loading / QuickJS initialization.
process.on('message', (message) => {
  chain = chain.then(() => handle(message));
});
process.on('disconnect', () => {
  sandbox?.dispose();
  sandbox = null;
  process.exit(0);
});
