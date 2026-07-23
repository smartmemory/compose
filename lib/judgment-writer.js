/**
 * lib/judgment-writer.js — the typed writer for judgment canon (S05).
 *
 * The six operations of design Decision 4, transport-free `(cwd, args)`
 * (journal-writer template): position create/amend, joint add, transition,
 * ledger append, and the read op. All writes:
 *   - validate synchronously BEFORE the idempotency wrapper (feature-writer
 *     ordering);
 *   - run under the judgment advisory lock (`.compose/data/judgment.lock`,
 *     journal-writer recipe: mkdir lock, stale recovery, bounded retry);
 *   - replay pending intents first (the reconciler runs on every write and
 *     on getJudgmentState);
 *   - stamp provenance themselves — no caller can set any provenance field;
 *   - regenerate projections, with compensating rollback on failure
 *     (`JUDGMENT_PARTIAL_WRITE` carries the cause);
 *   - append a best-effort audit event AFTER commit (feature-events);
 *   - return small typed results (AUDIT-19), errors carrying `code`/`cause`.
 *
 * Transitions are intent-first (design D4, rounds 2–3): the COMPLETE
 * mutation (joint + atomic ledger events + spawned predictions) is persisted
 * as a pending-intent record BEFORE the guard call; on a verdict it is
 * applied and the intent cleared; the reconciler replays incomplete intents
 * idempotently — guard state authoritative for the edge, the intent
 * authoritative for the payload. Where `capabilities.guard` is true the
 * Stratum guard (via the untouched `guardedTransition` adapter, mode
 * 'judgment' — a data-only LIFECYCLE_MODES entry) is the single lifecycle
 * authority; where absent, the write-guard's identical edge table enforces
 * (graph parity is contract-tested).
 *
 * ONE-UNDER-TEST is enforced writer-locally inside the advisory lock (the
 * floor). Guard-predicate expressibility: STRAT-GUARD edge predicates are
 * per-resource deterministic file checks (`server_file_exists`); a
 * population invariant across joints is not expressible today — probed
 * against the predicate surface in lifecycle-guard.js (edgePredicates’
 * `deterministic` statements), noted in the implementation report, and the
 * upstream population-invariant ask is filed in Stratum's tracker either way.
 */
