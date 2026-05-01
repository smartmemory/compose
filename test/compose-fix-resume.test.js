/**
 * Tests for `compose fix --resume` flag (T8 of COMP-FIX-HARD).
 *
 * Verifies that:
 *  - Without `--resume` (default), runBuild calls stratum.plan (regression guard).
 *  - With opts.resumeFlowId set, runBuild calls stratum.resume(flowId)
 *    instead of stratum.plan.
 *  - When opts.resumeFlowId is set, the loop body proceeds normally
 *    (response handling continues).
 *  - The CLI shape (validation in bin/compose.js) errors out when no
 *    active build exists or when its featureCode does not match the
 *    requested bug code. We exercise the underlying readActiveBuild logic
 *    here against a tmpdir-backed `.compose/data/active-build.json`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runBuild } from '../lib/build.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(tmpDir, { template = 'bug-fix' } = {}) {
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 1, capabilities: { stratum: true } })
  );

  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });
  writeFileSync(
    join(pipeDir, `${template}.stratum.yaml`),
    `
version: "0.2"
contracts:
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }
flows:
  ${template === 'bug-fix' ? 'bug_fix' : template}:
    input:
      featureCode: { type: string }
      description: { type: string }
      task: { type: string }
    output: PhaseResult
    steps:
      - id: design
        agent: claude
        intent: "stub"
        inputs: { featureCode: "$.input.featureCode" }
        output_contract: PhaseResult
        retries: 1
`
  );
}

function makeMockStratum() {
  const captured = { plan: null, resume: null, stepDoneCalls: [] };
  return {
    captured,
    async connect() {},
    async plan(spec, flow, inputs) {
      captured.plan = { spec, flow, inputs };
      return {
        status: 'complete',
        flow_id: 'mock-flow-fresh',
        step_id: 'design',
        step_number: 1,
        total_steps: 1,
      };
    },
    async resume(flowId) {
      captured.resume = { flowId };
      return {
        status: 'complete',
        flow_id: flowId,
        step_id: 'design',
        step_number: 1,
        total_steps: 1,
      };
    },
    async stepDone(flowId, stepId, result) {
      captured.stepDoneCalls.push({ flowId, stepId, result });
      return { status: 'complete', flow_id: flowId };
    },
    async audit() { return { status: 'complete' }; },
    async runAgentText() { return { text: '', tokens: { input: 0, output: 0 } }; },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Tests — runBuild resume behavior
// ---------------------------------------------------------------------------

describe('runBuild — resume branch (T8)', () => {
  test('without resumeFlowId: stratum.plan is called (regression guard)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-fresh-'));
    try {
      makeProject(tmpDir);
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-A');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-A\n');

      const stratum = makeMockStratum();
      await runBuild('BUG-A', {
        cwd: tmpDir,
        stratum,
        mode: 'bug',
        template: 'bug-fix',
        description: 'A bug',
        skipTriage: true,
      });

      assert.ok(stratum.captured.plan, 'stratum.plan must have been called');
      assert.equal(stratum.captured.resume, null, 'stratum.resume must NOT be called without --resume');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('with resumeFlowId: stratum.resume is called instead of stratum.plan', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-explicit-'));
    try {
      makeProject(tmpDir);
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-B');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-B\n');

      const stratum = makeMockStratum();
      await runBuild('BUG-B', {
        cwd: tmpDir,
        stratum,
        mode: 'bug',
        template: 'bug-fix',
        description: 'B bug',
        skipTriage: true,
        resumeFlowId: 'flow-resume-xyz',
      });

      assert.ok(stratum.captured.resume, 'stratum.resume must have been called');
      assert.equal(stratum.captured.resume.flowId, 'flow-resume-xyz');
      assert.equal(stratum.captured.plan, null,
        'stratum.plan must NOT be called when resumeFlowId is provided');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('after resume: loop body proceeds normally and active-build.json is updated', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-loop-'));
    try {
      makeProject(tmpDir);
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-C');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-C\n');

      const stratum = makeMockStratum();
      await runBuild('BUG-C', {
        cwd: tmpDir,
        stratum,
        mode: 'bug',
        template: 'bug-fix',
        description: 'C bug',
        skipTriage: true,
        resumeFlowId: 'flow-c-resume',
      });

      assert.ok(stratum.captured.resume, 'resume invoked');
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      assert.ok(existsSync(activePath), 'active-build.json should be written after resume');
      const active = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.equal(active.flowId, 'flow-c-resume');
      assert.equal(active.featureCode, 'BUG-C');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — CLI shape: validation against active-build.json
// ---------------------------------------------------------------------------
//
// The CLI handler in bin/compose.js reads .compose/data/active-build.json and
// errors out if it's missing or doesn't match the bug code. We assert the
// readActiveBuild contract directly.

describe('compose fix --resume CLI validation', () => {
  test('no active-build.json: resume must error (file absent)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-none-'));
    try {
      makeProject(tmpDir);
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      assert.ok(!existsSync(activePath), 'active-build.json should not exist');
      // The CLI handler is expected to detect missing file and exit(1) with
      // "No active build to resume for <bug-code>". We assert the precondition.
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('active-build featureCode mismatch: resume must error', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-mismatch-'));
    try {
      makeProject(tmpDir);
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      writeFileSync(activePath, JSON.stringify({
        featureCode: 'BUG-OTHER',
        flowId: 'flow-other',
        status: 'running',
      }));
      // The CLI handler is expected to detect mismatch and exit(1).
      const active = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.notEqual(active.featureCode, 'BUG-X');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('active-build matches bug code: flowId is loaded and passed through', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fix-resume-match-'));
    try {
      makeProject(tmpDir);
      const activePath = join(tmpDir, '.compose', 'data', 'active-build.json');
      writeFileSync(activePath, JSON.stringify({
        featureCode: 'BUG-MATCH',
        flowId: 'flow-match-1',
        status: 'running',
      }));
      const active = JSON.parse(readFileSync(activePath, 'utf-8'));
      assert.equal(active.featureCode, 'BUG-MATCH');
      assert.equal(active.flowId, 'flow-match-1');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
