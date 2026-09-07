/**
 * stratum-client.js — Single adapter for all Stratum TS CLI subprocess calls.
 *
 * This is the ONLY module in compose that spawns Stratum CLI processes.
 * All query and mutation calls go through the exported functions below.
 * No other file may spawn the Stratum CLI directly.
 *
 * Contract:
 *   - Query calls:   5s timeout, 1 retry on timeout, no retry on error
 *   - Mutation calls: 30s timeout, no retry (mutations are not idempotent to retry)
 *   - Exit 0  → parse stdout as JSON, return result
 *   - Exit 2  → conflict (idempotency), return { conflict: true, ... }
 *   - Non-zero → log stderr internally, return { error: { code, message, detail } }
 *   - stderr is NEVER forwarded to callers
 */

import { execFile as _execFileDefault } from 'node:child_process';
import { getTargetRoot } from './project-root.js';
import { resolveStratumBin, resolveStratumEngine as resolveEngine } from '../lib/stratum-engine.js';

// Injected executor — replaced by tests only. Production code never calls this setter.
let _execFile = _execFileDefault;
export function _testOnly_setExecFile(fn) { _execFile = fn; }
const QUERY_TIMEOUT_MS = 5_000;
// Measured 2026-09-07 on this seam: a `guard transition` subprocess costs
// 1.5-3.9 s idle (node startup + the stratum CLI module graph + guard store IO).
// A 10 s budget left under 3x headroom, and under full-suite load 6 of 200
// lifecycle-guard-e2e runs blew it; at 30 s the same probe under the same load
// was 0 of 200. A mutation timeout is a fail-closed refusal to the caller, so
// the budget must clear a loaded machine, not just an idle one.
const MUTATION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Engine selection (COMP-STRATUM-TS)
//
// All flow, gate, and guard calls use the TS CLI. The shared resolver still
// reads the environment/project capability so a retired Python selection fails
// loudly before any subprocess is spawned.
// ---------------------------------------------------------------------------

/** @returns {'ts'} */
export function resolveStratumEngine() {
  return resolveEngine(getTargetRoot());
}

/** Binary for flow/gate query+mutation calls under the selected engine. */
function flowGateBin() {
  const cwd = getTargetRoot();
  resolveEngine(cwd);
  return resolveStratumBin('cli', cwd);
}

// ---------------------------------------------------------------------------
// Core subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn a stratum binary with args. Returns a Promise resolving to { stdout, code }.
 * Rejects only on spawn failure (binary not found).
 *
 * @param {string[]} args
 * @param {number}   timeoutMs
 * @param {string}   [bin] — explicit binary selected by the calling seam
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnStratum(args, timeoutMs, bin) {
  return new Promise((resolve) => {
    const proc = _execFile(bin, args, { timeout: timeoutMs }, (err, out, err2) => {
      resolve(_spawnResult(bin, err, out, err2));
    });
    // Node delivers spawn failures through BOTH the callback and the child
    // 'error' event, in racy order. Both paths settle through the same
    // mapping — the promise keeps whichever fires first, never an unhandled
    // rejection, and only genuine spawn codes become SPAWN.
    proc.on('error', (err) => {
      resolve(_spawnResult(bin, err ?? new Error('child process error'), '', ''));
    });
  });
}

// Genuine spawn-level failures; other string codes (e.g. maxbuffer overruns)
// are execution failures and must not be reported as "install stratum".
const _SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

