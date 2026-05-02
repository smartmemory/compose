/**
 * feature-writer.js — typed writers for ROADMAP / feature.json mutations.
 *
 * First sub-ticket of COMP-MCP-FEATURE-MGMT (COMP-MCP-ROADMAP-WRITER).
 *
 * Three operations:
 *   addRoadmapEntry(cwd, args)  — register a new feature, regenerate ROADMAP
 *   setFeatureStatus(cwd, args) — flip status with transition policy enforcement
 *   roadmapDiff(cwd, args)      — read the audit log for a window
 *
 * All writes go through feature.json (canonical) + writeRoadmap()
 * (regenerates ROADMAP.md). Mutations append to the feature-events.jsonl
 * audit log. Idempotency keys protect against retries.
 *
 * No HTTP, no transport awareness — pure data + IO so the same writers can
 * be called from MCP tools, the CLI, or future REST routes.
 */

import { readFeature, writeFeature, listFeatures, updateFeature } from './feature-json.js';
// eslint-disable-next-line no-unused-vars
const _listFeatures = listFeatures;
import { writeRoadmap } from './roadmap-gen.js';
import { appendEvent, readEvents } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';

// ---------------------------------------------------------------------------
// Status / transition policy
// ---------------------------------------------------------------------------

const STATUSES = new Set([
  'PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE',
  'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED',
]);

// COMPLETE -> SUPERSEDED is force-only (per design Decision 6); not in the
// normal transitions list. Force flag bypasses the policy and is recorded in
// audit.
const TRANSITIONS = {
  PLANNED:     ['IN_PROGRESS', 'KILLED', 'PARKED'],
  IN_PROGRESS: ['PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED'],
  PARTIAL:     ['IN_PROGRESS', 'COMPLETE', 'KILLED'],
  COMPLETE:    [],
  BLOCKED:     ['IN_PROGRESS', 'KILLED', 'PARKED'],
  PARKED:      ['PLANNED', 'KILLED'],
  KILLED:      [],
  SUPERSEDED:  [],
};

const COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FEATURE_CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;

function validateCode(code) {
  if (typeof code !== 'string' || !FEATURE_CODE_RE.test(code)) {
    throw new Error(`feature-writer: invalid feature code "${code}" — must match ${FEATURE_CODE_RE}`);
  }
}

