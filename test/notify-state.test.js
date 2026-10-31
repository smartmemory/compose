/**
 * notify-state.test.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: Compose's own notify list over the real routes (express on a
 * loopback ephemeral port), on a scratch `COMPOSE_NOTIFY_STATE` file, never `~/.compose/notify-state.json`.
 * One row table: each row is one request (or a seeded file) and what the response and the file must show.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachNotifyStateRoutes, resolveNotifyStatePath } from '../server/notify-state-routes.js';

const TOKEN = 'notify-state-test-token';
const NOW = Date.parse('2026-10-31T21:00:00.000Z');
const inH = (h) => new Date(NOW + h * 3_600_000).toISOString();

async function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-state-'));
  const file = join(dir, 'notify-state.json');
  const prevToken = process.env.COMPOSE_API_TOKEN;
  process.env.COMPOSE_API_TOKEN = TOKEN;
  const warns = [];
  const app = express();
  app.use(express.json());
  attachNotifyStateRoutes(app, { env: { COMPOSE_NOTIFY_STATE: file }, now: () => NOW, warn: (m) => warns.push(m) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, { token = TOKEN } = {}) => {
    const res = await fetch(`${base}/api/notify/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-compose-token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async () => (await fetch(`${base}/api/notify/state`)).json();
  try {
    await fn({ post, get, file, dir, warns });
  } finally {
    await new Promise((r) => server.close(r));
    if (prevToken === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = prevToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('/api/notify/state', () => {
  it('COMPOSE_NOTIFY_STATE overrides the home path', () => {
    assert.equal(resolveNotifyStatePath({ COMPOSE_NOTIFY_STATE: '/x/y.json' }), '/x/y.json');
    assert.match(resolveNotifyStatePath({}), /\.compose\/notify-state\.json$/);
  });

  // [name, (ctx) => Promise<void>]
  const ROWS = [
    ['ack round-trips with its meta', async ({ post, get }) => {
      const r = await post({ key: 'disk', action: 'ack', meta: { title: 'Disk 80 GB free', sinceAt: inH(-1) } });
      assert.equal(r.status, 200);
      assert.deepEqual((await get()).entries.disk, { action: 'ack', at: new Date(NOW).toISOString(), title: 'Disk 80 GB free', sinceAt: inH(-1) });
    }],
    ['snooze stores until', async ({ post, get }) => {
      assert.equal((await post({ key: 'attention:seat1 5h', action: 'snooze', until: inH(2), meta: { seat: 'seat1' } })).status, 200);
      const e = (await get()).entries['attention:seat1 5h'];
      assert.equal(e.action, 'snooze');
      assert.equal(e.until, inH(2));
    }],
    ['dismiss then restore deletes the entry', async ({ post, get }) => {
      await post({ key: 'ctx:abc', action: 'dismiss' });
      assert.equal((await get()).entries['ctx:abc'].action, 'dismiss');
      await post({ key: 'ctx:abc', action: 'restore' });
      assert.equal((await get()).entries['ctx:abc'], undefined);
    }],
    ['release keeps a tombstone (no longer cleared, the mark survives)', async ({ post, get }) => {
      await post({ key: 'outage', action: 'ack', meta: { title: 'Claude API outage', sinceAt: inH(-2) } });
      await post({ key: 'outage', action: 'release' });
      const e = (await get()).entries.outage;
      assert.equal(e.action, 'released');
      assert.equal(e.was, 'ack');
      assert.equal(e.title, 'Claude API outage');
      assert.equal(e.sinceAt, inH(-2));
    }],
    ['release with no entry is a no-op', async ({ post, get }) => {
      assert.equal((await post({ key: 'queue:Q1', action: 'release' })).status, 200);
      assert.deepEqual((await get()).entries, {});
    }],
    ['security ack is allowed, dismiss and snooze are 400 with a reason', async ({ post, warns }) => {
      assert.equal((await post({ key: 'security:S1', action: 'ack', meta: { textHash: 'deadbeef' } })).status, 200);
      const d = await post({ key: 'security:S1', action: 'dismiss' });
      assert.equal(d.status, 400);
      assert.match(d.body.error, /security row/);
      assert.equal((await post({ key: 'security:S1', action: 'snooze', until: inH(1) })).status, 400);
      assert.equal(warns.filter((w) => w.includes('security:S1')).length, 2);
    }],
    ['snooze without until, in the past or more than 8 days ahead is 400', async ({ post }) => {
      assert.equal((await post({ key: 'disk', action: 'snooze' })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'snooze', until: inH(-1) })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'snooze', until: inH(8 * 24 + 1) })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'snooze', until: inH(8 * 24 - 1) })).status, 200);
    }],
    ['a bad key, a long key, an unknown action, answered and an unknown meta field are 400', async ({ post, get }) => {
      assert.equal((await post({ key: 'evil:1', action: 'ack' })).status, 400);
      assert.equal((await post({ key: 'ask:', action: 'ack' })).status, 400);
      assert.equal((await post({ key: `ctx:${'x'.repeat(200)}`, action: 'ack' })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'answered' })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'ack', meta: { answer: 'x' } })).status, 400);
      assert.equal((await post({ key: 'disk', action: 'ack', meta: { title: 'x'.repeat(141) } })).status, 400);
      assert.deepEqual((await get()).entries, {});
    }],
    ['entries older than 30 days are pruned on write', async ({ post, get, file }) => {
      const old = new Date(NOW - 31 * 86_400_000).toISOString();
      const young = new Date(NOW - 29 * 86_400_000).toISOString();
      writeFileSync(file, JSON.stringify({ v: 1, entries: { 'ctx:old': { action: 'ack', at: old }, 'ctx:young': { action: 'ack', at: young } } }));
      await post({ key: 'disk', action: 'ack' });
      assert.deepEqual(Object.keys((await get()).entries).sort(), ['ctx:young', 'disk']);
    }],
    ['the atomic write leaves no temp file and valid JSON', async ({ post, dir, file }) => {
      for (let i = 0; i < 5; i += 1) await post({ key: `ctx:s${i}`, action: 'ack' });
      assert.deepEqual(readdirSync(dir), ['notify-state.json']);
      assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf-8')).entries).length, 5);
    }],
    ['without the token a write is 401 and nothing is written', async ({ post, get }) => {
      assert.equal((await post({ key: 'disk', action: 'ack' }, { token: null })).status, 401);
      assert.equal((await post({ key: 'disk', action: 'ack' }, { token: 'wrong' })).status, 401);
      assert.deepEqual((await get()).entries, {});
    }],
    ['an unreadable file reads as empty, with one warning', async ({ get, file, warns }) => {
      writeFileSync(file, '{not json');
      assert.deepEqual((await get()).entries, {});
      await get();
      assert.equal(warns.filter((w) => w.includes('unreadable')).length, 1);
    }],
  ];
  it('rows', async () => {
    for (const [name, run] of ROWS) {
      await withApp(async (ctx) => {
        try { await run(ctx); } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
      });
    }
  });
});
