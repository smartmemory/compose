#!/usr/bin/env node
/**
 * npm-install-test.mjs (STRATUM-NPM-PUBLISH-CURRENT-1): install Compose the way a new user does,
 * from the npm registry into an empty directory with a fresh HOME, then walk the first-run path:
 * setup, git init, init, feature, build (up to the first step, past the model catalog) and start
 * with a headless load of the cockpit and the Stratum view.
 *
 * Why: a checkout with a sibling `stratum/` hides a stale npm Stratum (the 0.7.3 package had no
 * `models` command, the 0.1.0 UI package no `NavProvider`, so new users got a failing build and a
 * blank page while every local test passed).
 *
 * Network and slow (a cold npm cache downloads ~500 packages). Not part of `npm test`.
 *
 * Env:
 *   COMPOSE_NPM_SPEC   what to install (default `@smartmemory/compose@latest`; a tarball path works)
 *   COMPOSE_NPM_EXTRA  extra space-separated specs installed alongside (e.g. local Stratum tarballs)
 *   COMPOSE_NPM_CACHE  npm cache dir (default: a fresh one inside the temp dir, a true cold start)
 *   COMPOSE_NPM_DIR    work dir (default: a new temp dir), COMPOSE_NPM_KEEP=1 keeps it
 *
 * The child env is minimal (HOME, PATH, TMPDIR) and carries invalid provider keys, so the build
 * step can never reach a model on someone's account: the run stops it at its first step line.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = process.env.COMPOSE_NPM_SPEC || '@smartmemory/compose@latest';
const extra = (process.env.COMPOSE_NPM_EXTRA || '').split(/\s+/).filter(Boolean);
const root = process.env.COMPOSE_NPM_DIR || mkdtempSync(join(tmpdir(), 'compose-npm-install-'));
const home = join(root, 'home');
const install = join(root, 'install');
const proj = join(root, 'proj');
const cache = process.env.COMPOSE_NPM_CACHE || join(root, 'npm-cache');
for (const d of [home, install, proj]) mkdirSync(d, { recursive: true });

// Requests a packaged install cannot answer: these routes exist only with the owner's sibling
// checkouts (Cadence UI, ops status). Reported as WARNING, never silently dropped.
const KNOWN_SIBLING_ONLY = [/\/api\/cadence-ui\//, /\/api\/ops-status\//];

const env = {
  HOME: home,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  TMPDIR: tmpdir(),
  npm_config_cache: cache,
  ANTHROPIC_API_KEY: 'sk-invalid-npm-install-test',
  OPENAI_API_KEY: 'sk-invalid-npm-install-test',
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}
function run(cmd, args, cwd, timeoutMs = 300000) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const lastLines = (s, n = 3) => s.trim().split('\n').slice(-n).join(' | ');
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function main() {
  console.log(`[npm-install-test] dir ${root}`);
  console.log(`[npm-install-test] installing ${[spec, ...extra].join(' ')} (cache ${cache})`);
  writeFileSync(join(install, 'package.json'), '{"name":"compose-npm-install-test","private":true}\n');
  const t0 = Date.now();
  const inst = run('npm', ['install', '--no-audit', '--no-fund', spec, ...extra], install, 1800000);
  if (!record('npm install', inst.code === 0, `${Math.round((Date.now() - t0) / 1000)}s ${lastLines(inst.out, 2)}`)) return;

  const pkgDir = (name) => join(install, 'node_modules', '@smartmemory', name);
  for (const name of ['compose', 'stratum', 'stratum-ui']) {
    const dir = pkgDir(name);
    const real = existsSync(dir) && !lstatSync(dir).isSymbolicLink();
    const version = real ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version : 'missing';
    record(`@smartmemory/${name} is an installed copy`, real, version);
  }
  const compose = join(pkgDir('compose'), 'bin', 'compose.js');
  const stratumCli = join(pkgDir('stratum'), 'dist', 'cli', 'stratum.js');

  const models = run(process.execPath, [stratumCli, 'models', '--json'], proj, 60000);
  let catalogOk = false;
  try { catalogOk = models.code === 0 && typeof JSON.parse(models.out).catalog === 'object'; } catch { /* reported below */ }
  record('stratum models --json', catalogOk, catalogOk ? '' : lastLines(models.out));

  const setup = run(process.execPath, [compose, 'setup'], proj);
  record('compose setup', setup.code === 0, setup.code === 0 ? '' : lastLines(setup.out));
  const gitInit = run('git', ['init', '-q'], proj);
  const gitCommit = run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init'], proj);
  record('git init', gitInit.code === 0 && gitCommit.code === 0);
  const init = run(process.execPath, [compose, 'init'], proj);
  record('compose init', init.code === 0, init.code === 0 ? '' : lastLines(init.out));
  const feature = run(process.execPath, [compose, 'feature', 'T-1', 'npm install test feature'], proj);
  record('compose feature T-1', feature.code === 0, feature.code === 0 ? '' : lastLines(feature.out));

  // build: passes once the first step starts (the model catalog and engine resolved), then stops it.
  const buildResult = await new Promise((res) => {
    const child = spawn(process.execPath, [compose, 'build', 'T-1'], { cwd: proj, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (ok, why) => { if (done) return; done = true; clearTimeout(timer); killGroup(child); res({ ok, why }); };
    const timer = setTimeout(() => finish(false, `no step started in 180s: ${lastLines(out)}`), 180000);
    const onData = (b) => {
      out += b.toString().replace(/\x1b\[[0-9;]*m/g, ''); // the CLI colors its step lines
      if (/Unable to load model catalog|Malformed model catalog/.test(out)) finish(false, lastLines(out));
      else if (/^\[[?\d]+\/[?\d]+\] \S+\.\.\./m.test(out)) finish(true, out.match(/^\[[?\d]+\/[?\d]+\] \S+\.\.\./m)[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(false, `exited ${code} before a step started: ${lastLines(out)}`));
  });
  record('compose build T-1 reaches its first step (past the model catalog)', buildResult.ok, buildResult.why);

  const port = await freePort();
  const agentPort = await freePort();
  const server = spawn(process.execPath, [compose, 'start'], { cwd: proj, env: { ...env, PORT: String(port), AGENT_PORT: String(agentPort) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  server.stdout.on('data', (b) => { serverOut += b; });
  server.stderr.on('data', (b) => { serverOut += b; });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/`)).status === 200; } catch { /* not yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!record(`compose start serves the cockpit on ${port}`, up, up ? '' : lastLines(serverOut))) return;

    const { chromium } = createRequire(join(REPO, 'package.json'))('@playwright/test');
    const browser = await chromium.launch();
    try {
      for (const [path, mustSee] of [['/', /COMPOSE/i], ['/?view=stratum', /Runs[\s\S]*Gates|Gates[\s\S]*Runs/]]) {
        const page = await browser.newPage();
        const errors = [];
        const warnings = [];
        const failed = new Set();
        page.on('response', (r) => {
          if (r.status() < 400) return;
          if (KNOWN_SIBLING_ONLY.some((re) => re.test(r.url()))) { warnings.push(`${r.status()} ${r.url()}`); failed.add(r.status()); } else errors.push(`http ${r.status()} ${r.url()}`);
        });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          // The browser's own "Failed to load resource" line for a response already classified above.
          if (/^Failed to load resource: the server responded with a status of (\d+)/.test(m.text()) && failed.has(Number(RegExp.$1))) return;
          errors.push(`console: ${m.text()}`);
        });
        await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);
        const text = (await page.evaluate(() => document.body.innerText)).trim();
        for (const w of warnings) console.log(`WARNING ${path}: request a packaged install cannot answer (sibling-only route): ${w}`);
        record(`UI ${path} renders with no errors`, mustSee.test(text) && errors.length === 0, `${text.length} chars${errors.length ? `, errors: ${errors.join(' ; ')}` : ''}`);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    killGroup(server);
  }
}

try {
  await main();
} catch (e) {
  record('npm install test', false, e.stack || String(e));
} finally {
  if (process.env.COMPOSE_NPM_KEEP === '1' || process.env.COMPOSE_NPM_DIR) console.log(`[npm-install-test] kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
const failedCount = results.filter((r) => !r.ok).length;
console.log(`[npm-install-test] ${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 && results.length > 0 ? 0 : 1);
