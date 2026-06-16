/**
 * Unit tests for the pure helpers in server/health-routes.js:
 *   - rollupSummary  (worst-wins ok|warn|error)
 *   - hookRawToApi   (raw computeHooksStatus fact → API shape, incl. workspace-unverified)
 *
 * The HTTP endpoint itself is covered against a real Express app + fixtures in
 * test/integration/health-routes.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rollupSummary, hookRawToApi } from '../server/health-routes.js';

const okHooks = { 'post-commit': { state: 'absent' }, 'pre-push': { state: 'installed-current' } };

describe('rollupSummary', () => {
  test('all clear → ok', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [{ id: 'a' }], missing: [] },
        binaries: { present: [], missing: [] },
        version: { behind: false },
        hooks: okHooks,
      }),
      'ok',
    );
  });

  test('missing REQUIRED dep → error', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [{ id: 'x', optional: false }] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: okHooks,
      }),
      'error',
    );
  });

  test('missing OPTIONAL dep → warn', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [{ id: 'x', optional: true }] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: okHooks,
      }),
      'warn',
    );
  });

  test('foreign hook → error (even if everything else is fine)', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: { 'post-commit': { state: 'foreign' }, 'pre-push': { state: 'installed-current' } },
      }),
      'error',
    );
  });

  test('version behind → warn', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: { behind: true },
        hooks: okHooks,
      }),
      'warn',
    );
  });

  test('version null (offline) is neutral → ok', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: okHooks,
      }),
      'ok',
    );
  });

  test('installed-stale hook → warn', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: { 'post-commit': { state: 'absent' }, 'pre-push': { state: 'installed-stale', reason: 'STALE_WORKSPACE_ID' } },
      }),
      'warn',
    );
  });

  test('workspace-unverified hook → warn', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: { 'post-commit': { state: 'workspace-unverified' }, 'pre-push': { state: 'absent' } },
      }),
      'warn',
    );
  });

  test('absent hook is neutral → ok', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [] },
        binaries: { present: [], missing: [] },
        version: null,
        hooks: { 'post-commit': { state: 'absent' }, 'pre-push': { state: 'absent' } },
      }),
      'ok',
    );
  });

  test('unavailable dep section → warn (degradation, not error)', () => {
    assert.equal(
      rollupSummary({
        dependencies: { unavailable: true },
        binaries: { unavailable: true },
        version: null,
        hooks: okHooks,
      }),
      'warn',
    );
  });

  test('error wins over warn (required-missing + behind)', () => {
    assert.equal(
      rollupSummary({
        dependencies: { present: [], missing: [{ id: 'x', optional: false }] },
        binaries: { present: [], missing: [] },
        version: { behind: true },
        hooks: okHooks,
      }),
      'error',
    );
  });
});

describe('hookRawToApi', () => {
  test('installed-current + wsVerified → installed-current with workspace', () => {
    assert.deepEqual(
      hookRawToApi({ state: 'installed-current', wsVerified: true, bakedWorkspace: 'compose' }),
      { state: 'installed-current', workspace: 'compose' },
    );
  });

  test('installed-current + !wsVerified → workspace-unverified', () => {
    assert.deepEqual(
      hookRawToApi({ state: 'installed-current', wsVerified: false, bakedWorkspace: 'compose' }),
      { state: 'workspace-unverified' },
    );
  });

  test('installed-stale STALE_WORKSPACE_ID carries expected workspace', () => {
    assert.deepEqual(
      hookRawToApi({ state: 'installed-stale', reason: 'STALE_WORKSPACE_ID', expectedWorkspace: 'ws-x' }),
      { state: 'installed-stale', reason: 'STALE_WORKSPACE_ID', expected: { workspaceId: 'ws-x' } },
    );
  });

  test('installed-stale MISSING_WORKSPACE_ID has no expected block', () => {
    assert.deepEqual(
      hookRawToApi({ state: 'installed-stale', reason: 'MISSING_WORKSPACE_ID' }),
      { state: 'installed-stale', reason: 'MISSING_WORKSPACE_ID' },
    );
  });

  test('absent / foreign pass through', () => {
    assert.deepEqual(hookRawToApi({ state: 'absent' }), { state: 'absent' });
    assert.deepEqual(hookRawToApi({ state: 'foreign' }), { state: 'foreign' });
  });
});
