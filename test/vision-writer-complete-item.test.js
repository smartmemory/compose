/**
 * test/vision-writer-complete-item.test.js — COMP-COMPLETION-GATE slice 3.
 *
 * Direct-mode (no server) behaviour of the vision writer's completion seam:
 *   - AC-16: updateItemStatus('complete') refuses a MANAGED BUILD item and only
 *     that — fix items and the kickoff item (build, no feature.json) still work
 *   - AC-4b: completeItem in direct mode runs the same predicate as the server
 *     and stamps the tier; it refuses when feature.json is not COMPLETE
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { VisionWriter } from '../lib/vision-writer.js';

const DEAD_PORT = 19994;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'vw-complete-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ paths: { features: 'docs/features' }, capabilities: { guard: false } }));
  return root;
}
function feature(root, code, status) {
  const d = join(root, 'docs', 'features', code);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'feature.json'), JSON.stringify({ code, description: 'x', status }));
}
function vision(root, items) {
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({ items, connections: [], gates: [] }));
}
const readVision = (root) => JSON.parse(readFileSync(join(root, '.compose', 'data', 'vision-state.json'), 'utf8'));
const item = (code, mode) => ({ id: `it-${code}`, title: code, status: 'in_progress', lifecycle: { featureCode: code, mode, currentPhase: 'ship' } });
const writer = (root) => new VisionWriter(join(root, '.compose', 'data'), { port: DEAD_PORT });

describe('updateItemStatus — AC-16 (direct transport)', () => {
  test('refuses complete for a managed build item, writes nothing', async () => {
    const root = project();
    feature(root, 'V-1', 'IN_PROGRESS');
    vision(root, [item('V-1', 'build')]);
    await assert.rejects(() => writer(root).updateItemStatus('it-V-1', 'complete'), (e) => e.code === 'COMPLETE_VIA_GATE_ONLY');
    assert.equal(readVision(root).items[0].status, 'in_progress');
  });

  test('a malformed feature.json is still managed — refuses (fail closed)', async () => {
    const root = project();
    const d = join(root, 'docs', 'features', 'V-BAD');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'feature.json'), 'not json at all');
    vision(root, [item('V-BAD', 'build')]);
    await assert.rejects(() => writer(root).updateItemStatus('it-V-BAD', 'complete'), (e) => e.code === 'COMPLETE_VIA_GATE_ONLY');
    await assert.rejects(() => writer(root).completeItem('it-V-BAD', { featureCode: 'V-BAD' }), /could not be parsed/);
  });

  test('a fix item still completes', async () => {
    const root = project();
    feature(root, 'V-2', 'IN_PROGRESS');
    vision(root, [item('V-2', 'fix')]);
    await writer(root).updateItemStatus('it-V-2', 'complete');
    assert.equal(readVision(root).items[0].status, 'complete');
  });

  test('the kickoff item (build mode, no feature.json) still completes — `compose new` is not bricked', async () => {
    const root = project();
    vision(root, [item('my-product', 'build')]);
    await writer(root).updateItemStatus('it-my-product', 'complete');
    assert.equal(readVision(root).items[0].status, 'complete');
  });

  test('non-complete statuses on a managed build item are unaffected', async () => {
    const root = project();
    feature(root, 'V-3', 'IN_PROGRESS');
    vision(root, [item('V-3', 'build')]);
    await writer(root).updateItemStatus('it-V-3', 'blocked');
    assert.equal(readVision(root).items[0].status, 'blocked');
  });
});

describe('completeItem — AC-4b (direct transport)', () => {
  test('refuses when feature.json does not record COMPLETE', async () => {
    const root = project();
    feature(root, 'C-1', 'IN_PROGRESS');
    vision(root, [item('C-1', 'build')]);
    await assert.rejects(
      () => writer(root).completeItem('it-C-1', { featureCode: 'C-1' }),
      (e) => e.code === 'PROJECTION_REFUSED' && /not COMPLETE/.test(e.message),
    );
    assert.equal(readVision(root).items[0].status, 'in_progress');
  });

  test('mirrors a recorded completion and stamps the tier + evidence', async () => {
    const root = project();
    feature(root, 'C-2', 'COMPLETE');
    vision(root, [item('C-2', 'build')]);
    const r = await writer(root).completeItem('it-C-2', { featureCode: 'C-2', commitSha: 'deadbeef', ledgerRef: 'l#9' });
    assert.equal(r.transport, 'direct');
    assert.equal(r.verified_by, 'canonical-status-only');
    const it = readVision(root).items[0];
    assert.equal(it.status, 'complete');
    assert.equal(it.completion_projection.verified_by, 'canonical-status-only');
    assert.equal(it.completion_projection.commit_sha, 'deadbeef');
    assert.equal(it.completion_projection.ledger_ref, 'l#9');
    assert.equal(it.completion_projection.source, 'direct');
  });

  test('requires featureCode; unknown item throws', async () => {
    const root = project();
    vision(root, []);
    await assert.rejects(() => writer(root).completeItem('x', {}), /featureCode is required/);
    await assert.rejects(() => writer(root).completeItem('x', { featureCode: 'Q' }), /item not found/);
  });
});
