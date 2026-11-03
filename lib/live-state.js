// lib/live-state.js — COMP-DOGFOOD-LIVE-STATE-1
//
// A workspace's live owner orders, plus the hard-rules block read fresh from
// disk, so every runner can re-read them after its context is compacted.
// Contract: contracts/live-state.schema.json (Store, Order, View).
//
// Store: <root>/.compose/data/live-state.json. Writes take a mkdir lock and go
// tmp + rename, so a ledger hook and an MCP call adding at once never tear it.
// A corrupt store is never overwritten: writes refuse, reads warn.
//
// Readers: get_current_session (`live_state`), the MCP tool live_state_get,
// lib/live-state-cli.js (the Claude mod and any other runner), all through
// buildLiveState() and formatLiveStateSection() below, so the block is the
// same text whichever runner asks.

import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const STORE_FILE = 'live-state.json';
export const SECTION_TITLE = 'Live orders and hard rules';
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
const RULE_FILE_MAX = 256 * 1024;
const TEXT_MAX = 4000;
const SOURCE_MAX = 200;
const BY_MAX = 80;
const REASON_MAX = 500;
const ID_RE = /^LO-[1-9][0-9]*$/;

export class LiveStateError extends Error {
  constructor(message, code) { super(message); this.name = 'LiveStateError'; this.code = code; }
}

export function storePath(dataDir) { return join(dataDir, STORE_FILE); }

function emptyStore() { return { version: 1, rules_dir: null, next_seq: 1, live_orders: [] }; }

/** The store, or an empty one when the file does not exist. Throws LiveStateError('corrupt') on a bad file. */
export function readStore(dataDir) {
  const file = storePath(dataDir);
  if (!existsSync(file)) return emptyStore();
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (err) {
    throw new LiveStateError(`live-state store unreadable (${file}): ${err.message}`, 'corrupt');
  }
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.live_orders)
      || !Number.isInteger(doc.next_seq) || doc.next_seq < 1) {
    throw new LiveStateError(`live-state store has the wrong shape (${file})`, 'corrupt');
  }
  return { rules_dir: null, ...doc };
}

function writeStore(dataDir, store) {
  mkdirSync(dataDir, { recursive: true });
  const file = storePath(dataDir);
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Read-modify-write under a mkdir lock (atomic on POSIX); a lock older than LOCK_STALE_MS is a dead holder's. */
function mutate(dataDir, fn) {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'live-state.lock');
  const start = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > LOCK_WAIT_MS) throw new LiveStateError('live-state store is locked by another writer', 'locked');
      sleepSync(20);
    }
  }
  try {
    const store = readStore(dataDir);
    const out = fn(store);
    writeStore(dataDir, store);
    return out;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function isoOrThrow(v, field) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new LiveStateError(`${field} must be an ISO date-time`, 'invalid');
  return new Date(Date.parse(v)).toISOString();
}

function str(v, field, max, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new LiveStateError(`${field} is required`, 'invalid');
    return undefined;
  }
  if (typeof v !== 'string') throw new LiveStateError(`${field} must be a string`, 'invalid');
  const t = v.trim();
  if (!t) throw new LiveStateError(`${field} is required`, 'invalid');
  if (t.length > max) throw new LiveStateError(`${field} is over ${max} characters`, 'invalid');
  return t;
}

/** Active: not superseded and not past `expires`. */
export function isActive(order, now = new Date()) {
  if (order.superseded_by) return false;
  if (order.expires && Date.parse(order.expires) <= now.getTime()) return false;
  return true;
}

/** Active orders, newest `at` first (ties: the later-added id first). */
export function activeOrders(store, now = new Date()) {
  const seq = (o) => Number(o.id.slice(3));
  return store.live_orders.filter((o) => isActive(o, now))
    .sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (seq(b) - seq(a)));
}

function markSuperseded(store, id, by, reason, nowIso) {
  if (!ID_RE.test(id)) throw new LiveStateError(`not an order id: ${id}`, 'invalid');
  const o = store.live_orders.find((x) => x.id === id);
  if (!o) throw new LiveStateError(`no order ${id}`, 'not_found');
  if (o.superseded_by) throw new LiveStateError(`${id} is already superseded by ${o.superseded_by}`, 'conflict');
  if (by === id) throw new LiveStateError(`${id} cannot supersede itself`, 'invalid');
  o.superseded_by = by;
  o.superseded_at = nowIso;
  if (reason) o.supersede_reason = reason;
  return o;
}