import {
  readFileSync, writeFileSync, renameSync, unlinkSync,
  mkdirSync, rmSync, statSync, existsSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

import { checkOrInsert } from './idempotency.js';
import { appendEvent } from './feature-events.js';
import {
  createJudgmentStore,
  effectiveStore,
  goalCutoverComplete,
} from './judgment/store/index.js';
import { regenerateProjections } from './judgment-gen.js';
import { getJudgmentValidator } from './judgment/schema.js';
import {
  assertValidRecord,
  assertGrounding,
  assertEdgeArtifact,
  assertMethodGate,
} from './judgment-write-guard.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function typedError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// Advisory lock (journal-writer recipe: mkdir lock + stale recovery)
// ---------------------------------------------------------------------------

// A judgment critical section can legitimately span a guard subprocess call
// (Stratum client timeout: 10s), so unlike the journal recipe the lock is
// HEARTBEATED: the holder refreshes the dir mtime every second, and only a
// lock whose heartbeat has stopped for LOCK_STALE_MS is stealable. An owner
// token inside the dir makes release/steal safe against the ABA case (my
// stale lock was stolen; I must not delete the thief's lock on release).
// The heartbeat runs on the event loop, so a SYNCHRONOUS block longer than
// LOCK_STALE_MS would defeat it — the threshold is therefore set well above
// any sync section this codebase can produce (sync work here is small-file
// fs I/O; the long operations — guard subprocess calls — are async and keep
// the loop free). 20s of contiguous sync blocking is the documented bound.
const LOCK_STALE_MS = 20000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30000;
const LOCK_HEARTBEAT_MS = 1000;
const LOCK_RETRY_MS = 25;

function judgmentLockPath(cwd) {
  return join(cwd, '.compose', 'data', 'judgment.lock');
}

async function acquireJudgmentLock(cwd) {
  const path = judgmentLockPath(cwd);
  const ownerFile = join(path, 'owner');
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(path);
      writeFileSync(ownerFile, token);
      const heartbeat = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch { /* lock stolen/gone — release will no-op */ }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return () => {
        clearInterval(heartbeat);
        try {
          if (readFileSync(ownerFile, 'utf8') === token) rmSync(path, { recursive: true, force: true });
        } catch { /* not ours anymore — leave it */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const { mtimeMs } = statSync(path);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; loop and retry */ }
      if (Date.now() - start > LOCK_ACQUIRE_TIMEOUT_MS) {
        throw typedError('JUDGMENT_LOCK_TIMEOUT', `judgment-writer lock timeout after ${LOCK_ACQUIRE_TIMEOUT_MS}ms: ${path}`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Provenance + config
// ---------------------------------------------------------------------------

/**
 * Writer-stamped provenance. `session` is best-effort diagnostic garnish
 * (cross-process MCP reality — nothing may depend on it); the load-bearing
 * stamps are `actor` and `written_at`. `via`/`writtenAt` are INTERNAL opts
 * for the importer only — never reachable through the MCP surface.
 */
function stampProvenance(internal = {}) {
  const provenance = {
    actor: 'agent',
    session: process.env.CLAUDE_SESSION_ID || null,
    written_at: internal.writtenAt ?? new Date().toISOString(),
  };
  if (internal.via) provenance.via = internal.via;
  if (internal.intentId) provenance.intent_id = internal.intentId;
  return provenance;
}

function guardEnabled(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf8'));
    return config?.capabilities?.guard === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compensating rollback
// ---------------------------------------------------------------------------

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

class UndoLog {
  constructor() {
    this._entries = [];
    this._paths = new Set();
  }

  /** Capture a mutable file's exact preimage before its first overwrite. */
  capture(path) {
    if (this._paths.has(path)) return;
    this._paths.add(path);
    this._entries.push({ path, prior: existsSync(path) ? readFileSync(path, 'utf8') : null });
  }

  /** Mark a newly created file so compensation removes it. */
  created(path) {
    if (this._paths.has(path)) return;
    this._paths.add(path);
    this._entries.push({ path, prior: null });
  }

  restore() {
    for (const { path, prior } of [...this._entries].reverse()) {
      try {
        if (prior === null) { try { unlinkSync(path); } catch { /* gone */ } } else atomicWrite(path, prior);
      } catch { /* best-effort compensation */ }
    }
  }
}

/**
 * Run record mutations + projection regen with compensating rollback: on any
 * failure the touched records are restored, projections re-regenerated from
 * the restored records, and JUDGMENT_PARTIAL_WRITE surfaces the cause.
 */
function commitWithProjections(cwd, undo, mutate) {
  try {
    mutate();
    regenerateProjections(cwd);
  } catch (err) {
    undo.restore();
    try { regenerateProjections(cwd); } catch { /* projections follow restored records on next regen */ }
    throw typedError('JUDGMENT_PARTIAL_WRITE', `judgment write rolled back: ${err.message}`, err);
  }
}

// ---------------------------------------------------------------------------
// Intent replay (the reconciler)
// ---------------------------------------------------------------------------

let _intentCounter = 0;
function newIntentId() {
  _intentCounter += 1;
  return `intent-${Date.now()}-${process.pid}-${_intentCounter}`;
}

async function callGuard(cwd, { slug, from, to }) {
  // Lazy import: keeps this module leaf-light and cycle-free; the adapter is
  // only loaded where capabilities.guard is on.
  const { guardedTransition } = await import('../server/lifecycle-guard.js');
  return guardedTransition({ featureCode: slug, from, to, workspaceRoot: cwd, mode: 'judgment' });
}

/** Apply an intent payload idempotently (joint write, deduped events, predictions). */
function applyPayload(store, payload) {
  if (payload.joint) store.writeJoint(payload.joint);
  if (Array.isArray(payload.events) && payload.events.length > 0) {
    const existing = new Set(store.readLedgerEvents().map((e) => JSON.stringify(e)));
    for (const event of payload.events) {
      const serialized = JSON.stringify(event);
      if (!existing.has(serialized)) {
        store.appendLedgerEvent(event);
        existing.add(serialized);
      }
    }
  }
  for (const prediction of payload.predictions ?? []) {
    const existing = store.readPrediction(prediction.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(prediction)) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `intent prediction ${prediction.id} conflicts with an existing record`,
      );
    }
    if (!existing) store.writePrediction(prediction);
  }
}

/**
 * Drop an intent DURABLY: the ledger note lands (idempotent on its title,
 * which embeds the intent id) BEFORE the intent is cleared. If the append
 * fails the intent survives and the error propagates — a dropped divergence
 * must never silently vanish.
 */
function dropIntentDurably(store, intent, reason, detail) {
  const payload = intent.payload ?? {};
  const title = `intent dropped (${intent.id}): ${payload.slug} ${payload.from} → ${payload.to} — ${reason}`;
  const already = store.readLedgerEvents().some((e) => e.kind === 'note' && e.title === title);
  if (!already) {
    store.appendLedgerEvent({
      kind: 'note',
      title,
      body: JSON.stringify(detail),
      anchor: `joint:${payload.slug}`,
      provenance: stampProvenance(),
    });
  }
  store.clearIntent(intent.id);
}

const RESERVED_INTENT_KINDS = new Set(['goal_migration', 'package_transition']);

function intentAttributedRecord(record, intentId) {
  return {
    ...record,
    provenance: {
      ...(record?.provenance ?? stampProvenance()),
      intent_id: intentId,
    },
  };
}

function attributedTransitionPayload(intent) {
  const payload = intent.payload ?? {};
  return {
    ...payload,
    events: (payload.events ?? []).map(
      (event) => intentAttributedRecord(event, intent.id),
    ),
    predictions: (payload.predictions ?? []).map(
      (prediction) => intentAttributedRecord(prediction, intent.id),
    ),
  };
}

/**
 * The only registered S4 intent applier. Payload shape never selects this
 * handler; the dispatcher selects it exclusively from `intent.kind`.
 */
async function applyTransitionIntent(cwd, store, intent, { undo, unpublishedUndo }) {
  const payload = attributedTransitionPayload(intent);

  // Population invariant FIRST — before any guard call, so recovery can
  // never advance the authoritative guard for an intent it is about to drop.
  if (payload.to === 'under_test') {
    const occupant = store.listJoints().find(
      (joint) => joint.slug !== payload.slug && joint.state === 'under_test',
    );
    if (occupant) {
      return {
        status: 'refused',
        reason: `ONE-UNDER-TEST refused on replay (${occupant.slug} already under test)`,
        detail: { occupant: occupant.slug },
        divergence: {
          intent: intent.id,
          slug: payload.slug,
          refused: true,
          oneUnderTest: occupant.slug,
        },
      };
    }
  }

  let guardInfo = null;
  if (guardEnabled(cwd) && payload.to && payload.from !== payload.to) {
    const guard = await callGuard(cwd, {
      slug: payload.slug,
      from: payload.from,
      to: payload.to,
    });
    if (!guard.applied) {
      if (guard.error) {
        return {
          status: 'blocked',
          reason: 'guard_unavailable',
          error: guard.error,
        };
      }
      const alreadyAdvanced = guard.currentState === payload.to;
      if (!alreadyAdvanced) {
        if (!guard.refused) {
          return {
            status: 'blocked',
            reason: 'ambiguous_guard_verdict',
          };
        }
        return {
          status: 'refused',
          reason: 'refused by guard',
          detail: {
            verdict: guard.verdict ?? null,
            currentState: guard.currentState ?? null,
          },
          divergence: {
            intent: intent.id,
            slug: payload.slug,
            refused: true,
            verdict: guard.verdict ?? null,
          },
          guard: {
            verdict: guard.verdict ?? null,
            ledgerRef: guard.ledgerRef ?? null,
            currentState: guard.currentState ?? null,
          },
        };
      }
    }
    guardInfo = {
      verdict: guard.verdict ?? null,
      ledgerRef: guard.ledgerRef ?? null,
      currentState: guard.currentState ?? null,
    };
  }

  if (payload.joint) {
    const path = store._jointPath(payload.joint.slug);
    undo.capture(path);
    unpublishedUndo.capture(path);
  }
  if ((payload.events?.length ?? 0) > 0) undo.capture(store._ledgerPath());
  for (const prediction of payload.predictions ?? []) {
    const path = store._predictionPath(prediction.id);
    if (existsSync(path)) undo.capture(path);
    else undo.created(path);
  }
  applyPayload(store, payload);
  return { status: 'applied', guard: guardInfo };
}

/**
 * Typed replay dispatch. Future payloads cannot impersonate a transition:
 * only the registered `transition` kind reaches the transition handler.
 */
export const INTENT_APPLIERS = Object.freeze({
  transition: applyTransitionIntent,
});

function appendIntentAttestation(store, intent) {
  const matches = store.readLedgerEvents().filter(
    (event) => event.kind === 'attest' && event.intent_id === intent.id,
  );
  const mismatch = matches.find(
    (event) => event.tool !== intent.tool || event.op !== intent.op,
  );
  if (mismatch) {
    throw typedError(
      'JUDGMENT_CONFLICT',
      `intent ${intent.id} attestation attribution conflicts: expected ${intent.tool}/${intent.op}, found ${mismatch.tool}/${mismatch.op}`,
    );
  }
  if (matches.length > 0) return { appended: false };

  const event = {
    kind: 'attest',
    title: `intent published: ${intent.id}`,
    intent_id: intent.id,
    tool: intent.tool,
    op: intent.op,
    provenance: stampProvenance({ intentId: intent.id }),
  };
  assertValidRecord('ledger_event', event);
  store.appendLedgerEvent(event);
  return { appended: true };
}

function intentPartialError(intent, stage, err) {
  if (err?.code?.startsWith?.('JUDGMENT_')) return err;
  return typedError(
    'JUDGMENT_PARTIAL_WRITE',
    `intent ${intent.id} ${stage} failed before publication; intent retained: ${err.message}`,
    err,
  );
}

/**
 * Single inline + replay success path.
 *
 * Publication order is binding: idempotent apply → durable attestation →
 * durable clear (the publication point) → projection regeneration.
 */
export async function publishIntentLocked(cwd, store, intent) {
  const applier = INTENT_APPLIERS[intent.kind];
  if (!applier) {
    if (RESERVED_INTENT_KINDS.has(intent.kind)) {
      return {
        status: 'blocked',
        reason: 'reserved_intent_kind',
        kind: intent.kind,
      };
    }
    throw typedError(
      'JUDGMENT_INTENT_KIND',
      `intent ${intent.id} kind "${intent.kind}" is unregistered and was retained`,
    );
  }

  const undo = new UndoLog();
  const unpublishedUndo = new UndoLog();
  let applied;
  try {
    applied = await applier(cwd, store, intent, { undo, unpublishedUndo });
  } catch (err) {
    undo.restore();
    throw intentPartialError(intent, 'apply', err);
  }

  if (applied.status === 'blocked') return applied;
  if (applied.status === 'refused') {
    dropIntentDurably(store, intent, applied.reason, applied.detail);
    regenerateProjections(cwd);
    return applied;
  }

  // Capture the ledger preimage even when the payload carried no events:
  // attestation append is part of the pre-publication undo window.
  undo.capture(store._ledgerPath());
  try {
    appendIntentAttestation(store, intent);
  } catch (err) {
    undo.restore();
    throw intentPartialError(intent, 'attestation append', err);
  }

  try {
    store.clearIntent(intent.id);
  } catch (err) {
    // New intent-attributed ledger lines/predictions stay hidden and are
    // deduped on retry. Existing in-place records have no effective preimage,
    // so restore those until durable clear succeeds.
    unpublishedUndo.restore();
    throw typedError(
      'JUDGMENT_PARTIAL_WRITE',
      `intent ${intent.id} publication point clear failed; intent retained: ${err.message}`,
      err,
    );
  }

  try {
    regenerateProjections(cwd);
  } catch (err) {
    throw typedError(
      'JUDGMENT_PROJECTION_STALE',
      `intent ${intent.id} canonical effects are committed but projections are stale: ${err.message}`,
      err,
    );
  }
  return { status: 'published', guard: applied.guard ?? null };
}

/**
 * Replay every pending intent. MUST be called with the judgment lock held.
 * Guard state is authoritative for transition edges; intent kind is
 * authoritative for dispatch, and the intent payload is authoritative for
 * the complete mutation.
 */
async function replayIntentsLocked(cwd) {
  const store = createJudgmentStore(cwd);
  const intents = store.readIntents();
  let replayed = 0;
  const divergences = [];
  const blocked = [];
  for (const intent of intents) {
    const outcome = await publishIntentLocked(cwd, store, intent);
    if (outcome.status === 'published') replayed += 1;
    else if (outcome.status === 'refused') divergences.push(outcome.divergence);
    else if (outcome.status === 'blocked') {
      blocked.push({
        intent: intent.id,
        kind: intent.kind,
        reason: outcome.reason,
      });
    }
  }
  return { replayed, divergences, blocked };
}

/**
 * Public reconciler: replay pending intents under the lock. Also runs
 * automatically at the head of every write op and getJudgmentState.
 */
export async function replayPendingIntents(cwd) {
  const release = await acquireJudgmentLock(cwd);
  try {
    return await replayIntentsLocked(cwd);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Op wrapper: validate → (idempotency) → lock → replay → execute → audit
// ---------------------------------------------------------------------------

async function runOp(cwd, args, { tool, validate, execute }) {
  if (args?.provenance !== undefined) {
    throw typedError('JUDGMENT_INPUT', `${tool}: provenance is writer-stamped and cannot be set by the caller`);
  }
  const prepared = validate ? validate() : undefined; // sync, BEFORE idempotency (A1/A4)

  const doWrite = async () => {
    const release = await acquireJudgmentLock(cwd);
    try {
      await replayIntentsLocked(cwd);
      return await execute(prepared);
    } finally {
      release();
    }
  };

  let result;
  let cached = false;
  if (args?.idempotency_key) {
    ({ result, cached } = await checkOrInsert(cwd, `${tool}:${args.idempotency_key}`, doWrite));
  } else {
    result = await doWrite();
  }

  if (!cached) {
    // Best-effort audit AFTER commit (A5) — never let audit failure surface.
    try { appendEvent(cwd, { tool, result }); } catch { /* best-effort */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-STORES S3 — shared person/situation writer primitives
// ---------------------------------------------------------------------------

const FACT_CHANNELS = new Set(['said', 'observed', 'secondhand', 'inferred']);
const PERSON_SECTIONS = new Set(['role', 'life', 'stated', 'revealed']);
const LOAD_CHANNELS = new Set(['said', 'observed']);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function requireString(args, key, tool, op) {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args, key, tool, op) {
  if (!hasOwn(args, key)) return undefined;
  return requireString(args, key, tool, op);
}

function requireSlug(args, tool, op) {
  const slug = requireString(args, 'slug', tool, op);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: slug must match ^[a-z0-9][a-z0-9-]*$`);
  }
  return slug;
}

function requireDate(args, key, tool, op) {
  const value = requireString(args, key, tool, op);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: ${key} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function validateChannelAndVia(args, tool, op, { requireChannel = true } = {}) {
  const channel = requireChannel
    ? requireString(args, 'channel', tool, op)
    : optionalString(args, 'channel', tool, op);
  const via = optionalString(args, 'via', tool, op);
  if (channel !== undefined && !FACT_CHANNELS.has(channel)) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: unknown channel "${channel}"`);
  }
  if (channel === 'secondhand' && via === undefined) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: secondhand channel requires a non-empty via`);
  }
  if (channel !== undefined && channel !== 'secondhand' && via !== undefined) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: via is only valid for secondhand channel`);
  }
  const prepared = {};
  if (channel !== undefined) prepared.channel = channel;
  if (via !== undefined) prepared.via = via;
  return prepared;
}

function validateCreateArgs(args, tool) {
  return {
    slug: requireSlug(args, tool, 'create'),
    displayName: requireString(args, 'display_name', tool, 'create'),
  };
}

function validatePersonAddFactArgs(args) {
  const tool = 'judgment_person_write';
  const section = requireString(args, 'section', tool, 'add_fact');
  if (!PERSON_SECTIONS.has(section)) {
    throw typedError('JUDGMENT_INPUT', `${tool} add_fact: unknown section "${section}"`);
  }
  return {
    slug: requireSlug(args, tool, 'add_fact'),
    section,
    text: requireString(args, 'text', tool, 'add_fact'),
    ...validateChannelAndVia(args, tool, 'add_fact'),
    at: requireDate(args, 'at', tool, 'add_fact'),
  };
}

function validateSituationAddFactArgs(args) {
  const tool = 'judgment_situation_write';
  return {
    slug: requireSlug(args, tool, 'add_fact'),
    text: requireString(args, 'text', tool, 'add_fact'),
    ...validateChannelAndVia(args, tool, 'add_fact'),
    at: requireDate(args, 'at', tool, 'add_fact'),
  };
}

function validateCorrectArgs(args, tool, { person = false } = {}) {
  const prepared = {
    slug: requireSlug(args, tool, 'correct'),
    factId: requireString(args, 'fact_id', tool, 'correct'),
  };
  if (hasOwn(args, 'text')) prepared.text = requireString(args, 'text', tool, 'correct');
  if (hasOwn(args, 'at')) prepared.at = requireDate(args, 'at', tool, 'correct');
  if (hasOwn(args, 'channel') || hasOwn(args, 'via')) {
    Object.assign(prepared, validateChannelAndVia(
      args,
      tool,
      'correct',
      { requireChannel: hasOwn(args, 'channel') },
    ));
  }
  if (person && hasOwn(args, 'section')) {
    const section = requireString(args, 'section', tool, 'correct');
    if (!PERSON_SECTIONS.has(section)) {
      throw typedError('JUDGMENT_INPUT', `${tool} correct: unknown section "${section}"`);
    }
    prepared.section = section;
  }
  if (person && hasOwn(args, 'pair_with')) {
    prepared.pairWith = requireString(args, 'pair_with', tool, 'correct');
  }
  if (person && hasOwn(args, 'clear')) {
    if (
      !Array.isArray(args.clear)
      || args.clear.length !== 1
      || args.clear[0] !== 'diverges_with'
    ) {
      throw typedError('JUDGMENT_INPUT', `${tool} correct: clear must be exactly ["diverges_with"]`);
    }
    prepared.clearDivergence = true;
  }
  if (prepared.pairWith && prepared.clearDivergence) {
    throw typedError('JUDGMENT_INPUT', `${tool} correct: pair_with and clear are mutually exclusive`);
  }

  const mutableKeys = person
    ? ['text', 'at', 'channel', 'via', 'section', 'pairWith', 'clearDivergence']
    : ['text', 'at', 'channel', 'via'];
  if (!mutableKeys.some((key) => hasOwn(prepared, key))) {
    throw typedError('JUDGMENT_INPUT', `${tool} correct: provide at least one correctable field`);
  }
  return prepared;
}

function validateOpenFieldArgs(args) {
  const tool = 'judgment_person_write';
  const slug = requireSlug(args, tool, 'open_field');
  const create = hasOwn(args, 'name');
  const fill = hasOwn(args, 'open_field_id') && hasOwn(args, 'filled_by') && !hasOwn(args, 'reopen');
  const reopen = hasOwn(args, 'open_field_id') && args.reopen === true;
  if (Number(create) + Number(fill) + Number(reopen) !== 1) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${tool} open_field: select exactly one create, fill, or reopen branch`,
    );
  }
  if (create) {
    if (hasOwn(args, 'open_field_id') || hasOwn(args, 'filled_by') || hasOwn(args, 'reopen')) {
      throw typedError('JUDGMENT_INPUT', `${tool} open_field: select exactly one create, fill, or reopen branch`);
    }
    return { branch: 'create', slug, name: requireString(args, 'name', tool, 'open_field') };
  }
  const openFieldId = requireString(args, 'open_field_id', tool, 'open_field');
  if (fill) {
    return {
      branch: 'fill',
      slug,
      openFieldId,
      filledBy: requireString(args, 'filled_by', tool, 'open_field'),
    };
  }
  if (hasOwn(args, 'filled_by') || hasOwn(args, 'name')) {
    throw typedError('JUDGMENT_INPUT', `${tool} open_field: select exactly one create, fill, or reopen branch`);
  }
  return {
    branch: 'reopen',
    slug,
    openFieldId,
    reason: requireString(args, 'reason', tool, 'open_field'),
  };
}

function validateOwedArgs(args) {
  const tool = 'judgment_situation_write';
  const slug = requireSlug(args, tool, 'owed');
  const create = hasOwn(args, 'name') || hasOwn(args, 'why_load_bearing');
  const give = hasOwn(args, 'owed_id') && hasOwn(args, 'filled_by') && !hasOwn(args, 'reopen');
  const reopen = hasOwn(args, 'owed_id') && args.reopen === true;
  if (Number(create) + Number(give) + Number(reopen) !== 1) {
    throw typedError('JUDGMENT_INPUT', `${tool} owed: select exactly one create, give, or reopen branch`);
  }
  if (create) {
    if (hasOwn(args, 'owed_id') || hasOwn(args, 'filled_by') || hasOwn(args, 'reopen')) {
      throw typedError('JUDGMENT_INPUT', `${tool} owed: select exactly one create, give, or reopen branch`);
    }
    return {
      branch: 'create',
      slug,
      name: requireString(args, 'name', tool, 'owed'),
      whyLoadBearing: requireString(args, 'why_load_bearing', tool, 'owed'),
    };
  }
  const owedId = requireString(args, 'owed_id', tool, 'owed');
  if (give) {
    return {
      branch: 'give',
      slug,
      owedId,
      filledBy: requireString(args, 'filled_by', tool, 'owed'),
    };
  }
  if (hasOwn(args, 'filled_by') || hasOwn(args, 'name') || hasOwn(args, 'why_load_bearing')) {
    throw typedError('JUDGMENT_INPUT', `${tool} owed: select exactly one create, give, or reopen branch`);
  }
  return {
    branch: 'reopen',
    slug,
    owedId,
    reason: requireString(args, 'reason', tool, 'owed'),
  };
}

function validateRetirableArgs(args, tool, op, { createKeys, idKey }) {
  const slug = requireSlug(args, tool, op);
  const create = createKeys.every((key) => hasOwn(args, key));
  const remove = hasOwn(args, idKey) && args.remove === true;
  if (Number(create) + Number(remove) !== 1) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: select exactly one create or remove branch`);
  }
  if (create) {
    if (hasOwn(args, idKey) || hasOwn(args, 'remove') || hasOwn(args, 'reason')) {
      throw typedError('JUDGMENT_INPUT', `${tool} ${op}: select exactly one create or remove branch`);
    }
    const prepared = { branch: 'create', slug };
    for (const key of createKeys) {
      prepared[key] = requireString(args, key, tool, op);
    }
    return prepared;
  }
  if (createKeys.some((key) => hasOwn(args, key))) {
    throw typedError('JUDGMENT_INPUT', `${tool} ${op}: select exactly one create or remove branch`);
  }
  return {
    branch: 'remove',
    slug,
    entryId: requireString(args, idKey, tool, op),
    reason: requireString(args, 'reason', tool, op),
  };
}

function validateFamilyDispatch(args, tool, validators) {
  const op = args?.op;
  if (typeof op !== 'string' || !hasOwn(validators, op)) {
    throw typedError('JUDGMENT_INPUT', `${tool}: unknown op "${String(op)}"`);
  }
  return { op, input: validators[op](args) };
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function correctionTrace(prior, provenance) {
  return {
    prior,
    corrected_at: provenance.written_at,
    provenance,
  };
}

function removedBlock(reason, provenance) {
  return {
    at: provenance.written_at,
    reason,
    provenance,
  };
}

function persistAggregate(cwd, path, { created = false, write }) {
  const undo = new UndoLog();
  commitWithProjections(cwd, undo, () => {
    if (created) undo.created(path);
    else undo.capture(path);
    write();
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Allocate the next permanent sub-entry ID from the collection high-water
 * mark. The caller holds the writer lock. Retired entries remain in the
 * collection and therefore participate automatically.
 */
export function allocateStableEntryId(record, collection, prefix) {
  const entries = Array.isArray(collection) ? collection : record?.[collection];
  const collectionName = Array.isArray(collection) ? 'collection' : collection;
  if (!Array.isArray(entries)) {
    throw typedError(
      'JUDGMENT_CONFLICT',
      `${record?.slug ?? 'record'} ${String(collectionName)} is not an on-disk entry collection`,
    );
  }
  const pattern = new RegExp(`^${escapeRegExp(prefix)}([1-9][0-9]*)$`);
  const seen = new Set();
  let highWater = 0;
  for (const entry of entries) {
    const id = entry?.id;
    const match = typeof id === 'string' ? pattern.exec(id) : null;
    if (!match) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `${record?.slug ?? 'record'} ${String(collectionName)} has malformed id ${String(id)}; expected ${prefix}<positive-integer>`,
      );
    }
    if (seen.has(id)) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `${record?.slug ?? 'record'} ${String(collectionName)} has duplicate id ${id}`,
      );
    }
    seen.add(id);
    highWater = Math.max(highWater, Number(match[1]));
  }
  return `${prefix}${highWater + 1}`;
}

function assertFactVia(fact, ownerLabel) {
  if (fact.channel === 'secondhand') {
    if (typeof fact.via !== 'string' || fact.via.trim().length === 0) {
      throw typedError(
        'JUDGMENT_INPUT',
        `${ownerLabel} fact ${fact.id}: secondhand channel requires a non-empty via`,
      );
    }
  } else if (fact.via !== undefined) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${ownerLabel} fact ${fact.id}: via is only valid for secondhand channel`,
    );
  }
}

function activeEntries(entries) {
  return entries.filter((entry) => entry.removed == null);
}

function assertPersonSemantics(store, record) {
  allocateStableEntryId(record, 'facts', 'f');
  allocateStableEntryId(record, 'edges', 'e');
  allocateStableEntryId(record, 'open_fields', 'of');
  allocateStableEntryId(record, 'load_links', 'l');

  const facts = new Map(record.facts.map((fact) => [fact.id, fact]));
  for (const fact of record.facts) assertFactVia(fact, `person ${record.slug}`);

  for (const fact of record.facts) {
    if (fact.diverges_with === undefined) continue;
    const paired = facts.get(fact.diverges_with);
    if (!paired) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} fact ${fact.id}: diverges_with ${fact.diverges_with} does not resolve`,
      );
    }
    if (paired.diverges_with !== fact.id) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} divergence ${fact.id}↔${paired.id} is not reciprocal`,
      );
    }
    if (new Set([fact.section, paired.section]).size !== 2
      || ![fact.section, paired.section].every((section) => ['stated', 'revealed'].includes(section))) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} divergence ${fact.id}↔${paired.id} must join stated↔revealed`,
      );
    }
  }

  for (const field of record.open_fields) {
    if (!['open', 'filled'].includes(field.status)) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `person ${record.slug} open field ${field.id} has invalid lifecycle state ${String(field.status)}`,
      );
    }
    if (field.status === 'filled') {
      const fact = facts.get(field.filled_by);
      if (!fact) {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} open field ${field.id}: filled_by ${field.filled_by} does not resolve`,
        );
      }
      if (fact.channel !== 'said') {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} open field ${field.id}: filled_by ${field.filled_by} must name a said fact`,
        );
      }
    } else if (field.status === 'open' && field.filled_by !== undefined) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `person ${record.slug} open field ${field.id} is open but retains filled_by ${field.filled_by}`,
      );
    }
  }

  for (const edge of activeEntries(record.edges)) {
    if (!store.readPerson(edge.to)) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} edge ${edge.id}: target person ${edge.to} does not exist`,
      );
    }
  }

  const links = activeEntries(record.load_links);
  for (const link of links) {
    const fact = facts.get(link.fact);
    if (!fact) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} load link ${link.id}: fact ${link.fact} does not resolve`,
      );
    }
  }
  if (links.length > 0 && !record.facts.some((fact) => fact.channel === 'said')) {
    throw typedError(
      'JUDGMENT_LOAD_CHANNEL',
      `person ${record.slug} is a stub and cannot carry load (active: ${links.map((link) => link.id).join(', ')})`,
    );
  }
  for (const link of links) {
    const fact = facts.get(link.fact);
    if (!LOAD_CHANNELS.has(fact.channel)) {
      throw typedError(
        'JUDGMENT_LOAD_CHANNEL',
        `person ${record.slug} load link ${link.id}: fact ${fact.id} channel ${fact.channel} cannot carry load`,
      );
    }
  }
}

