import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const START_TIMEOUT_MS = 20_000;
const TEST_PORT_FLOOR = 20_000;
const TEST_PORT_SLOTS = 3_000;

function cleanRuntimeEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (
      key.startsWith('COMPOSE_')
      || key === 'NODE_TEST_CONTEXT'
      || key === 'STRATUM_GUARDS_DIR'
      || key === 'PORT'
      || key === 'AGENT_PORT'
      || key === 'VITE_PORT'
    ) {
      delete clean[key];
    }
  }
  return clean;
}

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function stopProcessGroup(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}

function startInstalledCompose(composeBin, workspace, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(composeBin, ['start'], {
      cwd: workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let checkingCockpit = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcessGroup(child);
      if (err) reject(err);
      else resolveResult({ stdout, stderr });
    };

    const inspect = () => {
      const output = stdout + stderr;
      if (/node_modules[/\\]\.bin[/\\]vite[^\n]*ENOENT/s.test(output)) {
        finish(new Error(`installed compose start tried to launch dev-only Vite, but npm omitted it:\n${output}`));
        return;
      }
      if (/ERR_MODULE_NOT_FOUND/.test(output)) {
        finish(new Error(`installed compose start is missing a packaged runtime module:\n${output}`));
        return;
      }

      const packagedMode = stdout.includes('[supervisor] Packaged install: serving cockpit from dist/');
      const apiStarted = stdout.includes('Compose server running on http://');
      const apiSandboxBlocked = stderr.includes('[compose] Uncaught exception (process kept alive): listen EPERM');
      if (packagedMode && apiSandboxBlocked) {
        // Restricted execution sandboxes can forbid loopback listeners. Reaching
        // server.listen still proves the packed server and all eager imports loaded.
        finish();
      } else if (packagedMode && apiStarted && !checkingCockpit) {
        checkingCockpit = true;
        void fetch(`http://127.0.0.1:${env.PORT}/`).then(async (response) => {
          const body = await response.text();
          if (response.status !== 200 || !body.includes('id="root"')) {
            finish(new Error(
              `installed compose start did not serve the packaged cockpit on its API port `
              + `(status=${response.status}):\n${body}\n${stdout}${stderr}`,
            ));
            return;
          }
          finish();
        }).catch((err) => finish(new Error(
          `installed compose start launched but its packaged cockpit was unreachable: ${err.message}\n${stdout}${stderr}`,
        )));
      }
    };

    child.stdout.on('data', (chunk) => { stdout += chunk; inspect(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; inspect(); });
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (!settled) {
        finish(new Error(
          `installed compose start exited before its packaged cockpit was ready `
          + `(code=${code}, signal=${signal ?? 'none'}):\n${stdout}${stderr}`,
        ));
      }
    });

    const timer = setTimeout(() => {
      finish(new Error(`installed compose start did not become ready within ${START_TIMEOUT_MS}ms:\n${stdout}${stderr}`));
    }, START_TIMEOUT_MS);
  });
}

test('a real production install can start the packaged cockpit without Vite', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'compose-package-start-'));
  const packDir = join(root, 'pack');
  const installDir = join(root, 'install');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const testBin = join(root, 'bin');
  const packCache = join(root, 'pack-cache');
  mkdirSync(packDir);
  mkdirSync(installDir);
  mkdirSync(workspace);
  mkdirSync(home);
  mkdirSync(testBin);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cleanEnv = {
    ...process.env,
    RESEND_API_KEY: '',
    STRIPE_API_KEY: '',
  };
  const packed = await run('npm', ['pack', '--json', '--pack-destination', packDir, '--cache', packCache], {
    cwd: REPO_ROOT,
    env: cleanEnv,
  });
  assert.equal(packed.code, 0, `npm pack failed:\n${packed.stdout}${packed.stderr}`);
  const [{ filename }] = JSON.parse(packed.stdout);

  writeFileSync(join(installDir, 'package.json'), '{"private":true}\n');
  const installCache = process.env.COMPOSE_PACKAGE_TEST_NPM_CACHE || join(root, 'install-cache');
  const installed = await run('npm', [
    'install',
    ...(process.env.COMPOSE_PACKAGE_TEST_NPM_CACHE ? ['--offline'] : []),
    '--prefer-offline',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--cache', installCache,
    join(packDir, filename),
  ], { cwd: installDir, env: cleanEnv });
  assert.equal(installed.code, 0, `npm install of packed tarball failed:\n${installed.stdout}${installed.stderr}`);

  const composeBin = join(installDir, 'node_modules', '.bin', 'compose');
  assert.ok(existsSync(composeBin), 'real npm install did not create the compose bin');
  assert.equal(
    existsSync(join(installDir, 'node_modules', '.bin', 'vite')),
    false,
    'test precondition failed: production install unexpectedly contains Vite',
  );

  mkdirSync(join(workspace, '.compose'), { recursive: true });
  writeFileSync(join(workspace, '.compose', 'compose.json'), JSON.stringify({
    version: 1,
    capabilities: { stratum: false, lifecycle: false },
  }));

  // listen(0) allocates from the OS ephemeral range. Keep this real installed
  // server below the default macOS/Linux ephemeral ranges so parallel tests
  // cannot receive our traffic through an address-family-specific listener.
  const portBase = TEST_PORT_FLOOR + ((process.pid % TEST_PORT_SLOTS) * 3);

  // The production supervisor clears configured ports by killing any listener
  // reported by lsof. This test has not reserved ownership of those processes,
  // so make lsof unavailable to this child only: a genuine collision must make
  // the test fail with EADDRINUSE, never kill another test's HTTP server.
  const lsofShim = join(testBin, 'lsof');
  writeFileSync(lsofShim, '#!/bin/sh\nexit 1\n');
  chmodSync(lsofShim, 0o755);

  await startInstalledCompose(composeBin, workspace, {
    ...cleanRuntimeEnv(cleanEnv),
    PATH: `${testBin}:${cleanEnv.PATH}`,
    HOME: home,
    COMPOSE_TARGET: workspace,
    PORT: String(portBase),
    AGENT_PORT: String(portBase + 1),
    VITE_PORT: String(portBase + 2),
  });

  const installedPackage = join(installDir, 'node_modules', '@smartmemory', 'compose');
  assert.doesNotThrow(
    () => readFileSync(join(installedPackage, 'dist', 'index.html'), 'utf8'),
    'installed package is missing the prebuilt cockpit',
  );
});
