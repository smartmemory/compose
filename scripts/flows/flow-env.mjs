/**
 * scripts/flows/flow-env.mjs — the sandbox Compose's own user flows run in
 * (COMP-VERIFY-FLOW-1 dogfood). Shared by scripts/flows/pipeline-roundtrip.mjs
 * and e2e/builder-save-blur.spec.js.
 *
 * Every flow gets: a throwaway workspace (COMPOSE_TARGET) and HOME, ports from
 * the shared test range 19000-19999 that both ~/.claude/scripts/port_check.py
 * (when present) and the OS call free, and THIS checkout's server started
 * against the throwaway. Nothing reaches the owner's live cockpit (:4001) or
 * agent (:4002): the cockpit's Vite config hard-wires its proxy to :4001, so
 * the UI flow serves it through a wrapper config with every proxy target
 * rewritten to the flow's own server, and refuses to start if any target
 * still names :4001 or :4002.
 *
 * A setup failure exits SETUP_EXIT (3), which the flows declare in
 * `setup_exit_codes`, so Compose reports FLOW_SETUP_ERROR, not FLOW_FAILED.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SETUP_EXIT = 3;
export const LIVE_PORTS = [4001, 4002];

export function setupFail(msg) {
  console.error(`SETUP: ${msg}`);
  process.exit(SETUP_EXIT);
}

/** A port in the shared test range that the registry and the OS both call free. */
export async function pickPort(taken = new Set()) {
  const checker = path.join(homedir(), '.claude', 'scripts', 'port_check.py');
  for (let i = 0; i < 30; i++) {
    const port = 19000 + Math.floor(Math.random() * 1000);
    if (taken.has(port)) continue;
    if (existsSync(checker) && spawnSync('python3', [checker, String(port)], { encoding: 'utf8' }).status !== 0) continue;
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) { taken.add(port); return port; }
  }
  return setupFail('no free port in 19000-19999 after 30 tries');
}

/** A throwaway root with a workspace (minimal config, no guard, no SmartMemory) and a HOME. */
export function makeSandbox(prefix) {
  const work = mkdtempSync(path.join(process.env.SM_SCRATCH_ROOT || tmpdir(), `flow-${prefix}-`));
  const ws = path.join(work, 'ws');
  const home = path.join(work, 'home');
  mkdirSync(path.join(ws, '.compose'), { recursive: true });
  mkdirSync(path.join(ws, 'pipelines'), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(ws, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: false, lifecycle: false, guard: false } }));
  return { work, ws, home, remove: () => rmSync(work, { recursive: true, force: true }) };
}

async function waitFor(url, child, what, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) setupFail(`${what} exited ${child.exitCode}: ${child.lastErr?.trim().split('\n').pop() ?? ''}`);
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) setupFail(`${what} did not answer ${url} within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function track(child) {
  child.lastErr = '';
  child.stderr?.on('data', (b) => { child.lastErr = (child.lastErr + b).slice(-4000); });
  return child;
}

/** This checkout's Compose server against the sandbox workspace. */
export async function startServer(sb, taken = new Set()) {
  const port = await pickPort(taken);
  const agentPort = await pickPort(taken);
  const child = track(spawn(process.execPath, ['server/index.js'], {
    cwd: REPO,
    env: { ...process.env, HOME: sb.home, COMPOSE_TARGET: sb.ws, PORT: String(port), AGENT_PORT: String(agentPort), COMPOSE_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  await waitFor(`http://127.0.0.1:${port}/api/pipeline/specs`, child, 'compose server');
  return { port, child, base: `http://127.0.0.1:${port}` };
}

/** This checkout's cockpit through Vite, every proxy target rewritten to the sandbox server. */
export async function startCockpit(sb, server, taken = new Set()) {
  const port = await pickPort(taken);
  const config = path.join(sb.work, 'vite.flow.config.mjs');
  writeFileSync(config, `
import base from ${JSON.stringify(path.join(REPO, 'vite.config.js'))};
const cfg = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
const retarget = (t) => t.replace(/:(4001|4002)\\b/, ':${server.port}');
const proxy = Object.fromEntries(Object.entries(cfg.server?.proxy ?? {}).map(([k, v]) =>
  [k, typeof v === 'string' ? retarget(v) : { ...v, target: retarget(v.target) }]));
const left = Object.values(proxy).map((v) => (typeof v === 'string' ? v : v.target)).filter((t) => /:(4001|4002)\\b/.test(t));
if (left.length) throw new Error('a proxy target still names a live port: ' + left.join(', '));
export default { ...cfg, clearScreen: false, cacheDir: ${JSON.stringify(path.join(sb.work, 'vite-cache'))},
  server: { ...cfg.server, port: ${port}, strictPort: true, proxy } };
`);
  let vite;
  try {
    vite = path.join(path.dirname(createRequire(path.join(REPO, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
  } catch (error) { return setupFail(`vite is not installed for ${REPO}: ${error.message}`); }
  const child = track(spawn(process.execPath, [vite, '--config', config], {
    cwd: REPO, env: { ...process.env, HOME: sb.home, VITE_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'],
  }));
  await waitFor(`http://127.0.0.1:${port}/`, child, 'vite');
  return { port, child, base: `http://127.0.0.1:${port}` };
}

export function stopAll(...children) {
  for (const c of children) if (c && c.exitCode === null) c.kill('SIGTERM');
}
