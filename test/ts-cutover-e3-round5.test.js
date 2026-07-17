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
    const r = deriveOrdinaryReviewScaffold({ response: {}, contractName, stepId: 'review_merge', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, true, 'review_merge must still be review (normalization stays)');
    assert.equal(r.isReduceMain, true, 'review_merge is a reducer');
    assert.equal(r.isReviewScaffoldMain, false, 'a reducer must NOT get the reviewer scaffold');
  });

  it('codex_review/review: reviewer scaffold PRESENT (G1 regression guard)', () => {
    const contractName = resolveStepOutputContract(BUILD_SPEC, 'build', 'codex_review/review').contractName;
    const r = deriveOrdinaryReviewScaffold({ response: {}, contractName, stepId: 'codex_review/review', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, true);
    assert.equal(r.isReduceMain, false);
    assert.equal(r.isReviewScaffoldMain, true, 'a real reviewer must get the scaffold');
  });

  it('a non-review step is neither review nor reduce', () => {
    const contractName = resolveStepOutputContract(BUILD_SPEC, 'build', 'blueprint').contractName;
    const r = deriveOrdinaryReviewScaffold({ response: {}, contractName, stepId: 'blueprint', reduceSteps: REDUCE_STEPS });
    assert.equal(r.isReviewMain, false);
    assert.equal(r.isReviewScaffoldMain, false);
  });

  it('the python-era reduce_mode input still marks a reducer (legacy path)', () => {
    const r = deriveOrdinaryReviewScaffold({
      response: { output_contract: 'ReviewResult', inputs: { reduce_mode: 'true' } },
      contractName: null, stepId: 'legacy_merge', reduceSteps: new Set(),
    });
    assert.equal(r.isReviewMain, true);
    assert.equal(r.isReviewScaffoldMain, false);
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