/**
 * Adds an order. The same text from the same source while an earlier copy is
 * still active returns that copy (`created: false`), so a hook that fires twice
 * for one ledger line adds it once. `supersedes` retires older orders in the same write.
 */
export function addOrder(dataDir, input = {}, { now = new Date() } = {}) {
  const text = str(input.text, 'text', TEXT_MAX);
  const source = str(input.source, 'source', SOURCE_MAX);
  const by = str(input.by, 'by', BY_MAX, { required: false });
  const at = input.at === undefined || input.at === null ? now.toISOString() : isoOrThrow(input.at, 'at');
  const expires = input.expires === undefined || input.expires === null ? null : isoOrThrow(input.expires, 'expires');
  if (expires && Date.parse(expires) <= Date.parse(at)) throw new LiveStateError('expires must be after at', 'invalid');
  const supersedes = input.supersedes === undefined ? [] : input.supersedes;
  if (!Array.isArray(supersedes) || !supersedes.every((s) => typeof s === 'string')) {
    throw new LiveStateError('supersedes must be a list of order ids', 'invalid');
  }
  return mutate(dataDir, (store) => {
    const dup = store.live_orders.find((o) => o.text === text && o.source === source && isActive(o, now));
    if (dup) return { order: dup, created: false, superseded: [] };
    const order = {
      id: `LO-${store.next_seq}`, text, at, source, ...(by ? { by } : {}),
      added_at: now.toISOString(), expires, superseded_by: null, superseded_at: null,
    };
    // validate every supersede before the first change, so a bad id leaves the store as it was
    for (const id of supersedes) {
      const o = store.live_orders.find((x) => x.id === id);
      if (!o) throw new LiveStateError(`no order ${id}`, 'not_found');
      if (o.superseded_by) throw new LiveStateError(`${id} is already superseded by ${o.superseded_by}`, 'conflict');
    }
    store.next_seq += 1;
    store.live_orders.push(order);
    const superseded = supersedes.map((id) => markSuperseded(store, id, order.id, undefined, order.added_at).id);
    return { order, created: true, superseded };
  });
}

/** Retires an order. `by` is the replacing order's id or a source string (a ledger line id). */
export function supersedeOrder(dataDir, input = {}, { now = new Date() } = {}) {
  const id = str(input.id, 'id', 20);
  const by = str(input.superseded_by, 'superseded_by', SOURCE_MAX);
  const reason = str(input.reason, 'reason', REASON_MAX, { required: false });
  return mutate(dataDir, (store) => {
    if (ID_RE.test(by) && !store.live_orders.some((o) => o.id === by)) {
      throw new LiveStateError(`superseded_by names no order: ${by}`, 'not_found');
    }
    return { order: { ...markSuperseded(store, id, by, reason, now.toISOString()) } };
  });
}

function containedDir(root, dir) {
  const rootReal = realpathSync(root);
  const abs = isAbsolute(dir) ? dir : resolve(root, dir);
  const real = realpathSync(abs);
  const rel = relative(rootReal, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new LiveStateError(`rules_dir is outside the workspace: ${dir}`, 'invalid');
  if (!statSync(real).isDirectory()) throw new LiveStateError(`rules_dir is not a directory: ${dir}`, 'invalid');
  return real;
}

/** Sets where the hard-rules files live (relative to the workspace root, which must contain it). */
export function configureLiveState(dataDir, { root, rules_dir } = {}) {
  const dir = str(rules_dir, 'rules_dir', 500);
  containedDir(root, dir);
  return mutate(dataDir, (store) => { store.rules_dir = dir; return { rules_dir: dir }; });
}

/**
 * Each top-level bullet of a rules file, whole: a line starting `- ` plus the
 * indented lines under it, up to a blank line, a heading or the next bullet.
 */
export function ruleBullets(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) { if (cur) out.push(cur.join('\n')); cur = [line.trimEnd()]; continue; }
    if (cur && /^\s+\S/.test(line)) { cur.push(line.trimEnd()); continue; }
    if (cur) { out.push(cur.join('\n')); cur = null; }
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}

