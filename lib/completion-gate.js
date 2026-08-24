/**
 * lib/completion-gate.js — COMP-COMPLETION-GATE slice 1.
 *
 * The one door a feature passes through to become COMPLETE.
 *
 * Context: the lifecycle guard has never guarded a real feature. 321 managed
 * features, 31 registered guard resources, zero overlap — every one of the 31
 * is a leaked test fixture. The reason is not that registration is impossible
 * (`guardedTransition` registers lazily); it is that the writers which actually
 * complete features never call a guarded transition at all. See
 * docs/features/COMP-COMPLETION-GATE/design.md §1.
 *
 * SLICE 1 SCOPE (design.md §2.9). This gate wraps `recordCompletion` with
 * evidence verification and a guarded transition, and changes nothing about how
 * writes happen — `setFeatureStatus` keeps doing the ROADMAP regeneration and
 * vision projection it already does correctly. That is what keeps this small:
 * no projection transaction, no vision seam, no refusals on the other writers.
 *
 * What that means honestly: after slice 1, completions made through
 * `record_completion` (MCP or CLI) are evidence-checked and ledgered. The other
 * bypasses — the build runner above all — remain open. This must NOT be
 * described as "completions are guarded"; that is the false claim in
 * COMP-MCP-ENFORCE/report.md that this feature exists to correct, and making it
 * one slice early would be the same error in a new place.
 *
 * Three things here are not obvious:
 *
 *  1. **Late registration, always.** No feature is registered today, and headless
 *     builds advance phases without the guard, so a mid-lifecycle guard state
 *     never exists. The gate registers at the mode's completable phase and takes
 *     ONE `→ complete` edge. Walking the full graph instead would refuse 91% of
 *     features (only 30 of 321 have design+blueprint+plan), and a gate that
 *     refuses nine of ten legitimate completions gets forced — which is how
 *     coverage reached zero in the first place. The ledger stamp records the
 *     weaker basis so it is never mistaken for lifecycle enforcement.
 *
 *  2. **Recovery is a write-ahead intent, not a derived id.** A derived id
 *     (`feature:sha`) identifies the RETRY, not the transition that reached the
 *     ledger: commit A applies, the process dies before the record is written, a
 *     retry on commit B finds no record for B and would be waved through as
 *     "recovery" against a ledger entry that attested A. The intent record is
 *     written before the transition and carries an `operation_id` that is also
 *     sent as a guard artifact — artifacts feed the payload digest, so two
 *     attempts are distinguishable even when both have no commit at all.
 *
 *  3. **The test command runs OUTSIDE the lock.** `spawnSync` blocks the event
 *     loop, and a blocked event loop cannot fire the lock's heartbeat timer, so
 *     a long test run inside the lock would get the lock declared stale and
 *     stolen from a live owner.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { acquireDirLock } from './dir-lock.js';
import { completablePhaseOf } from './lifecycle-modes.js';
import {
  ensureGuard,
  guardedTransition,
  guardTestCommand,
  resourceId,
  verifyCompletionEvidence,
} from '../server/lifecycle-guard.js';

/** Statuses with no legal outgoing transition — completing one is a policy violation. */
const TERMINAL_STATUSES = new Set(['KILLED', 'SUPERSEDED']);

/** The sentinel `completion-writer` stamps for a commit-less (non-git) completion. */
const NULL_SHA = '0'.repeat(40);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read `capabilities.guard` from the SERVED workspace root — not the process
 * global. A gate invoked over the CLI with `--workspace` must judge the guard by
 * the tree it is actually completing in.
 */
export function guardEnabled(workspaceRoot) {
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(workspaceRoot, '.compose', 'compose.json'), 'utf-8'),
    );
    return cfg?.capabilities?.guard === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write-ahead intent (design.md §2.4a)
// ---------------------------------------------------------------------------

function intentPath(workspaceRoot, featureCode) {
  return path.join(
    workspaceRoot, '.compose', 'data', 'completion-intents', `${featureCode}.json`,
  );
}

