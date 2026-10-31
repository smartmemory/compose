/**
 * COMP-COCKPIT-13 U1: GET /api/process over a fixture tree (test/fixtures/process). Real route on a loopback
 * ephemeral port; each row copies the fixture tree to a temp dir (so mtimes are controllable), optionally mutates it,
 * and runs a sequence of requests with a controllable clock. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachProcessRoutes, resolveProcessSources } from '../server/process-routes.js';

const FIX = fileURLToPath(new URL('./fixtures/process/', import.meta.url));
const NOW = 1_800_000_000_000;
const TTL = { builder: 10_000, stamps: 10_000 };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const age = (file, s) => { const t = (NOW - s * 1000) / 1000; utimesSync(file, t, t); };

async function withApp({ mutate = () => {}, remote = false, mount = true }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'process-routes-'));
  cpSync(FIX, root, { recursive: true });
  mutate(root);
  const env = { COMPOSE_OPS_STATUS_DIR: join(root, 'out'), COMPOSE_PROCESS_QUEUES_DIR: join(root, 'queues'), COMPOSE_PROCESS_EXTRA: '', COMPOSE_PROCESS_KPI_HISTORY: join(root, 'kpi-history.jsonl') };
  const app = express();
  const clock = { t: NOW };
  const warns = [];
  const infos = [];
  const mounted = mount ? attachProcessRoutes(app, { remote, env, sources: resolveProcessSources(env), now: () => clock.t, ttlMs: TTL, warn: (m) => warns.push(m), info: (m) => infos.push(m) }) : false;
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const raw = () => fetch(`http://127.0.0.1:${server.address().port}/api/process`);
  const get = async () => { const res = await raw(); assert.equal(res.status, 200); return res.json(); };
  try { await fn({ root, get, raw, clock, warns, infos, mounted }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}

const touchAll = (root) => {
  for (const f of ['master/process.json', 'hub/summary.json', 'main/summary.json']) age(join(root, 'out', f), 0);
};

// [name, options, check]
const ROWS = [
  ['fixture tree: each page value deep-equals its summary.json, table equals process.json, envelope recorded', { mutate: touchAll }, async ({ get, root }) => {
    const body = await get();
    const { builder, stamps } = body.sources;
    assert.equal(builder.error, null);
    for (const name of ['hub', 'main']) {
      assert.deepEqual(builder.value.pages[name].value, readJson(join(root, 'out', name, 'summary.json')), name);
    }
    assert.deepEqual(builder.value.table, readJson(join(root, 'out/master/process.json')));
    assert.equal(builder.value.asOf, '2026-10-30 20:56 local');
    assert.deepEqual(Object.keys(stamps.value.lanes), ['hub', 'main']);
    assert.equal(stamps.value.lanes.main.timeSplit.known, 3);
    assert.deepEqual(stamps.value.lanes.main.timeSplit.byRule, { 'U-a': 1, 'U-b': 1, 'U-c': 1, 'U-d': 1, 'U-e': 1 });
    assert.equal(stamps.value.lanes.main.timeSplit.outside, 1);
    assert.deepEqual(stamps.value.lanes.hub.warnings, ['1 rows skipped (not an object)']);
    // L7: the recorded envelope U2's view test feeds without mounting express (generated time and clock-free)
    const out = fileURLToPath(new URL('./fixtures/process/api-process.json', import.meta.url));
    if (process.env.RECORD_PROCESS_ENVELOPE === '1') writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
    assert.deepEqual(readJson(out), body, 'test/fixtures/process/api-process.json is stale: rerun with RECORD_PROCESS_ENVELOPE=1');
  }],
  ['L4: a key missing from summary.json passes through as absent, never 0', { mutate: touchAll }, async ({ get }) => {
    const main = (await get()).sources.builder.value.pages.main.value;
    assert.equal('gate_minutes' in main, false);
    assert.deepEqual(main.no_data, { gate_minutes: 'no data (n=0, needs gates[] stamps with result pass)' });
  }],
  ['stale page: mtime 1801 s old is marked stale, figures kept', { mutate: (root) => { touchAll(root); age(join(root, 'out/hub/summary.json'), 1801); } }, async ({ get }) => {
    const { pages } = (await get()).sources.builder.value;
    assert.equal(pages.hub.stale, true);
    assert.equal(pages.hub.ageS, 1801);
    assert.equal(pages.hub.value.waiting_share.pct, 17);
    assert.equal(pages.main.stale, false);
  }],
  ['failed page: BUILD-FAILED.txt shows beside the last good figures', { mutate: touchAll }, async ({ get }) => {
    const { pages } = (await get()).sources.builder.value;
    assert.deepEqual(pages.main.failed, { time: '2026-10-30 20:50 local', reason: 'summary build raised: fixture reason' });
    assert.equal(pages.main.value.waiting_share.pct, 36);
    assert.equal(pages.hub.failed, null);
  }],
  ['a summary.json that is not JSON is that page\'s error, the other pages render', { mutate: (root) => { touchAll(root); writeFileSync(join(root, 'out/hub/summary.json'), '{nope'); } }, async ({ get }) => {
    const { pages } = (await get()).sources.builder.value;
    assert.equal(pages.hub.value, null);
    assert.equal(pages.hub.error, 'hub: summary.json not JSON');
    assert.equal(pages.main.error, null);
  }],
  ['process.json missing: pages are found from the subdirs, the table is unavailable, P1-P5 still serve', { mutate: (root) => rmSync(join(root, 'out/master'), { recursive: true }) }, async ({ get }) => {
    const { builder } = (await get()).sources;
    assert.equal(builder.value.table, null);
    assert.equal(builder.value.tableError, 'master: process.json not found');
    assert.deepEqual(Object.keys(builder.value.pages), ['hub', 'main']);
  }],
  ['status dir missing: builder errors, stamps still served', { mutate: (root) => rmSync(join(root, 'out'), { recursive: true }) }, async ({ get, warns }) => {
    const { builder, stamps } = (await get()).sources;
    assert.equal(builder.value, null);
    assert.equal(builder.error, 'status dir not found');
    assert.equal(stamps.error, null);
    assert.equal(warns[0], '[process] builder unavailable: status dir not found');
    assert.equal(warns.filter((w) => w.includes('builder')).length, 1);
  }],
  ['L6: status dir absent at mount, present on the next load, is served without a restart', { mutate: (root) => renameSync(join(root, 'out'), join(root, 'out-later')) }, async ({ get, root, clock, infos }) => {
    assert.equal((await get()).sources.builder.error, 'status dir not found');
    renameSync(join(root, 'out-later'), join(root, 'out'));
    clock.t += 11_000; // past the ttl: stale-while-revalidate serves the old value once, the refresh runs
    await get();
    await new Promise((r) => setTimeout(r, 50));
    const builder = (await get()).sources.builder;
    assert.equal(builder.error, null);
    assert.deepEqual(Object.keys(builder.value.pages), ['hub', 'main']);
    assert.deepEqual(infos, ['[process] builder recovered']);
  }],
  ['queues dir missing: stamps outage with one [process] warn, recovery logs one info', { mutate: (root) => renameSync(join(root, 'queues'), join(root, 'queues-later')) }, async ({ get, root, clock, warns, infos }) => {
    const first = (await get()).sources;
    assert.equal(first.stamps.value, null);
    assert.equal(first.stamps.error, 'queues dir not found');
    assert.equal(first.builder.error, null);
    clock.t += 11_000;
    await get(); await new Promise((r) => setTimeout(r, 50)); // still down: refresh fails again, no second warn
    assert.deepEqual(warns, ['[process] stamps unavailable: queues dir not found']);
    renameSync(join(root, 'queues-later'), join(root, 'queues'));
    clock.t += 11_000;
    await get(); await new Promise((r) => setTimeout(r, 50));
    assert.equal((await get()).sources.stamps.error, null);
    assert.deepEqual(infos, ['[process] stamps recovered']);
  }],
  ['a lane file that is not JSON is that lane\'s error, the other lanes render', { mutate: (root) => writeFileSync(join(root, 'queues/hub-units.json'), '{nope') }, async ({ get, warns }) => {
    const { lanes } = (await get()).sources.stamps.value;
    assert.equal(lanes.hub.error, 'hub: not JSON');
    assert.equal(lanes.hub.timeSplit, null);
    assert.equal(lanes.main.error, null);
    assert.equal(warns[0], '[process] hub: not JSON');
  }],
  ['skipped rows and rejected stamps are warned once per change, never silently dropped', {}, async ({ get, warns, clock }) => {
    await get();
    assert.deepEqual(warns, ['[process] hub: 1 rows skipped, 0 units with a rejected stamp', '[process] main: 0 rows skipped, 1 units with a rejected stamp']);
    clock.t += 11_000; await get(); await new Promise((r) => setTimeout(r, 50)); // same counts: no new line
    assert.equal(warns.length, 2);
  }],
  ['single flight: concurrent GETs share one load per source', {}, async ({ get, root }) => {
    const bodies = await Promise.all([get(), get(), get(), get()]);
    assert.equal(new Set(bodies.map((b) => b.sources.builder.ts)).size, 1);
    assert.equal(new Set(bodies.map((b) => b.sources.stamps.ts)).size, 1);
    assert.ok(root);
  }],
  // U5: the daily KPI history behind the tile sparklines (forge/status/kpi-history.jsonl, written by the status builder)
  ['history: no file yet is empty lanes, no warning, nothing logged', {}, async ({ get, warns }) => {
    const { history } = (await get()).sources;
    assert.deepEqual(history.value, { lanes: {}, warnings: [] });
    assert.equal(history.error, null);
    assert.deepEqual(warns.filter((w) => w.includes('history')), []);
  }],
  ['history: two lanes, oldest first, a later line for the same day wins, a bad value reads null', { mutate: (root) => writeFileSync(join(root, 'kpi-history.jsonl'), [
    { date: '2026-10-31', lane: 'hub', waiting_share: 17, first_pass_clean: 40, review_rounds: 1, gate_minutes: null, standard: 97.6 },
    { date: '2026-10-30', lane: 'hub', waiting_share: 19, first_pass_clean: 38.5, review_rounds: 1, gate_minutes: null, standard: 97 },
    { date: '2026-10-31', lane: 'main', waiting_share: 36, first_pass_clean: 37, review_rounds: 'one', gate_minutes: 1, standard: 86.5 },
    { date: '2026-10-31', lane: 'hub', waiting_share: 18, first_pass_clean: 40, review_rounds: 1, gate_minutes: null, standard: 97.6 },
  ].map((r) => JSON.stringify(r)).join('\n')) }, async ({ get }) => {
    const { lanes, warnings } = (await get()).sources.history.value;
    assert.deepEqual(Object.keys(lanes).sort(), ['hub', 'main']);
    assert.deepEqual(lanes.hub.map((p) => [p.date, p.waiting_share]), [['2026-10-30', 19], ['2026-10-31', 18]]);
    assert.deepEqual(lanes.main, [{ date: '2026-10-31', waiting_share: 36, first_pass_clean: 37, review_rounds: null, gate_minutes: 1, standard: 86.5 }]);
    assert.deepEqual(warnings, []);
  }],
  ['history: a line that is not JSON or has no lane is skipped and counted, the rest serve', { mutate: (root) => writeFileSync(join(root, 'kpi-history.jsonl'),
    `{nope\n${JSON.stringify({ date: '2026-10-31', waiting_share: 1 })}\n${JSON.stringify({ date: '2026-10-31', lane: 'hub', waiting_share: 17 })}\n`) }, async ({ get }) => {
    const { history } = (await get()).sources;
    assert.deepEqual(history.value.lanes.hub.map((p) => p.waiting_share), [17]);
    assert.deepEqual(history.value.warnings, ['2 history lines skipped (not JSON, or no date or lane)']);
  }],
  ['history: at most the last 30 days per lane', { mutate: (root) => writeFileSync(join(root, 'kpi-history.jsonl'),
    Array.from({ length: 35 }, (_, i) => JSON.stringify({ date: `2026-09-${String(i + 1).padStart(2, '0')}`.replace(/^2026-09-3([1-5])$/, '2026-10-0$1'), lane: 'hub', waiting_share: i })).join('\n')) }, async ({ get }) => {
    const hub = (await get()).sources.history.value.lanes.hub;
    assert.equal(hub.length, 30);
    assert.deepEqual([hub[0].waiting_share, hub[29].waiting_share], [5, 34]);
  }],
  ['remote mode mounts nothing', { remote: true }, async ({ raw, mounted }) => {
    assert.equal(mounted, false);
    assert.equal((await raw()).status, 404);
  }],
];

describe('GET /api/process', () => {
  for (const [name, opts, check] of ROWS) it(name, () => withApp(opts, check));
});
