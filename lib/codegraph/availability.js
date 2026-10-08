// lib/codegraph/availability.js — STRAT-CODEGRAPH-1
//
// Is there a SmartMemory that can produce a code bundle on this machine?
// SmartMemory is OPTIONAL (owner decision 2026-10-05): without it every
// codegraph check is a no-op that prints one warn line per process, the same
// shape as the judgment enrichment (lib/judgment-gen.js:47). Nothing here
// throws into a build.
//
// Producer order: the SmartMemory CLI (`smartmemory code bundle`, CODE-BUNDLE-CLI-1)
// when `smartmemory code bundle --help` exits 0, else the Python fallback
// adapter (bundle_fallback.py), which needs a smartmemory whose CodeIndexer
// has a store-free `parse` (core main; no PyPI release has it as of 1.5.23).

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FALLBACK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bundle_fallback.py');
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
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Detect the bundle producer. Memoized per (cwd, python).
 *
 * @returns {Promise<{available: boolean, mode: 'cli'|'fallback'|null, python: string|null,
 *   version: string|null, typescriptGrammar: boolean|null, reason: string|null, fallbackReason: string|null,
 *   warnings: string[]}>}  fallbackReason: why the CLI was not used (mode 'fallback' only).
 */
export async function detectCodegraph({ cwd = process.cwd(), env = process.env } = {}) {
  const config = readCodegraphConfig(cwd);
  const python = env.COMPOSE_CODEGRAPH_PYTHON || config.python || 'python3';
  const key = `${cwd}\0${python}\0${env.COMPOSE_CODEGRAPH ?? ''}\0${config.enabled ?? ''}`;
  if (!memo.has(key)) memo.set(key, probe({ config, python, env }));
  return memo.get(key);
}

async function probe({ config, python, env }) {
  const base = { available: false, mode: null, python, version: null, typescriptGrammar: null, reason: null, fallbackReason: null, warnings: [] };
  if (env.COMPOSE_CODEGRAPH === '0' || config.enabled === false) {
    return { ...base, reason: 'disabled by configuration' };
  }
  // Build tests (NODE_ENV=test) reach plan_gate and explore_design with temp projects; a
  // capable SmartMemory on the machine would index each one. Opt in with COMPOSE_CODEGRAPH=1.
  if (env.NODE_ENV === 'test' && env.COMPOSE_CODEGRAPH !== '1') {
    return { ...base, reason: 'disabled under NODE_ENV=test (set COMPOSE_CODEGRAPH=1 to enable)' };
  }

  // CLI first. Its version and grammar coverage are its own business.
  const cli = await run('smartmemory', ['code', 'bundle', '--help'], { env });
  if (cli.ok) {
    const version = await run('smartmemory', ['--version'], { env });
    return { ...base, available: true, mode: 'cli', version: version.ok ? version.stdout.trim() || null : null };
  }

  const fallbackReason = cli.code === 'ENOENT'
    ? 'no `smartmemory` command on PATH'
    : `\`smartmemory code bundle --help\` failed (exit ${cli.code ?? '?'}): the installed CLI has no \`code bundle\` (CODE-BUNDLE-CLI-1)`;
  const probeRun = await run(python, ['-I', FALLBACK_SCRIPT, '--probe'], { env });
  if (!probeRun.ok) {
    return { ...base, reason: `no Python at "${python}" could run the codegraph probe` };
  }
  let report;
  try {
    report = JSON.parse(probeRun.stdout.trim().split('\n').pop());
  } catch {
    return { ...base, reason: 'codegraph probe returned unreadable output' };
  }
  if (!report.smartmemory) {
    return { ...base, reason: `smartmemory is not importable from ${python}` };
  }
  if (!report.store_free_parse) {
    return {
      ...base,
      version: report.version ?? null,
      reason: `smartmemory ${report.version ?? '?'} has no store-free CodeIndexer.parse (needs a core build with it; PyPI 1.5.23 lacks it)`,
    };
  }
  const warnings = [];
  if (!report.typescript_grammar) {
    warnings.push('tree-sitter-typescript/javascript are not installed: JS/TS files will not be parsed');
  }
  return {
    ...base,
    available: true,
    mode: 'fallback',
    fallbackReason,
    version: report.version ?? null,
    typescriptGrammar: !!report.typescript_grammar,
    warnings,
  };
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
