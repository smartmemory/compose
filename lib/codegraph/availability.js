// lib/codegraph/availability.js — STRAT-CODEGRAPH-1
//
// Is there a SmartMemory CLI that can produce a code bundle on this machine?
// SmartMemory is OPTIONAL (owner decision 2026-10-05): without it every
// codegraph check is a no-op that prints one warn line per process, the same
// shape as the judgment enrichment (lib/judgment-gen.js:47). Nothing here
// throws into a build.
//
// The producer is `smartmemory code bundle` (CODE-BUNDLE-CLI-1), version >= 1.5.26
// (1.5.25 segfaults on TypeScript repos). Discovery order: `.compose/compose.json`
// `codegraph.smartmemory`, then $COMPOSE_CODEGRAPH_SMARTMEMORY, then `smartmemory` on PATH.

import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const MIN_VERSION = '1.5.26';
const BROKEN_VERSIONS = new Map([['1.5.25', 'known segfault on TypeScript repos']]);
const PROBE_TIMEOUT_MS = 30000;

const memo = new Map();
const warned = new Set();

/** Print `[codegraph] message` once per key per process. Returns true when it printed. */
export function warnOnce(key, message) {
  if (warned.has(key)) return false;
  warned.add(key);
  console.warn(`[codegraph] ${message}`);
  return true;
}

/** Test seam: forget memoized probes and printed warnings. */
export function resetAvailabilityCache() {
  memo.clear();
  warned.clear();
}

/** The `codegraph` block of .compose/compose.json, or {}. */
export function readCodegraphConfig(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf8'));
    const block = config?.codegraph;
    return block && typeof block === 'object' ? block : {};
  } catch {
    return {};
  }
}

function run(cmd, args, { env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, code: error ? (error.code ?? null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Which CLI to run, and where the choice came from. A configured value with a slash is a path
 * (relative to the project root); a bare name is looked up on PATH like the default.
 */
export function locateCli({ cwd, env, config }) {
  const [spec, origin] = typeof config.smartmemory === 'string' && config.smartmemory
    ? [config.smartmemory, 'codegraph.smartmemory in .compose/compose.json']
    : env.COMPOSE_CODEGRAPH_SMARTMEMORY
      ? [env.COMPOSE_CODEGRAPH_SMARTMEMORY, 'COMPOSE_CODEGRAPH_SMARTMEMORY']
      : ['smartmemory', 'PATH'];
  if (spec.includes('/')) {
    const path = isAbsolute(spec) ? spec : resolve(cwd, spec);
    return { command: executable(path) ? path : null, spec, origin };
  }
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(dir, spec);
    if (executable(path)) return { command: path, spec, origin };
  }
  return { command: null, spec, origin };
}

/** [major, minor, patch] of "smartmemory, version 1.5.26" (or a bare "1.5.26"), else null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, minimum) {
  const min = parseVersion(minimum);
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/**
 * Which installation a CLI path is right now: the followed file's identity. A pip/uv (re)install
 * rewrites the console script, so an upgrade or downgrade at the same path re-probes.
 */
function installIdentity({ cwd, env, config }) {
  const { command } = locateCli({ cwd, env, config });
  if (!command) return 'none';
  try {
    const st = statSync(command, { bigint: true });
    return `${command}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return `${command}:gone`;
  }
}

/**
 * Detect the bundle producer. Memoized per (cwd, CLI choice, switches, installed CLI identity).
 *
 * @returns {Promise<{available: boolean, mode: 'cli'|null, command: string|null, version: string|null,
 *   reason: string|null, warnings: string[]}>}  command: the resolved CLI path.
 */
export async function detectCodegraph({ cwd = process.cwd(), env = process.env } = {}) {
  const config = readCodegraphConfig(cwd);
  const key = [cwd, config.smartmemory ?? '', env.COMPOSE_CODEGRAPH_SMARTMEMORY ?? '', env.PATH ?? '',
    env.COMPOSE_CODEGRAPH ?? '', config.enabled ?? '', env.NODE_ENV ?? '', installIdentity({ cwd, env, config })].join('\0');
  if (!memo.has(key)) memo.set(key, probe({ cwd, config, env }));
  return memo.get(key);
}

async function probe({ cwd, config, env }) {
  const base = { available: false, mode: null, command: null, version: null, reason: null, warnings: [] };
  if (env.COMPOSE_CODEGRAPH === '0' || config.enabled === false) {
    return { ...base, reason: 'disabled by configuration' };
  }
  // Build tests (NODE_ENV=test) reach plan_gate and explore_design with temp projects; a
  // capable SmartMemory on the machine would index each one. Opt in with COMPOSE_CODEGRAPH=1.
  if (env.NODE_ENV === 'test' && env.COMPOSE_CODEGRAPH !== '1') {
    return { ...base, reason: 'disabled under NODE_ENV=test (set COMPOSE_CODEGRAPH=1 to enable)' };
  }
  const upgrade = `pip install 'smartmemory>=${MIN_VERSION}'`;
  const { command, spec, origin } = locateCli({ cwd, env, config });
  if (!command) {
    return { ...base, reason: `no SmartMemory CLI: \`${spec}\` (from ${origin}) is not an executable; ${upgrade}` };
  }
  const versionRun = await run(command, ['--version'], { env });
  const version = parseVersion(versionRun.stdout) ? parseVersion(versionRun.stdout).join('.') : null;
  if (!version) {
    return { ...base, command, reason: `\`${command} --version\` gave no version (exit ${versionRun.code ?? '?'}); ${upgrade}` };
  }
  if (BROKEN_VERSIONS.has(version)) {
    return { ...base, command, version, reason: `smartmemory ${version} at ${command} has a ${BROKEN_VERSIONS.get(version)}; upgrade: ${upgrade}` };
  }
  if (!atLeast(parseVersion(version), MIN_VERSION)) {
    return { ...base, command, version, reason: `smartmemory ${version} at ${command} is older than ${MIN_VERSION}; upgrade: ${upgrade}` };
  }
  const help = await run(command, ['code', 'bundle', '--help'], { env });
  if (!help.ok) {
    return { ...base, command, version, reason: `\`${command} code bundle --help\` failed (exit ${help.code ?? '?'}); ${upgrade}` };
  }
  return { ...base, available: true, mode: 'cli', command, version };
}

/**
 * Detect, and print the one-time notice for this outcome. Callers use this at
 * every entry point so "unavailable" is a single warn line per process.
 */
export async function requireCodegraph(opts = {}) {
  const availability = await detectCodegraph(opts);
  if (!availability.available) {
    warnOnce('unavailable', `code graph checks skipped: ${availability.reason}`);
  } else {
    for (const warning of availability.warnings) warnOnce(`warning:${warning}`, warning);
  }
  return availability;
}
