/**
 * notify-state-routes.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: Compose's own notify list, the state behind the alert and
 * inbox actions (acknowledge, snooze, dismiss, restore, release, and `answered` from the answer route).
 *
 * File: `~/.compose/notify-state.json` (env `COMPOSE_NOTIFY_STATE` overrides). Home-scoped, because the per-project data
 * dir moves on a project switch and an acknowledgement is about the fleet, not a project. Written with an atomic
 * temp+rename (the `settings-store.js` `_save` pattern), entries older than 30 days pruned on every write.
 * Shape: `{v: 1, entries: {<key>: {action, at, until?, title?, lane?, seat?, sinceAt?, textHash?, answer?, first?, was?}}}`.
 *
 *   GET  /api/notify/state  -> {v, entries, generated}
 *   POST /api/notify/state  {key, action, until?, meta?} -> {ok, v, entries, generated}   (requireSensitiveOrPaired)
 *
 * The same state rides on every GET /api/fleet body as `notify` (fleet-routes.js), so the cockpit reads it on the
 * fleet poll it already runs. `answered` is never accepted here: only the answer route writes it (`store.answered`).
 * `release` keeps a tombstone (`action: 'released'`, `was`) so the Day ribbon can still draw the cleared mark after its
 * source drops the row; a released key is no longer cleared, so a later row with the same key is a new alert.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { requireSensitiveOrPaired } from './security.js';

export const NOTIFY_STATE_ROUTE = '/api/notify/state';
export const PRUNE_MS = 30 * 86_400_000;
export const MAX_SNOOZE_MS = 8 * 86_400_000;
const PREFIXES = ['security:', 'ask:', 'queue:', 'ctx:', 'attention:'];
const EXACT = ['disk', 'outage'];
const ACTIONS = ['ack', 'snooze', 'dismiss', 'restore', 'release'];
const SECURITY_ACTIONS = ['ack', 'restore', 'release'];
const META = {
  title: (v) => typeof v === 'string' && v.length <= 140,
  lane: (v) => typeof v === 'string' && v.length > 0 && v.length <= 100,
  seat: (v) => typeof v === 'string' && v.length > 0 && v.length <= 40,
  sinceAt: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
  textHash: (v) => typeof v === 'string' && /^[0-9a-f]{8}$/.test(v),
};

export function resolveNotifyStatePath(env = process.env) {
  return env.COMPOSE_NOTIFY_STATE || path.join(homedir(), '.compose', 'notify-state.json');
}

/** A known key: at most 200 characters, a known prefix with something after it, or an exact single-row key. */
export function validKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return false;
  if (EXACT.includes(key)) return true;
  return PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
}

/** `null` when the request is valid, else the refusal reason. */
export function validateWrite({ key, action, until, meta } = {}, nowMs = Date.now()) {
  if (!validKey(key)) return 'key must be at most 200 characters and start with a known prefix';
  if (!ACTIONS.includes(action)) return `action must be one of ${ACTIONS.join('|')}`;
  if (key.startsWith('security:') && !SECURITY_ACTIONS.includes(action)) return 'a security row can only be acknowledged, restored or released';
  if (action === 'snooze') {
    const t = typeof until === 'string' ? Date.parse(until) : NaN;
    if (!Number.isFinite(t)) return 'snooze needs until (an ISO time)';
    if (t <= nowMs) return 'until must be in the future';
    if (t - nowMs > MAX_SNOOZE_MS) return 'until must be at most 8 days ahead';
  }
  if (meta != null) {
    if (typeof meta !== 'object' || Array.isArray(meta)) return 'meta must be an object';
    for (const [k, v] of Object.entries(meta)) {
      if (!Object.hasOwn(META, k)) return `meta.${String(k).slice(0, 40)} is not allowed`;
      if (!META[k](v)) return `meta.${k} is invalid`;
    }
  }
  return null;
}

