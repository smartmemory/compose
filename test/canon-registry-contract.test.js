/**
 * canon-registry-contract.test.js — COMP-CANON-GUARD S1.
 *
 * The registry (lib/canon-registry.js) is the single source of truth for which
 * canonical paths are guarded, by which tools, at which enforcement point. This
 * contract test proves two things the design makes load-bearing:
 *
 *   1. The ship point resolves the SAME path→tools mapping the old hardcoded
 *      sets in mcp-enforcement.js did (legacy behavior is byte-preserved — the
 *      literals are pinned here so a future edit to the registry that changes
 *      ship behavior fails loudly).
 *   2. Each enforcement point ('ship' | 'hook') consumes ONLY its declared
 *      subset — one registry does NOT imply one coverage. docs/judgment/** is
 *      hook-only this slice; ROADMAP/CHANGELOG/feature.json are ship-only.
 *
 * Plus the lockout invariant: an unregistered path is guarded by no point.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGuarded,
  toolsForPath,
  featureCodeForPath,
  guardedPatternIdsFor,
  JUDGMENT_WRITE_TOOLS,
} from '../lib/canon-registry.js';

// Legacy tool sets, pinned verbatim from the pre-refactor mcp-enforcement.js.
// If a registry edit changes what the ship point expects, this fails.
const LEGACY_TOOLS_FOR_ROADMAP = ['add_roadmap_entry', 'set_feature_status', 'propose_followup'];
const LEGACY_TOOLS_FOR_CHANGELOG = ['add_changelog_entry'];
const LEGACY_TOOLS_FOR_FEATURE_JSON = [
  'add_roadmap_entry', 'set_feature_status', 'link_artifact',
  'link_features', 'record_completion', 'propose_followup',
];

const FD = 'docs/features';

describe('ship point resolves legacy mappings byte-for-byte', () => {
  test('ROADMAP.md', () => {
    assert.deepEqual(toolsForPath('ROADMAP.md', { featuresDir: FD, point: 'ship' }), LEGACY_TOOLS_FOR_ROADMAP);
  });
  test('CHANGELOG.md', () => {
    assert.deepEqual(toolsForPath('CHANGELOG.md', { featuresDir: FD, point: 'ship' }), LEGACY_TOOLS_FOR_CHANGELOG);
  });
  test('feature.json — full set', () => {
    assert.deepEqual(toolsForPath('docs/features/X-1/feature.json', { featuresDir: FD, point: 'ship' }), LEGACY_TOOLS_FOR_FEATURE_JSON);
  });
  test('feature.json honors a non-default featuresDir', () => {
    assert.deepEqual(toolsForPath('specs/features/X-1/feature.json', { featuresDir: 'specs/features', point: 'ship' }), LEGACY_TOOLS_FOR_FEATURE_JSON);
    assert.deepEqual(toolsForPath('docs/features/X-1/feature.json', { featuresDir: 'specs/features', point: 'ship' }), []);
  });
});

describe('each enforcement point consumes only its subset', () => {
  test('ship guards exactly the three legacy shapes, not judgment', () => {
    assert.deepEqual(guardedPatternIdsFor('ship').sort(), ['changelog', 'feature-json', 'roadmap']);
  });
  test('hook guards judgment and the override governance state, not the legacy shapes', () => {
    // COMP-CANON-OVERRIDE S1 widened this set deliberately. The override's own
    // ledger, attest baseline and grant directory are hook-guarded so the
    // runtime cannot rewrite its own audit trail; they are additionally
    // `overrideEligible: false` (see canon-registry-override.test.js) so the
    // override cannot be turned on itself. The legacy ship shapes stay out.
    assert.deepEqual(
      guardedPatternIdsFor('hook').sort(),
      ['judgment', 'override-attest', 'override-grants', 'override-ledger'],
    );
  });
  test('ROADMAP.md is ship-guarded but NOT hook-guarded', () => {
    assert.equal(isGuarded('ROADMAP.md', { featuresDir: FD, point: 'ship' }), true);
    assert.equal(isGuarded('ROADMAP.md', { featuresDir: FD, point: 'hook' }), false);
  });
  test('feature.json is ship-guarded but NOT hook-guarded (Decision 2 lockout)', () => {
    assert.equal(isGuarded('docs/features/X/feature.json', { featuresDir: FD, point: 'ship' }), true);
    assert.equal(isGuarded('docs/features/X/feature.json', { featuresDir: FD, point: 'hook' }), false);
  });
});

describe('judgment paths are hook-guarded, not ship-guarded (this slice)', () => {
  const cases = [
    'docs/judgment/records/joints/x.json',
    'docs/judgment/LEDGER.md',
    'docs/judgment/positions/some-slug.md',
    'docs/judgment/people/ruze.md',
    'docs/judgment/OBJECTIVE.md',
  ];
  for (const p of cases) {
    test(`${p} → hook-guarded, judgment tools`, () => {
      assert.equal(isGuarded(p, { featuresDir: FD, point: 'hook' }), true);
      assert.deepEqual(toolsForPath(p, { featuresDir: FD, point: 'hook' }), JUDGMENT_WRITE_TOOLS);
    });
    test(`${p} → NOT ship-guarded`, () => {
      assert.equal(isGuarded(p, { featuresDir: FD, point: 'ship' }), false);
      assert.deepEqual(toolsForPath(p, { featuresDir: FD, point: 'ship' }), []);
    });
  }
});

describe('lockout invariant — unregistered paths are guarded by no point', () => {
  const unregistered = ['README.md', 'src/index.js', 'docs/features/X/design.md', 'docs/whatever.md', 'docs/judgmentX/y.md'];
  for (const p of unregistered) {
    test(`${p} guarded by neither ship nor hook`, () => {
      assert.equal(isGuarded(p, { featuresDir: FD, point: 'ship' }), false);
      assert.equal(isGuarded(p, { featuresDir: FD, point: 'hook' }), false);
      assert.deepEqual(toolsForPath(p, { featuresDir: FD, point: 'ship' }), []);
      assert.deepEqual(toolsForPath(p, { featuresDir: FD, point: 'hook' }), []);
    });
  }
});

describe('featureCodeForPath — code correlation preserved', () => {
  test('single-segment feature dir → code', () => {
    assert.equal(featureCodeForPath('docs/features/COMP-X/feature.json', { featuresDir: FD }), 'COMP-X');
  });
  test('nested/multi-segment → null (no false correlation)', () => {
    assert.equal(featureCodeForPath('docs/features/a/b/feature.json', { featuresDir: FD }), null);
  });
  test('non-feature path → null', () => {
    assert.equal(featureCodeForPath('ROADMAP.md', { featuresDir: FD }), null);
  });
});
