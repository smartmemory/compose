// server/lifecycle-guard.js
//
// COMP-MCP-ENFORCE Slice 1 — compose-owned STRAT-GUARD policy.
//
// Compose owns the phase semantics (the graph + which evidence each edge
// requires); stratum's STRAT-GUARD primitive enforces them. This module:
//   - declares the canonical lifecycle phase graph as DATA (single source of
//     truth, imported by vision-routes.js for its own legality check),
//   - binds per-edge evidence predicates to server-read artifacts,
//   - lazily + idempotently registers each feature as a guarded resource,
//   - drives guarded transitions, fail-closed.
//
// See docs/features/COMP-MCP-ENFORCE/{design,blueprint,plan}.md.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  guardRegister as _guardRegister,
  guardTransition as _guardTransition,
} from './stratum-client.js';
import { setFeatureStatus as _setFeatureStatus } from '../lib/feature-writer.js';

// ---------------------------------------------------------------------------
// Canonical phase graph (compose-owned data — single source of truth)
// ---------------------------------------------------------------------------

/** Forward transitions between non-terminal lifecycle phases. */
export const BASE_TRANSITIONS = {
  explore_design: ['prd', 'architecture', 'blueprint'],
  prd: ['architecture', 'blueprint'],
  architecture: ['blueprint'],
  blueprint: ['verification'],
  verification: ['plan', 'blueprint'],
  plan: ['execute'],
  execute: ['report', 'docs'],
  report: ['docs'],
  docs: ['ship'],
  ship: [],
};

/** Phases whose forward edge may be skipped (not killed). */
export const SKIPPABLE = new Set(['prd', 'architecture', 'report']);

/** Terminal phases — no outgoing edges. */
export const TERMINAL = new Set(['complete', 'killed']);

/**
 * Assemble the FULL guarded graph the design requires: the forward
 * `BASE_TRANSITIONS` PLUS the `ship → complete` edge and a `<any non-terminal>
 * → killed` edge from every reachable non-terminal phase. The guard graph must
 * be a superset of every edge vision-routes will legally request, or the guard
 * would reject a transition the app considers valid.
 */
export function buildPhaseGraph(transitions = BASE_TRANSITIONS) {
  const graph = {};
  const nodes = new Set();
  for (const [from, tos] of Object.entries(transitions)) {
    graph[from] = [...tos];
    nodes.add(from);
    for (const t of tos) nodes.add(t);
  }
  // ship → complete (the highest-consequence edge; implemented separately in
  // vision-routes at /lifecycle/complete, so absent from BASE_TRANSITIONS).
  graph.ship = [...(graph.ship || []), 'complete'];
  // Every non-terminal phase → killed (vision-routes /lifecycle/kill allows
  // kill from any non-terminal phase, including ship).
  for (const s of nodes) {
    if (TERMINAL.has(s)) continue;
    graph[s] = graph[s] || [];
    if (!graph[s].includes('killed')) graph[s].push('killed');
  }
  graph.complete = [];
  graph.killed = [];
  return graph;
}

/**
 * Per-edge `deterministic` (trusted, server-read) evidence predicates. Paths are
 * RELATIVE to the guard's workspace_root and derived from the configured feature
 * directory (never hardcoded `docs/features`). Edges not listed here carry no
 * predicate — they still get graph-legality + per-resource serialization +
 * tamper-evident ledgering. Evidence-bound `ship → complete` is Slice 3.
 *
 * @param {string} featureRelDir e.g. "docs/features/FEAT-1"
 */
export function edgePredicates(featureRelDir) {
  const det = (id, file) => ({
    id,
    type: 'deterministic',
    statement: `server_file_exists('${featureRelDir}/${file}')`,
  });
  return {
    'explore_design->blueprint': [det('design_md', 'design.md')],
    'blueprint->verification': [det('blueprint_md', 'blueprint.md')],
    'plan->execute': [det('plan_md', 'plan.md')],
  };
}

/**
 * Project-scoped, opaque resource id. STRAT-GUARD state is stored globally keyed
 * only by resource_id and workspace_root is NOT part of the checksum, so a bare
 * `compose:<FC>` would let two compose projects sharing a feature code collide on
 * one ledger/current-state. The project-path hash prevents that.
 */
export function resourceId(featureCode, workspaceRoot) {
  const hash = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
  return `compose:${hash}:${featureCode}`;
}

// ---------------------------------------------------------------------------
// Lifecycle-as-truth: roadmap STATUS is a projection of lifecycle phase (Slice 2)
// ---------------------------------------------------------------------------

