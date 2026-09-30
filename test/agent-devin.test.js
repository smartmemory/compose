import { tier, thinking } from './helpers/model-catalog.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { PROVIDERS, validateAgentString, resolveAgentConfig } from '../lib/agent-string.js';
import { resolveTierModel, resolveTierThinking } from '../server/model-tiers.js';
import { runAndNormalize } from '../lib/result-normalizer.js';
import { resolvePlanSpecValues } from '../lib/stratum-mcp-client.js';
import { preflightPipelineProfiles, resolveRoleCollision } from '../lib/build.js';
import { routingExecutedTier } from '../lib/routing-ledger.js';
import { devinBuildFixture } from './helpers/devin-build-fixture.js';
import { runOneStep } from '../lib/gsd.js';

for (const raw of ['devin', 'devin::fast', 'devin::critical']) test(`accept ${raw}`, () => validateAgentString(raw));
test('provider list and error vocabulary', () => {
  assert.deepEqual(PROVIDERS, ['claude', 'codex', 'devin']);
  assert.ok(Object.isFrozen(PROVIDERS));
  assert.throws(() => validateAgentString('gemini'), /known: claude, codex, devin/);
  assert.throws(() => validateAgentString('devin::coordinator'), /not available for provider "devin"/);
});
for (const key of ['critical', 'standard', 'fast', 'budget']) test(`Devin ${key}`, () => {
  const cfg = resolveAgentConfig(`devin::${key}`);
  assert.equal(cfg.modelID, tier('devin', key).model); assert.equal(cfg.effort, tier('devin', key).effort); assert.equal(cfg.thinking, null);
});
test('bare and unknown tiers leave model and effort unset', () => {
  assert.equal(resolveAgentConfig('devin').modelID, null);
  assert.equal(resolveAgentConfig('devin').effort, null);
  assert.equal(resolveTierModel('fast', 'gemini'), null);
  assert.equal(resolveTierThinking('fast', 'gemini'), null);
});
for (const agent of PROVIDERS) for (const sandboxMode of [undefined, 'workspace-write']) test(`${agent} sandbox ${sandboxMode}`, async () => {
  let request;
  const stratum = { onEvent() { return () => {}; }, async agentRun(provider, _prompt, options) { assert.equal(provider, agent); request = options; return { text: 'done' }; } };
  await runAndNormalize(null, 'work', { step_id: 'work', agent }, { stratum, profile: `${agent}:read-only-reviewer:fast`, sandboxMode, executionRuntime: 'stratum' });
  assert.equal(request.sandboxMode, agent === 'claude' ? undefined : sandboxMode ?? 'read-only');
  if (agent !== 'claude') { assert.equal(request.thinking, undefined); assert.equal(request.allowedTools, undefined); }
});
test('bare Devin dispatch omits model and effort', async () => {
  await runAndNormalize(null, 'work', { agent: 'devin' }, { stratum: {
    onEvent() { return () => {}; }, async agentRun(_agent, _prompt, opts) { assert.equal(opts.modelID, undefined); assert.equal(opts.effort, undefined); return { text: 'done' }; },
  } });
});
const spec = agent => ({ version: 1, flows: { entry: 'main', main: { steps: [{ id: 'work', fanout: { dispatch: 'consumer', steps: [{ agent, do: 'work' }] } }] } } });
test('runtime roles resolve full Devin profiles to bare providers', () => {
  const profiles = {};
  const result = resolvePlanSpecValues(spec('$.input.implementer_agent'), { implementer_agent: 'devin::fast' }, profiles);
  assert.equal(result.flows.main.steps[0].fanout.steps[0].agent, 'devin');
  assert.equal(profiles.work, 'devin::fast');
});
test('authoring preflight accepts bare Devin and matching sidecars, rejects mismatch', () => {
  assert.equal(preflightPipelineProfiles({}, spec('devin')).resolved.work.provider, 'devin');
  assert.equal(preflightPipelineProfiles({ work: 'devin::fast' }, spec('devin')).resolved.work.modelID, tier('devin', 'fast').model);
  assert.throws(() => preflightPipelineProfiles({ work: 'devin::fast' }, spec('claude')), /provider|agent/);
});
for (const file of ['routing-start.schema.json','routing-record.schema.json','review-result.json','comp-obs-contract.schema.json']) test(`${file} provider contract accepts Devin only among known providers`, () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/' + file, import.meta.url)));
  const enums = [];
  function walk(value) { if (!value || typeof value !== 'object') return; if (value.enum?.includes('claude') && value.enum.includes('codex')) enums.push(value); for (const child of Object.values(value)) walk(child); }
  walk(schema); assert.equal(enums.length, 1);
  const validate = new Ajv().compile(enums[0]);
  assert.ok(validate('devin')); assert.equal(validate('gemini'), false);
  if (file === 'review-result.json') assert.ok(validate('judge'));
});
for (const tiers of [['fast'], ['fast','budget']]) test(`executed attribution ${tiers}`, () => {
  const mappings = Object.fromEntries(tiers.map(tier => [tier, resolveAgentConfig(`devin::${tier}`)]));
  const actual = routingExecutedTier({ mappings }, { transport: 'stratum', profileIntent: { provider: 'devin' } }, { id: 'r', launchOutcome: 'executed', reportedModel: tier('devin', 'fast').model, reportedEffort: tier('devin', 'fast').effort });
  assert.equal(actual.status, tiers.length === 1 ? 'known' : 'unknown');
  assert.equal(actual.value, tiers.length === 1 ? 'fast' : null);
});
for (const authoredAgent of ['devin', 'devin::fast', '$.input.implementer_agent']) {
  test(`GSD refuses ordinary ${authoredAgent} before routing issuance or dispatch`, async () => {
    const localSpec = { version: 1, flows: { entry: 'main', main: { steps: [{ id: 'work', agent: authoredAgent, do: 'work' }] } } };
    const resolved = resolvePlanSpecValues(localSpec, { implementer_agent: 'devin::fast' });
    let calls = 0;
    await assert.rejects(runOneStep({ status: 'ready', runId: 'flow', ready: [resolved.flows.main.steps[0]] }, {
      stratum: { async agentRun() { calls++; throw new Error('unexpected dispatch'); } }, localSpec,
    }), /devin is not supported for GSD direct steps yet \(COMP-AGENT-DEVIN-1\); use a consumer fan-out stage/);
    assert.equal(calls, 0);
  });
}

