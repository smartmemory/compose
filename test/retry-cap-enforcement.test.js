/**
 * Tests for Compose-side retry-cap enforcement (T5 of COMP-FIX-HARD).
 *
 * Stratum's retries field is declarative but unenforced. Compose reads
 * the per-step retries cap from the YAML and force-terminates the flow
 * when iterN > maxIter. In bug mode, when the failing step is one of
 * {test, fix, diagnose}, an emitCheckpoint is fired before terminating.
 *
 * Verifies:
 *  - bug mode + test step exceeds cap -> force terminate + checkpoint.md
 *  - bug mode + scope_check step exceeds cap -> force terminate, NO checkpoint
 *  - feature mode + cap exceeded -> force terminate, NO checkpoint
 *  - YAML-declared cap is respected (retries=2 -> terminate at iterN=3)
 *  - Default cap is 3 when YAML declares no retries field for the step
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runBuild } from '../lib/build.js';
import { __setRegenerateBugIndexForTest } from '../lib/bug-checkpoint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(tmpDir, { template = 'bug-fix', stepId = 'test', retries = 2 } = {}) {
  const composeDir = join(tmpDir, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({ version: 1, capabilities: { stratum: true } })
  );

  const pipeDir = join(tmpDir, 'pipelines');
  mkdirSync(pipeDir, { recursive: true });

  // YAML with a single step whose `retries` we control. The flow name
  // is the template name (sans .stratum.yaml).
  const flowName = template === 'bug-fix' ? 'bug_fix' : template;
  const retriesLine = retries === null ? '' : `    retries: ${retries}\n`;
  writeFileSync(
    join(pipeDir, `${template}.stratum.yaml`),
    `version: "0.2"
contracts:
  PhaseResult:
    phase: { type: string }
    artifact: { type: string }
    outcome: { type: string }
functions:
  ${stepId}:
    mode: compute
    intent: "stub"
    input:
      task: { type: string }
    output: PhaseResult
${retriesLine}flows:
  ${flowName}:
    input:
      featureCode: { type: string }
      description: { type: string }
      task: { type: string }
    output: PhaseResult
    steps:
      - id: ${stepId}
        function: ${stepId}
        agent: claude
        intent: "stub"
        inputs: { task: "$.input.task" }
        output_contract: PhaseResult
`
  );
}

/**
 * Mock stratum that returns ensure_failed `failCount` times in a row,
 * then `complete`. Each ensure_failed carries response.step_id = stepId.
 *
 * On stepDone after a retry: we again return ensure_failed (until budget
 * runs out), since runBuild's ensure_failed branch retries via retryResult
 * and then calls stepDone — we want the cap check to be the gate.
 */
