/**
 * test/completion-seed-tiers.test.js — COMP-COMPLETION-GATE AC-16a/AC-16b.
 *
 * Startup seeding is one of the four transports of the §2.3b predicate. It is
 * synchronous and pre-listen, so it never consults the guard; it projects on
 * canonical feature.json alone and stamps the honest tier:
 *   - managed feature, feature.json COMPLETE → canonical-status-only
 *   - unmanaged folder (no feature.json), report.md present → document-derived
 * A re-seed after cockpit drift repairs the item the same way (AC-16a).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanFeatures, seedFeatures } from '../server/feature-scan.js';
import { VisionStore } from '../server/vision-store.js';
import { VERIFIED_BY } from '../server/completion-projection.js';

function features(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-tiers-'));
  for (const [code, s] of Object.entries(spec)) {
    const d = join(dir, code);
    mkdirSync(d, { recursive: true });
    if (s.json) writeFileSync(join(d, 'feature.json'), JSON.stringify({ code, description: code, ...s.json }));
    for (const f of s.files || []) writeFileSync(join(d, f), `# ${code}\n`);
  }
  return dir;
}
const store = () => new VisionStore(mkdtempSync(join(tmpdir(), 'seed-tiers-store-')));
const only = (st) => [...st.items.values()][0];

describe('seedFeatures — three tiers', () => {
  test('managed COMPLETE feature seeds complete, stamped canonical-status-only', () => {
    const st = store();
    seedFeatures(scanFeatures(features({ 'T-1': { json: { status: 'COMPLETE' } } })), st);
    const it = only(st);
    assert.equal(it.status, 'complete');
    assert.equal(it.completion_projection.verified_by, VERIFIED_BY.CANONICAL);
    assert.equal(it.completion_projection.source, 'startup-scan');
  });

  test('unmanaged folder with only report.md seeds complete, stamped document-derived', () => {
    const st = store();
    seedFeatures(scanFeatures(features({ 'T-2': { files: ['design.md', 'report.md'] } })), st);
    const it = only(st);
    assert.equal(it.status, 'complete');
    assert.equal(it.completion_projection.verified_by, VERIFIED_BY.DOCUMENT);
  });

  test('a managed non-complete feature carries no projection stamp', () => {
    const st = store();
    seedFeatures(scanFeatures(features({ 'T-3': { json: { status: 'IN_PROGRESS' } } })), st);
    const it = only(st);
    assert.equal(it.status, 'in_progress');
    assert.equal(it.completion_projection, undefined);
  });

  test('a MANAGED feature with a status-less feature.json and a report.md is NOT seeded complete — canon wins (Codex r1 #4)', () => {
    const st = store();
    seedFeatures(scanFeatures(features({ 'T-5': { json: {}, files: ['design.md', 'report.md'] } })), st);
    const it = only(st);
    assert.notEqual(it.status, 'complete');
    assert.equal(it.completion_projection, undefined);
  });

  test('a MANAGED feature with a MALFORMED feature.json and a report.md is NOT seeded complete', () => {
    const dir = features({ 'T-6': { files: ['design.md', 'report.md'] } });
    writeFileSync(join(dir, 'T-6', 'feature.json'), '{ broken');
    const st = store();
    seedFeatures(scanFeatures(dir), st);
    const it = only(st);
    assert.equal(it.status, 'planned');
    assert.equal(it.completion_projection, undefined);
  });

  test('UPGRADE: an item already complete before tiers existed gets stamped on re-seed (Codex r1 #5)', () => {
    const dir = features({ 'T-7': { json: { status: 'COMPLETE' } } });
    const st = store();
    // Simulate a pre-slice-3 store: item complete, no completion_projection.
    const item = st.createItem({ type: 'feature', title: 'T-7', status: 'complete' });
    st.updateLifecycle(item.id, { featureCode: 'T-7', currentPhase: 'explore_design' });
    assert.equal(st.items.get(item.id).completion_projection, undefined);
    seedFeatures(scanFeatures(dir), st);
    assert.equal(st.items.get(item.id).status, 'complete');
    assert.equal(st.items.get(item.id).completion_projection.verified_by, VERIFIED_BY.CANONICAL);
  });

  test('a stamped complete item is DOWNGRADED when its canon is later corrupted or loses status (Codex r2 #2)', () => {
    const dir = features({ 'T-8': { json: { status: 'COMPLETE' }, files: ['report.md'] } });
    const st = store();
    seedFeatures(scanFeatures(dir), st);
    const id = only(st).id;
    assert.equal(st.items.get(id).completion_projection.verified_by, VERIFIED_BY.CANONICAL);

    writeFileSync(join(dir, 'T-8', 'feature.json'), '{ corrupt');
    seedFeatures(scanFeatures(dir), st);
    assert.notEqual(st.items.get(id).status, 'complete', 'corrupt canon: no longer complete');
    assert.equal(st.items.get(id).completion_projection ?? null, null, 'stale stamp removed');

    writeFileSync(join(dir, 'T-8', 'feature.json'), JSON.stringify({ code: 'T-8', description: 'x' }));
    st.updateItem(id, { status: 'complete' });
    seedFeatures(scanFeatures(dir), st);
    assert.notEqual(st.items.get(id).status, 'complete', 'status-less canon + report.md: not complete');
  });

  test('a canonical downgrade (COMPLETE → IN_PROGRESS) clears the stale stamp (Codex r3)', () => {
    const dir = features({ 'T-9': { json: { status: 'COMPLETE' } } });
    const st = store();
    seedFeatures(scanFeatures(dir), st);
    const id = only(st).id;
    assert.ok(st.items.get(id).completion_projection);
    writeFileSync(join(dir, 'T-9', 'feature.json'), JSON.stringify({ code: 'T-9', description: 'x', status: 'IN_PROGRESS' }));
    seedFeatures(scanFeatures(dir), st);
    assert.equal(st.items.get(id).status, 'in_progress');
    assert.equal(st.items.get(id).completion_projection ?? null, null);
  });

  test('re-seed repairs cockpit drift through the same tiering (AC-16a)', () => {
    const dir = features({ 'T-4': { json: { status: 'COMPLETE' } } });
    const st = store();
    seedFeatures(scanFeatures(dir), st);
    const id = only(st).id;
    st.updateItem(id, { status: 'planned' });
    seedFeatures(scanFeatures(dir), st);
    assert.equal(st.items.get(id).status, 'complete');
    assert.equal(st.items.get(id).completion_projection.verified_by, VERIFIED_BY.CANONICAL);
  });
});
