/**
 * xref-sync.test.js — COMP-ROADMAP-XREF-SYNC v1 (pull reconciliation).
 *
 * Verifies the structured feature.json links[] external carrier is reconciled
 * to live target state: a drifting `expect=` is rewritten to match reality, with
 * an injectable resolver (no network in tests). Pull only — never writes external.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { reconcileExpect, syncExternalRefs } from '../lib/xref-sync.js';
import { writeFeature, readFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-sync-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seed(cwd, code, links, extra = {}) {
  writeFeature(cwd, {
    code, description: 'd', status: 'PLANNED', phase: 'P', position: 1,
    created: '2026-05-02', updated: '2026-05-02', links, ...extra,
  });
}

describe('reconcileExpect (pure)', () => {
  test('rewrites expect when it contradicts live state', () => {
    assert.deepEqual(reconcileExpect({ expect: 'open' }, 'closed'), { changed: true, from: 'open', to: 'closed' });
    assert.deepEqual(reconcileExpect({ expect: 'PLANNED' }, 'COMPLETE'), { changed: true, from: 'PLANNED', to: 'COMPLETE' });
  });
  test('no change when expect already matches', () => {
    assert.deepEqual(reconcileExpect({ expect: 'closed' }, 'closed'), { changed: false });
  });
  test('nothing to pull when no expect is set', () => {
    assert.deepEqual(reconcileExpect({ expect: null }, 'open'), { changed: false });
  });
  test('skips when live state is null (unresolved)', () => {
    assert.deepEqual(reconcileExpect({ expect: 'open' }, null), { changed: false });
  });
});

describe('syncExternalRefs (feature.json links carrier)', () => {
  test('rewrites a drifting github link.expect and persists it', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, expect: 'open' }]);
    // Resolver reports the issue is actually closed.
    const resolve = async (ref) => ({ state: ref.provider === 'github' ? 'closed' : null });

    const res = await syncExternalRefs(cwd, { resolve });
    assert.equal(res.synced.length, 1);
    assert.deepEqual(
      { code: res.synced[0].code, from: res.synced[0].from, to: res.synced[0].to },
      { code: 'A-1', from: 'open', to: 'closed' });
    // Persisted to disk.
    assert.equal(readFeature(cwd, 'A-1').links[0].expect, 'closed');
  });

  test('dry-run reports the change but does NOT write', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, expect: 'open' }]);
    const resolve = async () => ({ state: 'closed' });

    const res = await syncExternalRefs(cwd, { resolve, dryRun: true });
    assert.equal(res.synced.length, 1);
    assert.equal(readFeature(cwd, 'A-1').links[0].expect, 'open', 'dry-run must not mutate');
  });

  test('local link reconciles to the target feature status', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'local', repo: 'sib', to_code: 'X-1', expect: 'PLANNED' }]);
    const resolve = async () => ({ state: 'COMPLETE' });
    const res = await syncExternalRefs(cwd, { resolve });
    assert.equal(readFeature(cwd, 'A-1').links[0].expect, 'COMPLETE');
    assert.equal(res.synced[0].to, 'COMPLETE');
  });

  test('unresolved (offline/rate-limit) ref is reported skipped, not changed', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, expect: 'open' }]);
    const resolve = async () => ({ skipped: true, reason: 'offline' });
    const res = await syncExternalRefs(cwd, { resolve });
    assert.equal(res.synced.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(readFeature(cwd, 'A-1').links[0].expect, 'open');
  });

  test('url/reserved providers and no-expect links are left alone', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [
      { kind: 'external', provider: 'url', url: 'https://x/y' },
      { kind: 'external', provider: 'jira', url: 'https://j/1', expect: 'open' },
      { kind: 'external', provider: 'github', repo: 'o/r', issue: 7 }, // no expect
    ]);
    let calls = 0;
    const resolve = async () => { calls++; return { state: 'closed' }; };
    const res = await syncExternalRefs(cwd, { resolve });
    assert.equal(res.synced.length, 0, 'nothing resolvable+expect-bearing to sync');
    assert.equal(calls, 0, 'resolver not called for unresolvable / no-expect links');
  });

  test('an in-sync github link produces no change', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, expect: 'closed' }]);
    const res = await syncExternalRefs(cwd, { resolve: async () => ({ state: 'closed' }) });
    assert.equal(res.synced.length, 0);
    assert.equal(res.unchanged, 1);
  });

  test('default resolver reads a sibling feature.json for local links (no injection, no network)', async () => {
    // Lay out parent/<repo> (cwd) + parent/sib so the default local resolver
    // resolves ../sib/docs/features/X-1/feature.json.
    const parent = mkdtempSync(join(tmpdir(), 'xref-parent-'));
    const cwd = join(parent, 'repo');
    mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
    mkdirSync(join(parent, 'sib', 'docs', 'features'), { recursive: true });
    writeFeature(join(parent, 'sib'), {
      code: 'X-1', description: 'd', status: 'COMPLETE', phase: 'P', position: 1,
      created: '2026-05-02', updated: '2026-05-02',
    });
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'local', repo: 'sib', to_code: 'X-1', expect: 'PLANNED' }]);

    const res = await syncExternalRefs(cwd, {}); // default resolver
    assert.equal(res.synced.length, 1);
    assert.equal(res.synced[0].to, 'COMPLETE');
    assert.equal(readFeature(cwd, 'A-1').links[0].expect, 'COMPLETE');
  });
});
