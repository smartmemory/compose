/**
 * Regression (BUG-26): `roadmap generate` must NOT emit a second `## Features`
 * section for phase-less (ungrouped) features when a `## Features` source
 * section already exists.
 *
 * Root cause: features whose feature.json has no `phase` were collected into an
 * `ungrouped` bucket and emitted via a hardcoded `renderPhase('Features', …)`
 * call. When the source ROADMAP.md already had a curated `## Features` section,
 * the phase loop emitted that block too — producing two identical headings that
 * regenerate deterministically (and that `roadmap check` masks as a fixed point).
 *
 * Contract: phase-less features merge into the conventional `Features` phase, so
 * exactly ONE `## Features` heading is emitted, and regen is idempotent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateRoadmapFromBase } from '../lib/roadmap-gen.js';

const featuresSource = [
  '# X Roadmap', '', 'intro', '', '---', '',
  '## Features — PARTIAL', '',
  '| # | Feature | Description | Status |',
  '|---|---------|-------------|--------|',
  '| — | COMP-MOBILE | Mobile PWA | COMPLETE |',
  '| — | COMP-FLAGS | Flag parser | PLANNED |', '',
].join('\n');

// Both features lack a `phase` field — the BUG-26 trigger.
const phaselessFeatures = [
  { code: 'COMP-MOBILE', description: 'Mobile PWA', status: 'COMPLETE' },
  { code: 'COMP-FLAGS', description: 'Flag parser', status: 'PLANNED' },
];

describe('BUG-26: phase-less features merge into a single Features section', () => {
  test('phase-less features + a source ## Features section yield ONE heading', () => {
    const out = generateRoadmapFromBase(featuresSource, phaselessFeatures, { projectName: 'X' });
    const count = (out.match(/^## Features /gm) || []).length;
    assert.equal(count, 1, `expected exactly 1 "## Features" heading, got ${count}`);
  });

  test('both phase-less features survive in the single section', () => {
    const out = generateRoadmapFromBase(featuresSource, phaselessFeatures, { projectName: 'X' });
    assert.ok(out.includes('COMP-MOBILE'), 'COMP-MOBILE row must survive');
    assert.ok(out.includes('COMP-FLAGS'), 'COMP-FLAGS row must survive');
  });

  test('regen is idempotent (no re-split on the second pass)', () => {
    const once = generateRoadmapFromBase(featuresSource, phaselessFeatures, { projectName: 'X' });
    const twice = generateRoadmapFromBase(once, phaselessFeatures, { projectName: 'X' });
    assert.equal(twice, once, 'regen of a converged file must be byte-idempotent');
    const count = (twice.match(/^## Features /gm) || []).length;
    assert.equal(count, 1, `expected 1 "## Features" heading after re-regen, got ${count}`);
  });

  test('phase-less features with NO source Features section still render once', () => {
    const noFeaturesSection = ['# X Roadmap', '', 'intro', '', '---', ''].join('\n');
    const out = generateRoadmapFromBase(noFeaturesSection, phaselessFeatures, { projectName: 'X' });
    const count = (out.match(/^## Features/gm) || []).length;
    assert.equal(count, 1, `expected exactly 1 synthesized "## Features" heading, got ${count}`);
    assert.ok(out.includes('COMP-MOBILE') && out.includes('COMP-FLAGS'), 'rows must render');
  });

  test('a feature explicitly phased "Features" coexists with phase-less ones in one section', () => {
    const mixed = [
      { code: 'COMP-TYPED', description: 'Typed feature', status: 'PLANNED', phase: 'Features', position: 1 },
      { code: 'COMP-MOBILE', description: 'Mobile PWA', status: 'COMPLETE' }, // phase-less
    ];
    const out = generateRoadmapFromBase(featuresSource, mixed, { projectName: 'X' });
    const count = (out.match(/^## Features /gm) || []).length;
    assert.equal(count, 1, `typed + phase-less must share ONE section, got ${count}`);
    assert.ok(out.includes('COMP-TYPED') && out.includes('COMP-MOBILE'), 'both must render');
  });
});
