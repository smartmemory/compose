/**
 * feature-events.test.js — coverage for lib/feature-events.js
 * (COMP-MCP-ROADMAP-WRITER T2).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendEvent, readEvents, normalizeSince } from '../lib/feature-events.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'feature-events-'));
}

describe('feature-events.appendEvent', () => {
  test('writes a row and stamps ts + actor', () => {
    const cwd = freshCwd();
    const row = appendEvent(cwd, { tool: 'add_roadmap_entry', code: 'FOO-1' });
    assert.equal(row.tool, 'add_roadmap_entry');
    assert.equal(row.code, 'FOO-1');
    assert.ok(typeof row.ts === 'string');
    assert.ok(row.actor.length > 0);

    const eventsPath = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    assert.ok(existsSync(eventsPath));
  });

  test('respects COMPOSE_ACTOR env var', () => {
    const prev = process.env.COMPOSE_ACTOR;
    process.env.COMPOSE_ACTOR = 'cockpit:user-42';
    try {
      const cwd = freshCwd();
      const row = appendEvent(cwd, { tool: 'set_feature_status', code: 'FOO-1' });
      assert.equal(row.actor, 'cockpit:user-42');
    } finally {
      if (prev === undefined) delete process.env.COMPOSE_ACTOR;
      else process.env.COMPOSE_ACTOR = prev;
    }
  });

  test('throws when tool is missing', () => {
    const cwd = freshCwd();
    assert.throws(() => appendEvent(cwd, {}), /tool is required/);
    assert.throws(() => appendEvent(cwd, { tool: '' }), /tool is required/);
    assert.throws(() => appendEvent(cwd), /tool is required/);
  });

  test('preserves additive fields beyond the canonical set', () => {
    const cwd = freshCwd();
    appendEvent(cwd, {
      tool: 'set_feature_status',
      code: 'X-1',
      from: 'PLANNED',
      to: 'IN_PROGRESS',
      idempotency_key: 'k1',
      custom_thing: 'preserved',
    });
    const all = readEvents(cwd);
    assert.equal(all.length, 1);
    assert.equal(all[0].custom_thing, 'preserved');
    assert.equal(all[0].idempotency_key, 'k1');
  });
});

describe('feature-events.readEvents', () => {
  test('returns empty array when file missing', () => {
    const cwd = freshCwd();
    assert.deepEqual(readEvents(cwd), []);
  });

  test('reads multiple appended events in order', () => {
    const cwd = freshCwd();
    appendEvent(cwd, { tool: 't', code: 'A' });
    appendEvent(cwd, { tool: 't', code: 'B' });
    appendEvent(cwd, { tool: 't', code: 'C' });
    const events = readEvents(cwd);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.code), ['A', 'B', 'C']);
  });

  test('filter by code', () => {
    const cwd = freshCwd();
    appendEvent(cwd, { tool: 't', code: 'A' });
    appendEvent(cwd, { tool: 't', code: 'B' });
    const events = readEvents(cwd, { code: 'A' });
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'A');
  });

  test('filter by tool', () => {
    const cwd = freshCwd();
    appendEvent(cwd, { tool: 'add_roadmap_entry', code: 'A' });
    appendEvent(cwd, { tool: 'set_feature_status', code: 'A' });
    const events = readEvents(cwd, { tool: 'set_feature_status' });
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'set_feature_status');
  });

  test('skips malformed lines without throwing', () => {
    const cwd = freshCwd();
    const path = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ ts: new Date().toISOString(), tool: 'good', code: 'A' }),
      'not json garbage',
      JSON.stringify({ ts: new Date().toISOString(), tool: 'good', code: 'B' }),
      '',
    ].join('\n'));
    const events = readEvents(cwd);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.code), ['A', 'B']);
  });

  test('filter by since with shorthand', () => {
    const cwd = freshCwd();
    const path = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    const now = Date.now();
    writeFileSync(path, [
      JSON.stringify({ ts: new Date(now - 48 * 3600_000).toISOString(), tool: 't', code: 'OLD' }),
      JSON.stringify({ ts: new Date(now - 1 * 3600_000).toISOString(), tool: 't', code: 'RECENT' }),
    ].join('\n'));
    const recent = readEvents(cwd, { since: '24h' });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].code, 'RECENT');
  });

  test('filter by since with ISO date', () => {
    const cwd = freshCwd();
    const path = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 't', code: 'OLD' }),
      JSON.stringify({ ts: '2026-12-01T00:00:00Z', tool: 't', code: 'NEW' }),
    ].join('\n'));
    const filtered = readEvents(cwd, { since: '2026-06-01T00:00:00Z' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].code, 'NEW');
  });
});

describe('feature-events.normalizeSince', () => {
  test('shorthand h/d/m', () => {
    const before = Date.now();
    const h24 = normalizeSince('24h');
    const after = Date.now();
    assert.ok(h24 >= before - 24 * 3600_000 && h24 <= after - 24 * 3600_000 + 1);

    const d7 = normalizeSince('7d');
    assert.ok(d7 < h24);

    const m30 = normalizeSince('30m');
    assert.ok(m30 > h24);
  });

  test('ISO date', () => {
    assert.equal(normalizeSince('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
  });

  test('Date object', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    assert.equal(normalizeSince(d), d.getTime());
  });

  test('number passes through', () => {
    assert.equal(normalizeSince(1234567890), 1234567890);
  });

  test('null/undefined return null (no filter)', () => {
    assert.equal(normalizeSince(undefined), null);
    assert.equal(normalizeSince(null), null);
  });

  test('garbage strings return null', () => {
    assert.equal(normalizeSince('not a date'), null);
  });
});