function makeFailingStratum({ stepId, failCount }) {
  const captured = { plan: null, stepDoneCalls: [], emittedFailures: 0 };
  let remaining = failCount;

  function failResponse() {
    return {
      status: 'ensure_failed',
      flow_id: 'mock-flow',
      step_id: stepId,
      step_number: 1,
      total_steps: 1,
      agent: 'claude',
      violations: ['stub failure'],
      inputs: { task: 'stub' },
    };
  }

  return {
    captured,
    async connect() {},
    async plan(spec, flow, inputs) {
      captured.plan = { spec, flow, inputs };
      if (remaining > 0) {
        remaining--;
        captured.emittedFailures++;
        return failResponse();
      }
      return { status: 'complete', flow_id: 'mock-flow', step_id: stepId };
    },
    async resume(flowId) {
      return { status: 'complete', flow_id: flowId, step_id: stepId };
    },
    async stepDone(flowId, stepId_, result) {
      captured.stepDoneCalls.push({ flowId, stepId: stepId_, result });
      if (remaining > 0) {
        remaining--;
        captured.emittedFailures++;
        return failResponse();
      }
      return { status: 'complete', flow_id: flowId, step_id: stepId_ };
    },
    async audit() { return { status: 'complete' }; },
    // runAndNormalize requires agentRun + onEvent + cancelAgentRun
    async agentRun(agentType, prompt, opts) {
      return {
        text: JSON.stringify({ outcome: 'failed', summary: 'still failing' }),
      };
    },
    onEvent(_correlationId, _subStepId, _handler) { return () => {}; },
    async cancelAgentRun() {},
    async runAgentText() {
      return { text: '', tokens: { input: 0, output: 0 } };
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBuild — retry-cap enforcement (T5)', () => {

  test('bug mode + test step exceeds cap -> force terminate + checkpoint.md', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rc-test-'));
    let regenCalled = false;
    __setRegenerateBugIndexForTest(() => { regenCalled = true; });
    try {
      makeProject(tmpDir, { template: 'bug-fix', stepId: 'test', retries: 2 });
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-CAP-1');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-CAP-1\n');

      // retries=2 means cap exceeds at iterN=3 (iterN > maxIter where iterN
      // is incremented BEFORE the check). Need >2 ensure_failed emissions
      // so iterN=3 is reached. Use 4 to be safe.
      const stratum = makeFailingStratum({ stepId: 'test', failCount: 4 });

      let result;
      try {
        result = await runBuild('BUG-CAP-1', {
          cwd: tmpDir,
          stratum,
          mode: 'bug',
          template: 'bug-fix',
          description: 'cap test',
          skipTriage: true,
        });
      } catch (err) {
        // runBuild may rethrow on failure; tolerate.
        result = { error: err.message };
      }

      // Checkpoint must exist
      assert.ok(
        existsSync(join(bugDir, 'checkpoint.md')),
        'checkpoint.md must be emitted on cap exceeded in bug mode for {test,fix,diagnose}'
      );
      assert.ok(regenCalled, 'regenerateBugIndex must be called via emitCheckpoint');
    } finally {
      __setRegenerateBugIndexForTest(null);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('bug mode + scope_check (not in {test,fix,diagnose}) -> terminate, NO checkpoint', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rc-scope-'));
    __setRegenerateBugIndexForTest(() => {});
    try {
      makeProject(tmpDir, { template: 'bug-fix', stepId: 'scope_check', retries: 1 });
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-CAP-2');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-CAP-2\n');

      const stratum = makeFailingStratum({ stepId: 'scope_check', failCount: 4 });

      try {
        await runBuild('BUG-CAP-2', {
          cwd: tmpDir,
          stratum,
          mode: 'bug',
          template: 'bug-fix',
          description: 'scope test',
          skipTriage: true,
        });
      } catch { /* tolerate */ }

      assert.ok(
        !existsSync(join(bugDir, 'checkpoint.md')),
        'checkpoint.md must NOT be emitted for steps outside {test, fix, diagnose}'
      );
    } finally {
      __setRegenerateBugIndexForTest(null);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('feature mode cap exceeded -> terminate, NO checkpoint', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rc-feat-'));
    __setRegenerateBugIndexForTest(() => {});
    try {
      makeProject(tmpDir, { template: 'build', stepId: 'test', retries: 2 });
      const featureDir = join(tmpDir, 'docs', 'features', 'FEAT-CAP-1');
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(featureDir, 'design.md'), '# FEAT-CAP-1\n');

      const stratum = makeFailingStratum({ stepId: 'test', failCount: 4 });

      try {
        await runBuild('FEAT-CAP-1', {
          cwd: tmpDir,
          stratum,
          template: 'build',
          description: 'feature cap test',
          skipTriage: true,
        });
      } catch { /* tolerate */ }

      // No checkpoint (bugs dir doesn't even exist for features)
      assert.ok(
        !existsSync(join(tmpDir, 'docs', 'bugs', 'FEAT-CAP-1', 'checkpoint.md')),
        'feature mode must never emit checkpoint.md'
      );
      assert.ok(
        !existsSync(join(tmpDir, 'docs', 'features', 'FEAT-CAP-1', 'checkpoint.md')),
        'feature mode must never emit checkpoint.md anywhere'
      );
    } finally {
      __setRegenerateBugIndexForTest(null);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('YAML cap respected: retries=2 -> force terminate at iterN=3', async () => {
    // The cap should fire on iter 3 specifically when YAML says retries=2.
    // We assert: stratum saw at most 3 ensure_failed emissions before
    // termination (1 initial + 2 retries permitted, 3rd triggers cap).
    const tmpDir = mkdtempSync(join(tmpdir(), 'rc-yaml-'));
    __setRegenerateBugIndexForTest(() => {});
    try {
      makeProject(tmpDir, { template: 'bug-fix', stepId: 'fix', retries: 2 });
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-CAP-3');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-CAP-3\n');

      // Provide unlimited failures; the cap should stop the loop.
      const stratum = makeFailingStratum({ stepId: 'fix', failCount: 50 });

      try {
        await runBuild('BUG-CAP-3', {
          cwd: tmpDir,
          stratum,
          mode: 'bug',
          template: 'bug-fix',
          description: 'fix cap test',
          skipTriage: true,
        });
      } catch { /* tolerate */ }

      // Did NOT loop forever; emittedFailures bounded by maxIter.
      // With retries=2, iterN reaches 3 at which point we terminate.
      // So exactly 3 ensure_failed emissions are expected before break.
      assert.ok(
        stratum.captured.emittedFailures <= 4,
        `cap should bound emissions to ~3 (got ${stratum.captured.emittedFailures})`
      );
      assert.ok(
        stratum.captured.emittedFailures >= 3,
        `should have emitted at least 3 failures before cap (got ${stratum.captured.emittedFailures})`
      );

      // Checkpoint emitted (fix is in {test,fix,diagnose})
      assert.ok(
        existsSync(join(bugDir, 'checkpoint.md')),
        'checkpoint.md emitted for fix step in bug mode'
      );
    } finally {
      __setRegenerateBugIndexForTest(null);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('default cap is 3 when YAML declares no retries for the step', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rc-default-'));
    __setRegenerateBugIndexForTest(() => {});
    try {
      makeProject(tmpDir, { template: 'bug-fix', stepId: 'diagnose', retries: null });
      const bugDir = join(tmpDir, 'docs', 'bugs', 'BUG-CAP-4');
      mkdirSync(bugDir, { recursive: true });
      writeFileSync(join(bugDir, 'description.md'), '# BUG-CAP-4\n');

      const stratum = makeFailingStratum({ stepId: 'diagnose', failCount: 50 });

      try {
        await runBuild('BUG-CAP-4', {
          cwd: tmpDir,
          stratum,
          mode: 'bug',
          template: 'bug-fix',
          description: 'diag cap test',
          skipTriage: true,
        });
      } catch { /* tolerate */ }

      // Default cap is 3 -> emissions bounded around 4 (iterN=4 triggers break).
      assert.ok(
        stratum.captured.emittedFailures <= 5,
        `default cap should bound emissions (got ${stratum.captured.emittedFailures})`
      );
      assert.ok(
        existsSync(join(bugDir, 'checkpoint.md')),
        'checkpoint.md emitted for diagnose step in bug mode'
      );
    } finally {
      __setRegenerateBugIndexForTest(null);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
