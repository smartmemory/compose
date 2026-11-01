/**
 * COMP-NOTIFY-GATES-1: a Compose gate posts one owner ask through the ops notify
 * client, and an answer from the phone, a chat or the digest reaches the gate once.
 *
 * Shapes come from the HITL-1 envelope contract (smart-memory-docs
 * docs/features/HITL-1/notify-envelope-contract.json): `Post`, `_grammar.post_id`,
 * `AnswerEvent`, `ProductReply`, `Close`, enums `channel`, `close_outcome_ask`,
 * `answer_reply`. This file points at those names; it does not restate them.
 *
 * Off unless COMPOSE_NOTIFY_GATES=1. Nothing here may fail a build: every notify
 * failure is one WARNING and today's behaviour.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveGateTimeoutMs } from './gate-timeout.js';
import { VisionWriter } from './vision-writer.js';

export const GATE_SOURCE = 'compose.gate';
// The resolve route's own vocabulary (server/vision-routes.js VALID_RESOLVE_OUTCOMES).
export const GATE_OPTIONS = Object.freeze([
  { value: 'approve', label: 'Approve' },
  { value: 'revise', label: 'Revise' },
  { value: 'kill', label: 'Kill' },
]);
const OPTION_VALUES = GATE_OPTIONS.map((o) => o.value);
const SEVERITIES = ['info', 'warn', 'critical'];
const NATIVE = /^[A-Za-z0-9._-]+$/;               // _grammar.post_id <native>, <episode>
const CHAT_CHANNEL = /^chat:[a-z0-9][a-z0-9-]*$/; // enums._patterns["chat:<session>"]
const FIXED_CHANNELS = ['phone', 'digest', 'compose', 'cadence', 'popup', 'mcp'];
const POST_ID_MAX = 200;   // _grammar.post_id_max_length (R14)
const TITLE_MAX = 120;     // R15
const BODY_MAX = 1000;     // R15
const ENQUEUE_TIMEOUT_MS = 10_000;
const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;
const NOTIFY_PREFIX = 'notify:';

export function notifyGatesEnabled(env = process.env) {
  return env.COMPOSE_NOTIFY_GATES === '1';
}

export function channelOk(value) {
  return typeof value === 'string' && (FIXED_CHANNELS.includes(value) || CHAT_CHANNEL.test(value));
}

/** `<flowId>:<stepId>:<round>` -> `compose.gate:<flowId>.<stepId>:<round>`, or null when it cannot meet R14. */
export function gatePostId(gateId) {
  const parts = typeof gateId === 'string' ? gateId.split(':') : [];
  if (parts.length !== 3) return null;
  const [flowId, stepId, round] = parts;
  const native = `${flowId}.${stepId}`;
  if (!flowId || !stepId || !NATIVE.test(native) || !NATIVE.test(round)) return null;
  const postId = `${GATE_SOURCE}:${native}:${round}`;
  return postId.length <= POST_ID_MAX ? postId : null;
}