/** The core rule files (H1 carries the word `core`) under rules_dir, read now. Never throws: errors land in `error`. */
export function readHardRules(root, rulesDir) {
  if (!rulesDir) return { dir: null, files: [], error: 'no rules_dir configured for this workspace (live_state_configure)' };
  let dir;
  try { dir = containedDir(root, rulesDir); } catch (err) {
    return { dir: rulesDir, files: [], error: err instanceof LiveStateError ? err.message : `rules_dir unreadable: ${rulesDir} (${err.code || err.message})` };
  }
  const files = [];
  const skipped = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    let text;
    try {
      const p = join(dir, name);
      if (statSync(p).size > RULE_FILE_MAX) { skipped.push(`${name} (over ${RULE_FILE_MAX} B)`); continue; }
      text = readFileSync(p, 'utf8');
    } catch (err) { skipped.push(`${name} (${err.code || 'unreadable'})`); continue; }
    const h1 = (text.split('\n').find((l) => l.startsWith('# ')) || '').slice(2).trim();
    if (!/\bcore\b/i.test(h1)) continue;
    files.push({ file: basename(name), title: h1, bullets: ruleBullets(text) });
  }
  const error = files.length === 0
    ? `no core rule files in ${rulesDir}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`
    : skipped.length ? `skipped: ${skipped.join(', ')}` : null;
  return { dir: rulesDir, files, error };
}

/**
 * The read view (contract View): the workspace's active orders and its hard
 * rules. An unbound session gets the same orders, with `bound: false`.
 */
export function buildLiveState({ root, dataDir, workspaceId = null, boundFeature = null, now = new Date() } = {}) {
  const view = {
    workspace: root ? { id: workspaceId, root } : null,
    bound: Boolean(boundFeature),
    bound_feature: boundFeature || null,
    orders: [],
    hard_rules: { dir: null, files: [], error: 'no workspace' },
    read_at: now.toISOString(),
    warnings: [],
  };
  if (!root) { view.warnings.push('workspace unknown: no live orders'); return view; }
  let store;
  try { store = readStore(dataDir || join(root, '.compose', 'data')); } catch (err) {
    view.warnings.push(`WARNING ${err.message}: no live orders read`);
    store = emptyStore();
  }
  view.orders = activeOrders(store, now);
  view.hard_rules = readHardRules(root, store.rules_dir);
  if (view.hard_rules.error) view.warnings.push(`hard rules: ${view.hard_rules.error}`);
  return view;
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The markdown section a runner injects after a compaction. Orders are never
 * cut; rule bullets are dropped from the end past `maxBytes`, and the section
 * says how many. `cachedNote` (a WARNING line) leads the body when the view
 * came from a cache.
 */
export function formatLiveStateSection(view, { maxBytes = 48_000, cachedNote = null } = {}) {
  const readAt = new Date(view.read_at);
  const head = [`## ${SECTION_TITLE} (Compose, ${localStamp(readAt)})`, ''];
  if (cachedNote) head.push(cachedNote, '');
  const ws = view.workspace ? `${view.workspace.id ?? 'workspace'} (${view.workspace.root})` : 'unknown';
  head.push(`Re-read from Compose for workspace ${ws}${view.bound ? `, session bound to ${view.bound_feature}` : ', session unbound'}. ` +
    'Where the compaction summary disagrees with these, these win.', '');
  for (const w of view.warnings) head.push(`WARNING ${w.replace(/^WARNING /, '')}`);
  if (view.warnings.length) head.push('');
  head.push(`### Live owner orders (${view.orders.length} active, newest first)`, '');
  if (view.orders.length === 0) head.push('- (none active)');
  for (const o of view.orders) {
    const when = localStamp(new Date(o.at));
    const meta = [o.source, o.by, o.expires ? `expires ${o.expires}` : null].filter(Boolean).join(', ');
    head.push(`- [${o.id}] ${when} (${meta}): ${o.text}`);
  }
  head.push('');
  const hr = view.hard_rules;
  head.push(`### Hard rules (${hr.dir ?? 'no rules dir'}, ${hr.files.length} core files, read from disk)`, '');
  if (hr.files.length === 0) head.push(`HARD RULES UNAVAILABLE: ${hr.error}`);
  const enc = (s) => Buffer.byteLength(s, 'utf8');
  let text = head.join('\n') + '\n';
  let cut = 0;
  for (const f of hr.files) {
    const fileHead = `#### ${f.file}: ${f.title}\n`;
    if (cut || enc(text) + enc(fileHead) > maxBytes) { cut += f.bullets.length; continue; }
    text += fileHead;
    for (const b of f.bullets) {
      if (cut || enc(text) + enc(b) + 1 > maxBytes) { cut += 1; continue; }
      text += b + '\n';
    }
  }
  if (cut) text += `\nWARNING ${cut} hard-rule bullets cut at the ${maxBytes} B cap; read the rest from ${hr.dir}\n`;
  return text;
}

/** The workspace root that holds `.compose/` at or above `start`, or null. */
export function findWorkspaceRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.compose', 'compose.json'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir || !up.startsWith(sep)) return null;
    dir = up;
  }
}
