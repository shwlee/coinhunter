import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';
import { buildBackend, runDotnet, serviceAssembly, serviceEnvironment } from './backend-tools.js';
import { createFrontendServer } from '../frontend/server/frontend-server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = resolve(root, 'backend');
export async function startBackend({ frontend = false, build = true } = {}) {
  if (build) await buildBackend();
  const internalKey = process.env.COINHUNTER_INTERNAL_KEY || randomBytes(32).toString('base64url');
  const operationsUrl = process.env.COINHUNTER_OPERATIONS_URL || 'http://127.0.0.1:3101';
  const executionUrl = process.env.COINHUNTER_EXECUTION_URL || 'http://127.0.0.1:3102';
  const publicUrl =
    process.env.COINHUNTER_PUBLIC_URL ||
    (process.env.AUTH_MODE === 'google' && process.env.GOOGLE_REDIRECT_URI
      ? new URL(process.env.GOOGLE_REDIRECT_URI).origin
      : `http://127.0.0.1:${process.env.PORT || 3000}`);
  const children = [];
  let closing = false;
  let web;
  const stop = async () => {
    if (closing) return;
    closing = true;
    if (web) await web.close();
    for (const { child, exited } of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.stdin.end('shutdown\n');
      const timer = setTimeout(() => child.kill(), 20000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void stop();
    });
  for (const name of ['CoinHunter.Execution.Host', 'CoinHunter.Operations.Api']) {
    const child = spawn('dotnet', [serviceAssembly(name)], {
      cwd: backend,
      env: serviceEnvironment({
        ASPNETCORE_ENVIRONMENT: 'Development',
        DOTNET_ENVIRONMENT: 'Development',
        COINHUNTER_INTERNAL_KEY: internalKey,
        Backend__ListenUrl: name === 'CoinHunter.Execution.Host' ? executionUrl : operationsUrl,
        Backend__ExecutionUrl: executionUrl,
        Backend__PublicUrl: publicUrl,
        Backend__UseStdinControl: 'true',
        Backend__RepositoryRoot: root,
        ...(name === 'CoinHunter.Execution.Host'
          ? {
              Backend__CSharpValidation__HostAssembly:
                process.env.Backend__CSharpValidation__HostAssembly ||
                serviceAssembly('CoinHunter.CSharp.Host'),
            }
          : {}),
        Backend__TrustedProxies__0: name === 'CoinHunter.Operations.Api' ? '127.0.0.1' : undefined,
        // Only Operations receives the explicitly selected authentication configuration.
        ...(name === 'CoinHunter.Operations.Api'
          ? Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) =>
                  ['AUTH_MODE', 'MOCK_COMPANY_DOMAIN'].includes(key) || key.startsWith('GOOGLE_'),
              ),
            )
          : {}),
      }),
      windowsHide: true,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const exited = new Promise((resolveExit) => {
      child.once('error', () => resolveExit(1));
      child.once('exit', resolveExit);
    });
    child.stdin.on('error', () => {});
    children.push({ child, exited });
    void exited.then((code) => {
      if (!closing) {
        process.exitCode = code || 1;
        void stop();
      }
    });
  }
  try {
    const readyBy = Date.now() + 10000;
    while (true) {
      if (
        closing ||
        children.some(({ child }) => child.exitCode !== null || child.signalCode !== null)
      )
        throw new Error('Backend host exited before readiness.');
      const ready = await new Promise((resolveReady) => {
        const probe = http.get(
          new URL('/health/ready', operationsUrl),
          { timeout: 1500 },
          (response) => {
            response.resume();
            resolveReady(response.statusCode === 200);
          },
        );
        probe.on('timeout', () => probe.destroy());
        probe.on('error', () => resolveReady(false));
      });
      if (ready) break;
      if (Date.now() >= readyBy) throw new Error('Backend readiness timed out.');
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  if (frontend) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      await stop();
      throw new Error('Local frontend launcher requires loopback HTTP.');
    }
    web = createFrontendServer({ operationsUrl, publicUrl });
    try {
      await new Promise((resolveListen, reject) => {
        web.server.once('error', reject);
        web.server.listen(Number(url.port || 80), '127.0.0.1', resolveListen);
      });
    } catch (error) {
      web = undefined;
      await stop();
      throw error;
    }
  }
  const control = !process.stdin.isTTY ? createInterface({ input: process.stdin }) : null;
  control?.on('line', (line) => {
    if (line === 'shutdown') void stop();
  });
  control?.on('close', () => {
    void stop();
  });
  console.log(`Coin Hunter split backend started${frontend ? ': ' + publicUrl : '.'}`);
  await Promise.all(children.map((item) => item.exited));
  control?.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'build') await buildBackend();
    else if (command === 'start') await startBackend();
    else if (command === 'web') await startBackend({ frontend: true });
    else if (command === 'test') {
      await buildBackend();
      await runDotnet([
        'run',
        '--project',
        'tests/CoinHunter.Backend.Checks',
        '--no-build',
        '--no-launch-profile',
        '--',
        root,
      ]);
      const { verifyBackend } = await import('./backend-smoke.js');
      await verifyBackend();
    } else throw new Error('Use: node scripts/backend.js build|start|test');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