function clip(text, n) {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

// R11 is a prose rule (the service cannot see a secret), so the product masks the
// obvious shapes before a summary leaves the Mac.
const SECRET_SHAPES = [
  /\b((?:api[_-]?key|token|secret|password|passwd|bearer)\s*[:=]\s*)\S+/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g,
];
export function maskSecrets(text) {
  return SECRET_SHAPES.reduce((acc, re) => acc.replace(re, (m, keep) => (typeof keep === 'string' ? `${keep}***` : '***')), text);
}

/** Contract `Post` for one gate. `gate` needs id, stepId, createdAt; summary is optional. */
export function buildGatePost(gate, { featureCode, summary, env = process.env } = {}) {
  const postId = gatePostId(gate.id);
  if (!postId) return null;
  const severity = SEVERITIES.includes(env.COMPOSE_NOTIFY_GATE_SEVERITY) ? env.COMPOSE_NOTIFY_GATE_SEVERITY : 'critical';
  const title = clip(`Gate ${gate.stepId}: ${featureCode}`.replace(/[\r\n]+/g, ' '), TITLE_MAX);
  const body = summary ? clip(maskSecrets(String(summary)), BODY_MAX) : '';
  const card = { title, ...(body ? { body } : {}), options: GATE_OPTIONS.map((o) => ({ ...o })) };
  return {
    post_id: postId,
    realm: 'owner',
    source: GATE_SOURCE,
    type: 'ask',
    kind: 'gate',
    subject: featureCode,
    // No `escalation`: escalation_defaults[severity] applies. No default/default_at: a gate never defaults (R7).
    severity,
    card,
    deadline: new Date(Date.parse(gate.createdAt) + resolveGateTimeoutMs(env)).toISOString(),
    callback: 'pull',
    payload: { gate_id: gate.id }, // R8/R16: the handle only; the pointer file is how an answer finds the gate
    version: gate.createdAt,
  };
}

/** Contract `Close` for an ask (R6: answered | defaulted | withdrawn). */
export function buildGateClose(postId, outcome, channel) {
  return { post_id: postId, outcome, channel };
}

/** Where a resolved gate's answer entered: `notify:<ch>` -> `<ch>`; web UI, CLI, terminal -> `compose`. */
export function channelOfResolvedBy(resolvedBy) {
  if (typeof resolvedBy === 'string' && resolvedBy.startsWith(NOTIFY_PREFIX)) {
    const ch = resolvedBy.slice(NOTIFY_PREFIX.length);
    if (channelOk(ch)) return ch;
  }
  return 'compose';
}

// ---------------------------------------------------------------------------
// The notify client (ops claude/scripts/notify_client.py enqueue: one op on stdin)
// ---------------------------------------------------------------------------

export function notifyClientPath(env = process.env) {
  return env.COMPOSE_NOTIFY_CLIENT || path.join(os.homedir(), '.claude', 'scripts', 'notify_client.py');
}

/** Resolves `{ ok, reason }`; never rejects. `spawnImpl` is injectable for tests. */
export function enqueueNotify(op, { env = process.env, spawnImpl = spawn, timeoutMs = ENQUEUE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, reason) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok, reason }); } };
    let child;
    try {
      child = spawnImpl('python3', [notifyClientPath(env), 'enqueue'], { stdio: ['pipe', 'ignore', 'ignore'], env });
    } catch (err) {
      done(false, `spawn failed (${err.code || err.name})`);
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(false, 'timeout'); }, timeoutMs);
    child.on('error', (err) => done(false, `spawn failed (${err.code || err.name})`));
    child.on('close', (code) => done(code === 0, code === 0 ? null : `exit ${code}`));
    child.stdin.on('error', () => { /* the close handler reports it */ });
    child.stdin.end(JSON.stringify(op));
  });
}

// ---------------------------------------------------------------------------
// Pointer file: <dir>/<sha256(post_id)>.json -> the gate record, and its tombstone
// ---------------------------------------------------------------------------

export function pointerDir(env = process.env) {
  return env.COMPOSE_NOTIFY_GATES_DIR || path.join(os.homedir(), '.compose', 'notify-gates');
}

function keyOf(postId) {
  return crypto.createHash('sha256').update(postId).digest('hex');
}

export function pointerPath(postId, env = process.env) {
  return path.join(pointerDir(env), `${keyOf(postId)}.json`);
}

