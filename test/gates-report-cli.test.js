/**
 * gates-report-cli.test.js — CLI integration tests for `compose gates report`.
 *
 * Spawns the CLI binary with a fixture log injected via COMPOSE_GATE_LOG.
 * Covers:
 *   - text output shape (column headers, gate_id, stats)
 *   - JSON output via --format json
 *   - rubber-stamp flag via --rubber-stamp-ms
 *   - --since filter (no entries → "No gate log entries found")
 *   - --feature filter
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'gates-cli-test-'));
}

function makeEntry(overrides = {}) {
  return {
    id: randomUUID(),
    gate_id: overrides.gate_id ?? 'build:design',
    decision: overrides.decision ?? 'approve',
    operator: 'ruze',
    duration_to_decide_ms: overrides.duration_to_decide_ms ?? 3500,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    feature_code: overrides.feature_code ?? 'COMP-TEST',
    decision_event_id: randomUUID(),
    ...overrides,
  };
}

function writeLog(logPath, entries) {
  writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function runCLI(args, env = {}) {
  return spawnSync(process.execPath, [COMPOSE_BIN, 'gates', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('compose gates report — text output', () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = makeTmpDir();
    logPath = join(dir, 'gate-log.jsonl');
    const entries = [
      makeEntry({ gate_id: 'build:design', decision: 'approve', duration_to_decide_ms: 4000 }),
      makeEntry({ gate_id: 'build:design', decision: 'approve', duration_to_decide_ms: 1000 }), // rubber stamp
      makeEntry({ gate_id: 'build:design', decision: 'interrupt', duration_to_decide_ms: 8000 }),
      makeEntry({ gate_id: 'build:plan',   decision: 'approve',   duration_to_decide_ms: 1500 }), // rubber stamp
    ];
    writeLog(logPath, entries);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  test('outputs header and gate_id rows', () => {
    const r = runCLI(['report', '--since', '1h'], { COMPOSE_GATE_LOG: logPath });
    assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
    assert.ok(r.stdout.includes('gate_id'), `missing header: ${r.stdout}`);
    assert.ok(r.stdout.includes('build:design'), `missing build:design row: ${r.stdout}`);
    assert.ok(r.stdout.includes('build:plan'), `missing build:plan row: ${r.stdout}`);
  });

  test('rubber_stamp candidate marker appears for high rubber-stamp gate', () => {
    const r = runCLI(['report', '--since', '1h', '--rubber-stamp-ms', '2000'], { COMPOSE_GATE_LOG: logPath });
    assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
    // build:plan has 1/1 decisions below 2000ms → rubber-stamp candidate
    assert.ok(r.stdout.includes('rubber-stamp candidate') || r.stdout.includes('rubber_stamp'), `${r.stdout}`);
  });

  test('--since filters out old entries', () => {
    const oldEntry = makeEntry({ gate_id: 'old:gate', timestamp: '2020-01-01T00:00:00Z' });
    const logPath2 = join(dir, 'old-gate-log.jsonl');
    writeLog(logPath2, [oldEntry]);
    const r = runCLI(['report', '--since', '24h'], { COMPOSE_GATE_LOG: logPath2 });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('No gate log entries found'), `expected empty message: ${r.stdout}`);
  });
});

describe('compose gates report — JSON output', () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = makeTmpDir();
    logPath = join(dir, 'gate-log.jsonl');
    const entries = [
      makeEntry({ gate_id: 'build:design', decision: 'approve', duration_to_decide_ms: 2000 }),
      makeEntry({ gate_id: 'build:design', decision: 'deny',    duration_to_decide_ms: 9000 }),
    ];
    writeLog(logPath, entries);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  test('--format json produces parseable JSON array', () => {
    const r = runCLI(['report', '--since', '1h', '--format', 'json'], { COMPOSE_GATE_LOG: logPath });
    assert.equal(r.status, 0, `CLI exited non-zero: ${r.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, 'output must be valid JSON');
    assert.ok(Array.isArray(parsed), 'JSON output must be array');
    assert.ok(parsed.length >= 1, 'must have at least one row');
    const row = parsed.find(r => r.gate_id === 'build:design');
    assert.ok(row, 'build:design row missing');
    assert.ok('logged_decisions' in row, 'logged_decisions field missing');
    assert.ok('approve_pct' in row, 'approve_pct field missing');
    assert.ok('deny_pct' in row, 'deny_pct field missing');
    assert.ok('interrupt_pct' in row, 'interrupt_pct field missing');
    assert.ok('median_ms' in row, 'median_ms field missing');
    assert.ok('rubber_stamp_pct' in row, 'rubber_stamp_pct field missing');
    assert.equal(row.logged_decisions, 2);
  });

  test('rubber_stamp_pct calculation correct (1 of 2 below 3000ms)', () => {
    const r = runCLI(['report', '--since', '1h', '--format', 'json'], { COMPOSE_GATE_LOG: logPath });
    const parsed = JSON.parse(r.stdout);
    const row = parsed.find(r => r.gate_id === 'build:design');
    // 2000ms < 3000ms → 1/2 = 50%
    assert.equal(row.rubber_stamp_pct, 50);
  });
});

describe('compose gates report — --feature filter', () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = makeTmpDir();
    logPath = join(dir, 'gate-log.jsonl');
    const entries = [
      makeEntry({ gate_id: 'build:design', feature_code: 'FC-A' }),
      makeEntry({ gate_id: 'build:plan',   feature_code: 'FC-B' }),
    ];
    writeLog(logPath, entries);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  test('--feature filters output to one feature', () => {
    const r = runCLI(['report', '--since', '1h', '--feature', 'FC-A', '--format', 'json'], { COMPOSE_GATE_LOG: logPath });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1, 'expected only FC-A gate');
    assert.equal(parsed[0].gate_id, 'build:design');
  });
});