/**
 * Project a lifecycle phase onto the roadmap STATUS enum. The lifecycle is the
 * source of truth; STATUS is derived. `complete`/`killed` are terminal; every
 * active phase (explore_design…ship) is IN_PROGRESS. PLANNED is the PRE-lifecycle
 * state (no projection needed); BLOCKED/PARKED/PARTIAL/SUPERSEDED have no phase
 * and stay set_feature_status's domain.
 */
export function phaseToStatus(phase) {
  if (phase === 'complete') return 'COMPLETE';
  if (phase === 'killed') return 'KILLED';
  return 'IN_PROGRESS';
}

let _statusWriter = _setFeatureStatus;
/** @internal test seam */
export function _testOnly_setStatusWriter(fn) { _statusWriter = fn; }
/** @internal test seam */
export function _testOnly_resetStatusWriter() { _statusWriter = _setFeatureStatus; }

/**
 * Write the phase-projected STATUS through to feature.json (closes the
 * COMP-PARITY-7 one-way-sync gap for the lifecycle-driven path). Best-effort:
 * a missing feature or a writer error is captured and returned, never thrown —
 * status projection must not roll back a lifecycle transition that already
 * applied. setFeatureStatus is itself idempotent (from===to → noop), so calling
 * it on every transition only writes on a real status change.
 */
export async function projectFeatureStatus({ featureCode, phase, cwd, commitSha }) {
  if (!featureCode) return { skipped: true };
  const status = phaseToStatus(phase);
  try {
    // derived:true — the lifecycle is authoritative, so the roadmap transition
    // table does not gate this projection (e.g. PARKED→IN_PROGRESS on resume).
    const args = { code: featureCode, status, reason: `lifecycle:${phase}`, derived: true };
    if (commitSha) args.commit_sha = commitSha;
    const result = await _statusWriter(cwd, args);
    return { status, result };
  } catch (e) {
    return { status, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Evidence-bound completion (Slice 3)
// ---------------------------------------------------------------------------

/** True if `sha` resolves to a real commit object in the repo at `cwd`. */
function gitCommitExists(sha, cwd) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
    { cwd, encoding: 'utf8' });
  return r.status === 0;
}

/**
 * Verify the evidence required to complete a feature under the guard — the
 * substrate confirms it, not a caller boolean (the design's "trusted evidence"
 * principle, evaluated compose-side because compose owns the repo + test runner):
 *   - `commit_sha` must exist as a real git commit (server-read, not syntax).
 *   - tests must be ATTESTED: a configured `testCommand` exits 0 (real exit code),
 *     OR `testsPassClaim` is explicitly true. There is NO silent default-to-true.
 *
 * @returns {Promise<{ok:boolean, reasons:string[], testsAttested:boolean}>}
 */
export async function verifyCompletionEvidence({ commitSha, cwd, testCommand, testsPassClaim }) {
  const reasons = [];

  if (!commitSha || typeof commitSha !== 'string' || !commitSha.trim()) {
    reasons.push('commit_sha is required for evidence-bound completion');
  } else if (!gitCommitExists(commitSha.trim(), cwd)) {
    reasons.push(`commit ${commitSha.trim()} not found in repository (server-read git verification)`);
  }

  let testsAttested = false;
  if (Array.isArray(testCommand) && testCommand.length > 0) {
    const [bin, ...rest] = testCommand;
    const r = spawnSync(bin, rest, { cwd, encoding: 'utf8' });
    if (r.error) {
      reasons.push(`test command failed to run: ${r.error.message}`);
    } else if (r.status !== 0) {
      reasons.push(`test command exited ${r.status} (not 0)`);
    } else {
      testsAttested = true;
    }
  } else if (testsPassClaim !== true) {
    reasons.push('tests_pass must be explicitly true (no configured test command to attest test results)');
  }

  return { ok: reasons.length === 0, reasons, testsAttested };
}

// ---------------------------------------------------------------------------
// Guard client (injectable for tests)
// ---------------------------------------------------------------------------

let _client = { register: _guardRegister, transition: _guardTransition };
/** @internal test seam */
export function _testOnly_setGuardClient(c) { _client = c; }

// Per-process registration cache — register is idempotent server-side, but the
// cache avoids a subprocess per request once a resource is known-registered.
const _registered = new Set();
/** @internal test seam */
export function _testOnly_resetGuardCache() { _registered.clear(); }

/**
 * Resolve the feature directory RELATIVE to the served `workspaceRoot` — read
 * from `<workspaceRoot>/.compose/compose.json` (NOT the process-global config,
 * which is pinned to getTargetRoot() and would drift for a non-current project
 * root). The relative dir is baked into the immutable guard registration, so it
 * must reflect the tree the routes actually serve.
 */
function _featureRelDir(featureCode, workspaceRoot) {
  let featuresRel = 'docs/features';
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspaceRoot, '.compose', 'compose.json'), 'utf-8'));
    featuresRel = cfg?.paths?.features || 'docs/features';
  } catch { /* missing/invalid config → default */ }
  return `${featuresRel}/${featureCode}`;
}

