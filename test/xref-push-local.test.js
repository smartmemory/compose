/**
 * xref-push-local.test.js — COMP-ROADMAP-XREF-PUSH-2 local-provider push.
 *
 * A `local` push-opted link writes the SIBLING repo's status to match `expect`,
 * by delegating to the sibling's own setFeatureStatus (transition policy +
 * ROADMAP roundtrip apply, never force). Golden flow uses a real temp sibling.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pushExternalRefs } from '../lib/xref-push.js';
import { writeFeature, readFeature } from '../lib/feature-json.js';

// Lay out parent/<repo> (cwd) + parent/sib so the local resolver finds
// ../sib/docs/features/X-1/feature.json.
function layout(siblingStatus) {
  const parent = mkdtempSync(join(tmpdir(), 'xref-push-local-'));
  const cwd = join(parent, 'repo');
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  mkdirSync(join(parent, 'sib', 'docs', 'features'), { recursive: true });
  writeFeature(join(parent, 'sib'), {
    code: 'X-1', description: 'd', status: siblingStatus, phase: 'P', position: 1,
    created: '2026-06-07', updated: '2026-06-07',
  });
  return { parent, cwd };
}
function seedLocalLink(cwd, expect, repo = 'sib') {
  writeFeature(cwd, {
    code: 'A-1', description: 'd', status: 'PLANNED', phase: 'P', position: 1,
    created: '2026-06-07', updated: '2026-06-07',
    links: [{ kind: 'external', provider: 'local', repo, to_code: 'X-1', expect, push: true }],
  }, 'docs/features', { validate: false });
}

describe('pushExternalRefs — local provider (sibling delegation)', () => {
  test('--apply flips the sibling status via its own setFeatureStatus', async () => {
    const { parent, cwd } = layout('IN_PROGRESS');
    seedLocalLink(cwd, 'COMPLETE');
    const res = await pushExternalRefs(cwd, { apply: true });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(res.pushed[0].state, { from: 'IN_PROGRESS', to: 'COMPLETE' });
    assert.equal(readFeature(join(parent, 'sib'), 'X-1').status, 'COMPLETE');
  });

  test('dry-run reports but does NOT change the sibling', async () => {
    const { parent, cwd } = layout('IN_PROGRESS');
    seedLocalLink(cwd, 'COMPLETE');
    const res = await pushExternalRefs(cwd, { apply: false });
    assert.equal(res.pushed.length, 1);
    assert.equal(readFeature(join(parent, 'sib'), 'X-1').status, 'IN_PROGRESS');
  });

  test('idempotent: sibling already at expect → unchanged, no write', async () => {
    const { cwd } = layout('COMPLETE');
    seedLocalLink(cwd, 'COMPLETE');
    let called = false;
    const res = await pushExternalRefs(cwd, { apply: true, setStatus: async () => { called = true; } });
    assert.equal(res.unchanged, 1);
    assert.equal(res.pushed.length, 0);
    assert.equal(called, false);
  });

  test('disallowed sibling transition → skipped with reason (never force)', async () => {
    // Sibling COMPLETE has no allowed transitions; expect PLANNED is rejected.
    const { parent, cwd } = layout('COMPLETE');
    seedLocalLink(cwd, 'PLANNED');
    const res = await pushExternalRefs(cwd, { apply: true });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /invalid transition/i);
    assert.equal(readFeature(join(parent, 'sib'), 'X-1').status, 'COMPLETE'); // untouched
  });

  test('containment-escape repo token → skipped, sibling never resolved', async () => {
    const { cwd } = layout('IN_PROGRESS');
    seedLocalLink(cwd, 'COMPLETE', '../evil');
    let called = false;
    const res = await pushExternalRefs(cwd, { apply: true, setStatus: async () => { called = true; } });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /not a valid sibling/);
    assert.equal(called, false);
  });

  test('setStatus is called once with (siblingRoot, to_code, expect)', async () => {
    const { parent, cwd } = layout('IN_PROGRESS');
    seedLocalLink(cwd, 'COMPLETE');
    const calls = [];
    await pushExternalRefs(cwd, { apply: true, setStatus: async (root, code, status) => { calls.push({ root, code, status }); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].code, 'X-1');
    assert.equal(calls[0].status, 'COMPLETE');
    assert.equal(calls[0].root, join(parent, 'sib'));
  });
});
