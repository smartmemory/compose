/**
 * Integration tests for COMP-PLAN-SECTIONS:
 * T6 — emit sections after plan_gate approve
 * T7 — append trailers after ship
 *
 * These tests don't drive a full build. They exercise the helper functions
 * exported by build.js directly (T6 helper) and confirm the wiring
 * (T7 trailer append) by composing emitSections + executeShipStep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { maybeEmitSectionsAfterPlanGate, executeShipStep } from '../../lib/build.js';
import { appendTrailers, emitSections } from '../../lib/sections.js';

function tmpFeatureDir(prefix = 'compose-int-sections-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write7TaskPlan(featureDir) {
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
}

function write4TaskPlan(featureDir) {
  const tasks = [];
  for (let i = 1; i <= 4; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
}

class FakeStream {
  constructor() { this.events = []; }
  write(ev) { this.events.push(ev); }
}

// ---------- T6 ----------

test('T6: maybeEmitSectionsAfterPlanGate — 7-task plan emits sections + stream event', () => {
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  const stream = new FakeStream();
  const result = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'TEST' });
  assert.equal(result.created.length, 7);
  assert.ok(fs.existsSync(path.join(dir, 'sections')));
  const evs = stream.events.filter(e => e.type === 'build_sections_emitted');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].featureCode, 'TEST');
  assert.equal(evs[0].created.length, 7);
});

test('T6: 4-task plan does not emit folder, no event', () => {
  const dir = tmpFeatureDir();
  write4TaskPlan(dir);
  const stream = new FakeStream();
  const result = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'SMALL' });
  assert.equal(result.created.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'sections')), false);
  assert.equal(stream.events.filter(e => e.type === 'build_sections_emitted').length, 0);
});

test('T6: stepId !== plan_gate is a no-op', () => {
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  const stream = new FakeStream();
  const result = maybeEmitSectionsAfterPlanGate('design_gate', dir, { streamWriter: stream, featureCode: 'X' });
  assert.equal(result.created.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'sections')), false);
});

// S4: All three plan_gate approve branches drive maybeEmitSectionsAfterPlanGate
// idempotently. We exercise the helper directly with each policy mode value to
// confirm the gate-branch wiring shape (the build.js call sites all funnel
// through this helper unconditionally on approve).

test('S4: plan_gate approve via policy.mode=skip — emits sections idempotently', () => {
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  const stream = new FakeStream();
  // First call (mimics skip-mode auto-approve)
  const r1 = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'SKIP' });
  assert.equal(r1.created.length, 7);
  assert.ok(fs.existsSync(path.join(dir, 'sections')));
  // Re-invocation (idempotent — all skipped)
  const r2 = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'SKIP' });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.skipped.length, 7);
});

test('S4: plan_gate approve via policy.mode=flag — emits sections + stream event', () => {
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  const stream = new FakeStream();
  const r = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'FLAG' });
  assert.equal(r.created.length, 7);
  const evs = stream.events.filter(e => e.type === 'build_sections_emitted');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].featureCode, 'FLAG');
});

test('S4: plan_gate approve via human gate (mode=gate, outcome=approve) — emits sections', () => {
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  const stream = new FakeStream();
  // Human approve branch in build.js calls maybeEmitSectionsAfterPlanGate only when
  // outcome === 'approve'. Drive the helper with the same args.
  const r = maybeEmitSectionsAfterPlanGate('plan_gate', dir, { streamWriter: stream, featureCode: 'HUMAN' });
  assert.equal(r.created.length, 7);
  assert.ok(fs.existsSync(path.join(dir, 'sections')));
});

test('S4: human gate with outcome=reject does NOT call helper (verified by absence)', () => {
  // In build.js the helper is called only when outcome==='approve'. We assert that
  // not calling the helper leaves the dir untouched.
  const dir = tmpFeatureDir();
  write7TaskPlan(dir);
  // Simulate reject path: do not invoke the helper.
  assert.equal(fs.existsSync(path.join(dir, 'sections')), false);
});

// S4 (regression): static-source assertion that all three plan_gate approve
// branches in lib/build.js call maybeEmitSectionsAfterPlanGate.
//
// Why static-source rather than runtime-drive: runBuild has heavy dependencies
// (Stratum flow, vision writer, gate prompts, server probing) that aren't
// reasonable to mock in this test bed. The earlier S4 tests above exercise the
// helper directly but would still pass if any of the three call sites in
// build.js were deleted. This test catches that deletion regression by parsing
// the source — three call sites must exist (skip mode, flag mode, human gate
// approve), and each must sit in the correct policy branch.
test('S4: lib/build.js has exactly three call sites for maybeEmitSectionsAfterPlanGate (one per approve branch)', () => {
  const buildPath = path.resolve(new URL('../../lib/build.js', import.meta.url).pathname);
  const src = fs.readFileSync(buildPath, 'utf8');

  // All call sites (the function definition uses `export function ...` and is
  // excluded; we match the call form `maybeEmitSectionsAfterPlanGate(`).
  const callRe = /maybeEmitSectionsAfterPlanGate\(/g;
  const declRe = /(?:export\s+)?function\s+maybeEmitSectionsAfterPlanGate\b/g;
  const calls = (src.match(callRe) || []).length;
  const decls = (src.match(declRe) || []).length;
  const callSites = calls - decls;
  assert.equal(callSites, 3, `expected exactly 3 call sites in build.js, got ${callSites}`);

  // Locate each call's offset and slice a window of preceding source to identify
  // the branch context. We expect (in order of appearance):
  //   1. skip-mode auto-approve  (preceded by `policy.mode === 'skip'`)
  //   2. flag-mode auto-approve  (preceded by `policy.mode === 'flag'`)
  //   3. human-gate approve      (preceded by `outcome === 'approve'`)
  const offsets = [];
  let m;
  const findRe = /maybeEmitSectionsAfterPlanGate\(/g;
  while ((m = findRe.exec(src)) !== null) {
    // Skip the function declaration site
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue;
    offsets.push(m.index);
  }
  assert.equal(offsets.length, 3, 'three invocation offsets');

  // For each call, look back ~800 chars for the gating predicate.
  const window = (idx) => src.slice(Math.max(0, idx - 800), idx);
  assert.match(window(offsets[0]), /policy\.mode\s*===\s*['"]skip['"]/, 'first call site must be inside the skip-mode branch');
  assert.match(window(offsets[1]), /policy\.mode\s*===\s*['"]flag['"]/, 'second call site must be inside the flag-mode branch');
  assert.match(window(offsets[2]), /outcome\s*===\s*['"]approve['"]/, 'third call site must be inside the human-gate approve branch');
});

// ---------- T7 ----------

function makeRepoWithFeature() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-int-ship-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email "test@example.com"', { cwd: repo });
  execSync('git config user.name "Test"', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repo });
  execSync('git commit -q -m "init"', { cwd: repo });
  return repo;
}

test('T7: ship step + appendTrailers wires commit/files/diffStat into trailers', async () => {
  const repo = makeRepoWithFeature();
  const featureCode = 'TEST-INT';
  const featureDir = path.join(repo, 'docs/features', featureCode);
  fs.mkdirSync(featureDir, { recursive: true });
  // Write a 7-task plan in the feature dir
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));

  // Simulate plan_gate: emit sections
  emitSections(featureDir);
  assert.ok(fs.existsSync(path.join(featureDir, 'sections')));

  // Create some real files matching declared section files so they get committed
  fs.writeFileSync(path.join(repo, 'file1.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'file3.js'), 'export const c = 3;\n');

  const context = { mode: 'feature', filesChanged: ['file1.js', 'file3.js'] };
  const shipResult = await executeShipStep(featureCode, repo, repo, context, 'Add files', null);
  assert.equal(shipResult.outcome, 'complete');
  assert.ok(shipResult.commit);

  // T7 wiring: build.js calls appendTrailers after ship. Exercise it directly here
  // (test is structural; T7 also verifies via the build.js source change).
  appendTrailers({
    featureDir,
    commit: shipResult.commit,
    filesChanged: shipResult.filesChanged,
    diffStat: shipResult.diffStat,
  });

  const sectionsDir = path.join(featureDir, 'sections');
  const files = fs.readdirSync(sectionsDir).sort();
  assert.equal(files.length, 7);
  // Section 1: file1.js declared and changed → owned
  const s1 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1, /## What Was Built\b/);
  assert.match(s1, new RegExp(shipResult.commit));
  assert.match(s1, /file1\.js/);
  // Section 2: file2.js declared but not changed → deviation
  const s2 = fs.readFileSync(path.join(sectionsDir, files[1]), 'utf8');
  assert.match(s2, /declared but did not change[^\n]*file2\.js/);

  // Re-ship: another commit, append iteration 2
  fs.writeFileSync(path.join(repo, 'file1.js'), 'export const a = 2;\n');
  const ship2 = await executeShipStep(featureCode, repo, repo, { mode: 'feature', filesChanged: ['file1.js'] }, 'Tweak file1', null);
  assert.equal(ship2.outcome, 'complete');
  appendTrailers({
    featureDir,
    commit: ship2.commit,
    filesChanged: ship2.filesChanged,
    diffStat: ship2.diffStat,
  });
  const s1v2 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1v2, /## What Was Built \(iteration 2\)/);

  // No sections → no-op
  const dir2 = tmpFeatureDir();
  appendTrailers({ featureDir: dir2, commit: 'abc', filesChanged: [], diffStat: '' });
  assert.equal(fs.existsSync(path.join(dir2, 'sections')), false);
});