export function readIntent(workspaceRoot, featureCode) {
  const p = intentPath(workspaceRoot, featureCode);
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    // Missing is the common case; malformed is treated the same way — an intent
    // we cannot read cannot authorize a recovery, and §2.4a's "no intent + guard
    // complete" row already fails closed.
    return null;
  }
}

function writeIntent(workspaceRoot, featureCode, record) {
  const p = intentPath(workspaceRoot, featureCode);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  // Rename so a crash mid-write never leaves a half-parsed intent behind.
  writeFileSync(p, readFileSync(tmp));
  rmSync(tmp, { force: true });
}

function clearIntent(workspaceRoot, featureCode) {
  try { rmSync(intentPath(workspaceRoot, featureCode), { force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Guard state
// ---------------------------------------------------------------------------

let _history = null;
/** @internal test seam */
export function _testOnly_setHistoryClient(fn) { _history = fn; }
/** @internal test seam */
export function _testOnly_resetHistoryClient() { _history = null; }

/**
 * The guard's current state for this resource, or null when it has never been
 * registered. Distinguishes "not found" (legacy/unregistered — the normal case)
 * from every other failure, which must fail CLOSED: an unreachable guard that
 * silently reads as "unregistered" would be a bypass wearing the legacy rule as
 * a disguise.
 *
 * @returns {Promise<{state: string|null, error?: object}>}
 */
async function currentGuardState(rid) {
  const client = _history || (await import('../server/stratum-client.js')).guardHistory;
  let res;
  try {
    res = await client(rid);
  } catch (e) {
    return { state: null, error: { code: 'GUARD_UNREACHABLE', message: e.message } };
  }
  if (res && (res.error || res.status === 'error')) {
    const err = res.error || res;
    // `error_type` is the field the REAL client returns (server/stratum-client.js
    // parses stratum's canonical `{status:'error', error_type, message}`); `code`
    // and `kind` are the shapes injected by _testOnly_setHistoryClient. Reading
    // only the latter two made the not-found branch below DEAD against the real
    // producer: every unregistered feature refused with "guard unreachable",
    // which is every feature that never ran a lifecycle. Found 2026-08-24 trying
    // to complete COMP-COVERAGE-GATE; see the real-shape test in
    // test/completion-gate.test.js.
    const code = String(err.code || err.kind || err.error_type || '');
    // Never registered — the expected state for every feature today.
    if (/not_found|NOT_FOUND|GuardNotFound/.test(code)
        || /not found|no guard registered/i.test(err.message || '')) {
      return { state: null };
    }
    return { state: null, error: err };
  }
  return { state: res?.current_state ?? null };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Verify a feature may complete, record it through the guard, and write it.
 *
 * FAIL-CLOSED throughout: evidence that does not verify, a guard that refuses,
 * and a guard that cannot be reached all return `{ok:false}` with nothing
 * written. Guard *disabled* is different from guard *unreachable* — the first
 * still runs the evidence check (it is compose-local and needs no stratum), the
 * second refuses.
 *
 * @param {object}   a
 * @param {string}   a.featureCode
 * @param {string}   [a.commitSha]        omitted ⇒ commit-less (non-git) completion
 * @param {boolean}  [a.testsPass]        explicit attestation; ignored when a testCommand attests
 * @param {string[]} [a.filesChanged]
 * @param {string}   [a.notes]
 * @param {boolean}  [a.force]
 * @param {string}   [a.builtVia]         preserved — the build-quick validator exemption reads it
 * @param {string}   [a.idempotencyKey]
 * @param {string}   a.workspaceRoot      provider, capabilities, guard resourceId, feature.json
 * @param {string}   [a.evidenceRoot]     git + tests; defaults to workspaceRoot (single-repo case)
 * @param {string}   [a.mode]
 * @param {'complete'|'evidence-only'} [a.intent]
 * @returns {Promise<object>}
 */
export async function completionGate({
  featureCode,
  commitSha,
  testsPass,
  filesChanged = [],
  notes,
  force,
  builtVia,
  idempotencyKey,
  workspaceRoot,
  evidenceRoot,
  mode = 'build',
  intent = 'complete',
}) {
  if (!featureCode) throw new Error('completion-gate: featureCode is required');
  if (!workspaceRoot) throw new Error('completion-gate: workspaceRoot is required');

  // Two roots. They are equal in the single-repo case, but a cross-repo build
  // runs git and tests in the agent's tree while feature metadata lives in the
  // project tree — verifying the wrong repo's HEAD is silent and wrong.
  const evRoot = evidenceRoot || workspaceRoot;
  const guarded = guardEnabled(workspaceRoot);
  const reasons = [];

  // --- 1. Evidence, BEFORE the lock (note 3 in the header) -----------------
  //
  // Scoped to `capabilities.guard`, matching the contract `assertCompletionEvidence`
  // already established (server/compose-mcp-tools.js:46). An earlier draft of this
  // design (AC-5) had the evidence check run even with the guard off, on the
  // reasoning that a fabricated SHA is worthless either way. That is true, but
  // `capabilities.guard: false` is a deliberate opt-OUT, and enforcing evidence
  // against a project that opted out is a breaking change for every such project —
  // including non-git workspaces, where the check can never pass at all. Respecting
  // the flag keeps slice 1 non-breaking; strengthening it is its own decision, not
  // a side effect of adding the gate.
  // Guard off: pass the caller's claim through untouched so `recordCompletion`'s
  // own validation still applies (it requires a strict boolean). Coercing an
  // omitted value to `false` here would quietly rewrite the record.
  let attestedTestsPass = testsPass;
  if (guarded) {
    const ev = await verifyCompletionEvidence({
      commitSha,
      cwd: evRoot,
      testCommand: guardTestCommand(workspaceRoot),
      testsPassClaim: testsPass,
    });
    if (!ev.ok) {
      return { ok: false, guarded, refusedAt: 'evidence', reasons: ev.reasons };
    }
    // A configured test command that exited 0 outranks any caller claim; without
    // one, only an explicit `true` counts. There is no silent default.
    attestedTestsPass = ev.testsAttested ? true : testsPass === true;
  }

  // Evidence-only callers (record_completion with set_status:false) are not
  // completing anything, so they must not drive the guard to a terminal state.
  if (intent === 'evidence-only') {
    return { ok: true, guarded, evidenceOnly: true, attestedTestsPass, reasons: [] };
  }

  const rid = resourceId(featureCode, workspaceRoot, mode);
  const lockDir = path.join(workspaceRoot, '.compose', 'data', 'locks', `completion-${featureCode}`);
  const release = await acquireDirLock(lockDir);

  try {
    // --- 2. Preflight ------------------------------------------------------
    // Lazy import: feature-writer ↔ completion-writer ↔ this module form a cycle
    // at load time, and completion-writer already dodges it the same way.
    const { getProvider } = await import('./feature-writer.js');
    const provider = await getProvider(workspaceRoot);
    const feature = await provider.getFeature(featureCode);
    if (!feature) {
      return { ok: false, guarded, refusedAt: 'preflight', reasons: [`feature "${featureCode}" not found`] };
    }
    // Terminal-status legality. The gate writes through a policy-free path, so
    // the policy `setFeatureStatus` enforces (KILLED/SUPERSEDED are terminal)
    // has to be re-asserted here or a killed feature could be completed.
    if (TERMINAL_STATUSES.has(feature.status)) {
      return {
        ok: false, guarded, refusedAt: 'preflight',
        reasons: [`feature "${featureCode}" is ${feature.status} — a terminal status has no legal completion`],
      };
    }

    // --- 3. Guard state + recovery decision (§2.4a) ------------------------
    const priorIntent = readIntent(workspaceRoot, featureCode);
    let guardState = null;
    if (guarded) {
      const g = await currentGuardState(rid);
      if (g.error) {
        // Configured but unreachable ⇒ refuse. Never degrade to the disabled path.
        return { ok: false, guarded, refusedAt: 'guard', reasons: ['guard unreachable'], error: g.error };
      }
      guardState = g.state;
    }
    const guardComplete = guardState === 'complete';

    let operationId = randomUUID();
    let recovering = false;

    if (guardComplete) {
      if (!priorIntent) {
        // The ledger says complete and nothing records why. Not ours to repair.
        return {
          ok: false, guarded, refusedAt: 'recovery',
          reasons: [
            `guard for "${featureCode}" is already complete with no completion intent on record — ` +
            `a prior completion cannot be automatically resumed; operator action required`,
          ],
        };
      }
      recovering = true;
      operationId = priorIntent.operation_id;
      // Same operation ⇒ re-drive the writes. Different ⇒ the ledger attested
      // something else and this is a second completion, not a retry.
      const sameCommit = (priorIntent.commit_sha || null) === (commitSha || null);
      if (!sameCommit) {
        return {
          ok: false, guarded, refusedAt: 'recovery',
          reasons: [
            `guard for "${featureCode}" already completed operation ${priorIntent.operation_id} ` +
            `against commit ${priorIntent.commit_sha || '(none)'}, but this attempt carries ` +
            `${commitSha || '(none)'} — refusing to complete twice against different evidence`,
          ],
        };
      }
    } else if (priorIntent) {
      // Intent with no applied transition: a crash BEFORE the guard. Stale.
      clearIntent(workspaceRoot, featureCode);
    }

    // --- 4. Write-ahead intent --------------------------------------------
    if (!recovering) {
      writeIntent(workspaceRoot, featureCode, {
        operation_id: operationId,
        feature_code: featureCode,
        commit_sha: commitSha || null,
        tests_attested: attestedTestsPass,
        started_at: new Date().toISOString(),
      });
    }

    // --- 5. The guarded transition ----------------------------------------
    let ledgerRef;
    if (guarded && !recovering) {
      const completable = completablePhaseOf(mode);
      const reg = await ensureGuard(featureCode, completable, workspaceRoot, mode);
      if (reg && (reg.error || reg.status === 'error')) {
        clearIntent(workspaceRoot, featureCode);
        return { ok: false, guarded, refusedAt: 'guard', reasons: ['guard registration failed'], error: reg.error || reg };
      }

      // The stamp records what this actually is. Late registration attests the
      // evidence present at completion, never lifecycle history — nothing here
      // knows whether a design doc existed when the work was done.
      const tags = ['late-registration'];
      if (!commitSha || commitSha === NULL_SHA) tags.push('no-repo-exemption');
      const resolvedBy = `agent:${tags.join('+')}`;

      const g = await guardedTransition({
        featureCode,
        from: completable,
        to: 'complete',
        workspaceRoot,
        commitSha,
        resolvedBy,
        mode,
        // operation_id rides in the artifacts so it lands in the payload digest —
        // without it two commit-less completions are indistinguishable in the ledger.
        artifacts: { operation_id: operationId },
      });
      if (!g.applied) {
        clearIntent(workspaceRoot, featureCode);
        return {
          ok: false, guarded, refusedAt: 'guard',
          reasons: [g.refused ? 'completion refused by guard' : 'guard transition failed'],
          verdict: g.verdict, error: g.error,
        };
      }
      ledgerRef = g.ledgerRef;
    }

    // --- 6. Write (unchanged path — slice 1 does not own the projections) ---
    const { recordCompletion } = await import('./completion-writer.js');
    const result = await recordCompletion(workspaceRoot, {
      feature_code: featureCode,
      ...(commitSha ? { commit_sha: commitSha } : {}),
      tests_pass: attestedTestsPass,
      files_changed: filesChanged,
      ...(notes ? { notes } : {}),
      ...(force ? { force } : {}),
      ...(builtVia ? { built_via: builtVia } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });

    clearIntent(workspaceRoot, featureCode);
    return {
      ok: true, guarded, recovered: recovering, operationId, ledgerRef,
      attestedTestsPass, reasons, result,
    };
  } finally {
    release();
  }
}
