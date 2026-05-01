/**
 * bug-checkpoint.js — COMP-FIX-HARD T2.
 *
 * Emits docs/bugs/<bug_code>/checkpoint.md when a bug-mode pipeline force-terminates,
 * then triggers regeneration of the global docs/bugs/INDEX.md.
 *
 * The bug-index-gen.js module is imported dynamically to tolerate parallel-task
 * development: if T3's file is not yet present, we still write the checkpoint and
 * emit a warning instead of throwing. Tests inject a stub via
 * __setRegenerateBugIndexForTest.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const DIFF_CAP = 5000;

// Test seam: tests can install a fake regenerator. When null, the default
// dynamic-import path is used.
let regeneratorOverride = null;

/**
 * Test-only hook to override the regenerateBugIndex implementation.
 * Pass `null` to restore default behavior.
 * @param {((cwd: string) => void | Promise<void>) | null} fn
 */
export function __setRegenerateBugIndexForTest(fn) {
  regeneratorOverride = fn;
}

/**
 * Emit a checkpoint markdown file for a bug whose pipeline has force-terminated,
 * then regenerate the bugs INDEX.
 *
 * @param {{ cwd: string, bug_code: string }} context - Build context (must include cwd and bug_code).
 * @param {string} stepId - The pipeline step that exhausted retries.
 * @param {{ violations?: any[], retries_exhausted?: number, [k: string]: any }} terminalResult
 *        - The final step response that triggered termination.
 * @returns {Promise<string>} Absolute path of the written checkpoint.md.
 */
export async function emitCheckpoint(context, stepId, terminalResult) {
  const { cwd, bug_code } = context;
  const bugDir = join(cwd, 'docs', 'bugs', bug_code);
  mkdirSync(bugDir, { recursive: true });

  const ts = new Date().toISOString();
  const retriesExhausted =
    (terminalResult && typeof terminalResult.retries_exhausted === 'number'
      ? terminalResult.retries_exhausted
      : null) ?? readActiveBuildRetries(cwd, stepId) ?? 0;

  const diffBody = getCurrentDiff(cwd);

  const violations =
    terminalResult && Array.isArray(terminalResult.violations) ? terminalResult.violations : [];
  const failureBody = formatLastFailure(violations[0]);

  const ledgerPointer = existsSync(join(bugDir, 'hypotheses.jsonl'))
    ? '[hypotheses.jsonl](./hypotheses.jsonl)'
    : '(none yet)';

  const md = [
    `# Checkpoint: ${bug_code}`,
    '',
    `**Time:** ${ts}`,
    `**Step:** ${stepId}`,
    `**Retries exhausted:** ${retriesExhausted}`,
    '',
    '## Current Diff',
    '',
    '```diff',
    diffBody,
    '```',
    '',
    '## Last Failure',
    '',
    '```',
    failureBody,
    '```',
    '',
    '## Hypothesis Ledger',
    '',
    ledgerPointer,
    '',
    '## To Resume',
    '',
    '```bash',
    `compose fix ${bug_code} --resume`,
    '```',
    '',
    '## Next Steps',
    '',
    '- Inspect the diff above and decide whether to keep, amend, or revert it.',
    '- Review the hypothesis ledger for previously rejected diagnoses.',
    '- Run the resume command to re-enter the failed step with full context.',
    '- If the bug is unsolvable in this session, mark it `PARKED` in the roadmap.',
    '',
  ].join('\n');

  const checkpointPath = join(bugDir, 'checkpoint.md');
  writeFileSync(checkpointPath, md, 'utf8');

  await invokeRegenerateBugIndex(cwd);

  return checkpointPath;
}

/**
 * Capture `git diff --no-color HEAD`, capped at DIFF_CAP chars.
 * Returns "(unable to get diff)" if git is unavailable or cwd is not a repo.
 * Never throws.
 */
function getCurrentDiff(cwd) {
  try {
    const out = execSync('git diff --no-color HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!out || out.length === 0) return '(no changes)';
    return out.length > DIFF_CAP ? out.slice(0, DIFF_CAP) : out;
  } catch {
    return '(unable to get diff)';
  }
}

/**
 * Best-effort lookup of retries-so-far from .compose/data/active-build.json.
 * Returns null when unavailable.
 */
function readActiveBuildRetries(cwd, stepId) {
  try {
    const p = join(cwd, '.compose', 'data', 'active-build.json');
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const counters = obj?.retryCounters || obj?.retry_counters;
    if (counters && typeof counters[stepId] === 'number') return counters[stepId];
    return null;
  } catch {
    return null;
  }
}

/**
 * Format the head violation for the Last Failure block.
 * - JSON-stringify objects (pretty), pass strings through.
 */
function formatLastFailure(v) {
  if (v == null) return '(no violation captured)';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Resolve the regenerateBugIndex function and call it. Honors test override.
 * Falls back gracefully (warning to stderr) if the sibling module isn't present yet.
 */
async function invokeRegenerateBugIndex(cwd) {
  if (typeof regeneratorOverride === 'function') {
    await regeneratorOverride(cwd);
    return;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const target = join(here, 'bug-index-gen.js');
    if (!existsSync(target)) {
      // Sibling module not built yet (parallel-task race); skip silently in that
      // narrow window. INDEX will refresh next time a checkpoint emits.
      return;
    }
    const mod = await import(`file://${target}`);
    if (typeof mod.regenerateBugIndex === 'function') {
      await mod.regenerateBugIndex(cwd);
    }
  } catch (err) {
    process.stderr.write(`[bug-checkpoint] regenerateBugIndex failed: ${err?.message || err}\n`);
  }
}