/** Map an execFile callback settle into the { stdout, stderr, code } contract. */
function _spawnResult(bin, err, out, err2) {
  const stdout = out || '';
  let stderr = err2 || '';
  let code;
  // A timeout kill NEVER reaches the execFile CALLBACK as `code: 'ETIMEDOUT'` —
  // node kills the child and reports `{ code: null, killed: true, signal:
  // 'SIGTERM' }`. Matching only on ETIMEDOUT left every real timeout falling
  // through to the generic `code = 1` branch below, so the TIMEOUT arms of
  // runQuery/runMutation/runGuard (and runQuery's retry) were unreachable and a
  // timed-out guard transition surfaced as `UNKNOWN` — rendered by the lifecycle
  // routes as "transition refused by guard", i.e. an infrastructure timeout
  // claiming the evidence was evaluated and rejected. Measured 2026-09-07:
  // 6/200 lifecycle-guard-e2e runs under full-suite load, every one this shape.
  // (`ETIMEDOUT` is still matched: execFileSync/spawnSync do set it, and
  // probeStratumBin in lib/stratum-engine.js already checks all three.)
  // `killed` is set only when NODE killed the child (timeout). A child that
  // died to an outside signal reports `signal` with `killed: false`; that is
  // not a timeout and is named as what it was rather than relabelled.
  if (err?.code === 'ETIMEDOUT' || err?.killed === true) {
    code = -1;
    stderr = stderr || err.message || String(err);
  } else if (typeof err?.code === 'number') code = err.code;
  else if (err?.signal != null) {
    code = 1;
    stderr = stderr || `stratum child killed by ${err.signal}`;
  }
  else if (typeof err?.code === 'string' && _SPAWN_CODES.has(err.code)) {
    code = -2;
    stderr = _spawnRemedy(bin, err.code);
  } else if (err) {
    // Non-spawn string codes (ERR_CHILD_PROCESS_STDIO_MAXBUFFER, ...) and
    // codeless errors: a generic failure with the real message preserved.
    code = 1;
    stderr = stderr || err.message || String(err);
  } else {
    code = 0;
  }
  return { stdout, stderr, code };
}

/** Binary-specific spawn-failure message with the install/path remedy. */
function _spawnRemedy(bin, code) {
  return `${bin} (TS stratum engine) failed to spawn (${code}). Install @smartmemory/stratum or set COMPOSE_STRATUM_TS_CLI_BIN`;
}

/**
 * A bounded, diagnosable tail of what the subprocess actually produced. The
 * TIMEOUT/PARSE_ERROR envelopes used to carry `detail: ''`, which made every
 * such failure indistinguishable from every other one in a log. stderr is not
 * forwarded to REST callers (see the module contract) — this detail is the
 * process-level shape (exit code + a stdout excerpt), not the child's stderr.
 */
function _detail(result) {
  const out = String(result?.stdout ?? '').trim();
  return `exit=${result?.code}${out ? ` stdout=${JSON.stringify(out.slice(0, 400))}` : ' stdout=<empty>'}`;
}

/**
 * Run a query command (read-only). Retries once on timeout.
 *
 * @returns {Promise<any>} parsed JSON result, or throws StratumError
 */
async function runQuery(args) {
  const bin = flowGateBin();
  let result = await spawnStratum(args, QUERY_TIMEOUT_MS, bin);

  if (result.code === -1) {
    // Retry once on timeout
    result = await spawnStratum(args, QUERY_TIMEOUT_MS, bin);
    if (result.code === -1) {
      return { error: { code: 'TIMEOUT', message: 'Stratum query timed out', detail: _detail(result) } };
    }
  }

  if (result.code === -2) {
    console.error('[stratum-client] query spawn failure:', result.stderr);
    return { error: { code: 'SPAWN', message: result.stderr, detail: '' } };
  }

  if (result.code !== 0) {
    console.error('[stratum-client] query error stderr:', result.stderr);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { error: { code: 'UNKNOWN', message: 'Stratum query failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'Stratum returned invalid JSON', detail: _detail(result) } };
  }
}

/**
 * Run a mutation command (gate approve/reject/revise). No retry.
 *
 * @returns {Promise<any>} parsed JSON result, or { conflict }, or { error }
 */
async function runMutation(args) {
  const result = await spawnStratum(args, MUTATION_TIMEOUT_MS, flowGateBin());

  if (result.code === -1) {
    return { error: { code: 'TIMEOUT', message: 'Stratum gate timed out', detail: _detail(result) } };
  }

  if (result.code === -2) {
    console.error('[stratum-client] mutation spawn failure:', result.stderr);
    return { error: { code: 'SPAWN', message: result.stderr, detail: '' } };
  }

  if (result.code === 2) {
    try {
      return JSON.parse(result.stdout);   // { conflict: true, ... }
    } catch {
      return { conflict: true, detail: '' };
    }
  }

  if (result.code !== 0) {
    console.error('[stratum-client] mutation error stderr:', result.stderr);
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { error: { code: 'UNKNOWN', message: 'Stratum gate failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'Stratum returned invalid JSON', detail: _detail(result) } };
  }
}

/**
 * Spawn the TS Stratum CLI with args and pipe `inputJson` on stdin.
 * Used by the STRAT-GUARD adapter, whose CLI reads one JSON kwargs object from
 * stdin. Same resolve contract as spawnStratum.
 *
 * @param {string[]} args
 * @param {string}   inputJson
 * @param {number}   timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnStratumStdin(args, inputJson, timeoutMs, bin, extraEnv) {
  return new Promise((resolve) => {
    const proc = _execFile(bin, args, {
      timeout: timeoutMs,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    }, (err, out, err2) => {
      resolve(_spawnResult(bin, err, out, err2));
    });
    // Same both-paths-settle-identically contract as spawnStratum.
    proc.on('error', (err) => {
      resolve(_spawnResult(bin, err ?? new Error('child process error'), '', ''));
    });

    // Feed the JSON kwargs on stdin. The test mock supplies a fake stdin; a
    // real child always has one. Guard so neither path throws.
    if (proc.stdin) {
      try {
        proc.stdin.write(inputJson);
        proc.stdin.end();
      } catch { /* child already exited / stdin closed — execFile cb still fires */ }
    }
  });
}