/**
 * The configured evidence-bound-completion test command (array form, e.g.
 * ["npm","test"]) from `<workspaceRoot>/.compose/compose.json` `guard.testCommand`,
 * or null when unconfigured. When null, evidence-bound completion falls back to
 * requiring an explicit tests_pass=true (still no silent default).
 */
export function guardTestCommand(workspaceRoot) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspaceRoot, '.compose', 'compose.json'), 'utf-8'));
    const cmd = cfg?.guard?.testCommand;
    return Array.isArray(cmd) && cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/**
 * Idempotently register the feature as a guarded resource, seeding `initial`
 * from the item's CURRENT phase (so items already mid-lifecycle at rollout don't
 * trip stale_from_state). Only the first registration ever seeds current_state;
 * later calls (different `initial`) are no-ops because `initial` is not part of
 * the policy checksum.
 *
 * @returns the register result, or {error} on guard failure.
 */
export async function ensureGuard(featureCode, currentPhase, workspaceRoot) {
  const rid = resourceId(featureCode, workspaceRoot);
  if (_registered.has(rid)) return { guard_id: rid, status: 'cached' };

  let res;
  try {
    res = await _client.register({
      resourceId: rid,
      graph: buildPhaseGraph(),
      edgePredicates: edgePredicates(_featureRelDir(featureCode, workspaceRoot)),
      initial: currentPhase,
      terminal: ['complete', 'killed'],
      stakes: {},
      workspaceRoot,
    });
  } catch (e) {
    // A thrown spawn failure (e.g. stratum-mcp not installed) must NOT escape as
    // a generic 500/400 — normalise to a fail-closed error result.
    return { error: { code: 'GUARD_UNREACHABLE', message: e.message } };
  }
  if (res && (res.status === 'registered' || res.status === 'exists')) {
    _registered.add(rid);
  }
  return res;
}

/**
 * Attempt a guarded lifecycle transition. Registers (idempotently) then
 * transitions. FAIL-CLOSED: any guard error (unreachable, illegal edge, error
 * dict) yields `{applied:false, error}` — the caller must NOT mutate state.
 *
 * @returns {Promise<{applied:boolean, refused?:boolean, verdict?:object,
 *   ledgerRef?:string, currentState?:string, error?:object}>}
 */
export async function guardedTransition({ featureCode, from, to, workspaceRoot, commitSha, resolvedBy = 'agent' }) {
  const reg = await ensureGuard(featureCode, from, workspaceRoot);
  if (reg && (reg.error || reg.status === 'error')) {
    return { applied: false, error: reg.error || reg };
  }

  const rid = resourceId(featureCode, workspaceRoot);
  const artifacts = commitSha ? { commit_sha: commitSha } : {};
  // No idempotency_key: a refuse→fix→retry is a NEW logical attempt that must
  // re-evaluate evidence, but it carries an identical (from,to,artifacts)
  // payload — an idempotency_key would make the guard replay the prior refusal.
  // Double-apply is already prevented server-side: once applied, current_state
  // advances and a duplicate call fails the from_state == current_state check.
  let res;
  try {
    res = await _client.transition({
      resourceId: rid,
      fromState: from,
      toState: to,
      artifacts,
      resolvedBy,
    });
  } catch (e) {
    // Fail-closed on a thrown spawn failure (see ensureGuard).
    return { applied: false, error: { code: 'GUARD_UNREACHABLE', message: e.message } };
  }

  if (!res || res.error || res.status === 'error') {
    return { applied: false, error: (res && (res.error || res)) || { code: 'UNKNOWN', message: 'no guard response' } };
  }
  if (res.status === 'applied') {
    return { applied: true, verdict: res.verdict, ledgerRef: res.ledger_ref, currentState: res.current_state };
  }
  // refused | replayed
  return {
    applied: res.status === 'replayed' ? true : false,
    refused: res.status === 'refused',
    verdict: res.verdict,
    ledgerRef: res.ledger_ref,
    currentState: res.current_state,
  };
}
