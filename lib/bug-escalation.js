/**
 * bug-escalation.js — COMP-FIX-HARD T10 Tier 1 + Tier 2 escalation.
 *
 * Tier 1: Codex second opinion (read-only). Costs ~30s, no writes.
 *   - Constructs a bounded prompt (one bug, one ledger, one diff).
 *   - Dispatches via stratum.runAgentText('codex', prompt, {cwd}).
 *   - Parses output to canonical ReviewResult via review-normalize.
 *   - Appends an `escalation_tier_1` entry to the bug's hypothesis ledger.
 *
 * Tier 2: Fresh agent in an isolated git worktree (patch-only, never commits).
 *   - "Materially new" gate: only proceeds if Codex's hypothesis is not already
 *     present in the ledger as a rejected entry.
 *   - Creates a detached worktree under ~/.stratum/worktrees/comp-fix-hard/<bug>-<ts>/.
 *   - Dispatches a fresh Claude agent with explicit "DO NOT commit" instructions
 *     and a target patch artifact path docs/bugs/<bug>/escalation-patch-<N>.md.
 *   - Cleanup runs in finally — worktree is removed on both success and error.
 *
 * Pattern references:
 *   - lib/build.js:2670+ (parallel-dispatch worktree create/remove)
 *   - lib/review-normalize.js (normalizeReviewResult)
 *   - lib/stratum-mcp-client.js (runAgentText)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

import { normalizeReviewResult } from './review-normalize.js';
import { appendHypothesisEntry, readHypotheses } from './bug-ledger.js';

// ---------------------------------------------------------------------------
// Tier 1 — Codex read-only second opinion
// ---------------------------------------------------------------------------

/**
 * Format the hypothesis ledger as a "Previously attempted" block for the
 * Codex prompt. Includes both rejected and accepted entries so Codex sees
 * the full investigation history, not just dead ends.
 */
function formatHypothesisBlock(hypotheses) {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
    return '## Previously attempted hypotheses\n\n_(none — this is the first escalation.)_\n';
  }
  const lines = ['## Previously attempted hypotheses', ''];
  for (const h of hypotheses) {
    if (!h) continue;
    lines.push(`- **Attempt ${h.attempt ?? '?'}** (${h.verdict ?? 'unknown'}): ${h.hypothesis ?? '(no hypothesis recorded)'}`);
    if (Array.isArray(h.evidence_against) && h.evidence_against.length > 0) {
      for (const ev of h.evidence_against) lines.push(`  - against: ${typeof ev === 'string' ? ev : JSON.stringify(ev)}`);
    }
    if (h.next_to_try) lines.push(`  - next_to_try: ${h.next_to_try}`);
  }
  return lines.join('\n') + '\n';
}

function buildCodexPrompt(bugDescription, reproTest, currentDiff, hypotheses) {
  return [
    '# Bug-fix second opinion (read-only)',
    '',
    'You are Codex acting as a second opinion on a stuck bug-fix loop. Do NOT modify any files. Output a structured review.',
    '',
    '## Bug description',
    '',
    bugDescription || '(no description provided)',
    '',
    '## Reproducer test',
    '',
    '```',
    reproTest || '(no repro provided)',
    '```',
    '',
    '## Current working diff',
    '',
    '```diff',
    currentDiff || '(no diff yet)',
    '```',
    '',
    formatHypothesisBlock(hypotheses),
    '',
    '## Output format',
    '',
    'Respond with a JSON object: { "summary": string, "findings": [{ "lens": "general", "file": string|null, "line": number|null, "severity": "must-fix"|"should-fix"|"nit", "finding": string, "confidence": 1-10, "rationale": string }] }.',
    '',
    'Focus on hypotheses NOT already attempted above. If you spot a materially new angle, flag it as must-fix with high confidence.',
    '',
  ].join('\n');
}

/**
 * Tier 1 — dispatch Codex for a read-only second opinion on a stuck bug.
 *
 * @param {object} stratum         StratumMcpClient (must expose runAgentText)
 * @param {object} context         { cwd, mode:'bug', bug_code }
 * @param {string} bugDescription
 * @param {string} reproTest
 * @param {string} currentDiff
 * @param {object[]} hypotheses    ledger entries (readHypotheses output)
 * @returns {Promise<object>} canonical ReviewResult
 */
export async function tier1CodexReview(stratum, context, bugDescription, reproTest, currentDiff, hypotheses) {
  const codexPrompt = buildCodexPrompt(bugDescription, reproTest, currentDiff, hypotheses ?? []);
  const rawText = await stratum.runAgentText('codex', codexPrompt, { cwd: context.cwd });

  const review = await normalizeReviewResult(rawText, {
    agentType: 'codex',
    lens: 'general',
    confidenceGate: 7,
  });

  // Append to ledger as escalation_tier_1.
  try {
    const prior = readHypotheses(context.cwd, context.bug_code);
    const attempt = prior.length + 1;
    appendHypothesisEntry(context.cwd, context.bug_code, {
      attempt,
      ts: new Date().toISOString(),
      hypothesis: review.summary || (review.findings[0]?.finding ?? '(codex returned no summary)'),
      verdict: 'escalation_tier_1',
      agent: 'codex',
      findings: review.findings,
    });
  } catch (err) {
    // Best-effort: ledger I/O must not abort the escalation flow.
    // eslint-disable-next-line no-console
    console.warn(`[bug-escalation] tier1 ledger append failed: ${err?.message || err}`);
  }

  return review;
}

// ---------------------------------------------------------------------------
// Tier 2 — Fresh agent in worktree (patch-only)
// ---------------------------------------------------------------------------

const WORKTREE_BASE = join(homedir(), '.stratum', 'worktrees', 'comp-fix-hard');