/**
 * Run a guard mutation: pipe `kwargs` as JSON on stdin, no retry (mutations are
 * not safe to blindly retry). Maps exit codes like runMutation. A guard refusal
 * is a NORMAL exit-0 result ({status:"refused"}), not an error.
 *
 * @returns {Promise<any>} parsed JSON result or { error }
 */
async function runGuard(action, kwargs, timeoutMs = MUTATION_TIMEOUT_MS, extraEnv) {
  const result = await spawnStratumStdin(['guard', action], JSON.stringify(kwargs), timeoutMs, flowGateBin(), extraEnv);

  if (result.code === -1) {
    return { error: { code: 'TIMEOUT', message: 'Stratum guard timed out', detail: _detail(result) } };
  }
  if (result.code === -2) {
    console.error('[stratum-client] guard spawn failure:', result.stderr);
    return { error: { code: 'SPAWN', message: result.stderr, detail: '' } };
  }
  if (result.code !== 0) {
    let canonical = null;
    try { canonical = JSON.parse(result.stdout); } catch { /* not canonical */ }
    // guard_not_found is a normal answer to a policy/history query (every
    // never-registered feature returns it); logging it as an error spammed
    // 363 lines from one `compose guard status` on 2026-09-06.
    if (canonical?.error_type !== 'guard_not_found') {
      console.error('[stratum-client] guard error stderr:', result.stderr);
    }
    if (canonical) return canonical;   // canonical { status:"error", ... }
    return { error: { code: 'UNKNOWN', message: 'Stratum guard failed', detail: '' } };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'Stratum returned invalid JSON', detail: _detail(result) } };
  }
}

/** Strip undefined values so the JSON kwargs object stays minimal. */
function _compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all persisted flows. @returns {Promise<FlowSummary[]|ErrorResult>} */
export async function queryFlows() {
  return runQuery(['query', 'flows']);
}

/** Full state for a single flow. @returns {Promise<FlowState|ErrorResult>} */
export async function queryFlow(flowId) {
  return runQuery(['query', 'flow', flowId]);
}

/** List all pending gate steps. @returns {Promise<PendingGate[]|ErrorResult>} */
export async function queryGates() {
  return runQuery(['query', 'gates']);
}

/**
 * Approve a gate step. Stratum is the mutation authority.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateApprove(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'approve', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}

/**
 * Reject (kill) a gate step.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateReject(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'reject', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}

/**
 * Send a gate step back for revision.
 * @param {string} flowId
 * @param {string} stepId
 * @param {string} [note]
 * @param {'human'|'agent'|'system'} [resolvedBy]
 * @returns {Promise<GateMutationResult|ConflictResult|ErrorResult>}
 */
export async function gateRevise(flowId, stepId, note = '', resolvedBy = 'human') {
  const args = ['gate', 'revise', flowId, stepId];
  if (note) args.push('--note', note);
  if (resolvedBy !== 'human') args.push('--resolved-by', resolvedBy);
  return runMutation(args);
}

// ---------------------------------------------------------------------------
// STRAT-GUARD adapter (COMP-MCP-ENFORCE Slice 1)
//
// Reaches stratum's guarded-transition primitive over the same CLI-subprocess
// seam. Each function translates camelCase params into the snake_case JSON
// kwargs the `stratum guard <action>` CLI forwards verbatim to the guard
// library, and pipes them on stdin.
// ---------------------------------------------------------------------------

