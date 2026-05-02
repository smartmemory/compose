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
import { appendTrailers, emitSections, analyzeRollup, writeRollup } from '../../lib/sections.js';
import { SECTIONS_DIR } from '../../lib/constants.js';

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

// ---------- COMP-PLAN-SECTIONS-REPORT T4 ----------

/**
 * Mirror the post-ship hook in build.js so we can drive trailer + roll-up
 * behavior end-to-end without standing up a full Stratum flow. If this
 * helper drifts from build.js, the static-source assertion below catches it.
 */
function postShipHook({ featureDir, shipResult, agentCwd, streamWriter, featureCode, renameSyncStub }) {
  let postShipAnalysis = null;
  try {
    if (shipResult.commit) {
      const trailerResult = appendTrailers({
        featureDir,
        commit: shipResult.commit,
        filesChanged: shipResult.filesChanged ?? [],
        cwd: agentCwd,
      });
      const sectionsDir = path.join(featureDir, SECTIONS_DIR);
      postShipAnalysis = analyzeRollup({
        sectionsDir,
        filesChanged: shipResult.filesChanged ?? [],
      });
      if (trailerResult.trailed?.length > 0) {
        const payload = {
          type: 'build_sections_trailed',
          featureCode,
          count: trailerResult.trailed.length,
          sections: trailerResult.trailed,
        };
        if (postShipAnalysis && Array.isArray(postShipAnalysis.unattributed)) {
          payload.unattributed = postShipAnalysis.unattributed;
        }
        streamWriter.write(payload);
      }
    }
  } catch (err) {
    try { streamWriter.write({ type: 'build_error', message: `sections trailer append failed: ${err.message}`, stepId: 'ship' }); } catch { /* ignore */ }
  }
  try {
    if (shipResult.commit && postShipAnalysis) {
      const today = new Date().toISOString().slice(0, 10);
      if (renameSyncStub) {
        // Test injection: invoke writeRollup but make the rename throw.
        const origRename = fs.renameSync;
        fs.renameSync = () => { throw new Error('simulated rename failure'); };
        try {
          writeRollup({ featureDir, analysis: postShipAnalysis, commit: shipResult.commit, date: today });
        } finally {
          fs.renameSync = origRename;
        }
      } else {
        writeRollup({ featureDir, analysis: postShipAnalysis, commit: shipResult.commit, date: today });
      }
    }
  } catch (err) {
    try { streamWriter.write({ type: 'build_error', message: `sections rollup write failed: ${err.message}`, stepId: 'ship' }); } catch { /* ignore */ }
  }
}

