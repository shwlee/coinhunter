import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildBackend, serviceAssembly, serviceEnvironment } from './backend-tools.js';
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  await buildBackend();
  const child = spawn(
    'dotnet',
    [serviceAssembly('CoinHunter.Operations.Api'), 'maintenance', ...process.argv.slice(2)],
    {
      cwd: resolve(root, 'backend'),
      windowsHide: true,
      stdio: 'inherit',
      env: serviceEnvironment({ Backend__RepositoryRoot: root }),
    },
  );
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
} catch {
  console.error(
    'Maintenance failed. Verify arguments and stop Operations before changing its files.',
  );
  process.exitCode = 1;
}
