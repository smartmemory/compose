/**
 * Tests for lib/roadmap-drift.js — emits roadmap_drift events with
 * read-side dedupe and stderr warning.
 *
 * COMP-MCP-MIGRATION-2-1-1 T2 (Option A).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitDrift } from '../lib/roadmap-drift.js';
import { readEvents } from '../lib/feature-events.js';

let cwd;
let stderrCaptured;
let originalStderrWrite;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'compose-drift-test-'));
  stderrCaptured = '';
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrCaptured += String(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  rmSync(cwd, { recursive: true, force: true });
});

describe('emitDrift', () => {
  test('writes roadmap_drift event when override differs from rollup', () => {
    emitDrift(cwd, {
      phaseId: 'Phase 7: MCP Writers',
      override: 'PARTIAL (SURFACE-4 complete)',
      computed: 'COMPLETE',
    });
    const events = readEvents(cwd);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'roadmap_drift');
    assert.equal(events[0].code, 'Phase 7: MCP Writers');
    assert.equal(events[0].from, 'COMPLETE');
    assert.equal(events[0].to, 'PARTIAL (SURFACE-4 complete)');
    assert.equal(events[0].reason, 'override-vs-rollup-divergence');
  });

  test('emits stderr warn line on every call', () => {
    emitDrift(cwd, {
      phaseId: 'Phase X',
      override: 'PARTIAL',
      computed: 'COMPLETE',
    });
    assert.match(stderrCaptured, /WARN: phase "Phase X"/);
    assert.match(stderrCaptured, /override "PARTIAL"/);
    assert.match(stderrCaptured, /rollup "COMPLETE"/);
  });

  test('dedupes same drift triple within 24h window', () => {
    const args = {
      phaseId: 'Phase X',
      override: 'PARTIAL',
      computed: 'COMPLETE',
    };
    emitDrift(cwd, args);
    emitDrift(cwd, args); // same triple
    const events = readEvents(cwd);
    assert.equal(events.length, 1, 'second call should not write a duplicate event');
  });

  test('stderr warn fires on both calls even when event is deduped', () => {
    const args = {
      phaseId: 'Phase X',
      override: 'PARTIAL',
      computed: 'COMPLETE',
    };
    emitDrift(cwd, args);
    const firstWarn = stderrCaptured;
    emitDrift(cwd, args);
    const secondWarn = stderrCaptured.slice(firstWarn.length);
    assert.match(firstWarn, /WARN:/);
    assert.match(secondWarn, /WARN:/);
  });

  test('different phaseId writes a separate event', () => {
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL', computed: 'COMPLETE' });
    emitDrift(cwd, { phaseId: 'B', override: 'PARTIAL', computed: 'COMPLETE' });
    const events = readEvents(cwd);
    assert.equal(events.length, 2);
  });

  test('different override text writes a separate event', () => {
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL', computed: 'COMPLETE' });
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL (revised)', computed: 'COMPLETE' });
    const events = readEvents(cwd);
    assert.equal(events.length, 2);
  });

  test('different computed status writes a separate event', () => {
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL', computed: 'COMPLETE' });
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL', computed: 'PLANNED' });
    const events = readEvents(cwd);
    assert.equal(events.length, 2);
  });

  test('no events file written if cwd has no .compose dir until first call', () => {
    const eventsFile = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    assert.equal(existsSync(eventsFile), false);
    emitDrift(cwd, { phaseId: 'A', override: 'PARTIAL', computed: 'COMPLETE' });
    assert.equal(existsSync(eventsFile), true);
  });
});
