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
import { getTargetRoot, getDataDir, resolveProjectPath, switchProject, setCurrentWorkspaceId } from './project-root.js';
import { resolveWorkspace } from '../lib/resolve-workspace.js';
import { discoverWorkspaces } from '../lib/discover-workspaces.js';

export function getVisionFile() { return path.join(getDataDir(), 'vision-state.json'); }
export function getSessionsFile() { return path.join(getDataDir(), 'sessions.json'); }

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export function loadVisionState() {
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
  const { addRoadmapEntry } = await import('../lib/feature-writer.js');
  return addRoadmapEntry(getTargetRoot(), args);
}

export async function toolSetFeatureStatus(args) {
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
  const { proposeFollowup } = await import('../lib/followup-writer.js');
  return proposeFollowup(getTargetRoot(), args);
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
  const { external_prefixes, feature_json_mode } = args;
  return validateProject(getTargetRoot(), {
    externalPrefixes: external_prefixes,
    featureJsonMode: feature_json_mode,
  });
}

export async function toolBindSession({ featureCode }) {
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
  return body;
}

// ---------------------------------------------------------------------------
// Lifecycle tools — read from disk, mutations delegate to Compose REST API
// ---------------------------------------------------------------------------

function _getComposeApi() {
  return `http://127.0.0.1:${process.env.COMPOSE_PORT || process.env.PORT || 3001}`;
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
  const port = process.env.COMPOSE_PORT || process.env.PORT || 3001;
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