function assertSituationSemantics(record) {
  allocateStableEntryId(record, 'facts', 'f');
  allocateStableEntryId(record, 'owed', 'o');
  allocateStableEntryId(record, 'load_links', 'l');

  const facts = new Map(record.facts.map((fact) => [fact.id, fact]));
  for (const fact of record.facts) assertFactVia(fact, `situation ${record.slug}`);

  for (const owed of record.owed) {
    if (!['open', 'given'].includes(owed.status)) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `situation ${record.slug} owed ${owed.id} has invalid lifecycle state ${String(owed.status)}`,
      );
    }
    if (owed.status === 'given') {
      if (!facts.has(owed.filled_by)) {
        throw typedError(
          'JUDGMENT_REF',
          `situation ${record.slug} owed ${owed.id}: filled_by ${owed.filled_by} does not resolve`,
        );
      }
    } else if (owed.status === 'open' && owed.filled_by !== undefined) {
      throw typedError(
        'JUDGMENT_CONFLICT',
        `situation ${record.slug} owed ${owed.id} is open but retains filled_by ${owed.filled_by}`,
      );
    }
  }

  for (const link of activeEntries(record.load_links)) {
    const fact = facts.get(link.fact);
    if (!fact) {
      throw typedError(
        'JUDGMENT_REF',
        `situation ${record.slug} load link ${link.id}: fact ${link.fact} does not resolve`,
      );
    }
    if (!LOAD_CHANNELS.has(fact.channel)) {
      throw typedError(
        'JUDGMENT_LOAD_CHANNEL',
        `situation ${record.slug} load link ${link.id}: fact ${fact.id} channel ${fact.channel} cannot carry load`,
      );
    }
  }
}

