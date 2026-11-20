import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(
    'node scripts/csharp-endurance.js [--smoke] [--minutes 30] [--games 2] [--cycles 3]\nFull runs require 30–55 minutes; smoke runs 20 seconds and never qualifies as endurance acceptance.\n',
  );
  process.exit(0);
}
const options = {
  durationSeconds: 1800,
  games: 2,
  restartCycles: 3,
  sampleSeconds: 5,
  noProgressSeconds: 20,
  minimumFreeDiskMiB: 1024,
  maxJournalMiB: 4096,
  smoke: false,
};
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (seen.has(key)) throw new Error(`Duplicate option: ${key}`);
  seen.add(key);
  if (key === '--smoke') {
    options.smoke = true;
    continue;
  }
  const fields = {
    '--minutes': 'durationSeconds',
    '--games': 'games',
    '--cycles': 'restartCycles',
  };
  if (!Object.hasOwn(fields, key) || !/^\d+$/.test(args[i + 1] || ''))
    throw new Error(`Invalid option: ${key}`);
  const value = Number(args[++i]);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid number: ${key}`);
  options[fields[key]] = key === '--minutes' ? value * 60 : value;
}
if (options.smoke) {
  if (seen.has('--minutes')) throw new Error('--smoke and --minutes cannot be combined.');
  options.durationSeconds = 20;
  options.sampleSeconds = 1;
  options.restartCycles = seen.has('--cycles') ? options.restartCycles : 1;
}
if (
  (!options.smoke && (options.durationSeconds < 1800 || options.durationSeconds > 3300)) ||
  options.games < 1 ||
  options.games > 4 ||
  options.restartCycles < 1 ||
  options.restartCycles > 20
)
  throw new Error('Invalid bounds: minutes 30–55, games 1–4, cycles 1–20.');

// Isolated build/data, independent of the running development server and .env.
process.env.COINHUNTER_BUILD_ROOT = resolve(root, 'artifacts/csharp-endurance-build');
const { buildBackend, dotnetEnvironment, serviceAssembly } = await import('./backend-tools.js');
await buildBackend();
const output = resolve(root, `artifacts/csharp-endurance-${randomUUID()}`);
await mkdir(output, { recursive: false });
const config = resolve(output, 'options.json');
await writeFile(config, JSON.stringify(options, null, 2) + '\n');
process.stdout.write(`Endurance artifacts: ${output}\n`);
const child = spawn(
  'dotnet',
  [serviceAssembly('CoinHunter.Backend.Checks'), root, 'csharp-endurance', config],
  { cwd: root, windowsHide: true, env: dotnetEnvironment, stdio: ['pipe', 'inherit', 'inherit'] },
);
child.stdin.on('error', () => {});
const exiting = new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolveExit(code ?? 1));
});
let stopReason = null,
  forced = false,
  killTimer;
const requestStop = (reason) => {
  if (stopReason) return;
  stopReason = reason;
  child.stdin.write('stop\n');
  killTimer = setTimeout(() => {
    forced = true;
    child.kill();
  }, 45000);
};
const interrupted = () => requestStop('operator-interrupted');
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
  if (line.trim() === 'stop') requestStop('operator-request');
});
process.on('SIGINT', interrupted);
process.on('SIGTERM', interrupted);
const timeout = setTimeout(
  () => requestStop('outer-watchdog'),
  (options.durationSeconds + options.restartCycles * 60 + 600) * 1000,
);
const stopFile = setInterval(() => {
  if (existsSync(resolve(output, 'stop.request'))) requestStop('operator-file');
}, 1000);
let exitCode;
try {
  await writeFile(
    resolve(output, 'supervisor.json'),
    JSON.stringify(
      {
        state: 'running',
        pid: process.pid,
        childPid: child.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  exitCode = await exiting;
} finally {
  clearTimeout(timeout);
  clearTimeout(killTimer);
  clearInterval(stopFile);
  process.off('SIGINT', interrupted);
  process.off('SIGTERM', interrupted);
  input.close();
  process.stdin.pause();
}
let report;
try {
  report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'));
} catch {
  /* Missing/invalid report is a failed run. */
}
const passed =
  exitCode === 0 &&
  !stopReason &&
  !forced &&
  report?.passed === true &&
  (options.smoke ? report.qualifiedLongRun === false : report.qualifiedLongRun === true);
await writeFile(
  resolve(output, 'supervisor.json'),
  JSON.stringify(
    { exitCode, stopReason, forced, passed, reportPresent: Boolean(report) },
    null,
    2,
  ) + '\n',
);
if (!passed)
  process.stderr.write(
    `Endurance failed. See ${output}; forced termination never confirms resource cleanup.\n`,
  );
else
  process.stdout.write(
    `${options.smoke ? 'SMOKE PASSED (not long-run acceptance)' : 'ENDURANCE PASSED'}: ${resolve(output, 'report.json')}\n`,
  );
process.exitCode = passed ? 0 : exitCode || 1;
