import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'contracts', 'comp-obs-contract.schema.json'), 'utf8'));
const { SchemaValidator } = await import(`${ROOT}/server/schema-validator.js`);
const { buildPhaseTransitionEvent } = await import(`${ROOT}/server/decision-event-emit.js`);
const { verifiedCompleteProjection, VERIFIED_BY } = await import(`${ROOT}/server/completion-projection.js`);
const { _testOnly_setHistoryClient, _testOnly_resetHistoryClient } = await import(`${ROOT}/lib/completion-gate.js`);
const validator = new SchemaValidator();

test('COMP-LIFECYCLE-BACKFILL: obs contract 0.2.7 accepts backfill provenance and legacy live events', () => {
  assert.equal(schema.version, '0.2.7');
  assert.ok(schema._changelog['0.2.7']);

  const backfill = buildPhaseTransitionEvent({
    featureCode: 'OBS-BF-1', from: 'ship', to: 'complete_backfilled', outcome: 'backfilled',
    timestamp: '2026-09-05T10:00:00.000Z', origin: 'backfill',
    recordedAt: '2026-09-06T10:00:00.000Z', confidence: 0.9,
  });
  const live = buildPhaseTransitionEvent({
    featureCode: 'OBS-BF-1', from: null, to: 'explore_design', timestamp: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(validator.validate('DecisionEvent', backfill).valid, true);
  assert.equal(validator.validate('DecisionEvent', live).valid, true);
  assert.deepEqual(live.metadata, { from_phase: 'null', to_phase: 'explore_design' });
});

test('COMP-LIFECYCLE-BACKFILL: the widened projection stamps the actual guarded terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-backfill-projection-'));
  try {
    mkdirSync(join(root, '.compose'), { recursive: true });
    mkdirSync(join(root, 'docs', 'features', 'OBS-BF-2'), { recursive: true });
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({
      paths: { features: 'docs/features' }, capabilities: { guard: true },
    }));
    writeFileSync(join(root, 'docs', 'features', 'OBS-BF-2', 'feature.json'), JSON.stringify({
      code: 'OBS-BF-2', description: 'fixture', phase: 'P', status: 'COMPLETE',
    }));
    _testOnly_setHistoryClient(async () => ({ current_state: 'complete_backfilled' }));
    const result = await verifiedCompleteProjection({
      item: { id: 'item-2', lifecycle: { featureCode: 'OBS-BF-2', mode: 'build' } },
      featureCode: 'OBS-BF-2', cwd: root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.verified_by, VERIFIED_BY.GUARDED);
    assert.equal(result.guardState, 'complete_backfilled');
  } finally {
    _testOnly_resetHistoryClient();
    rmSync(root, { recursive: true, force: true });
  }
});
