// lib/gsd-headless-config.js
//
// COMP-GSD-6 S05: headless auto-resume policy. Reads `gsd.headless.*` from
// .compose/compose.json and merges over conservative defaults. Every pause kind
// is independently overridable (per the product decision): crash and stuck
// auto-resume by default, budget does NOT (opting in would defeat the GSD-4
// ceiling), but a user MAY set budget.enabled:true for a fully-unattended burn.
//
// Unset config ⇒ defaults ⇒ behavior is a plain run plus supervision.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const HEADLESS_DEFAULTS = Object.freeze({
  autoResume: {
    crash: { enabled: true, maxAttempts: 5 },
    stuck: { enabled: true, maxAttempts: 2 },
    budget: { enabled: false, maxAttempts: 0 },
    // COMP-GSD-6-WATCHDOG: a hung child (heartbeat frozen on a live pid) is
    // killed + resumed like a crash. On by default — that's the whole point of
    // unattended robustness.
    hung: { enabled: true, maxAttempts: 3 },
  },
  backoff: { baseMs: 2000, factor: 2, maxMs: 60000 },
  heartbeatStaleMs: 90000,
  // COMP-GSD-6-WATCHDOG: supervisor poll cadence, SIGTERM→SIGKILL grace, and the
  // child's independent wall-clock heartbeat cadence (must be < heartbeatStaleMs).
  watchdogPollMs: 15000,
  watchdogKillGraceMs: 5000,
  watchdogHeartbeatMs: 30000,
});

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}
function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function mergeKind(override, def) {
  const o = override ?? {};
  return {
    enabled: bool(o.enabled, def.enabled),
    maxAttempts: num(o.maxAttempts, def.maxAttempts),
  };
}

// Merge a raw `gsd.headless` object over HEADLESS_DEFAULTS with per-field type
// validation (a malformed field falls back to its default, never throws).
export function resolveHeadlessConfig(raw) {
  const h = raw && typeof raw === 'object' ? raw : {};
  const ar = h.autoResume && typeof h.autoResume === 'object' ? h.autoResume : {};
  const bo = h.backoff && typeof h.backoff === 'object' ? h.backoff : {};
  const d = HEADLESS_DEFAULTS;

  // COMP-GSD-6-WATCHDOG: enforce the load-bearing invariant
  // `watchdogHeartbeatMs < heartbeatStaleMs`. The child must restamp its heartbeat
  // at least twice within the stale window, or a healthy quiet child trips the
  // watchdog. A misconfiguration (heartbeat ≥ stale) is clamped to half the stale
  // window rather than honored.
  const heartbeatStaleMs = num(h.heartbeatStaleMs, d.heartbeatStaleMs);
  let watchdogHeartbeatMs = num(h.watchdogHeartbeatMs, d.watchdogHeartbeatMs);
  if (watchdogHeartbeatMs >= heartbeatStaleMs) {
    watchdogHeartbeatMs = Math.max(1, Math.floor(heartbeatStaleMs / 2));
  }

  return {
    autoResume: {
      crash: mergeKind(ar.crash, d.autoResume.crash),
      stuck: mergeKind(ar.stuck, d.autoResume.stuck),
      budget: mergeKind(ar.budget, d.autoResume.budget),
      hung: mergeKind(ar.hung, d.autoResume.hung),
    },
    backoff: {
      baseMs: num(bo.baseMs, d.backoff.baseMs),
      factor: num(bo.factor, d.backoff.factor),
      maxMs: num(bo.maxMs, d.backoff.maxMs),
    },
    heartbeatStaleMs,
    watchdogPollMs: num(h.watchdogPollMs, d.watchdogPollMs),
    watchdogKillGraceMs: num(h.watchdogKillGraceMs, d.watchdogKillGraceMs),
    watchdogHeartbeatMs,
  };
}

// Read .compose/compose.json gsd.headless.* and resolve against defaults.
export function readHeadlessConfig(cwd) {
  const configPath = join(cwd, '.compose', 'compose.json');
  let raw = {};
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      raw = cfg?.gsd?.headless ?? {};
    } catch {
      /* malformed config → defaults */
    }
  }
  return resolveHeadlessConfig(raw);
}

// Backoff for attempt N (1-based): base * factor^(N-1), capped at maxMs.
export function backoffMs(cfg, attempt) {
  const { baseMs, factor, maxMs } = cfg.backoff;
  const raw = baseMs * Math.pow(factor, Math.max(0, attempt - 1));
  return Math.min(raw, maxMs);
}
