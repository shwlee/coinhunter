import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildBackendContent } from './backend-content.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = resolve(root, 'backend');
// Optional isolated build for testing while the normal development server holds its DLLs.
const buildRoot = process.env.COINHUNTER_BUILD_ROOT
  ? resolve(root, process.env.COINHUNTER_BUILD_ROOT)
  : null;
export const dotnetEnvironment = {
  ...process.env,
  DOTNET_CLI_HOME: resolve(root, 'artifacts/dotnet-home'),
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
  DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
  DOTNET_NOLOGO: '1',
  ...(buildRoot ? { ArtifactsPath: buildRoot } : {}),
};

export function serviceEnvironment(overrides = {}, base = dotnetEnvironment) {
  const allowed = new Set([
    'path',
    'pathext',
    'systemroot',
    'windir',
    'comspec',
    'temp',
    'tmp',
    'home',
    'userprofile',
    'appdata',
    'localappdata',
    'programfiles',
    'programfiles(x86)',
    'programw6432',
    'dotnet_root',
    'dotnet_root_x64',
    'dotnet_root(x86)',
    'dotnet_cli_home',
    'dotnet_cli_telemetry_optout',
    'dotnet_skip_first_time_experience',
    'dotnet_generate_aspnet_certificate',
    'dotnet_add_global_tools_to_path',
    'dotnet_nologo',
    'aspnetcore_environment',
    'dotnet_environment',
    'aspnetcore_forwardedheaders_enabled',
    'coinhunter_internal_key',
  ]);
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(
      ([key, value]) =>
        value !== undefined &&
        (allowed.has(key.toLowerCase()) ||
          key.startsWith('Backend__') ||
          (Object.hasOwn(overrides, key) &&
            (['AUTH_MODE', 'MOCK_COMPANY_DOMAIN'].includes(key) || key.startsWith('GOOGLE_')))),
    ),
  );
}

export function runDotnet(args, { quiet = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('dotnet', args, {
      cwd: backend,
      env: dotnetEnvironment,
      windowsHide: true,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (quiet)
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output = (output + chunk).slice(-24000);
        });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun(output)
        : reject(new Error(`dotnet command failed (${code})${quiet ? ': ' + output : ''}`)),
    );
  });
}

export async function buildBackend() {
  await buildBackendContent();
  const feed = resolve(root, 'artifacts/nuget-empty-feed');
  await mkdir(feed, { recursive: true });
  // Stage 1 needs only SDK/shared frameworks: restore without contacting external feeds.
  await runDotnet(['restore', 'CoinHunter.sln', '--source', feed, '--ignore-failed-sources']);
  await runDotnet(['build', 'CoinHunter.sln', '--no-restore']);
}

export function serviceAssembly(name) {
  if (buildRoot) return resolve(buildRoot, 'bin', name, 'debug', `${name}.dll`);
  return resolve(backend, 'src', name, 'bin/Debug/net10.0', `${name}.dll`);
}