/**
 * Register (idempotently) a guarded resource. Re-registering an identical policy
 * is a no-op ({status:"exists"}); a different policy is rejected (use migrate).
 * @returns {Promise<{guard_id:string,checksum:string,status:string}|ErrorResult>}
 */
export async function guardRegister({ resourceId, graph, edgePredicates, initial, terminal, stakes, workspaceRoot }) {
  return runGuard('register', _compact({
    resource_id: resourceId,
    graph,
    edge_predicates: edgePredicates,
    initial,
    terminal,
    stakes,
    workspace_root: workspaceRoot,
  }));
}

/**
 * Attempt a guarded transition. Applies only if the edge is legal and its
 * predicates verify server-side. A refusal is a normal result (status:"refused").
 * @returns {Promise<{status:string,verdict:object,ledger_ref:string,current_state:string}|ErrorResult>}
 */
export async function guardTransition({ resourceId, fromState, toState, artifacts, modifiedFiles, idempotencyKey, expectedPolicyChecksum, resolvedBy }) {
  return runGuard('transition', _compact({
    resource_id: resourceId,
    from_state: fromState,
    to_state: toState,
    artifacts,
    modified_files: modifiedFiles,
    idempotency_key: idempotencyKey,
    expected_policy_checksum: expectedPolicyChecksum,
    resolved_by: resolvedBy,
  }));
}

/**
 * The single sanctioned bypass of predicate verification. Requires a signed
 * one-shot AUTHORIZATION, a human resolver, and a rationale. Records a
 * 'deviation' ledger entry.
 *
 * Corrected 2026-09-07: this wrapper sent `override_token`, the shared secret
 * stratum retired in STRAT-GUARD-AUTHZ @3647b4c. Stratum now reads
 * `authorization` (`ts/src/mcp/server.ts:270`) — an sshsig over a payload it
 * reconstructs, bound to the resource's ledger head — so every call this wrapper
 * could have made was destined to fail on a missing authorization. It has no
 * production caller; the field name is fixed so the first one does not inherit
 * the break.
 * @returns {Promise<{status:string,ledger_ref:string,current_state:string}|ErrorResult>}
 */
export async function guardOverride({ resourceId, fromState, toState, authorization, rationale, resolvedBy = 'human' }) {
  return runGuard('override', _compact({
    resource_id: resourceId,
    from_state: fromState,
    to_state: toState,
    authorization,
    rationale,
    resolved_by: resolvedBy,
  }));
}

/**
 * Read a resource's current state + append-only, hash-chained transition ledger.
 * @returns {Promise<{resource_id:string,current_state:string,ledger:object[]}|ErrorResult>}
 */
export async function guardHistory(resourceId) {
  return runGuard('history', { resource_id: resourceId }, QUERY_TIMEOUT_MS);
}

/** Read an immutable guard policy for compatibility and upgrade decisions. */
export async function guardPolicy(resourceId) {
  return runGuard('policy', { resource_id: resourceId }, QUERY_TIMEOUT_MS);
}

/** List registered guard resources, optionally filtered by resource_id prefix. */
export async function guardList({ prefix } = {}) {
  return runGuard('list', prefix ? { prefix } : {}, QUERY_TIMEOUT_MS);
}

/** Apply a signed, server-owned guard upgrade descriptor. */
export async function guardApplyUpgrade({ resourceId, descriptorId, descriptorsPath }) {
  return runGuard('apply-upgrade', {
    resource_id: resourceId,
    descriptor_id: descriptorId,
  }, MUTATION_TIMEOUT_MS, {
    STRATUM_GUARD_UPGRADE_DESCRIPTORS: descriptorsPath,
  });
}

/** Inspect + verify a descriptor file through stratum's verifier (read-only). */
export async function guardDescriptors(descriptorsPath) {
  return runGuard('descriptors', {}, MUTATION_TIMEOUT_MS, {
    STRATUM_GUARD_UPGRADE_DESCRIPTORS: descriptorsPath,
  });
}

/** Compute stratum's canonical transition payload digest without changing state. */
export async function guardDigest({ fromState, toState, artifacts, modifiedFiles, resolvedBy, policyChecksum }) {
  return runGuard('digest', {
    from_state: fromState,
    to_state: toState,
    artifacts,
    modified_files: modifiedFiles,
    resolved_by: resolvedBy,
    policy_checksum: policyChecksum,
  }, QUERY_TIMEOUT_MS);
}