function tombstonePath(postId, env) {
  return path.join(pointerDir(env), 'closed', `${keyOf(postId)}.json`);
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writePointer(ptr, env = process.env) {
  writeJsonAtomic(pointerPath(ptr.post_id, env), ptr);
}

export function readPointer(postId, env = process.env) {
  const ptr = readJson(pointerPath(postId, env));
  return ptr && ptr.post_id === postId ? ptr : null;
}

export function readTombstone(postId, env = process.env) {
  const t = readJson(tombstonePath(postId, env));
  return t && t.post_id === postId ? t : null;
}

/**
 * Close-time bookkeeping: the live pointer goes away, and a tombstone keeps only
 * what a late answer needs (the winning value and channel), so it gets `conflict`
 * rather than `unknown gate`. Tombstones older than a week are pruned here.
 */
export function retirePointer(postId, { outcome, winningValue = null, channel = null, now = Date.now() } = {}, env = process.env) {
  try {
    writeJsonAtomic(tombstonePath(postId, env), {
      post_id: postId, outcome, winning_value: winningValue, channel, closed_at: new Date(now).toISOString(),
    });
  } catch { /* a missing tombstone only turns a late conflict into unknown gate */ }
  try { fs.rmSync(pointerPath(postId, env), { force: true }); } catch { /* best effort */ }
  const closedDir = path.join(pointerDir(env), 'closed');
  try {
    for (const name of fs.readdirSync(closedDir)) {
      const file = path.join(closedDir, name);
      if (now - fs.statSync(file).mtimeMs > TOMBSTONE_TTL_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* nothing to prune */ }
}

// ---------------------------------------------------------------------------
// Build side: post, then close exactly once
// ---------------------------------------------------------------------------

/**
 * Post the ask for a gate the build just created. Returns a handle with
 * `closeFor(resolvedGate)` and `withdraw()`, or null when nothing was posted.
 * Never throws.
 */
export async function openGateAsk({ gateId, featureCode, summary, writer, dataDir, env = process.env, log = console.warn, enqueue = enqueueNotify }) {
  try {
    const postId = gatePostId(gateId);
    if (!postId) {
      log(`WARNING: gate ${gateId} cannot map to a notify post_id (R14); not posted`);
      return null;
    }
    const gate = await writer.getGate(gateId);
    if (!gate?.createdAt) {
      log(`WARNING: gate ${gateId} not readable after create; not posted`);
      return null;
    }
    const post = buildGatePost(gate, { featureCode, summary, env });
    writePointer({
      post_id: postId, gate_id: gateId, data_dir: dataDir,
      workspace_id: writer.workspaceId ?? null, port: writer._port ?? null, version: post.version,
      via_server: writer.lastGateViaServer ?? null, deadline: post.deadline,
    }, env);
    const res = await enqueue({ op: 'post', body: post }, { env });
    if (!res.ok) {
      log(`WARNING: gate ${gateId} notify post not enqueued (${res.reason}); answer it in Compose`);
      retirePointer(postId, { outcome: 'withdrawn' }, env);
      return null;
    }
    return makeAskHandle(postId, gateId, { env, log, enqueue });
  } catch (err) {
    log(`WARNING: gate ${gateId} notify post failed (${err.message}); answer it in Compose`);
    return null;
  }
}

function makeAskHandle(postId, gateId, { env, log, enqueue }) {
  let closed = false;
  const send = async (outcome, channel, winningValue) => {
    if (closed) return;
    closed = true;
    retirePointer(postId, { outcome, winningValue, channel }, env);
    const res = await enqueue({ op: 'close', body: buildGateClose(postId, outcome, channel) }, { env });
    if (!res.ok) log(`WARNING: gate ${gateId} notify close not enqueued (${res.reason})`);
  };
  return {
    postId,
    get closed() { return closed; },
    /** Resolved gate -> `answered`. A notify answer's close rides the handler's reply (notify-cmd), so it is not sent twice. */
    async closeFor(gate) {
      if (closed) return;
      const channel = channelOfResolvedBy(gate?.resolvedBy);
      if (typeof gate?.resolvedBy === 'string' && gate.resolvedBy.startsWith(NOTIFY_PREFIX)) {
        closed = true;
        retirePointer(postId, { outcome: 'answered', winningValue: gate.outcome ?? null, channel }, env);
        return;
      }
      await send('answered', channel, gate?.outcome ?? null);
    },
    /** Cancel, timeout, expiry, error. */
    async withdraw() {
      await send('withdrawn', 'compose', null);
    },
  };
}

// ---------------------------------------------------------------------------
// Answer side: `compose gate answer` (AnswerEvent on stdin -> ProductReply on stdout)
// ---------------------------------------------------------------------------

const rejected = (reason) => ({ reply: 'rejected', reason });
const conflict = (winningValue, channel) => ({ reply: 'conflict', winning_value: String(winningValue ?? ''), channel });

function conflictFromGate(gate) {
  return conflict(gate.outcome, channelOfResolvedBy(gate.resolvedBy));
}

// M2: the deadline the post carried wins; a legacy pointer without it keeps the old env rule.
function postedDeadlineMs(ptr, gate, env) {
  const posted = typeof ptr.deadline === 'string' ? Date.parse(ptr.deadline) : NaN;
  return Number.isFinite(posted) ? posted : Date.parse(gate.createdAt) + resolveGateTimeoutMs(env);
}

function defaultWriterFor(ptr) {
  return new VisionWriter(ptr.data_dir, { port: ptr.port ?? undefined, workspaceId: ptr.workspace_id ?? undefined });
}

/**
 * One AnswerEvent -> one ProductReply (contract `answer_reply`). `channel` and `by`
 * are read from the event only, never set (R12). Idempotent on a retried event:
 * the second delivery finds the gate resolved by itself and replies conflict with
 * its own value, which the service ignores for an already-latched post (R3).
 * Throws only on a transient store/server failure, so the client retries.
 */
export async function answerGate(event, { env = process.env, now = Date.now(), writerFor = defaultWriterFor } = {}) {
  const postId = typeof event?.post_id === 'string' ? event.post_id : null;
  const ptr = postId ? readPointer(postId, env) : null;
  if (!ptr) {
    const tomb = postId ? readTombstone(postId, env) : null;
    if (tomb?.outcome === 'answered') return conflict(tomb.winning_value, tomb.channel);
    if (tomb) return rejected('withdrawn');
    return rejected('unknown gate');
  }
  if (!channelOk(event.channel)) return rejected('bad channel');

  const writer = writerFor(ptr);
  const viaRest = await writer._serverAvailable();
  // M1: a gate created through the server is answered through it. A probe miss is transient
  // (exit 3, the client keeps its cursor and retries), never a file write the server would erase.
  if (!viaRest && ptr.via_server === true) throw new Error('compose server unreachable for a server-created gate; retry');
  const gate = viaRest ? await writer._restGetGate(ptr.gate_id) : writer._directGetGate(ptr.gate_id);
  if (!gate) return rejected('unknown gate');
  if (gate.status === 'resolved') return conflictFromGate(gate);
  if (gate.status === 'expired' || now > postedDeadlineMs(ptr, gate, env)) return rejected('expired');
  if (gate.status !== 'pending') return rejected(`gate ${gate.status}`);
  if ((event.version ?? null) !== ptr.version) return rejected('stale version');
  if (!OPTION_VALUES.includes(event.value)) return rejected('bad value');

  const resolvedBy = `${NOTIFY_PREFIX}${event.channel}`;
  const note = typeof event.note === 'string' ? event.note : null;
  if (viaRest) {
    let body;
    try {
      body = await writer._restResolveGate(ptr.gate_id, event.value, note, resolvedBy);
    } catch (err) {
      if (/ failed: 409\b/.test(err.message)) return rejected('expired');
      if (/ failed: 404\b/.test(err.message)) return rejected('unknown gate');
      throw err;
    }
    if (body?.alreadyResolved) return conflict(body.gateOutcome, channelOfResolvedBy(body.resolvedBy));
  } else {
    const res = writer._directResolveGate(ptr.gate_id, event.value, note, resolvedBy);
    if (!res) return rejected('unknown gate');
    if (res.alreadyResolved) return conflictFromGate(res.gate);
  }
  // notify-cmd (ops notify_client pull_answers) enqueues this close after `accepted`;
  // the build's closeFor() skips its own close for a notify:* resolution.
  return { reply: 'accepted', close: buildGateClose(postId, 'answered', event.channel) };
}