function personCorrectionBlockers(record, factId) {
  const fact = record.facts.find((entry) => entry.id === factId);
  const refBlockers = [];
  const loadBlockers = [];

  if (fact.diverges_with !== undefined) {
    const paired = record.facts.find((entry) => entry.id === fact.diverges_with);
    if (
      !paired
      || paired.diverges_with !== fact.id
      || new Set([fact.section, paired.section]).size !== 2
      || ![fact.section, paired.section].every((section) => ['stated', 'revealed'].includes(section))
    ) {
      refBlockers.push(fact.diverges_with);
    }
  }
  if (fact.channel !== 'said') {
    refBlockers.push(
      ...record.open_fields
        .filter((field) => field.status === 'filled' && field.filled_by === fact.id)
        .map((field) => field.id),
    );
  }

  const activeLinks = activeEntries(record.load_links);
  if (!LOAD_CHANNELS.has(fact.channel)) {
    loadBlockers.push(
      ...activeLinks.filter((link) => link.fact === fact.id).map((link) => link.id),
    );
  }
  if (!record.facts.some((entry) => entry.channel === 'said')) {
    loadBlockers.push(...activeLinks.map((link) => link.id));
  }

  return {
    ref: [...new Set(refBlockers)].filter(Boolean),
    load: [...new Set(loadBlockers)].filter(Boolean),
  };
}

function situationCorrectionBlockers(record, factId) {
  const fact = record.facts.find((entry) => entry.id === factId);
  if (LOAD_CHANNELS.has(fact.channel)) return [];
  return activeEntries(record.load_links)
    .filter((link) => link.fact === factId)
    .map((link) => link.id);
}

function appendCorrectionTraces(priorByFact, provenance) {
  for (const [fact, prior] of priorByFact) {
    if (Object.keys(prior).length > 0) {
      fact.trace.push(correctionTrace(prior, provenance));
    }
  }
}

function recordPrior(priorByFact, fact, key) {
  let prior = priorByFact.get(fact);
  if (!prior) {
    prior = {};
    priorByFact.set(fact, prior);
  }
  if (!hasOwn(prior, key)) prior[key] = fact[key] ?? null;
}

function applyFactScalarCorrections(fact, input, priorByFact) {
  for (const key of ['text', 'at']) {
    if (hasOwn(input, key) && input[key] !== fact[key]) {
      recordPrior(priorByFact, fact, key);
      fact[key] = input[key];
    }
  }

  if (hasOwn(input, 'channel') && input.channel !== fact.channel) {
    recordPrior(priorByFact, fact, 'channel');
    fact.channel = input.channel;
    if (input.channel === 'secondhand') {
      recordPrior(priorByFact, fact, 'via');
      fact.via = input.via;
    } else if (fact.via !== undefined) {
      recordPrior(priorByFact, fact, 'via');
      delete fact.via;
    }
  } else if (hasOwn(input, 'via')) {
    if (fact.channel !== 'secondhand') {
      throw typedError(
        'JUDGMENT_INPUT',
        `fact ${fact.id}: via is only valid while channel is secondhand`,
      );
    }
    if (input.via !== fact.via) {
      recordPrior(priorByFact, fact, 'via');
      fact.via = input.via;
    }
  }
}

const PERSON_VALIDATORS = Object.freeze({
  create: (args) => validateCreateArgs(args, 'judgment_person_write'),
  add_fact: validatePersonAddFactArgs,
  correct: (args) => validateCorrectArgs(args, 'judgment_person_write', { person: true }),
  open_field: validateOpenFieldArgs,
  edge: (args) => validateRetirableArgs(
    args,
    'judgment_person_write',
    'edge',
    { createKeys: ['to', 'kind'], idKey: 'edge_id' },
  ),
  load_link: (args) => validateRetirableArgs(
    args,
    'judgment_person_write',
    'load_link',
    { createKeys: ['fact', 'carries'], idKey: 'load_link_id' },
  ),
});

function personRecord(store, slug) {
  const record = store.readPerson(slug);
  if (!record) throw typedError('JUDGMENT_NOT_FOUND', `person ${slug} does not exist`);
  return cloneRecord(record);
}

function writePersonAggregate(cwd, store, record, { created = false } = {}) {
  assertPersonSemantics(store, record);
  assertValidRecord('person', record);
  persistAggregate(cwd, store._personPath(record.slug), {
    created,
    write: () => store.writePerson(record),
  });
}

