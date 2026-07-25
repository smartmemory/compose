/**
 * COMP-CANON-OVERRIDE S1 — the governance class.
 *
 * Gate round 2, finding 2: registering the bypass ledger at the hook point
 * while making every hook-registered path grant-eligible makes the ledger
 * recursively overrideable — grant for the ledger, then rewrite it. Guarded
 * and grantable have to be different sets.
 *
 * Gate round 2, finding 1: the grant directory is governance state too. Left
 * unregistered, a runtime can write a token straight to disk and consume it,
 * with no ledger row at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGuarded, isOverrideEligible, matchEntry, guardedPatternIdsFor,
} from '../lib/canon-registry.js';

const FD = 'docs/features';
const at = (p) => ({ featuresDir: FD, point: 'hook' });

const GOVERNANCE = [
  '.compose/canon-overrides.jsonl',
  '.compose/canon-overrides-attest.json',
  '.compose/data/canon-grants/abc123.json',
  '.compose/data/canon-grants/consumed/abc123.json',
];

describe('canon registry — governance class', () => {
  test('governance paths are guarded at the hook point', () => {
    for (const p of GOVERNANCE) {
      assert.equal(isGuarded(p, at(p)), true, `${p} must be hook-guarded`);
    }
  });

  test('governance paths are NOT override-eligible', () => {
    for (const p of GOVERNANCE) {
      assert.equal(isOverrideEligible(p, at(p)), false, `${p} must not be grantable`);
    }
  });

  test('judgment canon IS override-eligible — the class is narrow', () => {
    const p = 'docs/judgment/records/joints/x.json';
    assert.equal(isGuarded(p, at(p)), true);
    assert.equal(isOverrideEligible(p, at(p)), true);
  });

  test('an unregistered path is neither guarded nor eligible', () => {
    const p = 'src/whatever.js';
    assert.equal(isGuarded(p, at(p)), false);
    assert.equal(isOverrideEligible(p, at(p)), false);
  });

  test('a ship-only path is not hook-eligible — enforcement points are not interchangeable', () => {
    // Gate round 1 finding 3: a grant for ROADMAP.md is meaningless because
    // the hook already allows it, and its ledger row would be misleading.
    for (const p of ['ROADMAP.md', 'CHANGELOG.md', 'docs/features/X-1/feature.json']) {
      assert.equal(isGuarded(p, { featuresDir: FD, point: 'ship' }), true, `${p} is ship-guarded`);
      assert.equal(isOverrideEligible(p, at(p)), false, `${p} must not be hook-grantable`);
    }
  });

  test('the hook set now carries the governance entries', () => {
    assert.deepEqual(
      guardedPatternIdsFor('hook').sort(),
      ['judgment', 'override-attest', 'override-grants', 'override-ledger'],
    );
  });

  test('governance entries do not leak into the ship set', () => {
    assert.deepEqual(guardedPatternIdsFor('ship').sort(), ['changelog', 'feature-json', 'roadmap']);
  });

  test('the grant directory matches by prefix, not just exact files', () => {
    const entry = matchEntry('.compose/data/canon-grants/deep/nested.json', at());
    assert.ok(entry, 'nested grant paths must match');
    assert.equal(entry.id, 'override-grants');
  });

  test('a lookalike path outside the grant directory is not captured', () => {
    for (const p of ['.compose/data/canon-grants-backup/x.json', '.compose/canon-grants/x.json']) {
      assert.equal(isGuarded(p, at(p)), false, `${p} must not match`);
    }
  });
});