for (const [provider, fallback] of [['claude', 'codex'], ['codex', 'claude'], ['devin', 'codex']]) {
  test(`role collision resolves ${provider} to ${fallback} through build role resolver`, () => {
    assert.deepEqual(resolveRoleCollision(provider, provider, { implementerExplicit: true }), {
      implementerAgent: provider, reviewerAgent: fallback,
    });
  });
}
for (const [roles, expected] of [
  [{ reviewer: 'claude' }, { implementer_agent: 'codex', reviewer_agent: 'claude' }],
  [{ implementer: 'codex' }, { implementer_agent: 'codex', reviewer_agent: 'claude' }],
]) test(`build invocation resolves ${JSON.stringify(roles)} collision`, async () => {
  const { planInputs } = await devinBuildFixture({ roles });
  assert.equal(planInputs.implementer_agent, expected.implementer_agent);
  assert.equal(planInputs.reviewer_agent, expected.reviewer_agent);
});

test('programmatic Devin implementer and consumer build use fake dispatch', async () => {
  const { planInputs } = await devinBuildFixture({ roles: { implementer: 'devin' } });
  assert.equal(planInputs.implementer_agent, 'devin');
  assert.equal(planInputs.reviewer_agent, 'codex');
});

test('explicit Devin pair warns and preserves both programmatic roles', async () => {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { planInputs } = await devinBuildFixture({ roles: { implementer: 'devin', reviewer: 'devin' } });
    assert.equal(planInputs.implementer_agent, 'devin');
    assert.equal(planInputs.reviewer_agent, 'devin');
    assert.ok(warnings.some(message => message.includes('both devin') && message.includes('cross-model review is disabled')));
  } finally { console.warn = previous; }
});
test('literal tiered Devin authoring is rejected by planning validation', async () => {
  await assert.rejects(devinBuildFixture({ authoredAgent: 'devin::fast' }), /Invalid enum value/);
});
for (const role of ['implementer', 'reviewer']) test(`programmatic unknown ${role} lists all providers`, async () => {
  await assert.rejects(devinBuildFixture({ roles: { [role]: 'gemini' } }), /known: claude, codex, devin/);
});
