import { AlgorithmSandbox } from './sandbox.js';

let sandbox;
let initialized = false;
process.on('message', async (message) => {
  const { id, type, payload } = message;
  try {
    if (type === 'initialize') {
      if (initialized) throw new Error('이미 초기화된 프로세스입니다.');
      initialized = true;
      sandbox = await AlgorithmSandbox.create(
        payload.source,
        payload.number,
        payload.columns,
        payload.rows,
      );
      process.send?.({ id, ok: true, result: { name: sandbox.name, pid: process.pid } });
    } else if (type === 'move') {
      const result = sandbox.invoke('moveNext', [payload.map, payload.position, payload.items]);
      process.send?.({ id, ok: true, result: { ...result, pid: process.pid } });
    } else if (type === 'close') {
      sandbox?.dispose();
      sandbox = null;
      process.send?.({ id, ok: true, result: { pid: process.pid } }, () => process.disconnect());
    } else {
      throw new Error('Unknown operation');
    }
  } catch (error) {
    process.send?.({ id, ok: false, error: String(error.message).slice(0, 500) });
  }
});
process.on('disconnect', () => {
  sandbox?.dispose();
  sandbox = null;
  process.exit(0);
});
