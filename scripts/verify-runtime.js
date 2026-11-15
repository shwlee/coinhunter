import { randomUUID } from 'node:crypto';
import { JavaScriptArtifacts } from '../backend/node/src/runtime/javascript-artifacts.js';
import { createJavaScriptRegistry } from '../backend/node/src/runtime/runner-registry.js';
import { ALGORITHM_MEMORY_LIMIT_BYTES } from '../backend/node/src/runtime/policy.js';

const source = `module.exports = class {
  initialize() { this.calls=0; }
  getName() { return '검증'; }
  moveNext() { this.calls++; if(this.calls===2) { this.saved=3; while(true){} } return this.saved || 0; }
}`;
const artifacts = new JavaScriptArtifacts();
const context = {
  contractVersion: 1,
  gameId: randomUUID(),
  playerId: 0,
  runId: randomUUID(),
  language: 'javascript',
  artifact: await artifacts.register(source),
  limits: { turnMs: 500, algorithmMemoryBytes: ALGORITHM_MEMORY_LIMIT_BYTES },
};
const player = createJavaScriptRegistry({ resolveArtifact: artifacts.resolve }).create(context);
try {
  const info = await player.initialize({ playerNumber: 0, columns: 6, rows: 6 });
  const results = [];
  for (let callId = 1; callId <= 3; callId++)
    results.push(
      await player.move({
        contractVersion: 1,
        gameId: context.gameId,
        playerId: 0,
        runId: context.runId,
        callId,
        map: Array(36).fill(0),
        myPosition: 0,
        items: [-1, -1, -1, -1],
      }),
    );
  console.log(JSON.stringify({ node: process.version, info, results }, null, 2));
  if (
    results[1].status !== 'timeout' ||
    results[2].direction !== 3 ||
    results.some((result) => result.instanceId !== info.instanceId || result.runId !== info.runId)
  )
    process.exitCode = 1;
} finally {
  await player.close();
}
