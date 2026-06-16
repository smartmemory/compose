/**
 * Unit tests for lib/hooks-status.js — the shared hook-status logic consumed by
 * both `compose hooks status` (CLI) and `GET /api/environment-health` (server).
 *
 * computeHooksStatus must mirror the historical inline statusOne logic
 * (bin/compose.js) exactly; formatHookStatusLines must reproduce the CLI's
 * printed lines byte-for-byte. The only addition vs. the legacy logic is the
 * non-state `wsVerified` flag (so the API can render `workspace-unverified`
 * without the CLI changing its output).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeHooksStatus,
  formatHookStatusLines,
  HOOK_MARKERS,
  HOOK_TYPE_LIST,
  extractBakedWorkspaceId,
} from '../lib/hooks-status.js';

const NODE = '/usr/local/bin/node';
const BIN = '/opt/compose/bin/compose.js';
const WS = 'ws-alpha';

function hookContent({ type = 'post-commit', node = NODE, bin = BIN, ws = WS, raw = false } = {}) {
  const wsLine = raw ? 'COMPOSE_WORKSPACE_ID="__COMPOSE_WORKSPACE_ID__"' : `COMPOSE_WORKSPACE_ID="${ws}"`;
  return [
    '#!/usr/bin/env bash',
    `${HOOK_MARKERS[type]} auto-records completions.`,
    `COMPOSE_NODE="${node}"`,
    `COMPOSE_BIN="${bin}"`,
    wsLine,
    'exit 0',
  ].join('\n');
}

describe('hooks-status: markers + helpers', () => {
  test('HOOK_TYPE_LIST covers both hook types', () => {
    assert.deepEqual(HOOK_TYPE_LIST, ['post-commit', 'pre-push']);
  });

  test('extractBakedWorkspaceId pulls the baked id', () => {
    assert.equal(extractBakedWorkspaceId(hookContent({ ws: 'foo' })), 'foo');
    assert.equal(extractBakedWorkspaceId('no workspace line here'), null);
  });
});

describe('computeHooksStatus', () => {
  let dir, hooksDir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hooks-status-'));
    hooksDir = join(dir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  function write(type, content) {
    writeFileSync(join(hooksDir, type), content);
  }

  function run({ expectedWsId = WS } = {}) {
    return computeHooksStatus({ projectRoot: dir, expectedWsId, composeNode: NODE, composeBin: BIN });
  }

  test('absent when no hook file exists', () => {
    rmSync(join(hooksDir, 'post-commit'), { force: true });
    const s = run()['post-commit'];
    assert.equal(s.state, 'absent');
    assert.equal(s.reason, null);
  });

  test('foreign when file exists without the Compose marker', () => {
    write('post-commit', '#!/usr/bin/env bash\necho hi\n');
    assert.equal(run()['post-commit'].state, 'foreign');
  });

  test('installed-current when marker + node + bin + workspace all match', () => {
    write('post-commit', hookContent({ type: 'post-commit' }));
    const s = run()['post-commit'];
    assert.equal(s.state, 'installed-current');
    assert.equal(s.reason, null);
    assert.equal(s.bakedWorkspace, WS);
    assert.equal(s.wsVerified, true);
  });

  test('workspace-unverified path: installed-current but wsVerified=false when expectedWsId is null', () => {
    write('post-commit', hookContent({ type: 'post-commit' }));
    const s = run({ expectedWsId: null })['post-commit'];
    // State stays installed-current (CLI lenient), but wsVerified flags the gap.
    assert.equal(s.state, 'installed-current');
    assert.equal(s.wsVerified, false);
  });

  test('installed-stale STALE_WORKSPACE_ID when baked workspace differs from expected', () => {
    write('post-commit', hookContent({ type: 'post-commit', ws: 'other-ws' }));
    const s = run({ expectedWsId: WS })['post-commit'];
    assert.equal(s.state, 'installed-stale');
    assert.equal(s.reason, 'STALE_WORKSPACE_ID');
  });

  test('installed-stale MISSING_WORKSPACE_ID when the raw template token survives', () => {
    write('post-commit', hookContent({ type: 'post-commit', raw: true }));
    const s = run({ expectedWsId: WS })['post-commit'];
    assert.equal(s.state, 'installed-stale');
    assert.equal(s.reason, 'MISSING_WORKSPACE_ID');
  });

  test('installed-stale "stale paths" when node/bin mismatch', () => {
    write('post-commit', hookContent({ type: 'post-commit', node: '/wrong/node' }));
    const s = run({ expectedWsId: WS })['post-commit'];
    assert.equal(s.state, 'installed-stale');
    assert.equal(s.reason, 'stale paths');
    assert.equal(s.nodeMatch, false);
    assert.equal(s.binMatch, true);
  });
});

describe('formatHookStatusLines (CLI byte-identical)', () => {
  const opts = { composeNode: NODE, composeBin: BIN };

  test('absent', () => {
    const lines = formatHookStatusLines('post-commit', { state: 'absent' }, opts);
    assert.deepEqual(lines, ['post-commit: absent — no hook installed']);
  });

  test('foreign', () => {
    const lines = formatHookStatusLines('pre-push', { state: 'foreign' }, opts);
    assert.deepEqual(lines, ['pre-push: foreign — hook exists but is not a Compose hook']);
  });

  test('installed-current with workspace line', () => {
    const lines = formatHookStatusLines(
      'pre-push',
      { state: 'installed-current', bakedWorkspace: 'compose' },
      opts,
    );
    assert.deepEqual(lines, ['pre-push: installed (current)', '  workspace: compose']);
  });

  test('installed-current without baked workspace omits the workspace line', () => {
    const lines = formatHookStatusLines('pre-push', { state: 'installed-current', bakedWorkspace: null }, opts);
    assert.deepEqual(lines, ['pre-push: installed (current)']);
  });

  test('installed-stale STALE_WORKSPACE_ID prints expected workspace id', () => {
    const lines = formatHookStatusLines(
      'post-commit',
      { state: 'installed-stale', reason: 'STALE_WORKSPACE_ID', expectedWorkspace: 'ws-x', nodeMatch: true, binMatch: true },
      opts,
    );
    assert.deepEqual(lines, [
      'post-commit: installed (STALE_WORKSPACE_ID — re-run install)',
      '  expected COMPOSE_WORKSPACE_ID="ws-x"',
    ]);
  });

  test('installed-stale stale paths prints expected node/bin', () => {
    const lines = formatHookStatusLines(
      'post-commit',
      { state: 'installed-stale', reason: 'stale paths', expectedWorkspace: 'ws-x', nodeMatch: false, binMatch: false },
      opts,
    );
    assert.deepEqual(lines, [
      'post-commit: installed (stale paths — re-run install)',
      `  expected COMPOSE_NODE="${NODE}"`,
      `  expected COMPOSE_BIN="${BIN}"`,
    ]);
  });

  test('installed-stale MISSING_WORKSPACE_ID does not print expected workspace line', () => {
    const lines = formatHookStatusLines(
      'post-commit',
      { state: 'installed-stale', reason: 'MISSING_WORKSPACE_ID', expectedWorkspace: 'ws-x', nodeMatch: true, binMatch: true },
      opts,
    );
    assert.deepEqual(lines, ['post-commit: installed (MISSING_WORKSPACE_ID — re-run install)']);
  });
});
