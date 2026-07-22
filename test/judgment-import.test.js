/**
 * judgment-import.test.js — coverage for bin/judgment-import.js (T7/S07):
 * import round-trip on fixture copies of the LIVE hand-written canon.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runJudgmentImport, mapCost } from '../bin/judgment-import.js';
import { RecordsStore } from '../lib/judgment/store/records.js';
import { checkProjectionRoundtrip } from '../lib/judgment-gen.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fixture cwd holding byte-copies of the hand-written canon AS IT STOOD at
 * cutover (frozen under test/fixtures/judgment-canon — the live files became
 * generated projections when the W3 import ran, so they can no longer serve
 * as parse fixtures).
 */
const CANON_FIXTURES = join(ROOT, 'test', 'fixtures', 'judgment-canon');

function fixtureCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-import-'));
  const dir = join(cwd, 'docs', 'judgment');
  mkdirSync(join(dir, 'positions'), { recursive: true });
  for (const rel of ['REGISTER.md', 'LEDGER.md', 'OBJECTIVE.md']) {
    copyFileSync(join(CANON_FIXTURES, rel), join(dir, rel));
  }
  for (const f of readdirSync(join(CANON_FIXTURES, 'positions')).filter((f) => f.endsWith('.md'))) {
    copyFileSync(join(CANON_FIXTURES, 'positions', f), join(dir, 'positions', f));
  }
  return cwd;
}

describe('mapCost', () => {
  test('minutes maps to hours with a note; ruled buckets pass through', () => {
    assert.deepEqual(mapCost('minutes'), { cost: 'hours', note: 'import: cost "minutes" mapped to "hours" (COARSE-BUCKETS)' });
    assert.deepEqual(mapCost('days'), { cost: 'days', note: null });
    assert.equal(mapCost('unknown-ish').cost, 'hours');
  });
});

describe('runJudgmentImport', () => {
  test('dry-run reports the diff and writes NO records', async () => {
    const cwd = fixtureCwd();
    const result = await runJudgmentImport(cwd, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.counts.joints >= 15, `expected >=15 joints, got ${result.counts.joints}`);
    assert.ok(result.counts.positions >= 3);
    assert.ok(result.counts.ledger_events >= 30, `expected >=30 events, got ${result.counts.ledger_events}`);
    assert.ok(result.diff.some((d) => d.file.endsWith('REGISTER.md') && d.changed), 'REGISTER.md would change');
    assert.ok(!existsSync(join(cwd, 'docs', 'judgment', 'records')), 'dry-run must not write records');
  });

  test('real run: records written via the writer, projections cut over, fixed point holds', async () => {
    const cwd = fixtureCwd();
    const result = await runJudgmentImport(cwd, { dryRun: false });
    assert.equal(result.dryRun, false);

    const store = new RecordsStore(cwd);

    // Positions: all three, with provenance via import.
    const slugs = store.listPositionSlugs();
    for (const slug of ['objective', 'judgment-layer', 'product-boundary']) {
      assert.ok(slugs.includes(slug), `position ${slug} imported`);
      assert.equal(store.latestPositionRevision(slug).provenance.via, 'import');
    }

    // ASSERT grounding preserved, elicitation cited (transcription-with-citation).
    const judgmentLayer = store.latestPositionRevision('judgment-layer');
    const assertClaims = judgmentLayer.claims.filter((c) => c.grounding === 'ASSERT');
    assert.ok(assertClaims.length >= 3, 'judgment-layer keeps its ASSERT steps');
    for (const claim of assertClaims) assert.ok(claim.elicitation, `claim ${claim.id} carries an elicitation citation`);
    const derived = judgmentLayer.claims.find((c) => c.grounding === 'DERIVED');
    assert.ok(derived, 'derived-from-2 step maps to DERIVED');
    assert.ok(derived.supports.length > 0);

    // Joints: states survive transcription.
    const joints = store.listJoints();
    const bySlug = Object.fromEntries(joints.map((j) => [j.slug, j]));
    assert.equal(bySlug['joint-is-non-obvious'].state, 'under_test');
    assert.equal(bySlug['already-knew'].rank, 'high');
    assert.equal(bySlug['already-knew'].resolve_by, 'INT', 'EXT-UNREACHABLE flag must not read as method EXT');
    assert.ok(bySlug['already-knew'].flags.includes('EXT-UNREACHABLE'));
    assert.equal(bySlug['ledger-used'].rank, 'medium');
    assert.equal(bySlug['commercial-intent'].state, 'resolved');
    assert.equal(bySlug['commercial-intent'].resolve_by, 'ASSERT');
    assert.ok(bySlug['commercial-intent'].resolution.elicitation, 'ASSERT resolution carries elicitation');
    assert.equal(bySlug['ingest-continuous'].state, 'dissolved');
    assert.ok(bySlug['ingest-continuous'].dissolution.decomposed_into.length >= 2);

    // Ledger: owner rulings present; every event stamped via import.
    const events = store.readLedgerEvents();
    const decideTitles = events.filter((e) => e.kind === 'decide').map((e) => e.title).join('\n');
    for (const ruling of ['instrument-now-product-later', 'horizon-months', 'assert-elicitation-amendment']) {
      assert.match(decideTitles, new RegExp(ruling));
    }
    assert.ok(events.every((e) => e.provenance.via === 'import'));
    assert.ok(events.some((e) => e.kind === 'override'), 'override entry imported');
    assert.ok(events.some((e) => e.kind === 'calibrate'), 'calibrate entries imported');
    assert.ok(events.some((e) => e.kind === 'note' && e.anchor === 'register-header'), 'register banner becomes an anchored note');

    // Projections regenerated over the hand-written files; pure-output fixed point.
    const register = readFileSync(join(cwd, 'docs', 'judgment', 'REGISTER.md'), 'utf8');
    assert.match(register, /^# Judgment Register/);
    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, true, JSON.stringify(check.diffs));

    // The diff the human gate reviews names every projection that changed.
    assert.ok(result.diff.length >= 4);
  });

  test('preflight: an unimplemented canon provider rejects the import before anything lands', async () => {
    const cwd = fixtureCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ judgment: { provider: 'smartmemory' } }));
    await assert.rejects(() => runJudgmentImport(cwd, { dryRun: false }), (err) => err.code === 'NOT_IMPLEMENTED');
    assert.ok(!existsSync(join(cwd, 'docs', 'judgment', 'records')), 'no floor records under a rejecting config');
  });

  test('import is re-runnable only onto a clean tree', async () => {
    const cwd = fixtureCwd();
    await runJudgmentImport(cwd, { dryRun: false });
    await assert.rejects(() => runJudgmentImport(cwd, { dryRun: false }), /already exist/i);
  });
});