/**
 * Determine whether Codex's hypothesis is "materially new" — i.e., not already
 * in the ledger with verdict 'rejected'. Comparison is a case-insensitive
 * normalized string equality on the hypothesis text.
 */
function isMateriallyNew(codexReview, ledgerEntries) {
  const codexHyp = String(codexReview?.summary ?? codexReview?.findings?.[0]?.finding ?? '').trim().toLowerCase();
  if (!codexHyp) return false;
  for (const e of ledgerEntries ?? []) {
    if (e?.verdict !== 'rejected') continue;
    const prior = String(e.hypothesis ?? '').trim().toLowerCase();
    if (!prior) continue;
    if (prior === codexHyp || prior.includes(codexHyp) || codexHyp.includes(prior)) {
      return false;
    }
  }
  return true;
}

/**
 * Pick the next escalation-patch-N.md filename, counting existing ones in
 * docs/bugs/<bug-code>/.
 */
function nextPatchPath(cwd, bugCode) {
  const bugDir = join(cwd, 'docs', 'bugs', bugCode);
  let n = 1;
  if (existsSync(bugDir)) {
    const existing = readdirSync(bugDir).filter(f => /^escalation-patch-(\d+)\.md$/.test(f));
    if (existing.length > 0) {
      const max = existing.reduce((acc, name) => {
        const m = name.match(/^escalation-patch-(\d+)\.md$/);
        const num = m ? parseInt(m[1], 10) : 0;
        return num > acc ? num : acc;
      }, 0);
      n = max + 1;
    }
  }
  return join(bugDir, `escalation-patch-${n}.md`);
}

function buildFreshAgentPrompt(bugCode, codexReview, hypotheses, patchPath, checkpointPath) {
  return [
    '# Fresh-agent escalation (patch-only, NO COMMITS)',
    '',
    `You are a fresh agent dispatched to investigate bug **${bugCode}** with no prior context from the original session.`,
    '',
    '## Hard rules',
    '',
    '1. **DO NOT commit.** Do not run `git commit` or `git add` under any circumstances.',
    '2. **DO NOT push.** Do not modify the remote.',
    `3. Produce a single artifact at \`${patchPath}\` describing the proposed patch (diff + reasoning) and STOP.`,
    '4. The original session will review your artifact and decide whether to apply it.',
    '',
    '## Codex second-opinion review',
    '',
    `Summary: ${codexReview?.summary ?? '(no summary)'}`,
    '',
    'Findings:',
    ...((codexReview?.findings ?? []).map(f => `- [${f.severity}] ${f.file ?? '(no file)'}:${f.line ?? '?'} — ${f.finding}`)),
    '',
    formatHypothesisBlock(hypotheses ?? []),
    '',
    checkpointPath ? `## Checkpoint reference\n\nSee ${checkpointPath} for prior context.\n` : '',
    '## Output',
    '',
    `Write to ${patchPath}:`,
    '- A unified diff of your proposed change',
    '- Reasoning: why this addresses the Codex finding without retreading rejected hypotheses',
    '- Risk notes: blast radius and rollback steps',
    '',
    'Then STOP.',
    '',
  ].join('\n');
}

/**
 * Tier 2 — dispatch a fresh agent in an isolated git worktree to draft a
 * patch (no commits). Cleanup is guaranteed via finally.
 *
 * @param {object} stratum
 * @param {object} context           { cwd, mode:'bug', bug_code }
 * @param {object} codexReview       output of tier1CodexReview
 * @param {object[]} hypotheses      ledger entries (readHypotheses output)
 * @param {string|null} checkpointPath
 * @returns {Promise<{skipped?: boolean, reason?: string, patch_path?: string, agent_reasoning?: string}>}
 */
export async function tier2FreshAgent(stratum, context, codexReview, hypotheses, checkpointPath) {
  // Materially-new gate — load ledger fresh in case caller passed stale data.
  let ledger = hypotheses;
  if (!Array.isArray(ledger) || ledger.length === 0) {
    try { ledger = readHypotheses(context.cwd, context.bug_code); } catch { ledger = []; }
  }
  if (!isMateriallyNew(codexReview, ledger)) {
    return { skipped: true, reason: 'no new hypothesis (codex matches a previously rejected entry)' };
  }

  // Compute patch artifact path BEFORE creating the worktree, so the agent
  // prompt references the same path that we report back to the caller.
  const patchPath = nextPatchPath(context.cwd, context.bug_code);

  // Create the detached worktree.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const wtPath = join(WORKTREE_BASE, `${context.bug_code}-${ts}`);
  // mkdir -p the parent (homedir() always exists; .stratum/worktrees may not)
  try {
    execSync(`mkdir -p "${WORKTREE_BASE}"`, { encoding: 'utf-8', timeout: 5000 });
  } catch { /* best-effort */ }

  execSync(`git worktree add "${wtPath}" --detach HEAD`, {
    cwd: context.cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
  });

  try {
    const prompt = buildFreshAgentPrompt(
      context.bug_code,
      codexReview,
      ledger,
      patchPath,
      checkpointPath,
    );
    const agent_reasoning = await stratum.runAgentText('claude', prompt, { cwd: wtPath });
    return { patch_path: patchPath, agent_reasoning: agent_reasoning ?? '' };
  } finally {
    try {
      execSync(`git worktree remove "${wtPath}" --force`, {
        cwd: context.cwd, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
      });
    } catch {
      // If `git worktree remove` fails (e.g. cwd no longer a git repo in tests),
      // fall back to `rm -rf` so the worktree dir doesn't linger.
      try { execSync(`rm -rf "${wtPath}"`, { encoding: 'utf-8', timeout: 10_000 }); } catch { /* give up */ }
    }
  }
}
