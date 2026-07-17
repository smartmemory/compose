/**
 * E3 cutover — round-5 regression fixes (H1, H2).
 *
 * H1: review_merge (a ReviewResult-out REDUCER) gets normalization but NOT the
 *     reviewer scaffold; codex_review/review (a real reviewer) still gets it.
 * H2: a run that RESOLVES late (after timeout/abort fired) still bills its usage.
 *
 * Run with: node --test test/ts-cutover-e3-round5.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import {
  resolveStepOutputContract,
  deriveOrdinaryReviewScaffold,
  loadPipelineProfiles,
  runConsumerIssuance,
} from '../lib/build.js';
import { buildStepPrompt } from '../lib/step-prompt.js';
import { buildReviewPrompt } from '../lib/review-prompt.js';
import { runAndNormalize, AgentTimeoutError } from '../lib/result-normalizer.js';

process.env.NODE_ENV = 'test';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const BUILD_SPEC_PATH = join(REPO_ROOT, 'pipelines', 'build.stratum.yaml');
const BUILD_SPEC = YAML.parse(readFileSync(BUILD_SPEC_PATH, 'utf-8'));
const BUILD_PROFILES = loadPipelineProfiles(BUILD_SPEC_PATH);
const REDUCE_STEPS = new Set(BUILD_PROFILES._reduceSteps ?? []);

// ---------------------------------------------------------------------------
// H1 — reducer (review_merge) gets normalization, NOT the reviewer scaffold
// ---------------------------------------------------------------------------
describe('H1 review_merge is a reducer, not a reviewer', () => {
  it('the build profile sidecar marks review_merge as a reduce step', () => {
    assert.ok(REDUCE_STEPS.has('review_merge'), 'build.profiles.json _reduceSteps must include review_merge');
  });

  it('review_merge: review for normalization but scaffold ABSENT', () => {
    const contractName = resolveStepOutputContract(BUILD_SPEC, 'build', 'review_merge').contractName;
    const r = deriveOrdinaryReviewScaffold({ contractName, stepId: 'review_merge', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, true, 'review_merge must still be review (normalization stays)');
    assert.equal(r.isReduceMain, true, 'review_merge is a reducer');
    assert.equal(r.isReviewScaffoldMain, false, 'a reducer must NOT get the reviewer scaffold');
  });

  it('codex_review/review: reviewer scaffold PRESENT (G1 regression guard)', () => {
    const contractName = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/review').contractName;
    const r = deriveOrdinaryReviewScaffold({ contractName, stepId: 'codex_review/review', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, true);
    assert.equal(r.isReduceMain, false);
    assert.equal(r.isReviewScaffoldMain, true, 'a real reviewer must get the scaffold');
  });

  it('a non-review step is neither review nor reduce', () => {
    const contractName = resolveStepOutputContract(BUILD_SPEC, 'build', 'blueprint').contractName;
    const r = deriveOrdinaryReviewScaffold({ contractName, stepId: 'blueprint', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, false);
    assert.equal(r.isReviewScaffoldMain, false);
  });

  it('a scoped TS ready id resolves reducer policy by its bare step id', () => {
    const r = deriveOrdinaryReviewScaffold({
      contractName: 'ReviewResult',
      stepId: 'review/review_merge',
      reduceSteps: REDUCE_STEPS,
    });
    assert.equal(r.isReviewMain, true);
    assert.equal(r.isReduceMain, true);
    assert.equal(r.isReviewScaffoldMain, false);
  });

});

// ---------------------------------------------------------------------------
// H8 — INTEGRATION: review_merge's actual prompt is the base reducer prompt
// (no reviewer scaffold), and its output goes through ReviewResult
// normalization. The pure-boolean test above only checks the classifier; this
// composes the SAME real functions the main dispatch loop composes for an
// ordinary step (buildStepPrompt → deriveOrdinaryReviewScaffold → conditional
// buildReviewPrompt scaffold → runAndNormalize with reviewMode) so a regression
// that dropped normalization or leaked the scaffold onto the reducer is caught.
// ---------------------------------------------------------------------------
const SCAFFOLD_MARKERS = ['You are a senior code reviewer', '## Severity Vocabulary'];

function reviewMergeDispatch() {
  const step = BUILD_SPEC.flows.build.steps.find(s => s.id === 'review_merge');
  return {
    step_id: 'review_merge', agent: 'claude', flow_id: 'f',
    intent: step.do, inputs: {}, output_fields: [],
    ensure: Array.isArray(step.ensure) ? step.ensure.map(e => e.expr ?? e) : [],
  };
}

// Mirrors the main dispatch loop's ordinary-step prompt construction exactly.
function composeMainStepPrompt(spec, flow, stepId, dispatch, context) {
  const basePrompt = buildStepPrompt(dispatch, context);
  const contractName = resolveStepOutputContract(spec, flow, stepId).contractName;
  const { isReviewMain, isReviewScaffoldMain } =
    deriveOrdinaryReviewScaffold({ contractName, stepId, reduceSteps: REDUCE_STEPS });
  let prompt = basePrompt;
  if (isReviewScaffoldMain) {
    prompt = buildReviewPrompt({
      agentType: 'claude', lens: 'general', lensFocus: '', exclusions: '',
      confidenceGate: 7, taskDescription: '', blueprint: '',
    }) + '\n\n' + basePrompt;
  }
  return { prompt, basePrompt, isReviewMain, isReviewScaffoldMain };
}

describe('H8 review_merge integration — base reducer prompt + ReviewResult normalization', () => {
  it("review_merge's prompt is the base reducer prompt with NO reviewer scaffold", () => {
    const dispatch = reviewMergeDispatch();
    const { prompt, basePrompt, isReviewMain, isReviewScaffoldMain } =
      composeMainStepPrompt(BUILD_SPEC, 'build', 'review_merge', dispatch, { cwd: process.cwd(), featureCode: 'F-1' });
    assert.equal(isReviewMain, true, 'review_merge still normalizes as review');
    assert.equal(isReviewScaffoldMain, false, 'review_merge must NOT be scaffolded');
    assert.equal(prompt, basePrompt, 'the reducer prompt is exactly the base step prompt (no scaffold prepended)');
    for (const marker of SCAFFOLD_MARKERS) {
      assert.ok(!prompt.includes(marker), `reducer prompt must not contain the reviewer scaffold marker: ${marker}`);
    }
    assert.ok(prompt.includes('review_merge'), 'the base prompt names the step');
    assert.ok(/merge/i.test(prompt), 'the base prompt carries the reducer (merge) intent');
  });

  it('a real reviewer (codex_review/review) DOES get the scaffold (contrast guard)', () => {
    const dispatch = { step_id: 'codex_review/review', agent: 'claude', flow_id: 'f', intent: 'review the work', inputs: {}, output_fields: [], ensure: [] };
    const { prompt, isReviewScaffoldMain } =
      composeMainStepPrompt(BUILD_SPEC, 'build', 'codex_review/review', dispatch, { cwd: process.cwd(), featureCode: 'F-1' });
    assert.equal(isReviewScaffoldMain, true, 'a real reviewer is scaffolded');
    assert.ok(SCAFFOLD_MARKERS.every(m => prompt.includes(m)), 'the reviewer prompt carries the scaffold');
  });

  it("review_merge's output is normalized to the canonical ReviewResult shape (reviewMode wiring)", async () => {
    const dispatch = reviewMergeDispatch();
    // The reducer emits a raw merge missing the canonical carrier fields; only
    // ReviewResult normalization (reviewMode:true — the value the loop derives
    // from isReviewMain) fills lenses_run / auto_fixes / asks / meta and stamps
    // findings.
    const rawMerge = JSON.stringify({
      clean: false, summary: 'merged findings',
      findings: [{ file: 'a.js', line: 3, severity: 'should-fix', finding: 'bad name', confidence: 9 }],
    });
    const stratum = {
      _localQuery: () => (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-test' };
        yield { type: 'result', subtype: 'success', result: rawMerge, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1 };
      })(),
      onEvent: () => () => {}, agentRun: async () => ({ text: '' }), cancelAgentRun: async () => {},
    };
    const out = await runAndNormalize(null, 'p', dispatch, {
      stratum, cwd: process.cwd(), localExecution: true, maxDurationMs: 5000,
      reviewMode: true, confidenceGate: 7, lens: 'general',
    });
    const result = out.result;
    assert.ok(result && typeof result === 'object', 'a structured result is produced');
    // Canonical ReviewResult carrier fields added by normalization.
    for (const field of ['clean', 'summary', 'findings', 'lenses_run', 'auto_fixes', 'asks', 'meta']) {
      assert.ok(field in result, `normalized ReviewResult must carry '${field}'`);
    }
    // Normalization stamps the applied confidence gate onto findings.
    assert.equal(result.findings[0].applied_gate, 7, 'review normalization stamped the confidence gate');
  });
});

// ---------------------------------------------------------------------------
// H2 — a late-RESOLVING run still bills its usage on the timeout path
// ---------------------------------------------------------------------------
const REVIEW_CLOSURE = {
  root: 'ReviewResult',
  contracts: { ReviewResult: { clean: 'boolean', summary: 'string', findings: 'array', meta: 'object', lenses_run: 'string[]', auto_fixes: 'array', asks: 'array' } },
};

// A local query that IGNORES the abort signal and resolves late (after the
// timeout fires) with a usage-bearing success result.
function makeLateResolveQuery(resultMessage, delayMs) {
  return function () {
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      await new Promise((r) => setTimeout(r, delayMs));
      yield resultMessage;
    })();
  };
}

const LATE_SUCCESS = {
  type: 'result', subtype: 'success', result: JSON.stringify({ clean: true, summary: 'ok', findings: [] }),
  total_cost_usd: 0.03, usage: { input_tokens: 42, output_tokens: 0 }, duration_ms: 20,
};

describe('H2 late-resolving run bills usage on timeout', () => {
  it('AgentTimeoutError carries usage when the run resolves after the timeout', async () => {
    const stratum = {
      _localQuery: makeLateResolveQuery(LATE_SUCCESS, 60),
      onEvent: () => () => {},
      agentRun: async () => ({ text: '' }),
      cancelAgentRun: async () => {},
    };
    let thrown;
    try {
      await runAndNormalize(null, 'p', { step_id: 's', agent: 'claude', flow_id: 'f' }, {
        stratum, cwd: process.cwd(), localExecution: true, maxDurationMs: 20,
      });
    } catch (err) { thrown = err; }
    assert.ok(thrown instanceof AgentTimeoutError, `expected AgentTimeoutError, got ${thrown}`);
    assert.ok(thrown.usage, 'the late-resolved run usage must ride the timeout error');
    assert.equal(thrown.usage.tokens, 42);
    assert.equal(thrown.usage.cost_usd, 0.03);
  });

  it('the consumer timeout envelope includes the late-resolved usage', async () => {
    const captured = {};
    const artifacts = {
      hooks: {},
      reconcileDescriptor: () => ({ action: 'execute', worktree: process.cwd() }),
      prepareIssuance: (_d, env) => { captured.prepared = env; },
      reconcileAudit: () => {},
      restoreToPreStageWitness: () => {},
    };
    const stratum = {
      _localQuery: makeLateResolveQuery(LATE_SUCCESS, 60),
      onEvent: () => () => {},
      stepDone: async (_f, _i, env) => { captured.envelope = env; return { status: 'completed' }; },
      audit: async () => ({}),
      agentRun: async () => ({ text: '' }),
      cancelAgentRun: async () => {},
    };
    const descriptor = {
      id: 'review_lenses/0', step: 'review_lenses', flow: 'build',
      itemIndex: 0, stage: 0, generation: 1, attempt: 1, epoch: 1, dispatchToken: 'tok-0',
      agent: 'claude', do: 'Run the review lens', item: { id: 'x', lens_name: 'security', confidence_gate: 8 },
      policy: { isolation: 'none' }, contract: REVIEW_CLOSURE,
    };
    const localSpec = { flows: { build: { steps: [{ id: 'review_lenses', fanout: { steps: [{ agent: 'claude', do: 'x', out: 'ReviewResult' }] } }] } } };
    await runConsumerIssuance({
      descriptor, flowId: 'flow-1', stratum, artifacts, localSpec,
      context: { cwd: process.cwd() },
      progress: { stepStart() {}, stepDone() {}, info() {}, debug() {}, warn() {}, toolUse() {}, toolSummary() {}, findings() {} },
      streamWriter: { write() {} },
      perItemTimeoutMs: 20,
    });
    assert.ok(captured.envelope.failure, 'a timed-out item yields a failure envelope');
    assert.ok(captured.envelope.usage, 'the timeout failure envelope must carry usage');
    assert.equal(captured.envelope.usage.tokens, 42);
    assert.ok(captured.envelope.usage.usd > 0, 'billed cost is reported');
  });
});
