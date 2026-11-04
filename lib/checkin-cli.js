#!/usr/bin/env node
/**
 * lib/checkin-cli.js — the coordinator's and lane leads' check-in view, read from Compose state (COMP-DOGFOOD-CUTOVER-1, row I).
 *
 *   node lib/checkin-cli.js --root <workspace> [--hours 24] [--json]
 *
 * Read only. Sections, each from the Compose module that owns it:
 *   launches in flight  the newest launch event per mark (last N h) is a counted `launch.running` (its `ev:` receipt, launch-events.js)
 *                       or a `launch.requested` (no receipt yet), and its pid answers `kill -0` now. Compose has no exit event, so a
 *                       launch whose pid is gone is counted under `launches ended` (not listed), never shown as in flight
 *   completions         `record_completion` rows of feature-events.jsonl in the last N h
 *   owner gates         the pending owner gates (owner-gates.js readOwnerGates; unreadable is "unknown", never 0)
 *   live orders         the active owner orders (live-state.js)
 *   ledger records      ledger lines recorded in Compose in the last N h, by writer (ledger-records.js)
 * Exit 0; 2 when a section could not be read (it is printed as unknown with the reason); 1 on bad usage.
 */
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEvents } from './feature-events.js';
import { readLaunchEvents } from './launch-events.js';
import { readLedgerRecords } from './ledger-records.js';
import { activeOrders, readStore } from './live-state.js';
import { readOwnerGates } from './owner-gates.js';
import { fileForRoot } from './owner-gates-cli.js';

const USAGE = 'usage: node lib/checkin-cli.js --root <workspace> [--hours <n>] [--json]';
const LIST_MAX = 20;
const ms = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const evMs = (e) => ms(e.at) ?? ms(e.launched_at) ?? ms(e.ts);

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The check-in view as data. `deps.alive(pid)` and `ownerQueueFile` are for tests. */
export function buildCheckin({ root, hours = 24, now = Date.now(), alive = pidAlive, ownerQueueFile, warn = () => {} }) {
  const since = now - hours * 3_600_000;
  const view = { root, hours, since: new Date(since).toISOString(), read_at: new Date(now).toISOString(), unknown: [] };
  const section = (name, fn) => {
    try { return fn(); } catch (e) { view.unknown.push(`${name}: ${e.message}`); return null; }
  };
  section('launches', () => {
    const last = new Map();
    for (const e of [...readLaunchEvents(root)].sort((a, b) => (evMs(a) ?? 0) - (evMs(b) ?? 0))) {
      if (e.tool?.startsWith('launch.') && e.mark) last.set(e.mark, e);
    }
    view.launches_in_flight = [];
    view.launches_ended = { running_seen: 0, requested_only: 0 };
    for (const e of last.values()) {
      const t = evMs(e);
      if (t === null || t < since) continue;
      const running = e.tool === 'launch.running' && typeof e.evidence_id === 'string' && e.evidence_id.startsWith('ev:');
      if (!running && e.tool !== 'launch.requested') continue;
      const up = alive(e.pid);
      if (up === false) { view.launches_ended[running ? 'running_seen' : 'requested_only'] += 1; continue; }
      view.launches_in_flight.push({ label: e.label, unit: e.unit ?? null, session: e.session, pid: e.pid ?? null, alive: up,
        state: running ? 'running' : 'requested', evidence_id: running ? e.evidence_id : null, at: new Date(t).toISOString() });
    }
    view.launches_in_flight.sort((x, y) => (x.at < y.at ? 1 : -1));
  });
  section('completions', () => {
    view.completions = readEvents(root, { since, tool: 'record_completion' })
      .map((e) => ({ code: e.code ?? null, completion_id: e.completion_id ?? null, commit_sha: e.commit_sha ?? null, at: e.ts }))
      .reverse();
  });
  section('owner gates', () => {
    const r = readOwnerGates({ file: ownerQueueFile ?? fileForRoot(root), now, warn });
    if (r.unreadable) throw new Error(r.error);
    view.owner_gates = r.gates.map((g) => ({ id: g.id, unit: g.unit, by: g.by, summary: g.summary, age_s: g.age_s }));
  });
  section('live orders', () => {
    view.live_orders = activeOrders(readStore(join(root, '.compose', 'data')), new Date(now)).map((o) => ({ id: o.id, by: o.by ?? null, at: o.at, text: o.text }));
  });
  section('ledger records', () => {
    const rows = readLedgerRecords(root, { since, warn });
    const byWriter = {};
    for (const r of rows) byWriter[r.by] = (byWriter[r.by] ?? 0) + 1;
    view.ledger = { count: rows.length, by_writer: byWriter, last: rows.slice(-5).map((r) => r.line) };
  });
  return view;
}

const cut = (s, n = 110) => { const t = String(s ?? '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The check-in view as text: one header line per section with its count, then at most LIST_MAX rows. */
export function formatCheckin(v) {
  const out = [`CHECKIN ${v.root} last ${v.hours} h (since ${v.since}), read ${v.read_at}`];
  const list = (title, rows, fmt) => {
    if (!rows) return;
    out.push(`${title}: ${rows.length}`);
    for (const r of rows.slice(0, LIST_MAX)) out.push(`  ${fmt(r)}`);
    if (rows.length > LIST_MAX) out.push(`  ... ${rows.length - LIST_MAX} more`);
  };
  list('launches in flight', v.launches_in_flight, (r) => `${r.label} session=${r.session} pid=${r.pid}${r.alive === null ? ' (pid unknown)' : ''} ${r.state} ${r.evidence_id ?? 'no receipt yet'} at=${r.at}`);
  if (v.launches_ended) out.push(`launches ended (pid gone, no exit event in Compose): ${v.launches_ended.running_seen} seen running, ${v.launches_ended.requested_only} never seen running`);
  list('completions', v.completions, (r) => `${r.code} ${r.completion_id ?? ''} ${r.commit_sha ? String(r.commit_sha).slice(0, 12) : ''} at=${r.at}`);
  list('owner gates pending', v.owner_gates, (r) => `${r.id} ${r.unit ?? ''} age=${Math.round(r.age_s / 60)}m ${cut(r.summary, 90)}`);
  list('live orders', v.live_orders, (r) => `${r.id} ${r.by ?? ''} ${cut(r.text)}`);
  if (v.ledger) {
    const w = Object.entries(v.ledger.by_writer).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ');
    out.push(`ledger records: ${v.ledger.count}${w ? ` (${w})` : ''}`);
    for (const l of v.ledger.last) out.push(`  ${cut(l, 140)}`);
  }
  for (const u of v.unknown) out.push(`UNKNOWN ${u}`);
  return `${out.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }, deps = {}) {
  const i = argv.indexOf('--root');
  const root = i >= 0 ? argv[i + 1] : undefined;
  const h = argv.indexOf('--hours');
  const hours = h >= 0 ? Number(argv[h + 1]) : 24;
  if (!root || !Number.isFinite(hours) || hours <= 0) { io.err.write(`${USAGE}\n`); return 1; }
  const view = buildCheckin({ root, hours, warn: (m) => io.err.write(`${m}\n`), ...deps });
  io.out.write(argv.includes('--json') ? `${JSON.stringify(view)}\n` : formatCheckin(view));
  return view.unknown.length ? 2 : 0;
}

const _self = fileURLToPath(import.meta.url);
let _entry = null;
try { _entry = process.argv[1] && realpathSync(process.argv[1]); } catch { _entry = null; }
if (_entry === _self) process.exitCode = main();