const PERSON_EXECUTORS = Object.freeze({
  create(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    if (store.readPerson(input.slug)) {
      throw typedError('JUDGMENT_CONFLICT', `person ${input.slug} already exists`);
    }
    const provenance = stampProvenance(internal);
    const record = {
      slug: input.slug,
      display_name: input.displayName,
      facts: [],
      edges: [],
      open_fields: [],
      load_links: [],
      provenance,
    };
    writePersonAggregate(cwd, store, record, { created: true });
    return { op: 'create', slug: record.slug };
  },

  add_fact(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = personRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    const fact = {
      id: allocateStableEntryId(record, 'facts', 'f'),
      section: input.section,
      text: input.text,
      channel: input.channel,
      at: input.at,
      provenance,
      trace: [],
    };
    if (input.via !== undefined) fact.via = input.via;
    record.facts.push(fact);
    record.provenance = provenance;
    writePersonAggregate(cwd, store, record);
    return { op: 'add_fact', slug: record.slug, id: fact.id };
  },

  correct(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = personRecord(store, input.slug);
    const fact = record.facts.find((entry) => entry.id === input.factId);
    if (!fact) {
      throw typedError('JUDGMENT_NOT_FOUND', `person ${record.slug} fact ${input.factId} not found`);
    }

    const provenance = stampProvenance(internal);
    const priorByFact = new Map();
    applyFactScalarCorrections(fact, input, priorByFact);

    if (hasOwn(input, 'section') && input.section !== fact.section) {
      recordPrior(priorByFact, fact, 'section');
      fact.section = input.section;
    }

    if (input.pairWith) {
      const paired = record.facts.find((entry) => entry.id === input.pairWith);
      if (!paired) {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} pair endpoint ${input.pairWith} does not resolve`,
        );
      }
      if (fact.diverges_with !== undefined) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `person ${record.slug} fact ${fact.id} is already paired with ${fact.diverges_with}`,
        );
      }
      if (paired.diverges_with !== undefined) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `person ${record.slug} fact ${paired.id} is already paired with ${paired.diverges_with}`,
        );
      }
      if (
        new Set([fact.section, paired.section]).size !== 2
        || ![fact.section, paired.section].every((section) => ['stated', 'revealed'].includes(section))
      ) {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} pair ${fact.id}↔${paired.id} must join stated↔revealed`,
        );
      }
      recordPrior(priorByFact, fact, 'diverges_with');
      recordPrior(priorByFact, paired, 'diverges_with');
      fact.diverges_with = paired.id;
      paired.diverges_with = fact.id;
    }

    if (input.clearDivergence) {
      const pairedId = fact.diverges_with;
      if (pairedId === undefined) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `person ${record.slug} fact ${fact.id} has no divergence pair to clear`,
        );
      }
      const paired = record.facts.find((entry) => entry.id === pairedId);
      recordPrior(priorByFact, fact, 'diverges_with');
      delete fact.diverges_with;
      if (paired?.diverges_with === fact.id) {
        recordPrior(priorByFact, paired, 'diverges_with');
        delete paired.diverges_with;
      }
    }

    if ([...priorByFact.values()].every((prior) => Object.keys(prior).length === 0)) {
      throw typedError('JUDGMENT_INPUT', `judgment_person_write correct: fact ${fact.id} has no changed value`);
    }

    const blockers = personCorrectionBlockers(record, fact.id);
    const allBlockers = [...new Set([...blockers.ref, ...blockers.load])];
    if (blockers.ref.length > 0) {
      throw typedError(
        'JUDGMENT_REF',
        `person ${record.slug} correction of fact ${fact.id} is blocked by dependent entries: ${allBlockers.join(', ')}`,
      );
    }
    if (blockers.load.length > 0) {
      throw typedError(
        'JUDGMENT_LOAD_CHANNEL',
        `person ${record.slug} correction of fact ${fact.id} is blocked by active load links: ${blockers.load.join(', ')}`,
      );
    }

    appendCorrectionTraces(priorByFact, provenance);
    record.provenance = provenance;
    writePersonAggregate(cwd, store, record);
    return { op: 'correct', slug: record.slug, fact_id: fact.id };
  },

  open_field(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = personRecord(store, input.slug);
    const provenance = stampProvenance(internal);

    let field;
    if (input.branch === 'create') {
      field = {
        id: allocateStableEntryId(record, 'open_fields', 'of'),
        name: input.name,
        status: 'open',
        provenance,
        trace: [],
      };
      record.open_fields.push(field);
    } else {
      field = record.open_fields.find((entry) => entry.id === input.openFieldId);
      if (!field) {
        throw typedError(
          'JUDGMENT_NOT_FOUND',
          `person ${record.slug} open field ${input.openFieldId} not found`,
        );
      }
      if (input.branch === 'fill') {
        if (field.status !== 'open') {
          throw typedError(
            'JUDGMENT_CONFLICT',
            `person ${record.slug} open field ${field.id} is already ${field.status}`,
          );
        }
        const fact = record.facts.find((entry) => entry.id === input.filledBy);
        if (!fact) {
          throw typedError(
            'JUDGMENT_REF',
            `person ${record.slug} open field ${field.id}: filled_by ${input.filledBy} does not resolve`,
          );
        }
        if (fact.channel !== 'said') {
          throw typedError(
            'JUDGMENT_REF',
            `person ${record.slug} open field ${field.id}: filled_by ${input.filledBy} must name a said fact`,
          );
        }
        field.trace.push(correctionTrace({ status: 'open', filled_by: null }, provenance));
        field.status = 'filled';
        field.filled_by = fact.id;
      } else {
        if (field.status !== 'filled') {
          throw typedError(
            'JUDGMENT_CONFLICT',
            `person ${record.slug} open field ${field.id} is already open`,
          );
        }
        field.trace.push(correctionTrace({
          status: 'filled',
          filled_by: field.filled_by,
        }, provenance));
        field.status = 'open';
        delete field.filled_by;
      }
    }

    record.provenance = provenance;
    writePersonAggregate(cwd, store, record);
    return {
      op: 'open_field',
      slug: record.slug,
      id: field.id,
      status: field.status,
    };
  },

  edge(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = personRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    let edge;

    if (input.branch === 'create') {
      if (!store.readPerson(input.to)) {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} edge target person ${input.to} does not exist`,
        );
      }
      edge = {
        id: allocateStableEntryId(record, 'edges', 'e'),
        to: input.to,
        kind: input.kind,
        provenance,
        removed: null,
      };
      record.edges.push(edge);
    } else {
      edge = record.edges.find((entry) => entry.id === input.entryId);
      if (!edge) {
        throw typedError('JUDGMENT_NOT_FOUND', `person ${record.slug} edge ${input.entryId} not found`);
      }
      if (edge.removed !== null) {
        throw typedError('JUDGMENT_CONFLICT', `person ${record.slug} edge ${edge.id} is already removed`);
      }
      edge.removed = removedBlock(input.reason, provenance);
    }

    record.provenance = provenance;
    writePersonAggregate(cwd, store, record);
    return {
      op: 'edge',
      slug: record.slug,
      id: edge.id,
      removed: edge.removed !== null,
    };
  },

  load_link(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = personRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    let link;

    if (input.branch === 'create') {
      const fact = record.facts.find((entry) => entry.id === input.fact);
      if (!fact) {
        throw typedError(
          'JUDGMENT_REF',
          `person ${record.slug} load link fact ${input.fact} does not resolve`,
        );
      }
      if (!record.facts.some((entry) => entry.channel === 'said')) {
        throw typedError('JUDGMENT_LOAD_CHANNEL', `person ${record.slug} is a stub and cannot carry load`);
      }
      if (!LOAD_CHANNELS.has(fact.channel)) {
        throw typedError(
          'JUDGMENT_LOAD_CHANNEL',
          `person ${record.slug} fact ${fact.id} channel ${fact.channel} cannot carry load`,
        );
      }
      link = {
        id: allocateStableEntryId(record, 'load_links', 'l'),
        fact: input.fact,
        carries: input.carries,
        provenance,
        removed: null,
      };
      record.load_links.push(link);
    } else {
      link = record.load_links.find((entry) => entry.id === input.entryId);
      if (!link) {
        throw typedError(
          'JUDGMENT_NOT_FOUND',
          `person ${record.slug} load link ${input.entryId} not found`,
        );
      }
      if (link.removed !== null) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `person ${record.slug} load link ${link.id} is already removed`,
        );
      }
      link.removed = removedBlock(input.reason, provenance);
    }

    record.provenance = provenance;
    writePersonAggregate(cwd, store, record);
    return {
      op: 'load_link',
      slug: record.slug,
      id: link.id,
      removed: link.removed !== null,
    };
  },
});

/**
 * One op-discriminated writer for the entire person family.
 */
export async function judgmentPersonWrite(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_person_write',
    validate: () => validateFamilyDispatch(args, 'judgment_person_write', PERSON_VALIDATORS),
    execute: ({ op, input }) => PERSON_EXECUTORS[op](cwd, input, internal),
  });
}

const SITUATION_VALIDATORS = Object.freeze({
  create: (args) => validateCreateArgs(args, 'judgment_situation_write'),
  add_fact: validateSituationAddFactArgs,
  correct: (args) => validateCorrectArgs(args, 'judgment_situation_write'),
  owed: validateOwedArgs,
  load_link: (args) => validateRetirableArgs(
    args,
    'judgment_situation_write',
    'load_link',
    { createKeys: ['fact', 'carries'], idKey: 'load_link_id' },
  ),
});

function situationRecord(store, slug) {
  const record = store.readSituationEntity(slug);
  if (!record) {
    throw typedError('JUDGMENT_NOT_FOUND', `situation entity ${slug} does not exist`);
  }
  return cloneRecord(record);
}

function writeSituationAggregate(cwd, store, record, { created = false } = {}) {
  assertSituationSemantics(record);
  assertValidRecord('situation_entity', record);
  persistAggregate(cwd, store._situationEntityPath(record.slug), {
    created,
    write: () => store.writeSituationEntity(record),
  });
}

const SITUATION_EXECUTORS = Object.freeze({
  create(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    if (store.readSituationEntity(input.slug)) {
      throw typedError('JUDGMENT_CONFLICT', `situation entity ${input.slug} already exists`);
    }
    const provenance = stampProvenance(internal);
    const record = {
      slug: input.slug,
      display_name: input.displayName,
      facts: [],
      owed: [],
      load_links: [],
      provenance,
    };
    writeSituationAggregate(cwd, store, record, { created: true });
    return { op: 'create', slug: record.slug };
  },

  add_fact(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = situationRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    const fact = {
      id: allocateStableEntryId(record, 'facts', 'f'),
      text: input.text,
      channel: input.channel,
      at: input.at,
      provenance,
      trace: [],
    };
    if (input.via !== undefined) fact.via = input.via;
    record.facts.push(fact);
    record.provenance = provenance;
    writeSituationAggregate(cwd, store, record);
    return { op: 'add_fact', slug: record.slug, id: fact.id };
  },

  correct(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = situationRecord(store, input.slug);
    const fact = record.facts.find((entry) => entry.id === input.factId);
    if (!fact) {
      throw typedError('JUDGMENT_NOT_FOUND', `situation ${record.slug} fact ${input.factId} not found`);
    }
    const provenance = stampProvenance(internal);
    const priorByFact = new Map();
    applyFactScalarCorrections(fact, input, priorByFact);
    if ([...priorByFact.values()].every((prior) => Object.keys(prior).length === 0)) {
      throw typedError('JUDGMENT_INPUT', `judgment_situation_write correct: fact ${fact.id} has no changed value`);
    }
    const blockers = situationCorrectionBlockers(record, fact.id);
    if (blockers.length > 0) {
      throw typedError(
        'JUDGMENT_LOAD_CHANNEL',
        `situation ${record.slug} correction of fact ${fact.id} is blocked by active load links: ${blockers.join(', ')}`,
      );
    }
    appendCorrectionTraces(priorByFact, provenance);
    record.provenance = provenance;
    writeSituationAggregate(cwd, store, record);
    return { op: 'correct', slug: record.slug, fact_id: fact.id };
  },

  owed(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = situationRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    let owed;

    if (input.branch === 'create') {
      owed = {
        id: allocateStableEntryId(record, 'owed', 'o'),
        name: input.name,
        why_load_bearing: input.whyLoadBearing,
        status: 'open',
        provenance,
        trace: [],
      };
      record.owed.push(owed);
    } else {
      owed = record.owed.find((entry) => entry.id === input.owedId);
      if (!owed) {
        throw typedError('JUDGMENT_NOT_FOUND', `situation ${record.slug} owed ${input.owedId} not found`);
      }
      if (input.branch === 'give') {
        if (owed.status !== 'open') {
          throw typedError(
            'JUDGMENT_CONFLICT',
            `situation ${record.slug} owed ${owed.id} is already ${owed.status}`,
          );
        }
        if (!record.facts.some((fact) => fact.id === input.filledBy)) {
          throw typedError(
            'JUDGMENT_REF',
            `situation ${record.slug} owed ${owed.id}: filled_by ${input.filledBy} does not resolve`,
          );
        }
        owed.trace.push(correctionTrace({ status: 'open', filled_by: null }, provenance));
        owed.status = 'given';
        owed.filled_by = input.filledBy;
      } else {
        if (owed.status !== 'given') {
          throw typedError(
            'JUDGMENT_CONFLICT',
            `situation ${record.slug} owed ${owed.id} is already open`,
          );
        }
        owed.trace.push(correctionTrace({
          status: 'given',
          filled_by: owed.filled_by,
        }, provenance));
        owed.status = 'open';
        delete owed.filled_by;
      }
    }

    record.provenance = provenance;
    writeSituationAggregate(cwd, store, record);
    return {
      op: 'owed',
      slug: record.slug,
      id: owed.id,
      status: owed.status,
    };
  },

  load_link(cwd, input, internal) {
    const store = createJudgmentStore(cwd);
    const record = situationRecord(store, input.slug);
    const provenance = stampProvenance(internal);
    let link;

    if (input.branch === 'create') {
      const fact = record.facts.find((entry) => entry.id === input.fact);
      if (!fact) {
        throw typedError(
          'JUDGMENT_REF',
          `situation ${record.slug} load link fact ${input.fact} does not resolve`,
        );
      }
      if (!LOAD_CHANNELS.has(fact.channel)) {
        throw typedError(
          'JUDGMENT_LOAD_CHANNEL',
          `situation ${record.slug} fact ${fact.id} channel ${fact.channel} cannot carry load`,
        );
      }
      link = {
        id: allocateStableEntryId(record, 'load_links', 'l'),
        fact: input.fact,
        carries: input.carries,
        provenance,
        removed: null,
      };
      record.load_links.push(link);
    } else {
      link = record.load_links.find((entry) => entry.id === input.entryId);
      if (!link) {
        throw typedError(
          'JUDGMENT_NOT_FOUND',
          `situation ${record.slug} load link ${input.entryId} not found`,
        );
      }
      if (link.removed !== null) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `situation ${record.slug} load link ${link.id} is already removed`,
        );
      }
      link.removed = removedBlock(input.reason, provenance);
    }

    record.provenance = provenance;
    writeSituationAggregate(cwd, store, record);
    return {
      op: 'load_link',
      slug: record.slug,
      id: link.id,
      removed: link.removed !== null,
    };
  },
});

/**
 * One op-discriminated writer for the entire situation family.
 */
export async function judgmentSituationWrite(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_situation_write',
    validate: () => validateFamilyDispatch(args, 'judgment_situation_write', SITUATION_VALIDATORS),
    execute: ({ op, input }) => SITUATION_EXECUTORS[op](cwd, input, internal),
  });
}

// ---------------------------------------------------------------------------
// COMP-JUDGMENT-STORES S4 — judgment_goal_write
// ---------------------------------------------------------------------------

const GOAL_TOOL = 'judgment_goal_write';

// The precheck must be exactly as strict as the contract's
// `format: "date-time"` (a laxer precheck would let malformed input reach
// the idempotency cache before validation), so it delegates to the same
// ajv instance that performs final schema validation.
let _dateTimeValidate = null;

function isContractDateTime(value) {
  if (!_dateTimeValidate) {
    _dateTimeValidate = getJudgmentValidator().ajv
      .compile({ type: 'string', format: 'date-time' });
  }
  return _dateTimeValidate(value);
}

function requireDateTimeValue(value, label, code = 'JUDGMENT_INPUT') {
  if (typeof value !== 'string' || !isContractDateTime(value)) {
    throw typedError(code, `${label} must be a valid date-time string`);
  }
  return value;
}

function requireNestedString(value, key, label, code = 'JUDGMENT_INPUT') {
  const field = value?.[key];
  if (typeof field !== 'string' || field.trim().length === 0) {
    throw typedError(code, `${label}.${key} must be a non-empty string`);
  }
  return field;
}

function sanitizeElicitation(value, label, code = 'JUDGMENT_INPUT') {
  return {
    asked: requireNestedString(value, 'asked', label, code),
    answered_at: requireDateTimeValue(value?.answered_at, `${label}.answered_at`, code),
    answer_ref: requireNestedString(value, 'answer_ref', label, code),
  };
}

function sanitizeRatification(value, code = 'JUDGMENT_INPUT') {
  return {
    ...sanitizeElicitation(value, `${GOAL_TOOL} cut: ratification`, code),
    quote: requireNestedString(value, 'quote', `${GOAL_TOOL} cut: ratification`, code),
  };
}

function sanitizeProvocation(value, code = 'JUDGMENT_INPUT') {
  return {
    quote: requireNestedString(value, 'quote', `${GOAL_TOOL} cut: provocation`, code),
    at: requireDateTimeValue(value?.at, `${GOAL_TOOL} cut: provocation.at`, code),
  };
}

function validateGoalClauseInput(value, index, { ordinary }) {
  const label = `${GOAL_TOOL} cut: clause ${index + 1}`;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw typedError('JUDGMENT_INPUT', `${label} must be an object`);
  }
  if (ordinary && (value.elicitation == null || typeof value.elicitation !== 'object')) {
    throw typedError(
      'JUDGMENT_UNRATIFIED_CUT',
      `${label} requires an elicitation citation before an ordinary goal cut`,
    );
  }
  const text = requireNestedString(value, 'text', label);
  const channel = requireNestedString(value, 'channel', label);
  if (!FACT_CHANNELS.has(channel)) {
    throw typedError('JUDGMENT_INPUT', `${label} has unknown channel "${channel}"`);
  }
  const via = hasOwn(value, 'via')
    ? requireNestedString(value, 'via', label)
    : undefined;
  if (channel === 'secondhand' && via === undefined) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${label}: secondhand channel requires a non-empty via`,
    );
  }
  if (channel !== 'secondhand' && via !== undefined) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${label}: via is only valid for secondhand channel`,
    );
  }
  const clause = {
    text,
    channel,
    elicitation: sanitizeElicitation(
      value.elicitation,
      `${label}.elicitation`,
      ordinary ? 'JUDGMENT_UNRATIFIED_CUT' : 'JUDGMENT_INPUT',
    ),
  };
  if (via !== undefined) clause.via = via;
  return clause;
}

function validateGoalCutArgs(args, internal) {
  const internalDraft = internal.via === 'import' || internal.via === 'migration';
  if (internal.via !== undefined && !internalDraft) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${GOAL_TOOL} cut: internal via must be import or migration`,
    );
  }
  if (!Array.isArray(args.clauses) || args.clauses.length === 0) {
    throw typedError(
      internalDraft ? 'JUDGMENT_INPUT' : 'JUDGMENT_UNRATIFIED_CUT',
      `${GOAL_TOOL} cut: ordinary cuts require non-empty clauses`,
    );
  }
  if (!internalDraft && (args.provocation == null || typeof args.provocation !== 'object')) {
    throw typedError(
      'JUDGMENT_UNRATIFIED_CUT',
      `${GOAL_TOOL} cut: ordinary cuts require a provocation citation`,
    );
  }
  if (!internalDraft && (args.ratification == null || typeof args.ratification !== 'object')) {
    throw typedError(
      'JUDGMENT_UNRATIFIED_CUT',
      `${GOAL_TOOL} cut: ordinary cuts require an owner ratification citation`,
    );
  }

  const prepared = {
    clauses: args.clauses.map(
      (clause, index) => validateGoalClauseInput(clause, index, { ordinary: !internalDraft }),
    ),
    provocation: args.provocation == null
      ? null
      : sanitizeProvocation(
        args.provocation,
        internalDraft ? 'JUDGMENT_INPUT' : 'JUDGMENT_UNRATIFIED_CUT',
      ),
    diffNote: requireString(args, 'diff_note', GOAL_TOOL, 'cut'),
    internalDraft,
  };
  if (args.ratification != null) {
    prepared.ratification = sanitizeRatification(
      args.ratification,
      internalDraft ? 'JUDGMENT_INPUT' : 'JUDGMENT_UNRATIFIED_CUT',
    );
  }
  return prepared;
}

