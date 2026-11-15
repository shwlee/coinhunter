import { readFile } from 'node:fs/promises';
import { MAPS } from '../backend/node/src/game/map-repository.js';
import { Match } from '../backend/node/src/game/match.js';

const source = await readFile(
  new URL('../backend/node/examples/nearest-coin.js', import.meta.url),
  'utf8',
);
const map = structuredClone(MAPS[0]);
map.settings.actionMs = 30;
map.settings.runningTimeMs = 10000;
const match = new Match(map, [source, source, source, source]);
const finished = new Promise((resolve) => match.once('closed', resolve));
await match.start();
const watchdog = setTimeout(() => match.stop('demo-deadline'), 30000);
await finished;
clearTimeout(watchdog);
console.log(
  JSON.stringify(
    {
      reason: match.state.reason,
      players: match.state.players.map((p) => ({ name: p.name, score: p.score, turn: p.turn })),
    },
    null,
    2,
  ),
);