export function createNotifyStateStore({ file = resolveNotifyStatePath(), now = Date.now, warn = console.warn } = {}) {
  let warnedRead = false;

  function read() {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (doc && typeof doc.entries === 'object' && doc.entries !== null && !Array.isArray(doc.entries)) {
        warnedRead = false;
        return { v: 1, entries: doc.entries };
      }
      throw new Error('no entries object');
    } catch (err) {
      if (err.code !== 'ENOENT' && !warnedRead) {
        warnedRead = true;
        warn(`[notify-state] unreadable ${file}: ${String(err.message).slice(0, 200)}; treating it as empty`);
      }
      return { v: 1, entries: {} };
    }
  }

  function save(entries) {
    const cutoff = now() - PRUNE_MS;
    const kept = {};
    for (const [k, e] of Object.entries(entries)) {
      const at = Date.parse(e?.at ?? '');
      if (Number.isFinite(at) && at >= cutoff) kept[k] = e;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: kept }, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore cleanup failure */ }
      throw new Error(`Failed to persist notify state: ${err.message}`);
    }
    return { v: 1, entries: kept };
  }

  const stamp = () => new Date(now()).toISOString();

  return {
    file,
    get: () => read(),
    /** `{ok: true, state}` or `{ok: false, status, reason}`. */
    apply(body) {
      const reason = validateWrite(body, now());
      if (reason) return { ok: false, status: 400, reason };
      const { key, action, until, meta } = body;
      const { entries } = read();
      const prev = entries[key] ?? null;
      if (action === 'restore') delete entries[key];
      else if (action === 'release') {
        if (prev && (prev.action === 'ack' || prev.action === 'dismiss')) {
          const { action: was, until: _u, ...rest } = prev;
          entries[key] = { ...rest, action: 'released', was, at: stamp() };
        }
      } else {
        entries[key] = { action, at: stamp(), ...(action === 'snooze' ? { until: new Date(Date.parse(until)).toISOString() } : {}), ...(meta ?? {}) };
      }
      return { ok: true, state: save(entries) };
    },
    /** The answer route's write: `{action: 'answered', at, answer, first?, ts?}` (`ts` = the answered queue record's, so a re-ask is not hidden); keeps a prior `sinceAt` for the ribbon. */
    answered(key, { answer, first, ts } = {}) {
      const { entries } = read();
      const prev = entries[key] ?? null;
      entries[key] = {
        action: 'answered',
        at: stamp(),
        answer: String(answer ?? '').slice(0, 1200),
        ...(first ? { first: String(first).slice(0, 140) } : {}),
        ...(Number.isFinite(ts) ? { ts } : {}),
        ...(prev?.sinceAt ? { sinceAt: prev.sinceAt } : {}),
      };
      return save(entries);
    },
  };
}

/** Mount GET/POST /api/notify/state; returns the store (fleet-routes.js puts it on /api/fleet and the answer route writes `answered`). */
export function attachNotifyStateRoutes(app, { env = process.env, store, now = Date.now, warn = console.warn } = {}) {
  const st = store ?? createNotifyStateStore({ file: resolveNotifyStatePath(env), now, warn });
  app.get(NOTIFY_STATE_ROUTE, (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json({ ...st.get(), generated: new Date(now()).toISOString() });
  });
  app.post(NOTIFY_STATE_ROUTE, requireSensitiveOrPaired, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const keyLog = JSON.stringify(String(body.key ?? '')).slice(0, 220);
    let out;
    try {
      out = st.apply(body);
    } catch (err) {
      warn(`[notify-state] write failed for ${keyLog}: ${String(err.message).slice(0, 200)}`);
      return res.status(500).json({ ok: false, error: 'the notify state could not be written' });
    }
    if (!out.ok) {
      warn(`[notify-state] refused ${keyLog}: ${out.reason}`);
      return res.status(out.status).json({ ok: false, error: out.reason });
    }
    res.set('cache-control', 'no-store');
    return res.json({ ok: true, ...out.state, generated: new Date(now()).toISOString() });
  });
  return st;
}