function validateGoalCorrectArgs(args) {
  const clauseId = requireString(args, 'clause_id', GOAL_TOOL, 'correct');
  if (!/^c[1-9][0-9]*$/.test(clauseId)) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${GOAL_TOOL} correct: clause_id must match c<positive-integer>`,
    );
  }
  return {
    clauseId,
    text: requireString(args, 'text', GOAL_TOOL, 'correct'),
  };
}

function validateGoalRetirableArgs(args, op, { createKey, idKey }) {
  const create = hasOwn(args, createKey);
  const remove = hasOwn(args, idKey) && args.remove === true;
  if (Number(create) + Number(remove) !== 1) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${GOAL_TOOL} ${op}: select exactly one create or remove branch`,
    );
  }
  if (create) {
    if (hasOwn(args, idKey) || hasOwn(args, 'remove') || hasOwn(args, 'reason')) {
      throw typedError(
        'JUDGMENT_INPUT',
        `${GOAL_TOOL} ${op}: select exactly one create or remove branch`,
      );
    }
    const input = {
      branch: 'create',
      value: requireString(args, createKey, GOAL_TOOL, op),
    };
    if (op === 'load_link') {
      input.carries = requireString(args, 'carries', GOAL_TOOL, op);
    }
    return input;
  }
  if (hasOwn(args, createKey) || (op === 'load_link' && hasOwn(args, 'carries'))) {
    throw typedError(
      'JUDGMENT_INPUT',
      `${GOAL_TOOL} ${op}: select exactly one create or remove branch`,
    );
  }
  return {
    branch: 'remove',
    entryId: requireString(args, idKey, GOAL_TOOL, op),
    reason: requireString(args, 'reason', GOAL_TOOL, op),
  };
}

function validateGoalDispatch(args, internal) {
  const op = args?.op;
  let input;
  switch (op) {
    case 'cut':
      input = validateGoalCutArgs(args, internal);
      break;
    case 'correct':
      input = validateGoalCorrectArgs(args);
      break;
    case 'joint_link':
      input = validateGoalRetirableArgs(
        args,
        op,
        { createKey: 'joint', idKey: 'joint_link_id' },
      );
      break;
    case 'load_link':
      input = validateGoalRetirableArgs(
        args,
        op,
        { createKey: 'clause', idKey: 'load_link_id' },
      );
      break;
    default:
      throw typedError('JUDGMENT_INPUT', `${GOAL_TOOL}: unknown op "${String(op)}"`);
  }
  return { op, input };
}

function goalWriteContext(cwd) {
  const rawStore = createJudgmentStore(cwd);
  const effective = effectiveStore(rawStore);
  if (effective.hasPendingIntentKind('goal_migration')) {
    throw typedError(
      'JUDGMENT_INTENT_PENDING',
      `${GOAL_TOOL}: goal_migration intent is still pending`,
    );
  }
  return { rawStore, effective };
}

function resolveEffectiveGoalClause(effective, reference, { ledger = false } = {}) {
  const pattern = ledger
    ? /^goal:v([1-9][0-9]*)#(c[1-9][0-9]*)$/
    : /^v([1-9][0-9]*)#(c[1-9][0-9]*)$/;
  const match = pattern.exec(reference);
  if (!match) {
    throw typedError('JUDGMENT_REF', `goal clause reference ${reference} is invalid`);
  }
  const version = Number(match[1]);
  const clauseId = match[2];
  const goal = effective.readGoalVersion(version);
  const clause = goal?.clauses?.find((entry) => entry.id === clauseId);
  if (!goal || !clause) {
    throw typedError('JUDGMENT_REF', `goal clause reference ${reference} does not resolve`);
  }
  return { goal, clause };
}

function assertGoalStateSemantics(effective, state) {
  // Calling the high-water allocator validates every extant ID, including
  // retired entries, without consuming the returned candidate.
  allocateStableEntryId(state, 'joints', 'gj');
  allocateStableEntryId(state, 'load_links', 'gl');
  for (const link of activeEntries(state.joints)) {
    if (!effective.readJoint(link.joint)) {
      throw typedError(
        'JUDGMENT_REF',
        `goal joint link ${link.id}: joint ${link.joint} does not resolve`,
      );
    }
  }
  for (const link of activeEntries(state.load_links)) {
    resolveEffectiveGoalClause(effective, link.clause);
  }
  assertValidRecord('goal_state', state);
}

function writeGoalState(cwd, rawStore, effective, state) {
  assertGoalStateSemantics(effective, state);
  persistAggregate(cwd, rawStore._goalStatePath(), {
    created: !existsSync(rawStore._goalStatePath()),
    write: () => rawStore.writeGoalState(state),
  });
}

const GOAL_EXECUTORS = Object.freeze({
  cut(cwd, input, internal) {
    const { rawStore, effective } = goalWriteContext(cwd);
    if (
      effective.derivePositionStatus('objective') === 'live'
      && !goalCutoverComplete(effective)
    ) {
      throw typedError(
        'JUDGMENT_MIGRATION_REQUIRED',
        `${GOAL_TOOL} cut: legacy objective is live; migration is required before the first goal cut`,
      );
    }

    const rawChain = rawStore.readGoalChain();
    const version = (rawChain.at(-1)?.version ?? 0) + 1;
    const provenance = stampProvenance(internal);
    const record = {
      version,
      clauses: [],
      provocation: input.provocation,
      diff_note: input.diffNote,
      provenance,
    };
    if (input.ratification !== undefined) record.ratification = input.ratification;
    for (const inputClause of input.clauses) {
      const clause = {
        id: allocateStableEntryId(record, 'clauses', 'c'),
        text: inputClause.text,
        channel: inputClause.channel,
        elicitation: inputClause.elicitation,
        provenance,
        trace: [],
      };
      if (inputClause.via !== undefined) clause.via = inputClause.via;
      record.clauses.push(clause);
    }
    assertValidRecord('goal_version', record);

    const undo = new UndoLog();
    const path = join(rawStore._goalDir(), `v${version}.json`);
    commitWithProjections(cwd, undo, () => {
      undo.created(path);
      rawStore.writeGoalVersion(record);
    });
    return {
      op: 'cut',
      version,
      ref: `goal:v${version}`,
      ratified: record.ratification != null,
    };
  },

  correct(cwd, input, internal) {
    const { rawStore, effective } = goalWriteContext(cwd);
    const current = effective.latestGoalVersion();
    if (!current) {
      throw typedError('JUDGMENT_REF', `${GOAL_TOOL} correct: no effective current goal version`);
    }
    const record = cloneRecord(current);
    const clause = record.clauses.find((entry) => entry.id === input.clauseId);
    if (!clause) {
      throw typedError(
        'JUDGMENT_REF',
        `${GOAL_TOOL} correct: current goal v${record.version} has no clause ${input.clauseId}`,
      );
    }
    if (clause.text === input.text) {
      throw typedError(
        'JUDGMENT_INPUT',
        `${GOAL_TOOL} correct: clause ${input.clauseId} wording is unchanged`,
      );
    }
    const provenance = stampProvenance(internal);
    clause.trace.push(correctionTrace({ text: clause.text }, provenance));
    clause.text = input.text;
    assertValidRecord('goal_version', record);

    const undo = new UndoLog();
    const path = join(rawStore._goalDir(), `v${record.version}.json`);
    commitWithProjections(cwd, undo, () => {
      undo.capture(path);
      rawStore.replaceGoalVersion(record.version, record);
    });
    return {
      op: 'correct',
      version: record.version,
      clause_id: clause.id,
    };
  },

  joint_link(cwd, input, internal) {
    const { rawStore, effective } = goalWriteContext(cwd);
    const provenance = stampProvenance(internal);
    const state = cloneRecord(effective.readGoalState() ?? {
      joints: [],
      load_links: [],
      provenance,
    });
    let link;
    if (input.branch === 'create') {
      if (!effective.readJoint(input.value)) {
        throw typedError(
          'JUDGMENT_REF',
          `${GOAL_TOOL} joint_link: joint ${input.value} does not resolve`,
        );
      }
      link = {
        id: allocateStableEntryId(state, 'joints', 'gj'),
        joint: input.value,
        provenance,
        removed: null,
      };
      state.joints.push(link);
    } else {
      link = state.joints.find((entry) => entry.id === input.entryId);
      if (!link) {
        throw typedError(
          'JUDGMENT_NOT_FOUND',
          `${GOAL_TOOL} joint_link: association ${input.entryId} not found`,
        );
      }
      if (link.removed !== null) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `${GOAL_TOOL} joint_link: association ${link.id} is already removed`,
        );
      }
      link.removed = removedBlock(input.reason, provenance);
    }
    state.provenance = provenance;
    writeGoalState(cwd, rawStore, effective, state);
    return {
      op: 'joint_link',
      id: link.id,
      removed: link.removed !== null,
    };
  },

  load_link(cwd, input, internal) {
    const { rawStore, effective } = goalWriteContext(cwd);
    const provenance = stampProvenance(internal);
    const state = cloneRecord(effective.readGoalState() ?? {
      joints: [],
      load_links: [],
      provenance,
    });
    let link;
    if (input.branch === 'create') {
      resolveEffectiveGoalClause(effective, input.value);
      link = {
        id: allocateStableEntryId(state, 'load_links', 'gl'),
        clause: input.value,
        carries: input.carries,
        provenance,
        removed: null,
      };
      state.load_links.push(link);
    } else {
      link = state.load_links.find((entry) => entry.id === input.entryId);
      if (!link) {
        throw typedError(
          'JUDGMENT_NOT_FOUND',
          `${GOAL_TOOL} load_link: association ${input.entryId} not found`,
        );
      }
      if (link.removed !== null) {
        throw typedError(
          'JUDGMENT_CONFLICT',
          `${GOAL_TOOL} load_link: association ${link.id} is already removed`,
        );
      }
      link.removed = removedBlock(input.reason, provenance);
    }
    state.provenance = provenance;
    writeGoalState(cwd, rawStore, effective, state);
    return {
      op: 'load_link',
      id: link.id,
      removed: link.removed !== null,
    };
  },
});