function maybeIdempotent(args, fn) {
  if (args.idempotency_key) {
    return checkOrInsert(args.cwd, args.idempotency_key, fn).then(({ result }) => result);
  }
  return Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------------
// addRoadmapEntry
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.description
 * @param {string} args.phase
 * @param {string} [args.complexity]
 * @param {string} [args.status]
 * @param {number} [args.position]
 * @param {string} [args.parent]
 * @param {string[]} [args.tags]
 * @param {string} [args.idempotency_key]
 */
export async function addRoadmapEntry(cwd, args) {
  validateCode(args.code);
  if (!args.description) throw new Error('feature-writer: description is required');
  if (!args.phase) throw new Error('feature-writer: phase is required');
  if (args.complexity && !COMPLEXITIES.has(args.complexity)) {
    throw new Error(`feature-writer: invalid complexity "${args.complexity}"`);
  }
  const status = args.status ?? 'PLANNED';
  if (!STATUSES.has(status)) {
    throw new Error(`feature-writer: invalid status "${status}"`);
  }

  return maybeIdempotent({ ...args, cwd }, () => {
    const existing = readFeature(cwd, args.code);
    if (existing) {
      throw new Error(`feature-writer: feature "${args.code}" already exists`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const feature = {
      code: args.code,
      description: args.description,
      status,
      phase: args.phase,
      created: today,
      updated: today,
    };
    if (args.complexity) feature.complexity = args.complexity;
    feature.position = args.position !== undefined
      ? args.position
      : nextPositionInPhase(cwd, args.phase);
    if (args.parent) feature.parent = args.parent;
    if (args.tags && args.tags.length) feature.tags = args.tags;

    writeFeature(cwd, feature);
    const roadmapPath = writeRoadmap(cwd);

    safeAppendEvent(cwd, {
      tool: 'add_roadmap_entry',
      code: args.code,
      to: status,
      phase: args.phase,
      idempotency_key: args.idempotency_key,
    });

    return {
      code: args.code,
      phase: args.phase,
      position: feature.position,
      roadmap_path: roadmapPath,
    };
  });
}

// Default position for a new feature: max existing position in the same
// phase, plus 1. Falls back to 1 when the phase is empty.
function nextPositionInPhase(cwd, phase) {
  const peers = _listFeatures(cwd).filter(f => f.phase === phase);
  if (peers.length === 0) return 1;
  const maxPos = peers.reduce((m, f) => {
    const p = typeof f.position === 'number' ? f.position : 0;
    return p > m ? p : m;
  }, 0);
  return maxPos + 1;
}

// Audit-log writes are best-effort: a failed append must NOT roll back a
// committed mutation (per design Decision 2 and docs/mcp.md). Log a warning
// and continue.
function safeAppendEvent(cwd, event) {
  try {
    appendEvent(cwd, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[feature-writer] audit append failed for ${event.tool} ${event.code ?? ''}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// setFeatureStatus
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.status
 * @param {string} [args.reason]
 * @param {string} [args.commit_sha]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 */
export async function setFeatureStatus(cwd, args) {
  validateCode(args.code);
  if (!STATUSES.has(args.status)) {
    throw new Error(`feature-writer: invalid status "${args.status}" — must be one of ${[...STATUSES].join(', ')}`);
  }

  return maybeIdempotent({ ...args, cwd }, () => {
    const feature = readFeature(cwd, args.code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.code}" not found`);
    }

    const from = feature.status;
    const to = args.status;

    if (from === to) {
      return { code: args.code, from, to, ts: new Date().toISOString(), noop: true };
    }

    const allowed = TRANSITIONS[from] ?? [];
    if (!allowed.includes(to) && !args.force) {
      throw new Error(
        `feature-writer: invalid transition for ${args.code}: ${from} → ${to}. ` +
        `Allowed from ${from}: [${allowed.join(', ') || 'none'}]. ` +
        `Pass force: true to override.`
      );
    }

    const updates = { status: to };
    if (args.commit_sha) updates.commit_sha = args.commit_sha;
    updateFeature(cwd, args.code, updates);
    writeRoadmap(cwd);

    const event = {
      tool: 'set_feature_status',
      code: args.code,
      from,
      to,
      idempotency_key: args.idempotency_key,
    };
    if (args.reason) event.reason = args.reason;
    if (args.commit_sha) event.commit_sha = args.commit_sha;
    if (args.force && !allowed.includes(to)) event.forced = true;
    safeAppendEvent(cwd, event);

    return { code: args.code, from, to, ts: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// roadmapDiff
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} [args]
 * @param {string|number|Date} [args.since='24h']
 * @param {string} [args.feature_code]
 * @param {string} [args.tool]
 */
export function roadmapDiff(cwd, args = {}) {
  const since = args.since ?? '24h';
  const events = readEvents(cwd, {
    since,
    code: args.feature_code,
    tool: args.tool,
  });

  const added = [];
  const status_changed = [];
  for (const e of events) {
    if (e.tool === 'add_roadmap_entry' && e.code) {
      added.push(e.code);
    }
    if (e.tool === 'set_feature_status' && e.code && e.from !== e.to) {
      status_changed.push({ code: e.code, from: e.from, to: e.to });
    }
  }

  return { events, added, status_changed };
}

// ---------------------------------------------------------------------------
// Exports for tests / introspection
// ---------------------------------------------------------------------------

export const _internals = { TRANSITIONS, STATUSES, COMPLEXITIES };
