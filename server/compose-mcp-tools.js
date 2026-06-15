/**
 * compose-mcp-tools.js — Tool implementations for the Compose MCP server.
 *
 * Reads directly from disk (no HTTP, no daemon dependency) so the MCP server
 * works even when the Compose server is not running.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ArtifactManager, ARTIFACT_SCHEMAS } from './artifact-manager.js';
import { getTargetRoot, getDataDir, resolveProjectPath, switchProject, setCurrentWorkspaceId, loadProjectConfig, isLifecycleEnabled } from './project-root.js';
import { resolveProfile, isToolAllowed } from './mcp-tool-policy.js';
import { getRoadmap } from '../lib/get-roadmap.js';

/**
 * COMP-MCP-ENFORCE Slice 3 — kill the `force` escape hatch at the MCP tool
 * boundary. When capabilities.guard is on, a caller-supplied force:true on a
 * status/roadmap mutation is the bypass STRAT-GUARD exists to close, so it is
 * rejected unless it carries a valid out-of-band override token (the agent
 * cannot mint it). Guard off → legacy behavior (no-op). Internal callers
 * (recordCompletion → setFeatureStatus directly) never pass through here.
 *
 * @param {object} args tool args (may carry force / override_token)
 * @param {string} toolName for the error message
 * @param {{guard?: boolean}} [capsOverride] test seam; otherwise read from config
 */
/**
 * COMP-MCP-ENFORCE Slice 3 — close the record_completion bypass. record_completion
 * is a public MCP tool that flips status to COMPLETE; under capabilities.guard it
 * must satisfy the SAME evidence as /lifecycle/complete (real commit + attested
 * tests), else a rogue client could complete a feature without a guard verdict or
 * evidence. Guard off → legacy behavior (no-op).
 *
 * @param {object} args record_completion args (commit_sha, tests_pass)
 * @param {{guard?: boolean}} [capsOverride] test seam
 * @param {string} [cwd]
 */
export async function assertCompletionEvidence(args, capsOverride, cwd = getTargetRoot()) {
  let guardOn;
  if (capsOverride && typeof capsOverride.guard === 'boolean') {
    guardOn = capsOverride.guard;
  } else {
    try { guardOn = loadProjectConfig()?.capabilities?.guard === true; } catch { guardOn = false; }
  }
  if (!guardOn) return;
  const { verifyCompletionEvidence, guardTestCommand } = await import('./lifecycle-guard.js');
  const ev = await verifyCompletionEvidence({
    commitSha: args?.commit_sha,
    cwd,
    testCommand: guardTestCommand(cwd),
    testsPassClaim: args?.tests_pass,
  });
  if (!ev.ok) {
    const e = new Error(
      `record_completion: completion evidence not satisfied under capabilities.guard: ${ev.reasons.join('; ')}`,
    );
    e.code = 'COMPLETION_EVIDENCE_REQUIRED';
    throw e;
  }
}

/** Terminal statuses owned by the lifecycle (projected from phase, Slice 2). */
const LIFECYCLE_OWNED_STATUS = new Set(['COMPLETE', 'KILLED']);

function _guardOn(capsOverride) {
  if (capsOverride && typeof capsOverride.guard === 'boolean') return capsOverride.guard;
  try { return loadProjectConfig()?.capabilities?.guard === true; } catch { return false; }
}

/** True iff a valid, non-agent-mintable override token accompanies the call. */
function _overrideOk(args) {
  const expected = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  return !!expected && args?.override_token === expected;
}

export function assertForceAuthorized(args, toolName, capsOverride) {
  if (!args?.force) return;
  if (!_guardOn(capsOverride)) return;
  if (!_overrideOk(args)) {
    const e = new Error(
      `${toolName}: force is disabled under capabilities.guard — supply a valid override_token ` +
      `(out-of-band STRATUM_GUARD_OVERRIDE_TOKEN; not agent-mintable) to deviate, or drive the ` +
      `change through the lifecycle.`,
    );
    e.code = 'FORCE_REQUIRES_OVERRIDE';
    throw e;
  }
}

