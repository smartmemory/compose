/**
 * lib/completion-gate.js — COMP-COMPLETION-GATE (slices 1–3).
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
 * SLICE 3 (design.md §2.3a, Decision 8/11): after the guard applies, THIS
 * module performs every write a completion consists of, in this order —
 * completion record → status COMPLETE → ROADMAP regen → vision projection →
 * events. Steps 1–2 are the durable truth and abort the completion if they
 * fail (the write-ahead intent stays, so a retry recovers). Steps 3–5 are
 * projections: re-drivable, so a failure is COLLECTED and reported as
 * `{ok:true, partial:true, failures:[…]}`, never swallowed — silent best-effort
 * is what produced the drift this feature exists to end.
 *
 * `setFeatureStatus` refuses COMPLETE unconditionally (AC-9), so the status
 * write here goes through `persistFeatureRaw` — the policy-free primitive whose
 * contract is now "callers must have passed the gate" (Decision 7; enforced by
 * the allowlist test, test/completion-write-allowlist.test.js). No marker lets
 * another module through: anything this file exported to identify itself could
 * be imported by the callers it exists to refuse.
 *
 * The vision projection is the self-verifying seam of §2.3b
 * (`VisionWriter.completeItem` → `server/completion-projection.js`): it
 * re-reads feature.json and the guard ledger and refuses unless the completion
 * is ALREADY recorded there, so it grants no authority of its own.
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

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { acquireDirLock } from './dir-lock.js';
import { deriveConfidence, resolveEvidenceRef } from './backfill-evidence.js';
import {
  completablePhaseOf, genesisOf, getMode, terminalOf, transitionsOf,
} from './lifecycle-modes.js';
import {
  applyBackfillUpgrade,
  ensureGuard,
  guardedTransition,
  guardErrorMessage,
  guardErrorType,
  guardTestCommand,
  isGuardError,
  resourceId,
  verifyCompletionEvidence,
  verifyCompletionEvidenceAsync,
} from '../server/lifecycle-guard.js';
import { insertBackfilledPhases, occurrenceKey } from '../server/lifecycle-phase-history.js';

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
export async function currentGuardState(rid) {
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
    // Never registered — the expected state for every feature today. The
    // message fallback applies ONLY when no code was returned at all: a SPAWN
    // failure whose message happens to say "stratum-mcp: command not found"
    // must not read as a legacy feature (found by the slice-3 fail-closed test).
    if (/not_found|NOT_FOUND|GuardNotFound/.test(code)
        || (!code && /not found|no guard registered/i.test(err.message || ''))) {
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
 * @param {string}   [a.visionItemId]     the item to project; resolved via findFeatureItem when absent
 * @param {Function} [a.visionProjector]  transport override for §2.3a step 4 — the server passes an
 *                                        in-process projector against its live store; default is
 *                                        VisionWriter.completeItem (REST when a server is up, direct
 *                                        file write otherwise)
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
  visionItemId,
  visionProjector,
  // --- COMP-LIFECYCLE-BACKFILL (intent:'backfill' only) --------------------
  reason,
  occurrences,
  item,
  store,
  actor,
}) {
  if (!featureCode) throw new Error('completion-gate: featureCode is required');
  if (!workspaceRoot) throw new Error('completion-gate: workspaceRoot is required');

  // Backfill is a PARAMETERISATION of this gate, not a sibling door (§5). It
  // shares the lock, the intent file, the write sequence and the refusal
  // vocabulary; what differs is that its evidence is historical, so it runs the
  // ASYNC evidence runner INSIDE the lock (§5.2) and merges by valid time.
  if (intent === 'backfill') {
    return backfillGate({
      featureCode, commitSha, testsPass, filesChanged, notes, reason, occurrences,
      workspaceRoot, evidenceRoot, mode, item, store, visionItemId, visionProjector,
      actor: actor || 'agent:rest',
    });
  }

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
      // Stratum >= 0.4.0 validates resolved_by strictly as "agent" | "human"
      // (guard/transition.ts) — a tagged resolver like "agent:late-registration"
      // is refused with evidence_parse_error, which is how every completion
      // failed silently after the upgrade. The tags therefore ride in
      // `artifacts`, where they still land in the ledger's payload digest.
      const tags = ['late-registration'];
      if (!commitSha || commitSha === NULL_SHA) tags.push('no-repo-exemption');
      const resolvedBy = 'agent';

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
        artifacts: { operation_id: operationId, resolver_tags: tags.join('+') },
      });
      if (!g.applied) {
        clearIntent(workspaceRoot, featureCode);
        return {
          ok: false, guarded, refusedAt: 'guard',
          reasons: [
            (g.refused ? 'completion refused by guard' : 'guard transition failed')
              + (g.error?.message ? `: ${g.error.message}` : ''),
          ],
          verdict: g.verdict, error: g.error,
        };
      }
      ledgerRef = g.ledgerRef;
    }

    // --- 6. The write sequence (§2.3a) — the gate is the single COMPLETE writer
    const { recordCompletion } = await import('./completion-writer.js');
    const { isLocalProvider, roundtripGuard, safeAppendEvent } = await import('./feature-writer.js');
    const failures = [];

    // 6.1 completion record. `set_status:false` is the record-only path; the
    //     writer's completing path is the one that calls THIS function.
    let rec;
    try {
      rec = await recordCompletion(workspaceRoot, {
        feature_code: featureCode,
        ...(commitSha ? { commit_sha: commitSha } : {}),
        tests_pass: attestedTestsPass,
        files_changed: filesChanged,
        ...(notes ? { notes } : {}),
        ...(force ? { force } : {}),
        ...(builtVia ? { built_via: builtVia } : {}),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        set_status: false,
      });
    } catch (e) {
      // The guard has applied and nothing durable is written: keep the intent so
      // a retry on the same evidence recovers (§2.4a) instead of completing twice.
      return {
        ok: false, guarded, refusedAt: 'write', operationId, ledgerRef, error: e,
        reasons: [`completion record could not be written: ${e.message}`],
      };
    }

    // 6.2 status → COMPLETE, raw — through the single authorized writer.
    //
    // The re-read and the preparation stay OUTSIDE the catch, exactly where they
    // were before the shared helper existed: a rejected read or a `null` feature
    // is a broken precondition, not a failed write, and it must keep throwing.
    const fresh = await provider.getFeature(featureCode);
    const prepared = prepareCompleteStatus(fresh, commitSha);
    let statusChanged = null;
    if (prepared) {
      try {
        await persistCompleteStatus({
          provider, workspaceRoot, featureCode, updated: prepared.updated,
        });
      } catch (e) {
        return {
          ok: false, guarded, refusedAt: 'write', operationId, ledgerRef, error: e,
          reasons: [`completion recorded but status could not be set: ${e.message}`],
          result: rec,
        };
      }
      statusChanged = { from: prepared.from, to: 'COMPLETE' };
    }

    // 6.3 ROADMAP regen — projection; collect on failure.
    try {
      await provider.renderRoadmap();
    } catch (e) {
      failures.push({ step: 'roadmap', message: e.message, recover: 'compose roadmap generate' });
    }

    // 6.4 vision projection — projection; collect on failure.
    let visionProjection = null;
    try {
      const project = visionProjector || defaultVisionProjector;
      visionProjection = await project({
        workspaceRoot, featureCode, visionItemId, commitSha, ledgerRef, mode,
      });
    } catch (e) {
      failures.push({ step: 'vision', message: e.message, recover: 'compose validate --fix' });
    }

    // 6.5 events — never fails a completion (safeAppendEvent swallows and warns).
    if (statusChanged) {
      await safeAppendEvent(workspaceRoot, {
        tool: 'set_feature_status',
        code: featureCode,
        from: statusChanged.from,
        to: 'COMPLETE',
        reason: 'completion_gate',
        via: 'completion_gate',
        operation_id: operationId,
        ...(commitSha ? { commit_sha: commitSha } : {}),
        ...(ledgerRef ? { ledger_ref: ledgerRef } : {}),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    }

    clearIntent(workspaceRoot, featureCode);
    return {
      ok: true, guarded, recovered: recovering, operationId, ledgerRef,
      attestedTestsPass, reasons,
      partial: failures.length > 0, failures, visionProjection,
      // The writer-shaped result every existing caller (MCP tool, CLI, cockpit)
      // returns as-is, so it must carry the whole partial story — not just the
      // ROADMAP half (Codex r1 #3): a vision projection that failed is a
      // completion the cockpit does not show.
      result: {
        ...rec,
        status_changed: statusChanged,
        status_flip_partial: failures.length > 0,
        partial: failures.length > 0,
        failures,
      },
    };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Default vision projector (§2.3a step 4) — VisionWriter.completeItem, which is
// REST when a server is up and a direct verified file write otherwise.
// ---------------------------------------------------------------------------

async function defaultVisionProjector({
  workspaceRoot, featureCode, visionItemId, commitSha, ledgerRef, mode, store, guarded,
}) {
  const { VisionWriter } = await import('./vision-writer.js');
  const writer = new VisionWriter(path.join(workspaceRoot, '.compose', 'data'));
  const itemId = visionItemId || (await writer.findFeatureItem(featureCode))?.id;
  // No item is not a failure: paths 1–2 (record_completion) have never carried
  // an item id, and a feature with no cockpit item has nothing to project.
  if (!itemId) return { skipped: true, reason: 'no vision item for feature' };

  // A caller that owns a LIVE store projects through it (Codex r1 #2/#4).
  //
  // Two defects made this necessary, and both were invisible from the outside.
  // First, with no server up `VisionWriter` falls through to a DIRECT write
  // against a separately loaded disk snapshot; the caller's in-memory item never
  // learns it was completed, and finalization then serializes that stale item
  // straight over the successful projection — the operation clears its intent
  // with the item still reading `in_progress` and carrying no stamp. Second, the
  // writer verifies against LIVE config, so the operation's persisted guard flag
  // never reached the verifier at all; only a hand-wired test callback made
  // §5.10a look wired. Both are fixed by projecting through the store the caller
  // already handed us, with the flag threaded to the projector AND the verifier.
  if (store) {
    const { applyVerifiedProjection } = await import('../server/completion-projection.js');
    return applyVerifiedProjection(store, {
      itemId, featureCode, cwd: workspaceRoot,
      // `?? true` keeps every caller that sends no flag byte-identical.
      consultGuard: guarded ?? true,
      guardEnabledOverride: guarded,
      evidence: { commitSha, ledgerRef, source: 'completion-gate' },
    });
  }
  return writer.completeItem(itemId, { featureCode, cwd: workspaceRoot, commitSha, ledgerRef, mode });
}

/**
 * §2.3a step 2 / §5.10 step 6.2 — the ONE authorized COMPLETE status write, split
 * into PREPARE and PERSIST because the two sit on opposite sides of an error
 * boundary the callers must keep.
 *
 * Both doors share these rather than carrying two copies of the same five lines.
 * That is not tidiness: the AC-19 allowlist scan asserts there is exactly ONE
 * `status: 'COMPLETE'` callsite in the repo and that it is the gate, so a second
 * copy would either fail that test or force it to be weakened into a per-FILE
 * check.
 *
 * The SPLIT is load-bearing (Codex r2 #2). The live path's re-read and status
 * preparation have always sat OUTSIDE the persistence `try`: a provider read
 * that rejects, or a `null` feature where one was just written, is a broken
 * precondition and throws — `/lifecycle/complete` answers 400 and
 * `record_completion` propagates the original error. Folding the re-read into
 * the helper quietly moved both under the catch and turned them into
 * `refusedAt:'write'` (422, and `COMPLETION_GATE_REFUSED` in place of the real
 * exception). `prepareCompleteStatus` is therefore pure and callers invoke it
 * before entering their own `try`; only `persistCompleteStatus` may throw a
 * write failure.
 */