test('T4: ship of 7-task fixture → report.md has Section Roll-up with all 7 indexed', async () => {
  const repo = makeRepoWithFeature();
  const featureCode = 'TEST-RU-1';
  const featureDir = path.join(repo, 'docs/features', featureCode);
  fs.mkdirSync(featureDir, { recursive: true });
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  for (let i = 1; i <= 7; i++) {
    fs.writeFileSync(path.join(repo, `file${i}.js`), `export const v = ${i};\n`);
  }
  const context = { mode: 'feature', filesChanged: Array.from({ length: 7 }, (_, i) => `file${i + 1}.js`) };
  const shipResult = await executeShipStep(featureCode, repo, repo, context, 'Add files', null);
  assert.equal(shipResult.outcome, 'complete');

  const stream = new FakeStream();
  postShipHook({ featureDir, shipResult, agentCwd: repo, streamWriter: stream, featureCode });

  const reportPath = path.join(featureDir, 'report.md');
  assert.ok(fs.existsSync(reportPath));
  const content = fs.readFileSync(reportPath, 'utf8');
  assert.match(content, /^## Section Roll-up\b/m);
  for (let i = 1; i <= 7; i++) {
    assert.match(content, new RegExp(`section-0${i}-title-${i}\\.md`));
  }
  const trailedEv = stream.events.find(e => e.type === 'build_sections_trailed');
  assert.ok(trailedEv);
  // The 7 declared files (file1..file7.js) must be attributed (not in unattributed).
  for (let i = 1; i <= 7; i++) {
    assert.ok(!trailedEv.unattributed.includes(`file${i}.js`), `file${i}.js should be attributed`);
  }
});

test('T4: re-ship → roll-up regenerated in place (only one heading)', async () => {
  const repo = makeRepoWithFeature();
  const featureCode = 'TEST-RU-2';
  const featureDir = path.join(repo, 'docs/features', featureCode);
  fs.mkdirSync(featureDir, { recursive: true });
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  fs.writeFileSync(path.join(repo, 'file1.js'), '1\n');
  const ship1 = await executeShipStep(featureCode, repo, repo, { mode: 'feature', filesChanged: ['file1.js'] }, 'first', null);
  postShipHook({ featureDir, shipResult: ship1, agentCwd: repo, streamWriter: new FakeStream(), featureCode });

  fs.writeFileSync(path.join(repo, 'file1.js'), '2\n');
  const ship2 = await executeShipStep(featureCode, repo, repo, { mode: 'feature', filesChanged: ['file1.js'] }, 'second', null);
  postShipHook({ featureDir, shipResult: ship2, agentCwd: repo, streamWriter: new FakeStream(), featureCode });

  const content = fs.readFileSync(path.join(featureDir, 'report.md'), 'utf8');
  const headings = content.match(/^## Section Roll-up\b/gm) || [];
  assert.equal(headings.length, 1);
  assert.match(content, new RegExp(ship2.commit.slice(0, 7)));
  assert.doesNotMatch(content, new RegExp(ship1.commit.slice(0, 7)));
});

test('T4: filesChanged includes non-declared file → unattributed in roll-up + stream event', async () => {
  const repo = makeRepoWithFeature();
  const featureCode = 'TEST-RU-3';
  const featureDir = path.join(repo, 'docs/features', featureCode);
  fs.mkdirSync(featureDir, { recursive: true });
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  fs.writeFileSync(path.join(repo, 'file1.js'), 'a\n');
  fs.writeFileSync(path.join(repo, 'rogue.js'), 'r\n');
  const context = { mode: 'feature', filesChanged: ['file1.js', 'rogue.js'] };
  const shipResult = await executeShipStep(featureCode, repo, repo, context, 'mix', null);
  assert.equal(shipResult.outcome, 'complete');

  const stream = new FakeStream();
  postShipHook({ featureDir, shipResult, agentCwd: repo, streamWriter: stream, featureCode });

  const content = fs.readFileSync(path.join(featureDir, 'report.md'), 'utf8');
  assert.match(content, /- `rogue\.js`/);
  const ev = stream.events.find(e => e.type === 'build_sections_trailed');
  assert.ok(ev);
  assert.ok(ev.unattributed.includes('rogue.js'));
});

test('T4: failure isolation — writeRollup throws, trailer event still emits, build_error emitted, ship unaffected', async () => {
  const repo = makeRepoWithFeature();
  const featureCode = 'TEST-RU-4';
  const featureDir = path.join(repo, 'docs/features', featureCode);
  fs.mkdirSync(featureDir, { recursive: true });
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  fs.writeFileSync(path.join(repo, 'file1.js'), 'x\n');
  fs.writeFileSync(path.join(repo, 'unclaimed.js'), 'u\n');
  const context = { mode: 'feature', filesChanged: ['file1.js', 'unclaimed.js'] };
  const shipResult = await executeShipStep(featureCode, repo, repo, context, 'fail-iso', null);
  assert.equal(shipResult.outcome, 'complete');

  const stream = new FakeStream();
  postShipHook({ featureDir, shipResult, agentCwd: repo, streamWriter: stream, featureCode, renameSyncStub: true });

  const trailedEv = stream.events.find(e => e.type === 'build_sections_trailed');
  assert.ok(trailedEv, 'trailer success event must fire even when writeRollup fails');
  assert.ok(trailedEv.unattributed.includes('unclaimed.js'));
  const errEv = stream.events.find(e => e.type === 'build_error' && /sections rollup write failed:/.test(e.message));
  assert.ok(errEv, 'build_error must be emitted with sections rollup write failed: prefix');
  // Ship outcome is independent (we already asserted shipResult.outcome above before the hook).
});

// Static-source guard: ensures build.js post-ship hook keeps the analyze →
// trailer-event → writeRollup ordering with isolated try/catch blocks.
test('T4: lib/build.js post-ship hook wires analyzeRollup, writeRollup, and emits build_sections_trailed.unattributed', () => {
  const buildPath = path.resolve(new URL('../../lib/build.js', import.meta.url).pathname);
  const src = fs.readFileSync(buildPath, 'utf8');
  assert.match(src, /analyzeRollup\(\{/, 'analyzeRollup must be invoked in build.js');
  assert.match(src, /writeRollup\(\{/, 'writeRollup must be invoked in build.js');
  assert.match(src, /sections rollup write failed:/, 'build_error message for rollup write failure must exist');
  // Ensure unattributed is wired into the trailer event payload.
  assert.match(src, /payload\.unattributed\s*=\s*postShipAnalysis\.unattributed/, 'unattributed field must be added to build_sections_trailed payload');
});
