import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageLenses,
  classifyDiffSize,
  shouldRunCrossModel,
  LENS_DEFINITIONS,
  BASELINE_LENSES,
} from '../lib/review-lenses.js';

const REQUIRED_FIELDS = ['id', 'lens_name', 'lens_focus', 'confidence_gate', 'exclusions'];

describe('classifyDiffSize', () => {
  it('returns small for 0 files', () => {
    assert.equal(classifyDiffSize([]), 'small');
  });

  it('returns small for 1 file', () => {
    assert.equal(classifyDiffSize(['a.js']), 'small');
  });

  it('returns small for 2 files', () => {
    assert.equal(classifyDiffSize(['a.js', 'b.js']), 'small');
  });

  it('returns medium for 3 files', () => {
    assert.equal(classifyDiffSize(['a.js', 'b.js', 'c.js']), 'medium');
  });

  it('returns medium for 8 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 8 }, (_, i) => `f${i}.js`)), 'medium');
  });

  it('returns large for 9 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 9 }, (_, i) => `f${i}.js`)), 'large');
  });

  it('returns large for 20 files', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 20 }, (_, i) => `f${i}.js`)), 'large');
  });

  it('handles non-array input gracefully (null → small)', () => {
    assert.equal(classifyDiffSize(null), 'small');
  });

  // STRAT-REV-FU-1: line-count gate aligned with original design (>200 lines = large)
  it('promotes small file-count diff to large when lineCount ≥ 200', () => {
    assert.equal(classifyDiffSize(['big-refactor.js'], 250), 'large');
  });

  it('promotes small file-count diff to medium when 50 ≤ lineCount < 200', () => {
    assert.equal(classifyDiffSize(['mid-refactor.js'], 100), 'medium');
  });

  it('keeps file-count gate primary — 9 files still large regardless of small lineCount', () => {
    assert.equal(classifyDiffSize(Array.from({ length: 9 }, (_, i) => `f${i}.js`), 10), 'large');
  });

  it('takes the larger of file-count and line-count classifications', () => {
    // 3 files = medium, 250 lines = large → large wins
    assert.equal(classifyDiffSize(['a.js', 'b.js', 'c.js'], 250), 'large');
    // 9 files = large, 10 lines = small → large wins
    assert.equal(classifyDiffSize(Array.from({ length: 9 }, (_, i) => `f${i}.js`), 10), 'large');
  });

  it('omitting lineCount preserves original file-count behavior', () => {
    assert.equal(classifyDiffSize(['a.js']), 'small');
    assert.equal(classifyDiffSize(['a.js', 'b.js', 'c.js']), 'medium');
  });
});

describe('shouldRunCrossModel', () => {
  it('returns false for small diff (2 files)', () => {
    assert.equal(shouldRunCrossModel(['a.js', 'b.js']), false);
  });

  it('returns false for medium diff (5 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 5 }, (_, i) => `f${i}.js`)), false);
  });

  it('returns true for large diff (9 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 9 }, (_, i) => `f${i}.js`)), true);
  });

  it('returns true for large diff (15 files)', () => {
    assert.equal(shouldRunCrossModel(Array.from({ length: 15 }, (_, i) => `f${i}.js`)), true);
  });

  it('returns false for empty file list', () => {
    assert.equal(shouldRunCrossModel([]), false);
  });

  // STRAT-REV-FU-1
  it('returns true for small file count when lineCount ≥ 200 (single-file mega-refactor)', () => {
    assert.equal(shouldRunCrossModel(['big-refactor.js'], 250), true);
  });

  it('returns false for small file count when lineCount < 200', () => {
    assert.equal(shouldRunCrossModel(['small.js'], 50), false);
  });
});

// STRAT-REV-FU-1: shortstat parser regression tests
describe('parseShortstat (STRAT-REV-FU-1)', () => {
  it('parses insertions+deletions', async () => {
    const { parseShortstat } = await import('../lib/build.js');
    assert.equal(parseShortstat(' 3 files changed, 10 insertions(+), 5 deletions(-)\n'), 15);
  });

  it('parses insertions-only (no deletions)', async () => {
    const { parseShortstat } = await import('../lib/build.js');
    assert.equal(parseShortstat(' 1 file changed, 250 insertions(+)\n'), 250);
  });

  it('parses deletions-only — must-fix from Codex review', async () => {
    const { parseShortstat } = await import('../lib/build.js');
    assert.equal(parseShortstat(' 1 file changed, 250 deletions(-)\n'), 250);
  });

  it('returns 0 for empty stdout (no changes)', async () => {
    const { parseShortstat } = await import('../lib/build.js');
    assert.equal(parseShortstat(''), 0);
    assert.equal(parseShortstat('   \n'), 0);
  });

  it('returns null for unrecognized shape (preserves file-count-only fallback)', async () => {
    const { parseShortstat } = await import('../lib/build.js');
    assert.equal(parseShortstat('garbage output\n'), null);
  });
});

