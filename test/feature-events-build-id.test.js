/**
 * feature-events-build-id.test.js — verifies COMP-MCP-MIGRATION-1
 * `build_id` stamping on audit rows.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendEvent, readEvents } from '../lib/feature-events.js';

let priorEnv;
beforeEach(() => { priorEnv = process.env.COMPOSE_BUILD_ID; });
afterEach(() => {
  if (priorEnv === undefined) delete process.env.COMPOSE_BUILD_ID;
  else process.env.COMPOSE_BUILD_ID = priorEnv;
});

describe('feature-events build_id stamping', () => {
  test('stamps build_id from COMPOSE_BUILD_ID env', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fe-bid-'));
    process.env.COMPOSE_BUILD_ID = 'test-uuid-1';
    const row = appendEvent(cwd, { tool: 'add_roadmap_entry', code: 'X-1' });
    assert.equal(row.build_id, 'test-uuid-1');
    const all = readEvents(cwd);
    assert.equal(all[0].build_id, 'test-uuid-1');
  });

  test('build_id is null when COMPOSE_BUILD_ID is unset', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fe-bid-'));
    delete process.env.COMPOSE_BUILD_ID;
    const row = appendEvent(cwd, { tool: 'add_roadmap_entry', code: 'X-1' });
    assert.equal(row.build_id, null);
  });

  test('caller-supplied build_id wins over env', () => {
    // The spread `...event` lands after the stamping defaults, so callers
    // can still inject their own build_id when they have one out-of-band.
    const cwd = mkdtempSync(join(tmpdir(), 'fe-bid-'));
    process.env.COMPOSE_BUILD_ID = 'env-uuid';
    const row = appendEvent(cwd, { tool: 'set_feature_status', code: 'X-1', build_id: 'override-uuid' });
    assert.equal(row.build_id, 'override-uuid');
  });

  test('readEvents preserves build_id', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fe-bid-'));
    process.env.COMPOSE_BUILD_ID = 'uuid-A';
    appendEvent(cwd, { tool: 'add_roadmap_entry', code: 'A-1' });
    process.env.COMPOSE_BUILD_ID = 'uuid-B';
    appendEvent(cwd, { tool: 'set_feature_status', code: 'A-1', from: 'PLANNED', to: 'IN_PROGRESS' });

    const all = readEvents(cwd);
    assert.equal(all.length, 2);
    assert.equal(all[0].build_id, 'uuid-A');
    assert.equal(all[1].build_id, 'uuid-B');
  });
});
