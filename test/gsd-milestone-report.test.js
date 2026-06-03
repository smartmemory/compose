// test/gsd-milestone-report.test.js
//
// COMP-GSD-7 S2: milestone report generator — model assembly, self-contained
// HTML render, atomic write to docs/gsd-reports/<feature>.html, and the
// graceful-degrade paths (missing timing / diff / budget / state).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEATURE = 'COMP-DEMO-1';

let mod;
let cwd;

function gdir(...p) { return join(cwd, '.compose', 'gsd', FEATURE, ...p); }
function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2)); }

// A full, healthy fixture: 2 tasks, both complete, timing + diffs + budget.
function seedFull() {
  writeJson(gdir('state.json'), {
    feature: FEATURE,
    status: 'complete',
    phase: 'done',
    startedAt: '2026-06-03T00:00:00.000Z',
    completedAt: '2026-06-03T00:01:40.000Z', // 100s
    pid: 4242,
    flowId: 'flow-xyz',
    decomposedTasks: [{ id: 'task-a' }, { id: 'task-b' }],
    completedTaskIds: ['task-a', 'task-b'],
  });
  writeJson(gdir('blackboard.json'), {
    'task-a': { status: 'passed', files_changed: ['lib/a.js', 'test/a.test.js'], summary: 'did A', attempts: 1 },
    'task-b': { status: 'passed', files_changed: ['lib/b.js'], summary: 'did B & <stuff>', attempts: 2 },
  });
  writeJson(gdir('timing.json'), {
    'task-a': { startedAt: '2026-06-03T00:00:00.000Z', completedAt: '2026-06-03T00:00:30.000Z', durationMs: 30000 },
    'task-b': { startedAt: '2026-06-03T00:00:05.000Z', completedAt: '2026-06-03T00:01:00.000Z', durationMs: 55000 },
  });
  mkdirSync(gdir('diffs'), { recursive: true });
  writeFileSync(gdir('diffs', 'task-a.diff'), 'diff --git a/lib/a.js b/lib/a.js\n+const a = 1;\n');
  writeFileSync(gdir('diffs', 'task-b.diff'), 'diff --git a/lib/b.js b/lib/b.js\n+const b = 2;\n');
  writeJson(gdir('budget-final.json'), {
    feature: FEATURE, kind: 'budget', axis: null,
    caps: { max_tokens: 100000, max_agent_dispatches: 10, ms: 600000, usd: 5 },
    consumed: { tokens: 42000, dispatches: 4, wall_s: 100, dollars: 1.23 },
    remainingTaskIds: [],
  });
}