function prepareCompleteStatus(fresh, commitSha) {
  if (fresh.status === 'COMPLETE') return null;
  const updated = { ...fresh, status: 'COMPLETE' };
  if (commitSha) updated.commit_sha = commitSha;
  return { updated, from: fresh.status };
}

async function persistCompleteStatus({ provider, workspaceRoot, featureCode, updated }) {
  const { isLocalProvider, roundtripGuard } = await import('./feature-writer.js');
  if (isLocalProvider(provider)) {
    // The same prose-loss fixed-point check `setFeatureStatus` runs. It is a
    // preflight against the ROADMAP, not a write; a refusal here aborts the
    // status flip with the record present and the intent kept — recoverable.
    await roundtripGuard(workspaceRoot, provider,
      (feats) => feats.map((f) => (f.code === featureCode ? updated : f)),
      { force: false, label: 'completion_gate' });
  }
  await provider.persistFeatureRaw(featureCode, updated);
}

// ---------------------------------------------------------------------------

// ===========================================================================
// COMP-LIFECYCLE-BACKFILL — completionGate({intent:'backfill'})  (blueprint §5)
//
// The shape of this function is the design. Five rules explain every ordering
// decision in it, and each one exists because getting it wrong is silent:
//
//  1. NOTHING DURABLE IS WRITTEN UNTIL THE HISTORY VALIDATES (BP-4/R2B-8).
//     Registration creates a guard resource and a ledger on disk. Registering
//     first and validating second leaves a permanent registration behind for a
//     request that was then refused. So: decide the initial state, validate
//     evidence and history, and only then register, upgrade and transition.
//
//  2. THE INTENT IS THE COMPLETE WRITE PLAN, NOT A BREADCRUMB (BP-3/R2B-3).
//     A resumed attempt recomputes NOTHING. Every value §5.10 writes comes out
//     of `writeContext`, and `writeContext` is either built fresh (§5.7) or
//     restored wholesale from the intent (§5.4a). If a value is not in
//     `writeContext`, the write sequence cannot see it — which is the only
//     structural way to stop a resume from writing different bytes than the
//     crash intended.
//
//  3. TIMESTAMPS ARE MINTED ONCE (BP-6). `startedAt` and every timestamp inside
//     the occurrences are stamped on the first attempt and persisted. A resume
//     stamps only `finalizedAt`, because that one really is now.
//
//  4. RECOVERY GOES STRAIGHT TO THE TRANSPORT (R2B-2), carrying the PERSISTED
//     policy checksum (R3-2/R4-1). `guardedTransition` calls `ensureGuard`,
//     which fails closed when the stored policy has moved — fatal on exactly
//     the recovery it would otherwise have completed. And the checksum must be
//     sent, or a crash BEFORE the transition would later apply under whatever
//     policy is current, moving the guard to a terminal state the plan was
//     never validated against.
//
//  5. EVERY RAW-TRANSPORT RESULT GOES THROUGH isGuardError (R4-2). The raw
//     verbs return stratum's canonical `{status:'error', error_type, message}`
//     unchanged; a check on `.error` alone misses every stratum-side refusal,
//     `policy_checksum_mismatch` included, and falls through to the success
//     branch.
// ===========================================================================

