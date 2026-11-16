import { validateAlgorithm } from '../runtime/preflight.js';
import { join } from 'node:path';
const key = process.argv[2];
if (process.env.COINHUNTER_REQUIRE_RESOURCE_GATE === '1') {
  let command = '';
  for await (const chunk of process.stdin) {
    command += chunk.toString();
    if (command.length > 16) throw new Error('invalid-resource-gate');
    if (command.includes('\n')) break;
  }
  if (command.trim() !== 'start') throw new Error('resource-gate-closed');
}
if (!/^[a-f0-9-]{36}$/.test(key || '')) process.exitCode = 1;
else {
  try {
    const result = await validateAlgorithm(
      undefined,
      'internal-validation',
      join(process.env.COINHUNTER_ENGINE_SOURCES, key + '.js'),
    );
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error: String(error.message).slice(0, 500),
        diagnostic: Number.isInteger(error.pos)
          ? { offset: error.pos, line: error.loc.line, column: error.loc.column + 1 }
          : null,
      }),
    );
  }
}