describe('triageLenses', () => {
  it('returns baseline lenses for any file list', () => {
    const tasks = triageLenses(['README.md']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('diff-quality'), 'missing diff-quality');
    assert.ok(ids.includes('contract-compliance'), 'missing contract-compliance');
  });

  it('adds security lens for auth files', () => {
    const tasks = triageLenses(['src/auth/login.js']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('security'), 'missing security lens for auth file');
  });

  it('adds security lens for SQL files', () => {
    const tasks = triageLenses(['db/query.sql']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('security'), 'missing security lens for SQL file');
  });

  it('adds framework lens for JSX files', () => {
    const tasks = triageLenses(['src/App.jsx']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('framework'), 'missing framework lens for JSX file');
  });

  it('adds framework lens for Next.js config', () => {
    const tasks = triageLenses(['next.config.js']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('framework'), 'missing framework lens for Next.js config');
  });

  it('returns all 5 lenses when both triggers present', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    const ids = tasks.map(t => t.id);
    assert.equal(ids.length, 5, `expected 5 lenses, got ${ids.length}: ${ids}`);
    assert.ok(ids.includes('diff-quality'));
    assert.ok(ids.includes('contract-compliance'));
    assert.ok(ids.includes('debug-discipline'));
    assert.ok(ids.includes('security'));
    assert.ok(ids.includes('framework'));
  });

  it('does not duplicate baseline lenses when triggers overlap', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    const ids = tasks.map(t => t.id);
    const diffQualityCount = ids.filter(id => id === 'diff-quality').length;
    assert.equal(diffQualityCount, 1, 'diff-quality should appear exactly once');
  });

  it('each LensTask has required fields', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    for (const task of tasks) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          field in task,
          `lens ${task.id || 'unknown'} missing field: ${field}`
        );
      }
    }
  });

});

describe('lens reasoning_template', () => {
  const LENS_IDS = Object.keys(LENS_DEFINITIONS);

  it('every lens has a reasoning_template object', () => {
    for (const id of LENS_IDS) {
      const def = LENS_DEFINITIONS[id];
      assert.ok(def.reasoning_template, `${id} missing reasoning_template`);
      assert.equal(typeof def.reasoning_template, 'object');
    }
  });

  it('every reasoning_template has require_citations: true', () => {
    for (const id of LENS_IDS) {
      assert.strictEqual(
        LENS_DEFINITIONS[id].reasoning_template.require_citations,
        true,
        `${id} missing require_citations`
      );
    }
  });

  it('every reasoning_template has exactly 3 sections', () => {
    for (const id of LENS_IDS) {
      const sections = LENS_DEFINITIONS[id].reasoning_template.sections;
      assert.ok(Array.isArray(sections), `${id} sections not an array`);
      assert.equal(sections.length, 3, `${id} expected 3 sections, got ${sections.length}`);
    }
  });

  it('every section has id, label, description', () => {
    for (const id of LENS_IDS) {
      for (const section of LENS_DEFINITIONS[id].reasoning_template.sections) {
        assert.ok(section.id, `${id} section missing id`);
        assert.ok(section.label, `${id} section missing label`);
        assert.ok(section.description, `${id} section missing description`);
      }
    }
  });

  it('first section is always premises', () => {
    for (const id of LENS_IDS) {
      const first = LENS_DEFINITIONS[id].reasoning_template.sections[0];
      assert.equal(first.id, 'premises', `${id} first section should be premises`);
    }
  });

  it('last section is always findings', () => {
    for (const id of LENS_IDS) {
      const sections = LENS_DEFINITIONS[id].reasoning_template.sections;
      const last = sections[sections.length - 1];
      assert.equal(last.id, 'findings', `${id} last section should be findings, got ${last.id}`);
    }
  });

  it('triageLenses returns tasks that still include reasoning_template', () => {
    const tasks = triageLenses(['src/auth/login.jsx']);
    for (const task of tasks) {
      assert.ok(task.reasoning_template, `triage task ${task.id} missing reasoning_template`);
    }
  });
});

describe('debug-discipline lens', () => {
  it('debug-discipline lens exists in LENS_DEFINITIONS', () => {
    assert.ok(LENS_DEFINITIONS['debug-discipline'], 'missing debug-discipline lens');
  });

  it('debug-discipline is a baseline lens', () => {
    assert.ok(BASELINE_LENSES.includes('debug-discipline'), 'debug-discipline should be baseline');
  });

  it('debug-discipline lens has reasoning_template', () => {
    const lens = LENS_DEFINITIONS['debug-discipline'];
    assert.ok(lens.reasoning_template);
    assert.equal(lens.reasoning_template.require_citations, true);
    assert.equal(lens.reasoning_template.sections.length, 3);
  });

  it('triageLenses always includes debug-discipline', () => {
    const tasks = triageLenses(['README.md']);
    const ids = tasks.map(t => t.id);
    assert.ok(ids.includes('debug-discipline'), 'should always include debug-discipline');
  });
});
