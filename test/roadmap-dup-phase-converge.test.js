/**
 * Regression: typed-writer regen must CONVERGE on duplicate phase headings.
 *
 * Root cause (forge-top "Wave 6" 4×/2× recurrence): readPhaseOrder returns a
 * phaseId once per heading occurrence; generateRoadmapFromBase iterated that
 * array verbatim and re-emitted the same anon-phase block once per occurrence,
 * making regen a fixed point on duplicates instead of a converger. A duplicate
 * introduced once became permanent and survived hand-collapse on the next regen.
 *
 * Contract: regenerating a source that contains the same phase heading N times
 * yields exactly ONE copy, and the result is idempotent thereafter.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateRoadmapFromBase } from '../lib/roadmap-gen.js';

const dupSource = [
  '# X Roadmap', '', 'intro', '', '---', '',
  '## Wave 6 — Situational Awareness — COMPLETE', '',
  '| # | Item | Status |', '|---|------|--------|',
  '| — | COMP-OBS-BRANCH | COMPLETE |', '',
  '---', '',
  '## Other — PLANNED', '',
  '| # | Item | Status |', '|---|------|--------|',
  '| — | FOO | PLANNED |', '',
  '---', '',
  '## Wave 6 — Situational Awareness — COMPLETE', '',
  '| # | Item | Status |', '|---|------|--------|',
  '| — | COMP-OBS-BRANCH | COMPLETE |', '',
].join('\n');

describe('typed-writer convergence on duplicate phase headings', () => {
  test('a doubled phase heading collapses to one on regen', () => {
    const out = generateRoadmapFromBase(dupSource, [], { projectName: 'X' });
    const count = (out.match(/^## Wave 6 /gm) || []).length;
    assert.equal(count, 1, `expected exactly 1 "## Wave 6" heading, got ${count}`);
  });

  test('regen is a converger, not a fixed point (4x -> 1x, then stable)', () => {
    const quad = dupSource + '\n---\n\n' +
      ['## Wave 6 — Situational Awareness — COMPLETE', '',
       '| # | Item | Status |', '|---|------|--------|',
       '| — | COMP-OBS-BRANCH | COMPLETE |', '',
       '---', '',
       '## Wave 6 — Situational Awareness — COMPLETE', '',
       '| # | Item | Status |', '|---|------|--------|',
       '| — | COMP-OBS-BRANCH | COMPLETE |', ''].join('\n');

    let txt = quad;
    for (let i = 0; i < 3; i++) txt = generateRoadmapFromBase(txt, [], { projectName: 'X' });
    const count = (txt.match(/^## Wave 6 /gm) || []).length;
    assert.equal(count, 1, `expected convergence to 1, got ${count}`);

    // Idempotent thereafter (byte-equal).
    const again = generateRoadmapFromBase(txt, [], { projectName: 'X' });
    assert.equal(again, txt, 'regen of a converged file must be byte-idempotent');
  });

  test('the surviving phase keeps its full title + content', () => {
    const out = generateRoadmapFromBase(dupSource, [], { projectName: 'X' });
    assert.ok(out.includes('## Wave 6 — Situational Awareness — COMPLETE'),
      'full heading title must survive');
    assert.ok(out.includes('COMP-OBS-BRANCH'), 'anon row content must survive');
    assert.ok(/^## Other /m.test(out), 'unrelated phases must be unaffected');
  });
});
