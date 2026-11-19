import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { loadAlgorithmContract } from '../backend/node/src/algorithm-assistant/contract.js';
import { DEFAULT_MAP_SETTINGS, MAP_SETTING_LIMITS } from '../backend/node/src/game/maps.js';
import {
  preflightScenarios,
  PREFLIGHT_FIXTURE_VERSION,
} from '../backend/node/src/runtime/preflight-scenarios.js';
const root = new URL('../', import.meta.url);
export async function buildBackendContent() {
  const registry = JSON.parse(
    await readFile(new URL('backend/node/maps/registry.json', root), 'utf8'),
  );
  const samples = await Promise.all(
    registry.maps.map(async (entry) => ({
      entry: { ...entry, source: 'sample' },
      document: JSON.parse(
        await readFile(new URL(`backend/node/maps/samples/${entry.id}.json`, root), 'utf8'),
      ),
    })),
  );
  const content = {
    schemaVersion: 1,
    defaults: DEFAULT_MAP_SETTINGS,
    limits: MAP_SETTING_LIMITS,
    contract: await loadAlgorithmContract(),
    samples,
    example: await readFile(new URL('backend/node/examples/nearest-coin.js', root), 'utf8'),
  };
  const directory = new URL('backend/contracts/generated/', root);
  await mkdir(directory, { recursive: true });
  const style = JSON.parse(await readFile(new URL('.prettierrc.json', root), 'utf8'));
  await writeFile(
    new URL('game-content.json', directory),
    await format(JSON.stringify(content), { ...style, parser: 'json' }),
  );
  await writeFile(
    new URL('algorithm-preflight.json', directory),
    await format(
      JSON.stringify({ version: PREFLIGHT_FIXTURE_VERSION, scenarios: await preflightScenarios() }),
      { ...style, parser: 'json' },
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildBackendContent();