describe('gsd-milestone-report', () => {
  beforeEach(async () => {
    mod = await import(`${REPO_ROOT}/lib/gsd-milestone-report.js`);
    cwd = mkdtempSync(join(tmpdir(), 'gsd-report-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  describe('assembleReportModel', () => {
    test('joins state + blackboard + timing + diffs + budget', () => {
      seedFull();
      const m = mod.assembleReportModel(FEATURE, cwd);
      assert.equal(m.feature, FEATURE);
      assert.equal(m.status, 'complete');
      assert.equal(m.startedAt, '2026-06-03T00:00:00.000Z');
      assert.equal(m.completedAt, '2026-06-03T00:01:40.000Z');
      assert.equal(m.tasks.length, 2);

      const a = m.tasks.find((t) => t.id === 'task-a');
      assert.equal(a.status, 'passed');
      assert.equal(a.attempts, 1);
      assert.deepEqual(a.filesChanged, ['lib/a.js', 'test/a.test.js']);
      assert.equal(a.durationMs, 30000);
      assert.equal(a.hasDiff, true);
      assert.match(a.diff, /const a = 1;/);

      assert.equal(m.budget.configured, true);
      assert.equal(m.budget.caps.max_tokens, 100000);
      assert.equal(m.budget.consumed.tokens, 42000);

      assert.equal(m.totals.taskCount, 2);
      assert.equal(m.totals.completed, 2);
      assert.equal(m.totals.completionRate, 1);
      assert.equal(m.totals.totalWallClockMs, 100000);
    });

    test('task order follows decomposedTasks', () => {
      seedFull();
      const m = mod.assembleReportModel(FEATURE, cwd);
      assert.deepEqual(m.tasks.map((t) => t.id), ['task-a', 'task-b']);
    });

    test('timeline includes start and completion', () => {
      seedFull();
      const m = mod.assembleReportModel(FEATURE, cwd);
      const labels = m.timeline.map((e) => e.label);
      assert.ok(labels.some((l) => /start/i.test(l)));
      assert.ok(labels.some((l) => /complet/i.test(l)));
    });

    test('degrade: no timing → durationMs null', () => {
      seedFull();
      rmSync(gdir('timing.json'));
      const m = mod.assembleReportModel(FEATURE, cwd);
      assert.equal(m.tasks.find((t) => t.id === 'task-a').durationMs, null);
    });

    test('degrade: no diff → hasDiff false, diff null', () => {
      seedFull();
      rmSync(gdir('diffs'), { recursive: true, force: true });
      const m = mod.assembleReportModel(FEATURE, cwd);
      const a = m.tasks.find((t) => t.id === 'task-a');
      assert.equal(a.hasDiff, false);
      assert.equal(a.diff, null);
    });

    test('degrade: no budget → budget.configured false', () => {
      seedFull();
      rmSync(gdir('budget-final.json'));
      const m = mod.assembleReportModel(FEATURE, cwd);
      assert.equal(m.budget.configured, false);
    });

    test('budget precedence: opts.budgetState wins over budget-final.json', () => {
      seedFull();
      const m = mod.assembleReportModel(FEATURE, cwd, {
        budgetState: { caps: { usd: 9 }, consumed: { dollars: 7 } },
      });
      assert.equal(m.budget.caps.usd, 9);
      assert.equal(m.budget.consumed.dollars, 7);
    });

    test('budget falls back to halt budget.json when no budget-final.json', () => {
      seedFull();
      rmSync(gdir('budget-final.json'));
      writeJson(gdir('budget.json'), { caps: { max_tokens: 7 }, consumed: { tokens: 7 } });
      const m = mod.assembleReportModel(FEATURE, cwd);
      assert.equal(m.budget.configured, true);
      assert.equal(m.budget.caps.max_tokens, 7);
    });

    test('no state.json → null model', () => {
      assert.equal(mod.assembleReportModel(FEATURE, cwd), null);
    });
  });

  describe('renderReportHtml', () => {
    test('self-contained: doctype, no external src/href, key data present', () => {
      seedFull();
      const html = mod.renderReportHtml(mod.assembleReportModel(FEATURE, cwd));
      assert.match(html, /<!DOCTYPE html>/i);
      assert.ok(!/src="http/.test(html) && !/href="http/.test(html), 'no external assets');
      assert.match(html, /COMP-DEMO-1/);
      assert.match(html, /task-a/);
      assert.match(html, /100000/); // budget cap
      assert.match(html, /const a = 1;/); // inlined diff
    });

    test('HTML-escapes task summaries (no raw < or unescaped &)', () => {
      seedFull();
      const html = mod.renderReportHtml(mod.assembleReportModel(FEATURE, cwd));
      // The summary "did B & <stuff>" must not appear raw.
      assert.ok(!html.includes('did B & <stuff>'));
      assert.match(html, /did B &amp; &lt;stuff&gt;/);
    });

    test('large diff is truncated with a marker', () => {
      seedFull();
      const big = 'x'.repeat(300 * 1024); // 300 KB > 200 KB cap
      writeFileSync(gdir('diffs', 'task-a.diff'), big);
      const html = mod.renderReportHtml(mod.assembleReportModel(FEATURE, cwd));
      assert.ok(html.length < big.length + 50_000, 'diff was not fully inlined');
      assert.match(html, /truncated/i);
    });

    test('unbudgeted run renders an unbudgeted note', () => {
      seedFull();
      rmSync(gdir('budget-final.json'));
      const html = mod.renderReportHtml(mod.assembleReportModel(FEATURE, cwd));
      assert.match(html, /unbudgeted|no budget/i);
    });
  });

  describe('writeGsdReport + generateGsdMilestoneReport', () => {
    test('writes to docs/gsd-reports/<feature>.html atomically', () => {
      seedFull();
      const r = mod.generateGsdMilestoneReport(FEATURE, cwd);
      assert.equal(r.ok, true);
      assert.equal(r.path, join(cwd, 'docs', 'gsd-reports', `${FEATURE}.html`));
      assert.ok(existsSync(r.path));
      assert.match(readFileSync(r.path, 'utf-8'), /<!DOCTYPE html>/i);
      assert.ok(!existsSync(`${r.path}.tmp`));
    });

    test('regenerate overwrites in place', () => {
      seedFull();
      mod.generateGsdMilestoneReport(FEATURE, cwd);
      const r2 = mod.generateGsdMilestoneReport(FEATURE, cwd);
      assert.equal(r2.ok, true);
      assert.ok(existsSync(r2.path));
    });

    test('no run state → ok:false with error, no file written', () => {
      const r = mod.generateGsdMilestoneReport(FEATURE, cwd);
      assert.equal(r.ok, false);
      assert.match(r.error, /state/i);
      assert.ok(!existsSync(join(cwd, 'docs', 'gsd-reports', `${FEATURE}.html`)));
    });
  });
});
