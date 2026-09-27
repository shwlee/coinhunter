import { PlayerProcess } from '../src/runtime/player-process.js';

const source = `module.exports = class {
  initialize() { this.calls=0; }
  getName() { return '검증'; }
  moveNext() { this.calls++; if(this.calls===2) { this.saved=3; while(true){} } return this.saved || 0; }
}`;
const player = new PlayerProcess();
try {
  await player.initialize(source, 0, 6, 6);
  const results = [];
  for (let turn = 1; turn <= 3; turn++) results.push({ turn, ...(await player.move([0], 0)) });
  console.log(JSON.stringify({ node: process.version, results }, null, 2));
  if (
    results[1].status !== 'timeout' ||
    results[2].value !== 3 ||
    new Set(results.map((r) => r.pid)).size !== 1
  )
    process.exitCode = 1;
} finally {
  await player.close();
}