/**
 * COMP-MCP-ENFORCE Slice 3 — terminal statuses (COMPLETE/KILLED) are owned by the
 * lifecycle (Slice 2: status is a projection of phase). Under capabilities.guard,
 * a public MCP caller cannot set/mint them directly — that would bypass the
 * evidence-gated /lifecycle/complete and the guarded /lifecycle/kill. The single
 * authorized escape is an out-of-band override token. Guard off → legacy.
 *
 * @param {object} args carries `status` (set_feature_status / add_roadmap_entry)
 * @param {string} toolName
 * @param {{guard?: boolean}} [capsOverride] test seam
 */
export function assertTerminalStatusAuthorized(args, toolName, capsOverride) {
  const status = args?.status;
  if (!status || !LIFECYCLE_OWNED_STATUS.has(status)) return;
  if (!_guardOn(capsOverride)) return;
  if (!_overrideOk(args)) {
    const e = new Error(
      `${toolName}: status ${status} is lifecycle-owned under capabilities.guard — drive it through ` +
      `/lifecycle (evidence-gated for complete, guarded for kill) instead of setting it directly, ` +
      `or supply a valid override_token.`,
    );
    e.code = 'STATUS_OWNED_BY_LIFECYCLE';
    throw e;
  }
}
import { resolveWorkspace } from '../lib/resolve-workspace.js';
import { discoverWorkspaces } from '../lib/discover-workspaces.js';
import { resolvePort } from '../lib/resolve-port.js';

export function getVisionFile() { return path.join(getDataDir(), 'vision-state.json'); }
export function getSessionsFile() { return path.join(getDataDir(), 'sessions.json'); }

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export function loadVisionState() {
  // FORGE-ROADMAP-RETIRE-STORE: when the bound workspace disables the lifecycle
  // capability (capabilities.lifecycle:false — e.g. a narrative-owned forge-top),
  // the vision store is RETIRED. Every MCP vision read funnels through here, so
  // returning the empty shape guarantees get_vision_items (and every dependent:
  // phase summary, item detail, pending gates, lifecycle status) can't surface a
  // second, drift-prone answer beside the prose ROADMAP. Reads stay inert even if
  // a stray write later recreates the file. get_roadmap (narrative) is unaffected.
  if (!isLifecycleEnabled()) return { items: [], connections: [], gates: [] };
  try {
    const raw = fs.readFileSync(getVisionFile(), 'utf-8');
    const state = JSON.parse(raw);
    if (Array.isArray(state.gates)) {
      const seen = new Map();
      for (const g of state.gates) seen.set(g.id, g);
      state.gates = Array.from(seen.values());
    }
    return state;
  } catch {
    return { items: [], connections: [], gates: [] };
  }
}

