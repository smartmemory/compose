/**
 * stratum-client.js — Single adapter for all stratum-mcp subprocess calls.
 *
 * This is the ONLY module in compose that spawns stratum-mcp processes.
 * All query and mutation calls go through the exported functions below.
 * No other file may call execFile/spawn with 'stratum-mcp' as the command.
 *
 * Contract:
 *   - Query calls:   5s timeout, 1 retry on timeout, no retry on error
 *   - Mutation calls: 10s timeout, no retry (mutations are not idempotent to retry)
 *   - Exit 0  → parse stdout as JSON, return result
 *   - Exit 2  → conflict (idempotency), return { conflict: true, ... }
 *   - Non-zero → log stderr internally, return { error: { code, message, detail } }
 *   - stderr is NEVER forwarded to callers
 */

import { execFile as _execFileDefault } from 'node:child_process';
import { getTargetRoot } from './project-root.js';
import { resolveStratumEngine as resolveEngine, LIVE_STRATUM_TS_CLI_BIN } from '../lib/stratum-engine.js';

const STRATUM_BIN = 'stratum-mcp';

// Injected executor — replaced by tests only. Production code never calls this setter.
let _execFile = _execFileDefault;
export function _testOnly_setExecFile(fn) { _execFile = fn; }
const QUERY_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Engine selection (COMP-STRATUM-TS)
//
// The flow/gate seam is engine-selectable: the TS engine's `stratum` CLI
// (default) or Python `stratum-mcp`, with the same JSON projections and
// exit codes. Guard calls are PINNED to Python — STRAT-GUARD is not part of
// the TS port. Resolution order: COMPOSE_STRATUM_ENGINE env override, then
// capabilities.stratumEngine in .compose/compose.json, then "ts".
// Unknown values fail loudly; never a silent fallback.
// ---------------------------------------------------------------------------

/** @returns {'python'|'ts'} */
export function resolveStratumEngine() {
  return resolveEngine(getTargetRoot());
}

/** Binary for flow/gate query+mutation calls under the selected engine. */
function flowGateBin() {
  // C1: the TS default is the live checkout's query/gate CLI, NOT a bare
  // `stratum` (which resolves to whatever is on $PATH — e.g. miniconda's
  // incompatible python CLI). The COMPOSE_STRATUM_TS_BIN override is retained.
  if (resolveStratumEngine() === 'ts') return process.env.COMPOSE_STRATUM_TS_BIN || LIVE_STRATUM_TS_CLI_BIN;
  return STRATUM_BIN;
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
function spawnStratum(args, timeoutMs, bin = STRATUM_BIN) {
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
  if (err?.code === 'ETIMEDOUT') code = -1;
  else if (typeof err?.code === 'number') code = err.code;
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
  return bin === STRATUM_BIN
    ? `stratum-mcp failed to spawn (${code}). Install with: pip install stratum-mcp`
    : `${bin} (TS stratum engine) failed to spawn (${code}). Install @smartmemory/stratum or set COMPOSE_STRATUM_TS_BIN`;
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
      return { error: { code: 'TIMEOUT', message: 'stratum-mcp query timed out', detail: '' } };
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
      return { error: { code: 'UNKNOWN', message: 'stratum-mcp query failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'stratum-mcp returned invalid JSON', detail: '' } };
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
    return { error: { code: 'TIMEOUT', message: 'stratum-mcp gate timed out', detail: '' } };
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
      return { error: { code: 'UNKNOWN', message: 'stratum-mcp gate failed', detail: '' } };
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'stratum-mcp returned invalid JSON', detail: '' } };
  }
}

/**
 * Spawn stratum-mcp with args and pipe `inputJson` (a string) on stdin.
 * Used by the STRAT-GUARD adapter, whose CLI reads one JSON kwargs object from
 * stdin. Same resolve contract as spawnStratum. PINNED to the Python binary —
 * STRAT-GUARD is not part of the TS port and ignores the engine flag.
 *
 * @param {string[]} args
 * @param {string}   inputJson
 * @param {number}   timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function spawnStratumStdin(args, inputJson, timeoutMs) {
  return new Promise((resolve) => {
    const proc = _execFile(STRATUM_BIN, args, { timeout: timeoutMs }, (err, out, err2) => {
      resolve(_spawnResult(STRATUM_BIN, err, out, err2));
    });
    // Same both-paths-settle-identically contract as spawnStratum.
    proc.on('error', (err) => {
      resolve(_spawnResult(STRATUM_BIN, err ?? new Error('child process error'), '', ''));
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
async function runGuard(action, kwargs, timeoutMs = MUTATION_TIMEOUT_MS) {
  const result = await spawnStratumStdin(['guard', action], JSON.stringify(kwargs), timeoutMs);

  if (result.code === -1) {
    return { error: { code: 'TIMEOUT', message: 'stratum-mcp guard timed out', detail: '' } };
  }
  if (result.code === -2) {
    console.error('[stratum-client] guard spawn failure:', result.stderr);
    return { error: { code: 'SPAWN', message: result.stderr, detail: '' } };
  }
  if (result.code !== 0) {
    console.error('[stratum-client] guard error stderr:', result.stderr);
    try {
      return JSON.parse(result.stdout);   // canonical { status:"error", ... }
    } catch {
      return { error: { code: 'UNKNOWN', message: 'stratum-mcp guard failed', detail: '' } };
    }
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { error: { code: 'PARSE_ERROR', message: 'stratum-mcp returned invalid JSON', detail: '' } };
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
// kwargs the `stratum-mcp guard <action>` CLI forwards verbatim to the guard
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
export async function guardTransition({ resourceId, fromState, toState, artifacts, modifiedFiles, idempotencyKey, resolvedBy }) {
  return runGuard('transition', _compact({
    resource_id: resourceId,
    from_state: fromState,
    to_state: toState,
    artifacts,
    modified_files: modifiedFiles,
    idempotency_key: idempotencyKey,
    resolved_by: resolvedBy,
  }));
}

/**
 * The single sanctioned bypass of predicate verification. Requires an
 * out-of-band override token (server env STRATUM_GUARD_OVERRIDE_TOKEN), a human
 * resolver, and a rationale. Records a 'deviation' ledger entry.
 * @returns {Promise<{status:string,ledger_ref:string,current_state:string}|ErrorResult>}
 */
export async function guardOverride({ resourceId, fromState, toState, overrideToken, rationale, resolvedBy = 'human' }) {
  return runGuard('override', _compact({
    resource_id: resourceId,
    from_state: fromState,
    to_state: toState,
    override_token: overrideToken,
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
