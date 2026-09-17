import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import {
  agentResult,
  fakeBuildStratum,
  makeBuildWorkspace,
  readyWork,
} from './helpers/build-stratum-fixture.js';

function fixture(t, code = 'RESUME-STATE') {
  const cwd = makeBuildWorkspace(code);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const activePath = join(cwd, '.compose', 'data', 'active-build.json');
  const run = (stratum, opts = {}) => runBuild(code, {
    cwd,
    mode: 'bug',
    template: 'bug-fix',
    stratum,
    skipTriage: true,
    description: 'resume state test',
    ...opts,
  });
  return { cwd, code, activePath, run };
}

test('resume refusal distinguishes a terminal failed run from no active record', async t => {
  const f = fixture(t);
  writeFileSync(f.activePath, JSON.stringify({
    featureCode: f.code,
    flowId: 'flow-failed',
    status: 'failed',
    mode: 'bug',
    currentStepId: 'stale_current_step',
  }));
  const stratum = fakeBuildStratum({
    audit: () => ({
      status: 'failed',
      steps: {
        execute_tasks: { status: 'succeeded' },
        review_lenses: { status: 'failed' },
      },
      events: [],
    }),
  });

  await assert.rejects(
    f.run(stratum, { resume: true, resumeFlowId: 'flow-failed' }),
    /The run failed at step "review_lenses" and cannot be resumed\./,
  );
  assert.equal(stratum.calls.some(call => call.type === 'plan'), false);

  rmSync(f.activePath);
  await assert.rejects(
    f.run(stratum, { resume: true }),
    /Nothing to resume \(no in-progress or failed build found\)/,
  );
  assert.equal(stratum.calls.some(call => call.type === 'plan'), false);
});

test('resume rehydrates persisted step summaries while a fresh run starts empty', async t => {
  const resumed = fixture(t, 'RESUME-HISTORY');
  writeFileSync(resumed.activePath, JSON.stringify({
    featureCode: resumed.code,
    flowId: 'flow-resume-history',
    status: 'running',
    mode: 'bug',
    currentStepId: 'work',
    steps: [{
      id: 'explore_design',
      status: 'done',
      summary: 'Design finished',
      artifact: 'docs/design.md',
      agent: 'claude',
      durationMs: 42,
      filesChanged: ['lib/design.js'],
      retries: 1,
      violations: [],
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.02,
    }],
  }));
  let resumedPrompt = null;
  const resumeStratum = fakeBuildStratum({
    audit: () => ({ status: 'running', steps: {}, events: [] }),
    agentRun: (_provider, prompt) => {
      resumedPrompt = prompt;
      return agentResult(
        { phase: 'work', outcome: 'complete', summary: 'Resumed work complete' },
        'resume-dispatch',
      );
    },
    stepDone: () => ({ status: 'completed', runId: 'flow-resume-history' }),
  });
  resumeStratum.resume = async () => ({
    ...readyWork(),
    runId: 'flow-resume-history',
  });

  await resumed.run(resumeStratum, { resume: true, resumeFlowId: 'flow-resume-history' });

  assert.match(resumedPrompt, /## Prior Steps\n- \*\*explore_design\*\*: Design finished → `docs\/design\.md`/);
  assert.deepEqual(
    JSON.parse(readFileSync(resumed.activePath, 'utf8')).steps.map(step => step.id),
    ['explore_design', 'work'],
  );

  const fresh = fixture(t, 'FRESH-HISTORY');
  writeFileSync(fresh.activePath, JSON.stringify({
    featureCode: fresh.code,
    flowId: 'stale-flow',
    status: 'complete',
    mode: 'bug',
    steps: [{ id: 'stale_step', status: 'done', summary: 'Must not leak' }],
  }));
  let freshPrompt = null;
  const freshStratum = fakeBuildStratum({
    plan: () => ({ ...readyWork(), runId: 'fresh-flow' }),
    agentRun: (_provider, prompt) => {
      freshPrompt = prompt;
      return agentResult(
        { phase: 'work', outcome: 'complete', summary: 'Fresh work complete' },
        'fresh-dispatch',
      );
    },
    stepDone: () => ({ status: 'completed', runId: 'fresh-flow' }),
  });

  await fresh.run(freshStratum, { fresh: true });
  assert.doesNotMatch(freshPrompt, /Must not leak|## Prior Steps/);
});