export function loadSessions() {
  try {
    const raw = fs.readFileSync(getSessionsFile(), 'utf-8');
    const sessions = JSON.parse(raw);
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// COMP-MCP-ROADMAP-READ — read-only roadmap reader. Thin wrapper over
// lib/get-roadmap.js; never mutates the filesystem.
export function toolGetRoadmap(args = {}) {
  return getRoadmap(getTargetRoot(), args ?? {});
}

export function toolGetVisionItems({ phase, status, type, keyword, limit = 30 }) {
  const { items } = loadVisionState();

  let results = items;
  if (phase) results = results.filter(i => i.phase === phase);
  if (status) {
    const statuses = status.split(',').map(s => s.trim());
    results = results.filter(i => statuses.includes(i.status));
  }
  if (type) results = results.filter(i => i.type === type);
  if (keyword) {
    const kw = keyword.toLowerCase();
    results = results.filter(i =>
      i.title?.toLowerCase().includes(kw) ||
      i.description?.toLowerCase().includes(kw)
    );
  }

  const sliced = results.slice(0, limit);
  return {
    count: results.length,
    returned: sliced.length,
    items: sliced.map(i => ({
      id: i.id,
      title: i.title,
      type: i.type,
      phase: i.phase,
      status: i.status,
      confidence: i.confidence ?? null,
      description: i.description ?? null,
    })),
  };
}

export function toolGetItemDetail({ id }) {
  const { items, connections } = loadVisionState();

  const item = items.find(i => i.id === id || i.semanticId === id || i.slug === id);
  if (!item) return { error: `Item not found: ${id}` };

  const resolvedId = item.id;
  const related = connections.filter(c => c.fromId === resolvedId || c.toId === resolvedId);
  const connectionDetails = related.map(c => {
    const other = items.find(i => i.id === (c.fromId === resolvedId ? c.toId : c.fromId));
    return {
      direction: c.fromId === resolvedId ? 'outgoing' : 'incoming',
      type: c.type,
      otherId: other?.id,
      otherTitle: other?.title ?? '(unknown)',
      otherStatus: other?.status,
    };
  });

  return { ...item, connections: connectionDetails };
}

export function toolGetPhasesSummary({ phase }) {
  const { items } = loadVisionState();

  const scoped = phase ? items.filter(i => i.phase === phase) : items;
  const byStatus = {};
  const byType = {};
  for (const item of scoped) {
    const s = item.status || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const t = item.type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
  }

  const confidences = scoped.map(i => i.confidence).filter(c => typeof c === 'number');
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : null;

  return { phase: phase || 'all', total: scoped.length, byStatus, byType, avgConfidence };
}

export function toolGetBlockedItems() {
  const { items, connections } = loadVisionState();
  const itemMap = new Map(items.map(i => [i.id, i]));

  const blocked = [];
  for (const conn of connections) {
    if (conn.type === 'blocks') {
      const blocker = itemMap.get(conn.fromId);
      const target = itemMap.get(conn.toId);
      if (
        blocker && target &&
        blocker.status !== 'complete' &&
        blocker.status !== 'killed'
      ) {
        blocked.push({
          item: { id: target.id, title: target.title, status: target.status, phase: target.phase },
          blockedBy: { id: blocker.id, title: blocker.title, status: blocker.status },
        });
      }
    }
  }

  return { count: blocked.length, blocked };
}

export async function toolGetCurrentSession({ featureCode } = {}) {
  if (featureCode) {
    // Delegate to REST API for live session + lifecycle context
    try {
      const { body } = await _httpRequest('GET',
        `/api/session/current?featureCode=${encodeURIComponent(featureCode)}`);
      return typeof body === 'object' && body !== null ? body : { session: null };
    } catch {
      return { session: null };
    }
  }
  // Existing disk-read path (keep as-is)
  const sessions = loadSessions();
  if (sessions.length === 0) return { session: null };

  const last = sessions[sessions.length - 1];
  const allSummaries = [];
  for (const [, acc] of Object.entries(last.items || {})) {
    for (const s of acc.summaries || []) {
      if (s) allSummaries.push(typeof s === 'string' ? { summary: s } : s);
    }
  }

  return {
    session: {
      id: last.id,
      startedAt: last.startedAt,
      endedAt: last.endedAt ?? null,
      source: last.source,
      toolCount: last.toolCount,
      blockCount: (last.blocks || []).length,
      errorCount: (last.errors || []).length,
      itemCount: Object.keys(last.items || {}).length,
      recentSummaries: allSummaries.slice(-5),
    },
  };
}

// ---------------------------------------------------------------------------
// Roadmap writers — COMP-MCP-ROADMAP-WRITER
// Pure file-based mutations via lib/feature-writer.js. No HTTP delegation.
// ---------------------------------------------------------------------------

export async function toolAddRoadmapEntry(args) {
  assertForceAuthorized(args, 'add_roadmap_entry');
  assertTerminalStatusAuthorized(args, 'add_roadmap_entry');
  const { addRoadmapEntry } = await import('../lib/feature-writer.js');
  return addRoadmapEntry(getTargetRoot(), args);
}

export async function toolSetFeatureStatus(args) {
  assertForceAuthorized(args, 'set_feature_status');
  assertTerminalStatusAuthorized(args, 'set_feature_status');
  const { setFeatureStatus } = await import('../lib/feature-writer.js');
  return setFeatureStatus(getTargetRoot(), args);
}

export async function toolRoadmapDiff(args) {
  const { roadmapDiff } = await import('../lib/feature-writer.js');
  return roadmapDiff(getTargetRoot(), args);
}

export async function toolLinkArtifact(args) {
  const { linkArtifact } = await import('../lib/feature-writer.js');
  return linkArtifact(getTargetRoot(), args);
}

export async function toolLinkFeatures(args) {
  const { linkFeatures } = await import('../lib/feature-writer.js');
  return linkFeatures(getTargetRoot(), args);
}

export async function toolGetFeatureArtifacts(args) {
  const { getFeatureArtifacts } = await import('../lib/feature-writer.js');
  return getFeatureArtifacts(getTargetRoot(), args);
}

export async function toolGetFeatureLinks(args) {
  const { getFeatureLinks } = await import('../lib/feature-writer.js');
  return getFeatureLinks(getTargetRoot(), args);
}

// ---------------------------------------------------------------------------
// Follow-up filing — COMP-MCP-FOLLOWUP
// ---------------------------------------------------------------------------

export async function toolProposeFollowup(args) {
  // propose_followup also accepts a caller-supplied `status` and routes to
  // addRoadmapEntry — gate lifecycle-owned terminal statuses the same way.
  assertTerminalStatusAuthorized(args, 'propose_followup');
  const { proposeFollowup } = await import('../lib/followup-writer.js');
  return proposeFollowup(getTargetRoot(), args);
}

// ---------------------------------------------------------------------------
// Checkpoints / resume — COMP-RESUME
// ---------------------------------------------------------------------------

// write_checkpoint reads/writes directly from disk so it works even when the
// Compose server is down (same stance as the rest of this file).
export async function toolWriteCheckpoint(args) {
  const { writeCheckpoint } = await import('../lib/checkpoint/checkpoint-writer.js');
  return writeCheckpoint(getTargetRoot(), args);
}

// compose_resume HTTP-delegates: reconcile must run server-side where the live
// vision item / lifecycle state and broadcasts exist (mirrors toolBindSession).
export async function toolComposeResume({ featureCode }) {
  let result;
  try {
    result = await _httpRequest('POST', '/api/session/bind/reconcile', { featureCode });
  } catch (err) {
    throw new Error(`Compose server unreachable: ${err.message}`);
  }
  const { status, body } = result;
  if (status >= 400) {
    const errMsg = (body && typeof body === 'object' && body.error)
      ? body.error
      : `HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`;
    throw new Error(errMsg);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Changelog writer — COMP-MCP-CHANGELOG-WRITER
// ---------------------------------------------------------------------------

export async function toolAddChangelogEntry(args) {
  const { addChangelogEntry } = await import('../lib/changelog-writer.js');
  return addChangelogEntry(getTargetRoot(), args);
}

export async function toolGetChangelogEntries(args) {
  const { getChangelogEntries } = await import('../lib/changelog-writer.js');
  return getChangelogEntries(getTargetRoot(), args);
}

// ---------------------------------------------------------------------------
// Journal writer — COMP-MCP-JOURNAL-WRITER
// ---------------------------------------------------------------------------

export async function toolWriteJournalEntry(args) {
  const { writeJournalEntry } = await import('../lib/journal-writer.js');
  return writeJournalEntry(getTargetRoot(), args);
}

export async function toolGetJournalEntries(args) {
  const { getJournalEntries } = await import('../lib/journal-writer.js');
  return getJournalEntries(getTargetRoot(), args);
}

// ---------------------------------------------------------------------------
// Completion writer — COMP-MCP-COMPLETION
// ---------------------------------------------------------------------------

export async function toolRecordCompletion(args) {
  await assertCompletionEvidence(args);
  const { recordCompletion } = await import('../lib/completion-writer.js');
  return recordCompletion(getTargetRoot(), args);
}

export async function toolGetCompletions(args) {
  const { getCompletions } = await import('../lib/completion-writer.js');
  return getCompletions(getTargetRoot(), args);
}

export async function toolValidateFeature(args = {}) {
  const { validateFeature } = await import('../lib/feature-validator.js');
  const { feature_code, external_prefixes, feature_json_mode } = args;
  return validateFeature(getTargetRoot(), feature_code, {
    externalPrefixes: external_prefixes,
    featureJsonMode: feature_json_mode,
  });
}

export async function toolValidateProject(args = {}) {
  const { validateProject } = await import('../lib/feature-validator.js');
  const { external_prefixes, feature_json_mode, external, fix, apply, fix_classes } = args;
  const opts = {
    externalPrefixes: external_prefixes,
    featureJsonMode: feature_json_mode,
    external: external === true,
  };
  const result = await validateProject(getTargetRoot(), opts);
  if (!fix) return result;
  // COMP-MCP-VALIDATE-2: reconcile mechanical drift. Forwards the same validate
  // options so the fixer operates on the same context that was validated.
  const { reconcileProject } = await import('../lib/feature-reconciler.js');
  const reconcile = await reconcileProject(getTargetRoot(), {
    apply: apply === true,
    classes: fix_classes,
    featureJsonMode: feature_json_mode,
    externalPrefixes: external_prefixes,
    external: external === true,
  });
  // When fixes were applied, re-validate so the returned findings reflect the
  // post-fix state (closed loop).
  const finalResult = (apply === true && !reconcile.refused)
    ? await validateProject(getTargetRoot(), opts)
    : result;
  return { ...finalResult, reconcile };
}

// COMP-ROADMAP-GRAPH-1: generate / verify the roadmap dependency graph HTML.
// Returns small summaries only (counts + warning/dangling lists) — never the
// HTML body, which would blow the MCP response token cap.
export async function toolRoadmapGraph({ project, out } = {}) {
  const { generateRoadmapGraph } = await import('../lib/roadmap-graph/index.js');
  const cwd = project || getTargetRoot();
  try {
    const r = generateRoadmapGraph(cwd, { out });
    return {
      path: r.path,
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      droppedCount: r.droppedCount,
      warnings: r.warnings,
    };
  } catch (err) {
    if (err && err.code === 'DANGLING_EDGE') {
      const e = new Error(err.message);
      e.code = 'DANGLING_EDGE';
      e.dangling = err.dangling;
      throw e;
    }
    throw err;
  }
}

// COMP-ROADMAP-XREF-PUSH-2: programmatic push surface. Dry-run by default;
// only links with push:true are eligible. Returns the small summary, never a
// large body. apply:true performs the writes (github issue state/labels, local
// sibling status via the sibling's own setFeatureStatus).
export async function toolRoadmapXrefPush({ project, apply } = {}) {
  const { pushExternalRefs } = await import('../lib/xref-push.js');
  const cwd = project || getTargetRoot();
  return pushExternalRefs(cwd, { apply: apply === true });
}

export async function toolRoadmapGraphCheck({ project, out } = {}) {
  const { checkRoadmapGraph } = await import('../lib/roadmap-graph/index.js');
  const cwd = project || getTargetRoot();
  try {
    const r = checkRoadmapGraph(cwd, { out });
    return {
      matches: r.matches,
      exists: r.exists,
      path: r.path,
      diffSummary: r.diffSummary,
      nodeCount: r.nodeCount,
      edgeCount: r.edgeCount,
      warnings: r.warnings,
    };
  } catch (err) {
    if (err && err.code === 'DANGLING_EDGE') {
      const e = new Error(err.message);
      e.code = 'DANGLING_EDGE';
      e.dangling = err.dangling;
      throw e;
    }
    throw err;
  }
}

export async function toolBindSession({ featureCode, profile } = {}) {
  let result;
  try {
    result = await _httpRequest('POST', '/api/session/bind', { featureCode });
  } catch (err) {
    throw new Error(`Compose server unreachable: ${err.message}`);
  }
  const { status, body } = result;
  if (status >= 400) {
    const errMsg = (body && typeof body === 'object' && body.error)
      ? body.error
      : `HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`;
    throw new Error(errMsg);
  }
  // COMP-MCP-ENFORCE-1: record the bound feature (anchor for phase resolution)
  // on any non-error reply — including `already_bound` — so reconnects/repeat
  // binds keep the anchor. Use the server's AUTHORITATIVE featureCode from the
  // reply (an `already_bound` reply returns the real bound feature, which may
  // differ from the request arg) so the anchor never drifts. The trusted env
  // profile is the floor; the bind `profile` arg may only NARROW it.
  const boundCode = (body && typeof body === 'object' && body.featureCode) || featureCode;
  if (boundCode) _boundFeatureCode = boundCode;
  _sessionProfile = resolveProfile(process.env.COMPOSE_SESSION_PROFILE, profile);
  return body;
}

// ---------------------------------------------------------------------------
// Lifecycle tools — read from disk, mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

function _getComposeApi() {
  return `http://127.0.0.1:${resolvePort()}`;
}

async function _postLifecycle(itemId, action, body) {
  let result;
  try {
    result = await _httpRequest('POST', `/api/vision/items/${itemId}/lifecycle/${action}`, body);
  } catch (err) {
    throw new Error(`Compose server unreachable: ${err.message}`);
  }
  const { status, body: respBody } = result;
  if (status >= 400) {
    const errMsg = (respBody && typeof respBody === 'object' && respBody.error)
      ? respBody.error
      : `HTTP ${status}: ${typeof respBody === 'string' ? respBody : JSON.stringify(respBody)}`;
    throw new Error(errMsg);
  }
  return respBody;
}

async function _postGate(gateId, action, body) {
  let result;
  try {
    result = await _httpRequest('POST', `/api/vision/gates/${gateId}/${action}`, body);
  } catch (err) {
    throw new Error(`Compose server unreachable: ${err.message}`);
  }
  const { status, body: respBody } = result;
  if (status >= 400) {
    const errMsg = (respBody && typeof respBody === 'object' && respBody.error)
      ? respBody.error
      : `HTTP ${status}: ${typeof respBody === 'string' ? respBody : JSON.stringify(respBody)}`;
    throw new Error(errMsg);
  }
  return respBody;
}

/**
 * Centralized http.request wrapper for Compose REST calls from the MCP layer.
 * Injects X-Compose-Workspace-Id from the current session binding when set.
 * COMP-WORKSPACE-HTTP T5.
 */
async function _httpRequest(method, urlPath, body = null) {
  const port = resolvePort();
  const headers = { 'Content-Type': 'application/json' };
  if (_binding?.id) headers['X-Compose-Workspace-Id'] = _binding.id;
  let payload = null;
  if (body !== null && body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  const opts = { hostname: '127.0.0.1', port, path: urlPath, method, headers };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

export function toolGetFeatureLifecycle({ id }) {
  const { items } = loadVisionState();
  const item = items.find(i => i.id === id || i.semanticId === id || i.slug === id);
  if (!item) return { error: `Item not found: ${id}` };
  if (!item.lifecycle) return { error: 'No lifecycle on this item' };
  return item.lifecycle;
}

export async function toolKillFeature({ id, reason }) {
  return _postLifecycle(id, 'kill', { reason });
}

export async function toolCompleteFeature({ id, commit_sha, tests_pass, files_changed, notes }) {
  const body = {};
  if (commit_sha !== undefined) body.commit_sha = commit_sha;
  if (tests_pass !== undefined) body.tests_pass = tests_pass;
  if (files_changed !== undefined) body.files_changed = files_changed;
  if (notes !== undefined) body.notes = notes;
  return _postLifecycle(id, 'complete', body);
}

export async function toolIterationStart({ id, loopType, maxIterations }) {
  return _postLifecycle(id, 'iteration/start', { loopType, maxIterations });
}

export async function toolIterationReport({ id, result }) {
  return _postLifecycle(id, 'iteration/report', { result });
}

export async function toolIterationAbort({ id, reason }) {
  return _postLifecycle(id, 'iteration/abort', { reason });
}

// ---------------------------------------------------------------------------
// Artifact tools — read/write directly (no REST delegation needed)
// ---------------------------------------------------------------------------

export function toolAssessFeatureArtifacts({ featureCode }) {
  const featureRoot = resolveProjectPath('features');
  if (!fs.existsSync(featureRoot)) {
    // Return empty assessments — feature root hasn't been created yet
    const empty = {};
    for (const filename of Object.keys(ARTIFACT_SCHEMAS)) {
      empty[filename] = { exists: false, wordCount: 0, meetsMinWordCount: false, sections: { found: [], missing: [], optional: [] }, completeness: 0, lastModified: null };
    }
    return { artifacts: empty };
  }
  const manager = new ArtifactManager(featureRoot);
  return manager.assess(featureCode);
}

export function toolScaffoldFeature({ featureCode, only }) {
  const featureRoot = resolveProjectPath('features');
  const manager = new ArtifactManager(featureRoot);
  return manager.scaffold(featureCode, only ? { only } : undefined);
}

// ---------------------------------------------------------------------------
// Gate tools — mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

export async function toolApproveGate({ gateId, outcome, comment }) {
  return _postGate(gateId, 'resolve', { outcome, comment });
}

export function toolGetPendingGates({ itemId }) {
  const { gates } = loadVisionState();
  if (!gates) return { count: 0, gates: [] };
  const pending = gates.filter(g => g.status === 'pending' && (!itemId || g.itemId === itemId));
  return { count: pending.length, gates: pending };
}

// ---------------------------------------------------------------------------
// Workspace binding (MCP session-scoped)
// ---------------------------------------------------------------------------
//
// `_binding` is process-global by intent. Claude Code spawns ONE stdio MCP
// child per Claude session; the child's lifetime IS the session's lifetime.
// "Session-scoped" therefore equals "process-scoped" in this architecture.
// COMP-WORKSPACE-ID Decision 5 documents this. The HTTP server (port 4001)
// is the shared-across-sessions process, NOT this module — it gets the
// workspace per request via the X-Compose-Workspace-Id header instead.

let _binding = null;

export function toolSetWorkspace({ workspaceId }) {
  const resolved = resolveWorkspace({ workspaceId });
  switchProject(resolved.root);
  setCurrentWorkspaceId(resolved.id);
  _binding = resolved;
  return { id: resolved.id, root: resolved.root, source: 'mcp-binding' };
}

export function toolGetWorkspace() {
  const { candidates } = discoverWorkspaces(process.cwd());
  return { current: _binding, candidates };
}

export function _getBinding() { return _binding?.id ?? null; }

// ---------------------------------------------------------------------------
// COMP-MCP-ENFORCE-1 — phase-scoped MCP tool gate (profile × phase)
//
// Trusted profile = spawn-injected COMPOSE_SESSION_PROFILE (the agent cannot
// rewrite its own launch env); bind_session may only NARROW it. The bound
// feature anchor (_boundFeatureCode) lets the gate resolve the current phase
// on-disk and check that re-permitted mutations target the bound feature.
// All process-global by intent (one MCP child per session).
// ---------------------------------------------------------------------------

let _sessionProfile = resolveProfile(process.env.COMPOSE_SESSION_PROFILE, null);
let _boundFeatureCode = null;

export function _getSessionProfile() { return _sessionProfile; }
export function _getBoundFeatureCode() { return _boundFeatureCode; }
/** @internal test seam */
export function _testOnly_setSessionContext({ profile, boundFeatureCode } = {}) {
  if (profile !== undefined) _sessionProfile = profile;
  if (boundFeatureCode !== undefined) _boundFeatureCode = boundFeatureCode;
}

/** The bound feature's current lifecycle phase from vision-state.json, or null. */
export function resolveBoundPhase() {
  if (!_boundFeatureCode) return null;
  try {
    const { items } = loadVisionState();
    const item = items.find((i) => i.lifecycle?.featureCode === _boundFeatureCode);
    return item?.lifecycle?.currentPhase ?? null;
  } catch {
    return null;
  }
}

/** Resolve a gated tool's target to a feature code (for the feature-scoped re-permit check). */
function _resolveTargetFeatureCode(tool, args = {}) {
  try {
    if (tool === 'record_completion') return args.feature_code ?? null;
    if (tool === 'set_feature_status' || tool === 'add_roadmap_entry' || tool === 'propose_followup') {
      return args.code ?? null;
    }
    if (tool === 'complete_feature' || tool === 'kill_feature') {
      const { items } = loadVisionState();
      return items.find((i) => i.id === args.id)?.lifecycle?.featureCode ?? null;
    }
    if (tool === 'approve_gate') {
      const { items, gates } = loadVisionState();
      const gate = gates?.find((g) => g.id === args.gateId);
      return items.find((i) => i.id === gate?.itemId)?.lifecycle?.featureCode ?? null;
    }
  } catch { /* fall through */ }
  return null;
}

function _targetMatchesBoundFeature(tool, args) {
  if (!_boundFeatureCode) return false;
  const code = _resolveTargetFeatureCode(tool, args);
  return code !== null && code === _boundFeatureCode;
}

/**
 * Throw PHASE_TOOL_DENIED if the tool is not allowed for the current
 * profile×phase. No-op when the capability is off (default) or on a valid
 * override token. On unresolved CONTEXT the behavior is graduated, NOT blanket
 * fail-open: an unresolved PROFILE (no/unknown env) normalizes to orchestrator →
 * unrestricted; an unresolved PHASE only fails open the phase *refinement* — the
 * profile BASE policy (implementer deny / reviewer allowlist) still applies
 * (a restricted context with unknown phase stays restricted, which is the safe
 * reading). `_testCtx` lets tests drive flag/profile/phase/target without disk/env.
 */
export function assertToolPhaseAllowed(tool, args = {}, _testCtx) {
  const guardOn = _testCtx?.phaseScopedTools ?? (loadProjectConfig()?.capabilities?.phaseScopedTools === true);
  if (!guardOn) return;
  if (_overrideOk(args)) return;

  const profile = _testCtx?.profile ?? _sessionProfile;
  const phase = _testCtx?.phase ?? resolveBoundPhase();
  const targetMatchesBoundFeature = _testCtx?.targetMatches ?? _targetMatchesBoundFeature(tool, args);

  const verdict = isToolAllowed({ tool, profile, phase, targetMatchesBoundFeature });
  if (!verdict.allowed) {
    const e = new Error(
      `${tool} is not available to profile '${profile}'` +
      (phase ? ` in phase '${phase}'` : '') + `: ${verdict.reason}. ` +
      `Supply a valid override_token to deviate.`,
    );
    e.code = 'PHASE_TOOL_DENIED';
    e.profile = profile;
    e.phase = phase;
    throw e;
  }
}