const BACKFILL_TERMINAL = 'complete_backfilled';
const HEX64 = /^[0-9a-f]{64}$/;

/** Every `writeContext` key §5.10 may read. A missing one is a corrupt intent. */
const WRITE_CONTEXT_FIELDS = [
  'operationId', 'requestDigest', 'featureCode', 'mode', 'reason', 'commitSha',
  'filesChanged', 'notes', 'attested', 'startedAt', 'occurrences', 'terminalOcc',
  'history', 'writtenKeys', 'skippedKeys', 'guardInitial', 'upgrade', 'guarded',
  'policyChecksum', 'envelope',
];

const refusal = (refusedAt, reasons, extra = {}) => ({
  ok: false, refusedAt, reasons: Array.isArray(reasons) ? reasons : [reasons], ...extra,
});

const deepClone = (x) => JSON.parse(JSON.stringify(x));

/** Stable key order, so the digest is a function of the CLAIM and not of typing order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * §5.1 — canonicalise the request and digest it BEFORE anything else.
 *
 * `notes` is excluded: prose that does not change what is claimed. `observedTime`
 * is excluded because it is server-derived — it is instead part of the
 * per-occurrence claim inside `insertBackfilledPhases`.
 */
export function backfillRequestDigest({
  featureCode, commitSha, testsPass, mode, filesChanged, reason, occurrences,
}) {
  const canonical = {
    feature_code: featureCode,
    commit_sha: commitSha ?? null,
    tests_pass: testsPass ?? null,
    mode,
    files_changed: [...new Set(filesChanged ?? [])].sort(),
    reason: (reason ?? '').trim(),
    occurrences: [...(occurrences ?? [])]
      .map((o) => ({ phase: o.phase, kind: o.evidence?.kind ?? null, ref: o.evidence?.ref ?? null }))
      .sort((a, b) => `${a.phase}\u001f${a.ref}`.localeCompare(`${b.phase}\u001f${b.ref}`)),
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

function inGraph(graph, phase) {
  if (Object.hasOwn(graph, phase)) return true;
  return Object.values(graph).some((tos) => (tos || []).includes(phase));
}

/** The raw guard transport. Imported lazily so the module graph stays acyclic. */
async function rawGuard() {
  return import('../server/stratum-client.js');
}

// ---------------------------------------------------------------------------

async function backfillGate({
  featureCode, commitSha, testsPass, filesChanged = [], notes, reason, occurrences = [],
  workspaceRoot, evidenceRoot, mode = 'build', item, store, visionItemId, visionProjector, actor,
}) {
  const evRoot = evidenceRoot || workspaceRoot;
  const guarded = guardEnabled(workspaceRoot);

  // --- §5.1 request shape, then the digest, BEFORE anything else -----------
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return refusal('request', 'a backfill requires a non-empty reason', { guarded });
  }
  if (typeof commitSha !== 'string' || commitSha.trim().length === 0) {
    return refusal('request', 'a backfill requires commit_sha', { guarded });
  }
  const requestDigest = backfillRequestDigest({
    featureCode, commitSha, testsPass, mode, filesChanged, reason, occurrences,
  });

  const rid = resourceId(featureCode, workspaceRoot, mode);
  const lockDir = path.join(workspaceRoot, '.compose', 'data', 'locks', `completion-${featureCode}`);
  const release = await acquireDirLock(lockDir);

  try {
    // --- §5.3 mode-aware preflight ---------------------------------------
    const tracksJson = getMode(mode).runner.tracksFeatureJson;
    const { getProvider } = await import('./feature-writer.js');
    if (tracksJson) {
      const provider = await getProvider(workspaceRoot);
      const feature = await provider.getFeature(featureCode);
      if (!feature) {
        return refusal('preflight', `feature "${featureCode}" not found`, { guarded });
      }
      if (TERMINAL_STATUSES.has(feature.status)) {
        return refusal('preflight',
          `feature "${featureCode}" is ${feature.status} — a terminal status has no legal completion`,
          { guarded });
      }
    }
    if (!item || !item.lifecycle) {
      return refusal('preflight',
        `no vision item with a lifecycle for "${featureCode}" — run scaffold_feature first`,
        { guarded });
    }

    // --- §5.3 lookup order: finalized -> pending/intent -> new ------------
    const records = item.lifecycle.backfills ?? [];
    const finalized = records.find((r) => r.request_digest === requestDigest && r.state === 'finalized');
    if (finalized) {
      return {
        ok: true, guarded, backfill: finalized, status: 'finalized',
        operationId: finalized.operation_id, ledgerRef: finalized.guardRef ?? null, reasons: [],
      };
    }

    const priorIntent = readIntent(workspaceRoot, featureCode);
    const pending = records.find((r) => r.request_digest === requestDigest && r.state === 'pending');

    // BP-3: the INTENT is the only recovery source. A pending record is a marker.
    if (pending && (!priorIntent || priorIntent.request_digest !== requestDigest)) {
      return refusal('recovery',
        'a pending backfill record exists for this request with no matching intent — '
        + 'the operation cannot be resumed automatically; operator action required', { guarded });
    }
    if (priorIntent && priorIntent.intent === 'backfill' && priorIntent.request_digest !== requestDigest) {
      return refusal('recovery', 'a different backfill operation is in flight for this feature', { guarded });
    }
    if (priorIntent && priorIntent.intent !== 'backfill') {
      clearIntent(workspaceRoot, featureCode);   // a stale live-completion intent
    }
    const recovering = Boolean(priorIntent && priorIntent.intent === 'backfill'
      && priorIntent.request_digest === requestDigest);

    let writeContext;
    let skipHistoryWrite = false;

    if (recovering) {
      // ================= §5.4a RECOVERY ==================================
      const op = priorIntent;
      writeContext = {
        operationId: op.operation_id, requestDigest: op.request_digest,
        featureCode: op.feature_code, mode: op.mode, reason: op.reason,
        commitSha: op.commit_sha, filesChanged: op.files_changed,
        notes: op.notes, attested: op.tests_attested, startedAt: op.started_at,
        occurrences: op.occurrences, terminalOcc: op.terminal_occurrence,
        history: op.write_plan?.history,
        writtenKeys: op.write_plan?.written, skippedKeys: op.write_plan?.skipped,
        guardInitial: op.guard_initial, upgrade: op.upgrade,
        guarded: op.guarded, policyChecksum: op.policy_checksum,
        envelope: op.envelope, ledgerRef: null,
      };
      // R3-4: a missing field is a CORRUPT intent, not a defaultable zero. The
      // four nullable ones are checked with `hasOwn` on the intent itself, so
      // "the operation had none" stays distinguishable from "the intent omitted it".
      for (const field of WRITE_CONTEXT_FIELDS) {
        if (writeContext[field] === undefined) {
          return refusal('recovery',
            `the persisted intent is missing ${field} — clear it and re-run`, { guarded });
        }
      }
      for (const key of ['notes', 'guard_initial', 'upgrade', 'policy_checksum']) {
        if (!Object.hasOwn(op, key)) {
          return refusal('recovery',
            `the persisted intent is missing ${key} — clear it and re-run`, { guarded });
        }
      }

      // --- History divergence on resume (R2B-3, R3-5) ---------------------
      const replay = insertBackfilledPhases(item, [...writeContext.occurrences, writeContext.terminalOcc]);
      if (!replay.ok) return refusal('history', replay.reasons, { guarded });
      if (canonicalJson(replay.history) === canonicalJson(writeContext.history)) {
        // Nothing moved — keep the plan exactly as persisted.
      } else if (replay.written.length === 0
        && [...writeContext.occurrences, writeContext.terminalOcc]
          .every((o) => replay.skipped.includes(occurrenceKey(o)))) {
        // The history already reached disk, terminal occurrence included — which
        // §4.1 step 3a recognises by operation_id rather than by claim (R3-5).
        writeContext.history = item.lifecycle.phaseHistory;
        skipHistoryWrite = true;
      } else {
        return refusal('history',
          "the item's phase history changed while a backfill was in flight", { guarded });
      }

      if (writeContext.guarded) {
        const resolved = await replayGuardTransition(rid, writeContext);
        if (!resolved.ok) return { ...resolved, guarded: writeContext.guarded };
        writeContext.ledgerRef = resolved.ledgerRef;
      }
    } else {
      // ================= §5.4b BOOTSTRAP =================================
      const operationId = randomUUID();
      const now = new Date().toISOString();      // minted ONCE (BP-6)

      let guardInitial = null;
      let fromState = null;
      let policyChecksum = null;
      let upgrade = null;
      let needsRegistration = false;
      let proposedInitial = null;

      if (guarded) {
        const g = await currentGuardState(rid);
        if (g.error) return refusal('guard', 'guard unreachable', { guarded, error: g.error });
        if (g.state === null) {
          // R2B-8: COMPUTE the initial, do NOT register yet.
          const lp = item.lifecycle.currentPhase;
          proposedInitial = inGraph(transitionsOf(mode), lp) ? lp : genesisOf(mode);
          needsRegistration = true;
          fromState = proposedInitial;
          guardInitial = { registered: proposedInitial, lifecycle_phase: lp };
        } else {
          fromState = g.state;
        }
      } else {
        // Unguarded: the lifecycle IS the source of truth, and legality is local.
        fromState = item.lifecycle.currentPhase;
      }
      if (terminalOf(mode).includes(fromState)) {
        return refusal('guard', `${featureCode} is already terminal at "${fromState}"`, { guarded });
      }

      // --- §5.5 materialise and VALIDATE before any guard mutation -------
      const ev = await verifyCompletionEvidenceAsync({
        commitSha, cwd: evRoot, testCommand: guardTestCommand(workspaceRoot), testsPassClaim: testsPass,
      });
      if (!ev.ok) return refusal('evidence', ev.reasons, { guarded });
      const attested = ev.testsAttested ? true : testsPass === true;

      const fwd = transitionsOf(mode);
      for (const o of occurrences) {
        if (!inGraph(fwd, o.phase)) {
          return refusal('request', `"${o.phase}" is not a phase of mode ${mode}`, { guarded });
        }
      }

      let materialised;
      try {
        materialised = occurrences.map((o) => {
          const resolved = resolveEvidenceRef(evRoot, o.evidence);
          return {
            phase: o.phase, step: o.phase, to: o.phase, from: null,
            enteredAt: resolved.observedTime, timestamp: resolved.observedTime, exitedAt: null,
            outcome: 'backfilled', recordedAt: now, origin: 'backfill',
            confidence: deriveConfidence(resolved.kind), episode: 1, evidence: resolved,
          };
        });
      } catch (e) {
        // A path that escapes the repo, a symlink that leaves it, a missing file:
        // the occurrence cannot be placed in the history at all.
        return refusal('history', e.message, { guarded });
      }

      const terminalOcc = {
        phase: BACKFILL_TERMINAL, step: BACKFILL_TERMINAL, to: BACKFILL_TERMINAL, from: fromState,
        enteredAt: now, timestamp: now, exitedAt: null,
        outcome: 'backfilled', recordedAt: now, origin: 'live',
        confidence: 1.0, episode: 2, operation_id: operationId,
        evidence: {
          kind: 'commit', ref: commitSha, verifiedAt: now,
          observedTime: now, observedEpochMs: Date.parse(now),
        },
      };
      // The terminal occurrence IS live — it happened now. The terminal STATE is
      // the provenance signal (Decision 11), not this field.

      const probe = insertBackfilledPhases(item, [...materialised, terminalOcc]);
      if (!probe.ok) return refusal('history', probe.reasons, { guarded });
      if (probe.history[probe.history.length - 1]?.phase !== BACKFILL_TERMINAL) {
        return refusal('history',
          'backfilled evidence is dated after the completion being recorded', { guarded });
      }

      // --- §5.6 register, legacy compatibility, lazy upgrade (guarded only)
      if (guarded) {
        const reg = await ensureGuard(featureCode, needsRegistration ? proposedInitial : fromState,
          workspaceRoot, mode);
        if (isGuardError(reg)) {
          return refusal('guard', ['guard registration failed'], { guarded, error: reg.error || reg });
        }
        if (needsRegistration) {
          const g = await currentGuardState(rid);
          if (g.error || g.state === null) {
            return refusal('guard', ['guard registration could not be confirmed'],
              { guarded, error: g.error });
          }
          if (g.state !== fromState) {
            return refusal('guard', `registration seeded "${g.state}", not "${fromState}"`, { guarded });
          }
        }
        if (reg.status === 'legacy') {
          const u = await applyBackfillUpgrade({ featureCode, workspaceRoot, mode });
          if (!u.ok) {
            return refusal('upgrade', [
              ...u.reasons,
              'regenerate with `compose guard descriptors`, have the operator re-sign it, and commit both files',
            ], { guarded, error: u.error });
          }
          upgrade = { descriptor_id: u.descriptorId ?? null, status: u.status, ledger_ref: u.ledgerRef ?? null };
        }
        // BP-1: read the checksum AFTER any upgrade and BEFORE the transition.
        const { guardPolicy } = await rawGuard();
        const pol = await guardPolicy(rid);
        if (isGuardError(pol)) {
          return refusal('guard', [`guard policy unreadable: ${guardErrorMessage(pol)}`], { guarded });
        }
        policyChecksum = pol.checksum ?? null;
        if (!HEX64.test(String(policyChecksum))) {
          return refusal('guard', ['guard policy returned no usable checksum'], { guarded });
        }
      }

      // --- §5.7 write-ahead intent: the COMPLETE validated write plan ----
      writeContext = {
        operationId, requestDigest, featureCode, mode, reason,
        commitSha: commitSha ?? null, filesChanged, notes: notes ?? null,
        attested, startedAt: now,
        occurrences: materialised, terminalOcc,
        history: probe.history, writtenKeys: probe.written, skippedKeys: probe.skipped,
        guardInitial, upgrade, guarded, policyChecksum,
        envelope: {
          from: fromState, to: BACKFILL_TERMINAL,
          artifacts: {
            operation_id: operationId,
            request_digest: requestDigest,
            resolver_tags: 'late-registration+backfill',
            ...(commitSha ? { commit_sha: commitSha } : {}),
          },
          modified_files: [], resolved_by: 'agent',
          idempotency_key: operationId,
          ...(guarded ? { expected_policy_checksum: policyChecksum } : {}),
        },
        ledgerRef: null,
      };

      writeIntent(workspaceRoot, featureCode, {
        operation_id: writeContext.operationId, feature_code: writeContext.featureCode,
        mode: writeContext.mode, intent: 'backfill',
        request_digest: writeContext.requestDigest, reason: writeContext.reason,
        commit_sha: writeContext.commitSha, files_changed: writeContext.filesChanged,
        notes: writeContext.notes,
        tests_attested: writeContext.attested, started_at: writeContext.startedAt,
        guarded: writeContext.guarded,
        occurrences: writeContext.occurrences,
        terminal_occurrence: writeContext.terminalOcc,
        write_plan: {
          history: writeContext.history,
          written: writeContext.writtenKeys,
          skipped: writeContext.skippedKeys,
        },
        guard_initial: writeContext.guardInitial,
        upgrade: writeContext.upgrade,
        policy_checksum: writeContext.policyChecksum,
        envelope: writeContext.envelope,
      });

      // --- §5.8 the fresh guarded transition -----------------------------
      if (guarded) {
        const applied = await freshGuardTransition(rid, writeContext, workspaceRoot, featureCode);
        if (!applied.ok) return { ...applied, guarded };
        writeContext.ledgerRef = applied.ledgerRef;
      }
    }

    // --- §5.10 the write sequence ---------------------------------------
    //
    // `return await`, NOT `return`. `try { return p } finally { release() }`
    // runs the finally as soon as the expression is EVALUATED, so returning the
    // bare promise released the lock at the write sequence's first suspension
    // and let the completion record, the status flip, the audit event and
    // finalization all run unlocked — with a concurrent retry free to enter the
    // same pending operation while they were still in flight (Codex r1 #1).
    return await backfillWriteSequence({
      wc: writeContext, item, store, workspaceRoot, visionItemId, visionProjector,
      actor, recovering, skipHistoryWrite, getProvider,
    });
  } finally {
    release();
  }
}

/**
 * §5.8 — the FRESH transition.
 *
 * DEVIATION from the blueprint's pseudocode, deliberately: this uses the RAW
 * `guardTransition` transport rather than `guardedTransition`. §5.6 has already
 * run `ensureGuard`, so the wrapper's only remaining contribution is a second
 * (cached) registration call plus collapsing `replayed` into `applied:true` —
 * and that collapsing is exactly what R2B-6 forbids, because a replay returns a
 * HISTORICAL verdict and says nothing about what happened afterwards. Surfacing
 * `status` verbatim would need a change to `server/lifecycle-guard.js`, which
 * this slice may not touch; going straight to the transport gets the same
 * guarantee with no cross-slice edit.
 */
async function freshGuardTransition(rid, wc, workspaceRoot, featureCode) {
  const { guardTransition } = await rawGuard();
  const env = wc.envelope;
  let g;
  try {
    g = await guardTransition({
      resourceId: rid, fromState: env.from, toState: env.to,
      artifacts: env.artifacts, modifiedFiles: env.modified_files,
      idempotencyKey: env.idempotency_key, resolvedBy: env.resolved_by,
      expectedPolicyChecksum: env.expected_policy_checksum,
    });
  } catch (e) {
    return refusal('guard', [`guard transition failed: ${e.message}`]);
  }

  if (guardErrorType(g) === 'policy_checksum_mismatch') {
    // R2B-7: refused ATOMICALLY under stratum's resource lock; nothing written.
    // This is the ONE refusal that is retryable with no operator action.
    clearIntent(workspaceRoot, featureCode);
    return refusal('guard',
      `the guard policy for ${featureCode} changed while this backfill was in flight `
      + `(expected ${env.expected_policy_checksum}) — nothing was written; retry`);
  }
  if (isGuardError(g)) {
    return refusal('guard', [`guard transition failed: ${guardErrorMessage(g)}`], { error: g });
  }
  if (g.status === 'applied') return { ok: true, ledgerRef: g.ledger_ref ?? null };
  if (g.status === 'replayed') {
    // §5.9b: a fresh attempt that meets an existing entry is a recovery in
    // disguise, and is resolved read-only like any other.
    return verifyGuardLedger(rid, wc);
  }
  return refusal('guard', [g.status === 'refused' ? 'refused by guard' : 'guard transition failed'],
    { verdict: g.verdict });
}

/**
 * §5.9a — the RECOVERY replay. Raw transport, no `ensureGuard`, no policy
 * re-derivation, and ALWAYS carrying the persisted checksum (R3-2/R4-1).
 */
async function replayGuardTransition(rid, wc) {
  const env = wc.envelope;
  if (wc.policyChecksum === null || !HEX64.test(String(wc.policyChecksum))) {
    return refusal('recovery', 'intent has no policy checksum; clear it or re-run');
  }
  if ((env.expected_policy_checksum ?? null) !== wc.policyChecksum) {
    return refusal('recovery', 'intent envelope checksum disagrees with intent policy_checksum');
  }
  const { guardTransition } = await rawGuard();
  let g;
  try {
    g = await guardTransition({
      resourceId: rid, fromState: env.from, toState: env.to,
      artifacts: env.artifacts, modifiedFiles: env.modified_files,
      idempotencyKey: env.idempotency_key, resolvedBy: env.resolved_by,
      expectedPolicyChecksum: wc.policyChecksum,
    });
  } catch (e) {
    return refusal('recovery', `guard transition failed: ${e.message}`);
  }
  if (guardErrorType(g) === 'policy_checksum_mismatch') {
    return verifyGuardLedger(rid, wc);       // READ-ONLY. Nothing was written.
  }
  if (isGuardError(g)) {
    return refusal('recovery', `guard transition failed: ${guardErrorMessage(g)}`);
  }
  if (g.status === 'applied') return { ok: true, ledgerRef: g.ledger_ref ?? null };
  // `replayed` is NOT `applied` (R2B-6): the ledger is read on EVERY recovery
  // success, because a kill, an override or a migrate could have moved the
  // resource on after the historical verdict this replay is echoing.
  return verifyGuardLedger(rid, wc);
}

/**
 * §5.9c — read-only verification. No transition is issued: everything is decided
 * from `guard digest` (a pure function) and ONE `guard history` read, so all
 * three conditions describe one consistent moment.
 */
async function verifyGuardLedger(rid, wc) {
  if (wc.policyChecksum === null) return refusal('recovery', 'no policy checksum on record');
  const { guardDigest, guardHistory, guardPolicy } = await rawGuard();
  const env = wc.envelope;

  const d = await guardDigest({
    fromState: env.from, toState: env.to, artifacts: env.artifacts,
    modifiedFiles: env.modified_files, resolvedBy: env.resolved_by,
    policyChecksum: wc.policyChecksum,
  });
  if (isGuardError(d)) {
    return refusal('recovery', `payload digest could not be computed: ${guardErrorMessage(d)}`);
  }

  const h = await guardHistory(rid);
  if (isGuardError(h)) {
    return refusal('recovery', `guard history unreadable: ${guardErrorMessage(h)}`);
  }
  const ledger = h.ledger ?? [];

  // (1) THE ENTRY EXISTS AND IS OURS. Matching on id + to_state + outcome alone
  //     is R2-1, which BP-1 rejected — the payload digest is what makes it ours.
  const index = ledger.findIndex((e) => e.kind === 'transition'
    && e.idempotency_key === wc.operationId
    && e.outcome === 'applied'
    && e.to_state === BACKFILL_TERMINAL
    && e.payload_digest === d.payload_digest);
  if (index === -1) {
    // R3-2: the operation NEVER applied. This is where the design deliberately
    // stops — the intent stays, the guard is untouched, and a HUMAN decides.
    const livePolicy = await guardPolicy(rid);
    const liveChecksum = isGuardError(livePolicy) ? '(unreadable)' : (livePolicy.checksum ?? '(none)');
    if (liveChecksum !== wc.policyChecksum) {
      return refusal('recovery',
        `this backfill never reached the guard, and the policy for ${wc.featureCode} has changed `
        + `since the intent was written (recorded ${wc.policyChecksum}, now ${liveChecksum}). `
        + 'Nothing has been written. Either clear the intent at '
        + `.compose/data/completion-intents/${wc.featureCode}.json and re-run the backfill under `
        + 'the current policy, or restore the policy the intent was written against.');
    }
    return refusal('recovery',
      'no applied ledger entry under this operation id matches the persisted envelope');
  }
  const entry = ledger[index];

  // (2) THE RESOURCE IS STILL WHERE THAT ENTRY LEFT IT.
  if (h.current_state !== BACKFILL_TERMINAL) {
    return refusal('recovery',
      `the guard has moved to "${h.current_state}" since this operation applied`);
  }

  // (3) NOTHING MUTATED IT AFTERWARDS. The ledger is append-only and ordered, so
  //     this is a suffix scan. R3-6: the kinds are the ones stratum ACTUALLY
  //     writes — there is no 'override' kind and no 'migrate' kind, and the
  //     first draft scanned for both, so an override slipped past silently.
  for (const e of ledger.slice(index + 1)) {
    if (e.kind === 'transition' || e.kind === 'deviation') {
      return refusal('recovery',
        `the guard was mutated after this operation applied (a ${e.kind} entry `
        + `${e.from_state} -> ${e.to_state})`);
    }
    if (e.kind === 'graph_version') {
      // State-preserving BY CONSTRUCTION — verify rather than assume, so a
      // future stratum that moved state in a policy entry breaks loudly.
      if (e.from_state !== e.to_state) {
        return refusal('recovery', 'a policy entry moved the guard state after this operation applied');
      }
      continue;
    }
    return refusal('recovery', `unrecognised ledger entry kind "${e.kind}" after this operation`);
  }

  return { ok: true, ledgerRef: entry.entry_digest ?? null };
}

/**
 * §5.10 — the write sequence. EVERY value comes from `wc`: no probe, no `now`,
 * no request, no live `guardEnabled`. Steps 6.0–6.2 are durable truth and abort
 * with the intent KEPT; 6.3–6.4 are re-drivable projections and are collected.
 */
async function backfillWriteSequence({
  wc, item, store, workspaceRoot, visionItemId, visionProjector, actor, recovering,
  skipHistoryWrite, getProvider,
}) {
  const tracksJson = getMode(wc.mode).runner.tracksFeatureJson;
  const failures = [];

  // --- 6.0 history + PENDING marker, ONE store write -----------------------
  const snapshot = deepClone(item.lifecycle);
  if (!skipHistoryWrite) item.lifecycle.phaseHistory = wc.history;
  item.lifecycle.currentPhase = BACKFILL_TERMINAL;
  item.lifecycle.completedAt = wc.terminalOcc.enteredAt;      // stable (BP-6)
  if (!Array.isArray(item.lifecycle.backfills)) item.lifecycle.backfills = [];
  const record = {
    operation_id: wc.operationId, request_digest: wc.requestDigest, state: 'pending',
    reason: wc.reason,
    recordedAt: wc.startedAt,          // R3-4: the OPERATION's instant, not the retry's
    finalizedAt: null,
    completionEvidence: {
      commit_sha: wc.commitSha, tests_attested: wc.attested, verified_at: wc.startedAt,
    },
    guardRef: wc.ledgerRef ?? null, guard_initial: wc.guardInitial, upgrade: wc.upgrade,
    actor,
    occurrenceKeys: [...wc.writtenKeys, ...wc.skippedKeys],
  };
  const at = item.lifecycle.backfills.findIndex((r) => r.operation_id === wc.operationId);
  if (at === -1) item.lifecycle.backfills.push(record);
  else item.lifecycle.backfills[at] = { ...item.lifecycle.backfills[at], ...record };
  const liveRecord = item.lifecycle.backfills.find((r) => r.operation_id === wc.operationId);

  store.updateLifecycle(item.id, item.lifecycle);
  if (store.lastSaveOk === false) {
    // BP-5: roll the in-memory item back so memory and disk agree.
    item.lifecycle = snapshot;
    store.items.set(item.id, item);
    return refusal('write', 'vision-state could not be persisted',
      { guarded: wc.guarded, operationId: wc.operationId, ledgerRef: wc.ledgerRef });
  }

  const provider = await getProvider(workspaceRoot);

  // --- 6.1 completion record — BP-11: only for modes that track feature.json
  let rec = null;
  if (tracksJson) {
    const { recordCompletion } = await import('./completion-writer.js');
    try {
      rec = await recordCompletion(workspaceRoot, {
        feature_code: wc.featureCode,
        ...(wc.commitSha ? { commit_sha: wc.commitSha } : {}),
        tests_pass: wc.attested,
        files_changed: wc.filesChanged,
        ...(wc.notes ? { notes: wc.notes } : {}),
        idempotency_key: wc.operationId,
        set_status: false,
      });
    } catch (e) {
      // Durable write failed: the intent is KEPT so a retry resumes.
      return refusal('write', `completion record could not be written: ${e.message}`,
        { guarded: wc.guarded, operationId: wc.operationId, ledgerRef: wc.ledgerRef, error: e });
    }
  }

  // --- 6.2 status -> COMPLETE, raw ----------------------------------------
  let statusChanged = null;
  if (tracksJson) {
    // The backfill door keeps the re-read INSIDE the catch, deliberately and
    // unlike the live path above. A backfill holds a write-ahead intent, and
    // §5.11 says a durable-write failure refuses at `write` and KEEPS it so a
    // retry resumes — a thrown read here would escape the gate with the intent
    // stranded and no `refusedAt` for the caller to act on.
    try {
      const fresh = await provider.getFeature(wc.featureCode);
      const prepared = prepareCompleteStatus(fresh, wc.commitSha);
      if (prepared) {
        await persistCompleteStatus({
          provider, workspaceRoot, featureCode: wc.featureCode, updated: prepared.updated,
        });
        statusChanged = { from: prepared.from, to: 'COMPLETE' };
      }
    } catch (e) {
      return refusal('write', `completion recorded but status could not be set: ${e.message}`,
        { guarded: wc.guarded, operationId: wc.operationId, ledgerRef: wc.ledgerRef, error: e, result: rec });
    }
  }

  // --- 6.3 ROADMAP regen — projection; collected --------------------------
  if (tracksJson) {
    try {
      await provider.renderRoadmap();
    } catch (e) {
      failures.push({ step: 'roadmap', message: e.message, recover: 'compose roadmap generate' });
    }
  }

  // --- 6.4 vision projection ----------------------------------------------
  let visionProjection = null;
  if (tracksJson) {
    try {
      const project = visionProjector || defaultVisionProjector;
      visionProjection = await project({
        workspaceRoot, featureCode: wc.featureCode, visionItemId: visionItemId ?? item.id,
        commitSha: wc.commitSha, ledgerRef: wc.ledgerRef, mode: wc.mode,
        // R2B-4/R3-7: the EFFECTIVE flag for THIS operation, not live config.
        guarded: wc.guarded,
        // The LIVE store, so the projection writes the same item finalization
        // is about to serialize (Codex r1 #2).
        store,
      });
      // `applyVerifiedProjection` REPORTS a refused or unpersisted projection as
      // `{ok:false}`; it does not throw. Handling only exceptions finalized the
      // operation and cleared its intent with the item still incomplete
      // (Codex r1 #3). A projector that returns nothing at all is the same
      // failure wearing a quieter disguise.
      if (!visionProjection || visionProjection.ok === false) {
        failures.push({
          step: 'vision',
          message: (visionProjection?.reasons ?? ['the vision projection reported no result']).join('; '),
          recover: 'compose validate --fix',
        });
      }
    } catch (e) {
      failures.push({ step: 'vision', message: e.message, recover: 'compose validate --fix' });
    }
  } else {
    // R2B-9: modes without feature.json have no projector, and updateLifecycle
    // does NOT touch item.status — so without this the item finalizes still
    // reading its old status while its lifecycle says complete_backfilled. This
    // is DURABLE, not a projection: a failure is rolled back and collected.
    const priorStatus = item.status;
    store.updateItem(item.id, { status: 'complete' });
    if (store.lastSaveOk === false) {
      store.updateItem(item.id, { status: priorStatus });
      failures.push({
        step: 'item-status',
        message: 'vision item status could not be persisted',
        recover: 'retry the backfill',
      });
    }
  }

  // --- 6.5 audit — BP-5: NON-SWALLOWING, emitted regardless of statusChanged
  let auditOk = false;
  try {
    await provider.appendEvent(wc.featureCode, {
      tool: 'backfill_completion', code: wc.featureCode,
      from: statusChanged?.from ?? null, to: 'COMPLETE',
      reason: 'backfill', via: 'completion_gate',
      operation_id: wc.operationId, backfill_request_digest: wc.requestDigest,
      ...(wc.commitSha ? { commit_sha: wc.commitSha } : {}),
      ...(wc.ledgerRef ? { ledger_ref: wc.ledgerRef } : {}),
    });
    auditOk = true;
  } catch (e) {
    failures.push({ step: 'audit', message: e.message, recover: 'retry the backfill' });
  }

  const common = {
    ok: true, guarded: wc.guarded, operationId: wc.operationId,
    ledgerRef: wc.ledgerRef ?? null, recovered: recovering,
    attestedTestsPass: wc.attested, visionProjection,
    written: wc.writtenKeys, skipped: wc.skippedKeys,
    result: rec ? { ...rec, status_changed: statusChanged } : null,
  };

  // --- 6.6 finalize — ONLY with an empty failure set AND a confirmed audit --
  if (failures.length === 0 && auditOk) {
    const snapshot2 = deepClone(item.lifecycle);
    liveRecord.state = 'finalized';
    // The ONLY timestamp in this section minted at write time, deliberately: it
    // records when the operation FINISHED, which on a resume really is now.
    liveRecord.finalizedAt = new Date().toISOString();
    store.updateLifecycle(item.id, item.lifecycle);
    if (store.lastSaveOk === false) {
      item.lifecycle = snapshot2;
      store.items.set(item.id, item);
      // Return the RESTORED record, not the detached one this block already
      // mutated to `finalized` (Codex r1 #6). The caller was being handed a
      // record that says finalized while disk and memory both say pending.
      const restored = (item.lifecycle.backfills ?? [])
        .find((r) => r.operation_id === wc.operationId) ?? null;
      return {
        ...common,
        partial: true,
        failures: [{ step: 'finalize', message: 'vision-state could not be persisted', recover: 'retry the backfill' }],
        backfill: restored, status: 'pending', reasons: [],
      };
    }
    clearIntent(workspaceRoot, wc.featureCode);            // LAST
    return { ...common, partial: false, failures: [], backfill: liveRecord, status: 'finalized', reasons: [] };
  }

  // The record stays `pending`, the intent stays. A retry resumes.
  return { ...common, partial: true, failures, backfill: liveRecord, status: 'pending', reasons: [] };
}
