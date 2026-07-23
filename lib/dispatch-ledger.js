/**
 * dispatch-ledger.js — closed, append-only telemetry events for agent dispatch.
 *
 * Ledger rows are addressed by an explicit project root so callers running in a
 * worktree cannot accidentally split telemetry away from the build project.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { normalizeSince } from './feature-events.js';

export const DISPATCH_LEDGER_RELATIVE_PATH = '.compose/data/dispatch-ledger.jsonl';

export const DISPATCH_SITES = Object.freeze([
  'build-step', 'consumer', 'review', 'review-repair', 'gsd', 'gate-qa',
  'escalation', 'preflight', 'judge', 'design-chat', 'import', 'validation',
  'new-project', 'unattributed',
]);
export const DISPATCH_OUTCOMES = Object.freeze(['ok', 'error', 'blocked']);
export const SETTLEMENT_FAILURE_CLASSES = Object.freeze([
  'ownership', 'vocabulary', 'normalization', 'agent', 'ensure-retry',
]);
export const ESTIMATE_LANES = Object.freeze(['trivial', 'standard', 'complex']);
export const ESTIMATE_SOURCES = Object.freeze(['fresh', 'cached', 'escalated']);
export const TRIAGE_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const BUILD_TERMINAL_STATUSES = Object.freeze(['complete', 'failed', 'aborted']);
export const BUILD_FILES_SOURCES = Object.freeze(['ship', 'accumulated']);

const EVENT_FIELDS = {
  dispatch: {
    required: ['dispatch_id', 'site', 'agent', 'outcome'],
    optional: [
      'build_id', 'feature_code', 'step_id', 'attempt', 'model',
      'effort_intended', 'effort_executed', 'tokens_in', 'tokens_out',
      'tokens_total', 'usd', 'duration_ms', 'note',
    ],
  },
  settlement: {
    required: ['dispatch_id', 'accepted'],
    optional: ['build_id', 'step_id', 'failure_class'],
  },
  'triage-estimate': {
    required: ['build_id', 'feature_code', 'tier', 'lane', 'profile', 'estimate_source'],
    optional: ['confidence'],
  },
  'build-actuals': {
    required: [
      'build_id', 'feature_code', 'terminal_status', 'files_changed_count',
      'files_source', 'review_iterations', 'escalations', 'tokens_total', 'usd',
    ],
    optional: ['test_count', 'pass_rate'],
  },
};

const countersByPath = new Map();

function ledgerPath(projectCwd) {
  return resolve(projectCwd, DISPATCH_LEDGER_RELATIVE_PATH);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value) {
  return value === null || isFiniteNumber(value);
}

function isNullableString(value) {
  return value === null || isString(value);
}

function isEnum(value, values) {
  return values.includes(value);
}

function invalid(message) {
  throw new Error(`dispatch-ledger.appendEvent: ${message}`);
}

function validateEvent(event, { allowExtra = false } = {}) {
  if (!isPlainObject(event)) invalid('event must be an object');
  if (!isString(event.kind)) invalid('kind is required');
  const shape = EVENT_FIELDS[event.kind];
  if (!shape) invalid(`unknown kind "${event.kind}"`);

  const allowed = new Set(['kind', ...shape.required, ...shape.optional]);
  if (!allowExtra) {
    for (const field of Object.keys(event)) {
      if (!allowed.has(field)) invalid(`unknown field "${field}" for ${event.kind}`);
    }
  }
  for (const field of shape.required) {
    if (!Object.hasOwn(event, field) || event[field] === undefined) {
      invalid(`required field "${field}" is missing for ${event.kind}`);
    }
  }

  switch (event.kind) {
    case 'dispatch':
      requireString(event, 'dispatch_id');
      requireEnum(event, 'site', DISPATCH_SITES);
      requireString(event, 'agent');
      requireEnum(event, 'outcome', DISPATCH_OUTCOMES);
      optionalString(event, 'build_id');
      optionalString(event, 'feature_code');
      optionalString(event, 'step_id');
      optionalNumber(event, 'attempt');
      optionalNullableString(event, 'model');
      optionalNullableString(event, 'effort_intended');
      optionalNullableString(event, 'effort_executed');
      for (const field of ['tokens_in', 'tokens_out', 'tokens_total', 'usd', 'duration_ms']) {
        optionalNullableNumber(event, field);
      }
      optionalString(event, 'note');
      break;
    case 'settlement':
      requireString(event, 'dispatch_id');
      if (typeof event.accepted !== 'boolean') invalid('accepted must be a boolean');
      optionalString(event, 'build_id');
      optionalString(event, 'step_id');
      optionalEnum(event, 'failure_class', SETTLEMENT_FAILURE_CLASSES);
      break;
    case 'triage-estimate':
      requireString(event, 'build_id');
      requireString(event, 'feature_code');
      if (!Number.isInteger(event.tier) || event.tier < 0 || event.tier > 4) {
        invalid('tier must be an integer 0-4');
      }
      requireEnum(event, 'lane', ESTIMATE_LANES);
      if (!isPlainObject(event.profile)) invalid('profile must be a non-array object');
      requireEnum(event, 'estimate_source', ESTIMATE_SOURCES);
      if (Object.hasOwn(event, 'confidence') && event.confidence !== null && !isEnum(event.confidence, TRIAGE_CONFIDENCES)) {
        invalid(`confidence must be one of ${TRIAGE_CONFIDENCES.join(', ')} or null`);
      }
      break;
    case 'build-actuals':
      requireString(event, 'build_id');
      requireString(event, 'feature_code');
      requireEnum(event, 'terminal_status', BUILD_TERMINAL_STATUSES);
      requireNumber(event, 'files_changed_count');
      requireEnum(event, 'files_source', BUILD_FILES_SOURCES);
      requireNumber(event, 'review_iterations');
      requireNumber(event, 'escalations');
      requireNumber(event, 'tokens_total');
      requireNumber(event, 'usd');
      optionalNullableNumber(event, 'test_count');
      optionalNullableNumber(event, 'pass_rate');
      break;
  }
}

function requireString(event, field) {
  if (!isString(event[field])) invalid(`${field} must be a non-empty string`);
}

function requireNumber(event, field) {
  if (!isFiniteNumber(event[field])) invalid(`${field} must be a number`);
}

function requireEnum(event, field, values) {
  if (!isEnum(event[field], values)) invalid(`${field} must be one of ${values.join(', ')}`);
}

function optionalString(event, field) {
  if (Object.hasOwn(event, field) && !isString(event[field])) invalid(`${field} must be a non-empty string`);
}

function optionalNullableString(event, field) {
  if (Object.hasOwn(event, field) && !isNullableString(event[field])) invalid(`${field} must be a string or null`);
}

function optionalNumber(event, field) {
  if (Object.hasOwn(event, field) && !isFiniteNumber(event[field])) invalid(`${field} must be a number`);
}

function optionalNullableNumber(event, field) {
  if (Object.hasOwn(event, field) && !isNullableFiniteNumber(event[field])) invalid(`${field} must be a number or null`);
}

function optionalEnum(event, field, values) {
  if (Object.hasOwn(event, field) && !isEnum(event[field], values)) {
    invalid(`${field} must be one of ${values.join(', ')}`);
  }
}

function isValidStoredRow(row) {
  if (!isPlainObject(row) || row.v !== 1 || !isIsoTimestamp(row.ts) || !Number.isInteger(row._seq) || row._seq < 0) {
    return false;
  }
  try {
    validateEvent(row, { allowExtra: true });
    return true;
  } catch {
    return false;
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function seedCounter(path) {
  if (countersByPath.has(path)) return countersByPath.get(path);
  let highest = 0;
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (isValidStoredRow(row)) highest = Math.max(highest, row._seq);
      } catch {
        // A torn JSONL row must not prevent later rows from being read.
      }
    }
  }
  countersByPath.set(path, highest);
  return highest;
}

/**
 * Append one closed dispatch-ledger event, stamping its immutable envelope.
 *
 * @param {string} projectCwd
 * @param {object} event caller-supplied kind and closed payload only
 * @returns {object} the row written to disk
 */
export function appendEvent(projectCwd, event) {
  validateEvent(event);
  const path = ledgerPath(projectCwd);
  const nextSeq = seedCounter(path) + 1;
  countersByPath.set(path, nextSeq);
  const row = { v: 1, ts: new Date().toISOString(), _seq: nextSeq, ...event };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n');
  return row;
}

/**
 * Tolerantly read valid, known ledger rows. Future fields are preserved.
 *
 * @param {string} projectCwd
 * @param {object} [opts]
 * @param {string} [opts.kind]
 * @param {string|number|Date} [opts.since]
 * @param {string} [opts.feature]
 * @returns {Array<object>}
 */
export function readEvents(projectCwd, { kind, since, feature } = {}) {
  const path = ledgerPath(projectCwd);
  if (!existsSync(path)) return [];
  const sinceMs = normalizeSince(since);
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!isValidStoredRow(row)) continue;
      if (kind && row.kind !== kind) continue;
      if (feature && row.feature_code !== feature) continue;
      if (sinceMs !== null && Date.parse(row.ts) < sinceMs) continue;
      rows.push(row);
    } catch {
      // Malformed rows are expected in an append-only JSONL file after a tear.
    }
  }
  return rows;
}