/**
 * One op-discriminated writer for goal versions and their mutable sidecar.
 */
export async function judgmentGoalWrite(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: GOAL_TOOL,
    validate: () => validateGoalDispatch(args, internal),
    execute: ({ op, input }) => GOAL_EXECUTORS[op](cwd, input, internal),
  });
}

// ---------------------------------------------------------------------------
// judgment_position_create
// ---------------------------------------------------------------------------

/**
 * Create a position revision: a new chain, a new revision on an existing
 * chain (P1b update), a superseding revision (`supersedes: <slug>#r<N>`), or
 * a tombstone (`retracted: true`). Always a NEW immutable r<N>.json.
 */
export async function judgmentPositionCreate(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_position_create',
    validate: () => {
      const record = {
        slug: args.slug,
        claims: Array.isArray(args.claims) ? args.claims : [],
        conviction: args.conviction,
        provenance: stampProvenance(internal),
      };
      if (args.rejected_alternatives !== undefined) record.rejected_alternatives = args.rejected_alternatives;
      if (args.supersedes !== undefined) record.supersedes = args.supersedes;
      if (args.retracted !== undefined) record.retracted = args.retracted;
      if (args.provider_ids !== undefined) record.provider_ids = args.provider_ids;
      assertGrounding(record, { via: internal.via });
      assertValidRecord('position_revision', record);
      return record;
    },
    execute: (record) => {
      const store = createJudgmentStore(cwd);
      if (record.supersedes) {
        const [targetSlug, revPart] = record.supersedes.split('#r');
        if (!store.readPositionRevision(targetSlug, Number(revPart))) {
          throw typedError('JUDGMENT_NOT_FOUND', `supersedes target ${record.supersedes} does not exist`);
        }
      }
      const undo = new UndoLog();
      let written;
      commitWithProjections(cwd, undo, () => {
        written = store.writePositionRevision(record);
        undo.created(written.path);
      });
      return { slug: record.slug, rev: written.rev, ref: written.ref, status: store.derivePositionStatus(record.slug) };
    },
  });
}

// ---------------------------------------------------------------------------
// judgment_position_amend
// ---------------------------------------------------------------------------

const AMEND_ALLOWED_KEYS = new Set(['slug', 'claim_id', 'grounding', 'elicitation', 'conviction', 'idempotency_key']);

/**
 * Scoped amendment (P6 SHAKE-GROUNDING): a new revision whose delta is
 * restricted to one claim's grounding and/or the conviction block. Anything
 * else — claim text, branches, rejected alternatives — is supersession.
 */
export async function judgmentPositionAmend(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_position_amend',
    validate: () => {
      const illegal = Object.keys(args ?? {}).filter((k) => !AMEND_ALLOWED_KEYS.has(k));
      if (illegal.length > 0) {
        throw typedError(
          'JUDGMENT_INPUT',
          `judgment_position_amend: delta is restricted to grounding/conviction (illegal: ${illegal.join(', ')}) — for any other change create a superseding revision via judgment_position_create with supersedes: <slug>#r<N> (supersession path)`,
        );
      }
      if (!args.grounding && !args.conviction) {
        throw typedError('JUDGMENT_INPUT', 'judgment_position_amend: nothing to amend — provide grounding (with claim_id) and/or conviction');
      }
      if (args.grounding && !args.claim_id) {
        throw typedError('JUDGMENT_INPUT', 'judgment_position_amend: grounding amendment requires claim_id');
      }
      // Sync shape validation BEFORE idempotency (A1/A4).
      if (args.grounding !== undefined && !['EXT', 'INT', 'ASSERT', 'DERIVED', 'AGENT'].includes(args.grounding)) {
        throw typedError('JUDGMENT_INPUT', `judgment_position_amend: unknown grounding "${args.grounding}"`);
      }
      if (args.conviction !== undefined) assertValidRecord('conviction', args.conviction);
      if (args.elicitation !== undefined) assertValidRecord('elicitation', args.elicitation);
      return null;
    },
    execute: async () => {
      const store = createJudgmentStore(cwd);
      const latest = store.latestPositionRevision(args.slug);
      if (!latest) throw typedError('JUDGMENT_NOT_FOUND', `position ${args.slug} does not exist`);
      if (latest.retracted) throw typedError('JUDGMENT_CONFLICT', `position ${args.slug} is retracted — a tombstone cannot be amended`);

      const record = { ...latest };
      delete record.rev;
      record.claims = latest.claims.map((c) => ({ ...c }));
      if (args.grounding) {
        const claim = record.claims.find((c) => c.id === args.claim_id);
        if (!claim) throw typedError('JUDGMENT_NOT_FOUND', `claim ${args.claim_id} not found on ${args.slug}`);
        claim.grounding = args.grounding;
        if (args.elicitation) claim.elicitation = args.elicitation;
        if (args.grounding !== 'ASSERT') delete claim.elicitation;
      }
      if (args.conviction) record.conviction = args.conviction;
      record.provenance = stampProvenance(internal);

      assertGrounding(record, { via: internal.via });
      assertValidRecord('position_revision', record);

      const undo = new UndoLog();
      let written;
      commitWithProjections(cwd, undo, () => {
        written = store.writePositionRevision(record);
        undo.created(written.path);
      });
      return { slug: args.slug, rev: written.rev, ref: written.ref };
    },
  });
}

// ---------------------------------------------------------------------------
// judgment_joint_add
// ---------------------------------------------------------------------------

/**
 * Add a joint. State is writer-stamped 'open' — never caller-set. Exception:
 * the importer (`internal.via === 'import'`, unreachable through MCP) may
 * transcribe a joint in its historical state with its resolution/dissolution
 * artifacts — import is transcription, not replayed transitions.
 */
export async function judgmentJointAdd(cwd, args, internal = {}) {
  const importing = internal.via === 'import';
  return runOp(cwd, args, {
    tool: 'judgment_joint_add',
    validate: () => {
      if (args.state !== undefined && !importing) {
        throw typedError('JUDGMENT_INPUT', 'judgment_joint_add: state is the transition artifact — joints are born open');
      }
      const record = {
        slug: args.slug,
        question: args.question,
        branch_true: args.branch_true,
        branch_false: args.branch_false,
        resolve_by: args.resolve_by,
        cost: args.cost,
        rank: args.rank,
        state: importing ? (args.state ?? 'open') : 'open',
        provenance: stampProvenance(internal),
      };
      if (args.ext !== undefined) record.ext = args.ext;
      if (args.straddle !== undefined) record.straddle = args.straddle;
      if (args.flags !== undefined) record.flags = args.flags;
      if (importing) {
        if (args.resolution !== undefined) record.resolution = args.resolution;
        if (args.dissolution !== undefined) record.dissolution = args.dissolution;
      }
      assertValidRecord('joint', record);
      return record;
    },
    execute: (record) => {
      const store = createJudgmentStore(cwd);
      if (store.readJoint(record.slug)) {
        throw typedError('JUDGMENT_CONFLICT', `joint ${record.slug} already exists`);
      }
      const undo = new UndoLog();
      commitWithProjections(cwd, undo, () => {
        undo.created(store._jointPath(record.slug));
        store.writeJoint(record);
      });
      return { slug: record.slug, state: record.state, rank: record.rank };
    },
  });
}

// ---------------------------------------------------------------------------
// judgment_transition
// ---------------------------------------------------------------------------

function noteEvent(slug, title, body, provenance) {
  return { kind: 'note', title, body, anchor: `joint:${slug}`, provenance };
}

/**
 * Joint state machine + rank changes. Intent-first: the complete mutation is
 * persisted before the guard call; guard refusal/unavailability never leaves
 * a half-applied write. Rank changes (alone or alongside an edge) atomically
 * emit their `rank` ledger event in the same locked operation.
 */
const JOINT_STATES = ['open', 'under_test', 'resolved', 'inconclusive', 'superseded', 'dissolved'];
const RESOLVE_METHODS = ['EXT', 'INT', 'CONSTRUCT', 'ASSERT', 'STRADDLE'];

export async function judgmentTransition(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_transition',
    validate: () => {
      // Full sync shape validation BEFORE the idempotency wrapper (A1/A4):
      // a cached key must never mask malformed input.
      if (!args.slug) throw typedError('JUDGMENT_INPUT', 'judgment_transition: slug is required');
      if (!args.to && !args.rank) {
        throw typedError('JUDGMENT_INPUT', 'judgment_transition: provide a target state (to) and/or a rank change');
      }
      if (args.to !== undefined && !JOINT_STATES.includes(args.to)) {
        throw typedError('JUDGMENT_INPUT', `judgment_transition: unknown target state "${args.to}"`);
      }
      if (args.resolution !== undefined) assertValidRecord('resolution', args.resolution);
      if (args.dissolution !== undefined) assertValidRecord('dissolution', args.dissolution);
      if (args.ext !== undefined) assertValidRecord('ext_package', args.ext);
      if (args.straddle !== undefined) assertValidRecord('straddle_package', args.straddle);
      if (args.reopen !== undefined && typeof args.reopen.shaken_evidence_ref !== 'string') {
        throw typedError('JUDGMENT_INPUT', 'judgment_transition: reopen requires { shaken_evidence_ref }');
      }
      if (args.redispose !== undefined) {
        if (!RESOLVE_METHODS.includes(args.redispose.new_resolve_by)) {
          throw typedError('JUDGMENT_INPUT', 'judgment_transition: redispose requires new_resolve_by (EXT|INT|CONSTRUCT|ASSERT|STRADDLE)');
        }
        if (args.redispose.ext !== undefined) assertValidRecord('ext_package', args.redispose.ext);
        if (args.redispose.straddle !== undefined) assertValidRecord('straddle_package', args.redispose.straddle);
      }
      if (args.rank !== undefined && !['high', 'medium'].includes(args.rank.to)) {
        throw typedError('JUDGMENT_INPUT', 'judgment_transition: rank change requires rank.to (high|medium)');
      }
      return null;
    },
    execute: async () => {
      const store = createJudgmentStore(cwd);
      const joint = store.readJoint(args.slug);
      if (!joint) throw typedError('JUDGMENT_NOT_FOUND', `joint ${args.slug} does not exist`);
      const from = joint.state;
      const intentId = newIntentId();
      const provenance = stampProvenance({ ...internal, intentId });
      const events = [];
      const mutated = { ...joint };

      const isEdge = args.to !== undefined && args.to !== from;
      if (args.to !== undefined && args.to === from) {
        throw typedError('JUDGMENT_INPUT', `judgment_transition: joint ${args.slug} is already ${from}`);
      }

      if (isEdge) {
        assertEdgeArtifact(from, args.to, args);

        // Method packages attach ONLY at dispose (open → under_test) or via
        // the re-dispose input — never on resolution edges, where a supplied
        // package could silently erase a stored judgment-dispatch stamp.
        if ((args.ext || args.straddle) && !(from === 'open' && args.to === 'under_test')) {
          throw typedError('JUDGMENT_INPUT', 'judgment_transition: ext/straddle packages attach at dispose (open → under_test) or inside redispose — not on this edge');
        }
        // Re-dispose is exclusively the inconclusive → under_test|open input;
        // on any other edge it would swap the method and erase the stored
        // package (incl. a judgment-dispatch stamp) before the gates run.
        if (args.redispose && from !== 'inconclusive') {
          throw typedError('JUDGMENT_INPUT', 'judgment_transition: redispose is only legal on inconclusive → under_test|open (P3 retry-with-different-method)');
        }
        if (args.redispose) {
          mutated.resolve_by = args.redispose.new_resolve_by;
          delete mutated.ext;
          delete mutated.straddle;
          if (args.redispose.ext) mutated.ext = args.redispose.ext;
          if (args.redispose.straddle) mutated.straddle = args.redispose.straddle;
        }
        if (args.ext) mutated.ext = args.ext;
        if (args.straddle) mutated.straddle = args.straddle;

        assertMethodGate(mutated, args.to, args);

        // ONE-UNDER-TEST, inside the advisory lock (the writer-local floor).
        // A pending intent targeting under_test (kept alive by a guard
        // outage) occupies the slot too — recovery must not roll past one.
        if (args.to === 'under_test') {
          const other = store.listJoints().find((j) => j.slug !== args.slug && j.state === 'under_test');
          if (other) {
            throw typedError('JUDGMENT_CONFLICT', `ONE-UNDER-TEST: joint ${other.slug} is already under test`);
          }
          const pending = store.readIntents().find(
            (intent) => (
              intent.kind === 'transition'
              && intent.payload?.to === 'under_test'
              && intent.payload?.slug !== args.slug
            ),
          );
          if (pending) {
            throw typedError('JUDGMENT_CONFLICT', `ONE-UNDER-TEST: pending intent ${pending.id} already targets under_test for ${pending.payload.slug}`);
          }
        }

        // Per-edge apply semantics.
        if (['resolved', 'inconclusive', 'superseded'].includes(args.to)) {
          mutated.resolution = args.resolution;
        } else if (args.to === 'dissolved') {
          mutated.dissolution = args.dissolution;
        } else if (args.to === 'open' || (args.to === 'under_test' && args.redispose)) {
          // open-returning edges + re-dispose: the artifact is ledgered, the
          // stale resolution must not survive on the joint.
          if (args.resolution) {
            events.push(noteEvent(args.slug, `failed_to_run: ${args.slug}`, args.resolution.reason, provenance));
          }
          if (args.reopen) {
            events.push(noteEvent(
              args.slug,
              `reopened: ${args.slug}`,
              `shaken evidence: ${args.reopen.shaken_evidence_ref}${joint.resolution ? `; prior resolution: ${JSON.stringify(joint.resolution)}` : ''}`,
              provenance,
            ));
          }
          if (args.redispose) {
            events.push(noteEvent(
              args.slug,
              `re-disposed: ${args.slug}`,
              `new method: ${args.redispose.new_resolve_by}${joint.resolution ? `; prior resolution: ${JSON.stringify(joint.resolution)}` : ''}`,
              provenance,
            ));
          }
          delete mutated.resolution;
        }
        mutated.state = args.to;
      }

      let rankChange = null;
      if (args.rank) {
        if (!args.rank.to) throw typedError('JUDGMENT_INPUT', 'judgment_transition: rank change requires rank.to');
        if (args.rank.to !== joint.rank) {
          rankChange = { joint: args.slug, from: joint.rank, to: args.rank.to };
          mutated.rank = args.rank.to;
          events.push({
            kind: 'rank',
            title: `rank ${args.slug}: ${rankChange.from} → ${rankChange.to}`,
            refs: [args.slug],
            rank_change: rankChange,
            provenance,
          });
        }
      }
      if (!isEdge && !rankChange) {
        throw typedError('JUDGMENT_INPUT', `judgment_transition: rank is already ${joint.rank} — nothing to do`);
      }

      assertValidRecord('joint', mutated);
      for (const event of events) assertValidRecord('ledger_event', event);

      // Intent-first: persist the COMPLETE mutation before the guard call.
      const intent = {
        id: intentId,
        kind: 'transition',
        tool: 'judgment_transition',
        op: 'transition',
        payload: { slug: args.slug, from, to: mutated.state, joint: mutated, events, predictions: [] },
        created_at: provenance.written_at,
      };
      assertValidRecord('pending_intent', intent);
      store.persistIntent(intent);

      const publication = await publishIntentLocked(cwd, store, intent);
      if (publication.status === 'blocked') {
        throw typedError(
          'JUDGMENT_GUARD_UNAVAILABLE',
          `guard transition failed closed (intent ${intent.id} kept for replay): ${publication.error?.message ?? publication.reason}`,
          publication.error,
        );
      }
      if (publication.status === 'refused') {
        return {
          applied: false,
          refused: true,
          slug: args.slug,
          from,
          to: args.to,
          guard: publication.guard ?? {
            verdict: null,
            ledgerRef: null,
            currentState: null,
          },
          divergence: true,
        };
      }

      const result = { applied: true, slug: args.slug, from, to: mutated.state, state: mutated.state, rank: mutated.rank };
      if (publication.guard) result.guard = publication.guard;
      return result;
    },
  });
}

// ---------------------------------------------------------------------------
// judgment_ledger_append
// ---------------------------------------------------------------------------

const LEDGER_PASSTHROUGH_KEYS = [
  'kind', 'title', 'body', 'refs', 'rejected', 'conviction', 'trigger',
  'open_joints', 'prediction', 'disposition', 'recall_verdict', 'attribution',
  'prediction_ref', 'prediction_grade', 'reason', 'anchor', 'rank_change',
  'elicitation', 'rests_on',
];

function nextPredictionId(store) {
  return `p-${store.listPredictions().length + 1}`;
}

/**
 * Append a ledger event (kind-specific required fields enforced by the
 * schema). Writer-internal side-effects: a commit-moment `decide` (kind
 * decide + trigger) and a CONSTRUCT-disposition event spawn prediction
 * records from their embedded prediction; a `postmortem` carrying
 * prediction_ref + prediction_grade flips that prediction to graded.
 */
export async function judgmentLedgerAppend(cwd, args, internal = {}) {
  return runOp(cwd, args, {
    tool: 'judgment_ledger_append',
    validate: () => {
      if (args.kind === 'attest') {
        throw typedError(
          'JUDGMENT_INPUT',
          'judgment_ledger_append: attest is a writer-reserved intent publication event',
        );
      }
      const event = { provenance: stampProvenance(internal) };
      for (const key of LEDGER_PASSTHROUGH_KEYS) {
        if (args[key] !== undefined) event[key] = args[key];
      }
      assertValidRecord('ledger_event', event);
      return event;
    },
    execute: (event) => {
      const store = createJudgmentStore(cwd);

      let spawned = null;
      const isCommitDecide = event.kind === 'decide' && event.trigger !== undefined;
      if (isCommitDecide && (event.rests_on?.length ?? 0) > 0) {
        const effective = effectiveStore(store);
        if (effective.hasPendingIntentKind('goal_migration')) {
          throw typedError(
            'JUDGMENT_INTENT_PENDING',
            'judgment_ledger_append: goal_migration intent is still pending',
          );
        }
        for (const reference of event.rests_on) {
          const { clause } = resolveEffectiveGoalClause(
            effective,
            reference,
            { ledger: true },
          );
          if (clause.channel === 'inferred') {
            throw typedError(
              'JUDGMENT_INFERRED_COMMIT',
              `judgment_ledger_append: ${reference} is inferred and may not carry a commit`,
            );
          }
        }
      }
      const isConstructDisposition = event.disposition === 'CONSTRUCT';
      if ((isCommitDecide || isConstructDisposition) && event.prediction) {
        spawned = {
          id: nextPredictionId(store),
          text: event.prediction.text,
          outcome_criteria: event.prediction.outcome_criteria,
          made_at: event.provenance.written_at,
          context: isCommitDecide ? 'commit' : 'construct',
          refs: event.refs ?? [],
          status: 'open',
          provenance: event.provenance,
        };
        assertValidRecord('prediction', spawned);
      }

      let graded = null;
      if (event.kind === 'postmortem' && event.prediction_ref) {
        const prediction = store.readPrediction(event.prediction_ref);
        if (!prediction) throw typedError('JUDGMENT_NOT_FOUND', `prediction ${event.prediction_ref} does not exist`);
        graded = { ...prediction, status: 'graded', grade: event.prediction_grade };
        assertValidRecord('prediction', graded);
      }

      const undo = new UndoLog();
      let seq;
      commitWithProjections(cwd, undo, () => {
        undo.capture(store._ledgerPath());
        if (spawned) {
          const path = store._predictionPath(spawned.id);
          if (existsSync(path)) undo.capture(path);
          else undo.created(path);
        }
        if (graded) undo.capture(store._predictionPath(graded.id));
        ({ seq } = store.appendLedgerEvent(event));
        if (spawned) store.writePrediction(spawned);
        if (graded) store.writePrediction(graded);
      });

      const result = { seq, kind: event.kind };
      if (spawned) result.prediction_id = spawned.id;
      if (graded) result.graded = graded.id;
      return result;
    },
  });
}

// ---------------------------------------------------------------------------
// get_judgment_state (read)
// ---------------------------------------------------------------------------

/**
 * Session-load / P6-sweep read: register + under-test + open predictions +
 * recent ledger. Small result (AUDIT-19) — titles and refs, never full
 * document text. Replays pending intents first (reconciler-on-read).
 */
export async function getJudgmentState(cwd) {
  const release = await acquireJudgmentLock(cwd);
  try {
    const replay = await replayIntentsLocked(cwd);
    regenerateProjections(cwd);
    const store = effectiveStore(createJudgmentStore(cwd));
    const positions = store.listPositionSlugs().map((slug) => {
      const latest = store.latestPositionRevision(slug);
      return {
        slug,
        ref: `${slug}#r${latest.rev}`,
        status: store.derivePositionStatus(slug),
        conviction: latest.conviction?.level ?? null,
      };
    });
    const joints = store.listJoints().map((j) => ({
      slug: j.slug,
      state: j.state,
      resolve_by: j.resolve_by,
      cost: j.cost,
      rank: j.rank,
    }));
    const openPredictions = store.listPredictions({ status: 'open' })
      .map((p) => ({ id: p.id, text: p.text, context: p.context }));
    const recentLedger = store.readLedgerEvents().slice(-10)
      .map((e) => ({ kind: e.kind, title: e.title }));
    const people = store.listPeople();
    const latestGoal = store.latestGoalVersion();
    return {
      positions,
      joints,
      under_test: joints.filter((j) => j.state === 'under_test').map((j) => j.slug),
      open_predictions: openPredictions,
      recent_ledger: recentLedger,
      intents_replayed: replay.replayed,
      divergences: replay.divergences,
      counts: {
        people: {
          spoken: people.filter(
            (person) => person.facts.some((fact) => fact.channel === 'said'),
          ).length,
          stub: people.filter(
            (person) => !person.facts.some((fact) => fact.channel === 'said'),
          ).length,
        },
        entities: store.listSituationEntities().length,
        goal: {
          version: latestGoal?.version ?? null,
          ratified: Boolean(latestGoal?.ratification),
        },
      },
    };
  } finally {
    release();
  }
}
