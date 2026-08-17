/**
 * policy-check-build-wiring.test.js — COMP-POLICY-CHECK-3/4/5/6 through the
 * REAL build loop (runBuild over the live TS engine bin, stubbed agent).
 *
 * Proves the wiring end to end rather than the seam functions in isolation:
 * a violating draft triggers exactly one revision pass, the revised draft is
 * what the step reports, every match (flagged AND suppressed) lands in
 * feature-events.jsonl + build-stream.jsonl, and `unsuppressed_violations`
 * reaches the step output so a spec-declared
 * `ensure: ['result.unsuppressed_violations == 0']` governs.
 *
 * Harness shape borrowed from retry-cap-enforcement.test.js.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild, settleDispatches } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { _clearCatalogCache } from '../lib/policy-catalog.js';
import { seedCanonicalCatalog } from './helpers/policy-catalog-stub.js';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

// Single-step pipeline. The out contract DECLARES unsuppressed_violations, which
// is what lets Compose attach the count (strict contracts are left untouched
// when the field is undeclared) and what makes the ensure evaluable.
function policySpec({ attempts = 1 } = {}) {
  return `
version: 1
contracts:
  R:
    passed: boolean
    summary: string
    unsuppressed_violations: number
flows:
  entry: fix
  fix:
    input:
      task: string
    output:
      from: \${work.output}
      contract: R
    steps:
      - id: work
        do: "work \${input.task}"
        out: R
        attempts: ${attempts}
        ensure:
          - expr: "result.unsuppressed_violations == 0"
`;
}

/**
 * Agent stub: the Nth response is drafts[N-1] (last one repeats). Records every
 * prompt it was handed so the revision pass is observable.
 */
function scriptedAgentFactory(drafts, prompts) {
  return function factory() {
    return {
      async *run(prompt) {
        prompts.push(prompt);
        const draft = drafts[Math.min(prompts.length - 1, drafts.length - 1)];
        const { _usage, ...payload } = draft;
        yield { type: 'assistant', content: JSON.stringify(payload) };
        if (_usage) yield { type: 'usage', ..._usage };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

async function setupWorkspace(code, { attempts, memoryDir, userMode }) {
  const workspace = await mkdtemp(join(tmpdir(), 'policy-build-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'policy-build-state-'));
  await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
  await mkdir(join(workspace, 'pipelines'), { recursive: true });
  await mkdir(join(workspace, 'docs', 'bugs', code), { recursive: true });
  await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({
    version: 2,
    capabilities: { stratum: true },
    policyCheck: { memoryDir, ...(userMode ? { userMode } : {}) },
  }));
  await writeFile(join(workspace, 'pipelines', 'bug-fix.stratum.yaml'), policySpec({ attempts }));
  await writeFile(join(workspace, 'docs', 'bugs', code, 'description.md'), `# ${code}\n`);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workspace });
  return { workspace, stateRoot };
}

async function runPolicyBuild(code, { drafts, task, attempts = 1, memoryDir, userMode }) {
  const { workspace, stateRoot } = await setupWorkspace(code, { attempts, memoryDir, userMode });
  const prompts = [];
  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN], cwd: workspace,
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
  installAgentHarness(client, scriptedAgentFactory(drafts, prompts), workspace);
  try {
    await runBuild(code, {
      cwd: workspace, stratum: client, template: 'bug-fix', mode: 'bug',
      skipTriage: true, description: task,
    });
  } finally {
    await client.close();
  }
  return { workspace, stateRoot, prompts };
}

async function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const VIOLATING = { passed: true, summary: 'Wired the loader. Want me to continue with the tests?' };
const CLEAN = { passed: true, summary: 'Wired the loader, then wrote the tests.' };

describe('COMP-POLICY-CHECK — build loop wiring', () => {
  const cleanups = [];
  afterEach(async () => {
    _clearCatalogCache();
    for (const p of cleanups.splice(0)) await rm(p, { recursive: true, force: true });
  });

  test('a violating draft triggers exactly one revision pass and the revision stands', async () => {
    const memoryDir = seedCanonicalCatalog();
    cleanups.push(memoryDir);
    const code = 'BUG-POLICY-REVISE';
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [VIOLATING, CLEAN],
      task: 'do the whole thing',
      memoryDir,
    });
    cleanups.push(workspace, stateRoot);

    // Exactly two agent calls: the draft and the single revision pass.
    assert.equal(prompts.length, 2, 'one revision pass, never a loop');
    assert.match(prompts[1], /POLICY CHECK/, 'the revision prompt carries the violation notice');
    assert.match(prompts[1], /Never suggest stopping points/);

    // The step passes its ensure, so the flow completes.
    const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
    assert.notEqual(active.status, 'failed', 'a revised-clean step must not fail the build');

    // COMP-POLICY-CHECK-5: trace rows for both passes.
    const events = await readJsonl(join(workspace, '.compose', 'data', 'feature-events.jsonl'));
    const policyRows = events.filter(e => e.tool === 'policy_check');
    assert.equal(policyRows.length, 1, 'the clean revision adds no new match rows');
    assert.equal(policyRows[0].step_id, 'work');
    assert.equal(policyRows[0].rule, 'Never suggest stopping points');
    assert.equal(policyRows[0].suppressed, false);
    assert.equal(policyRows[0].user_mode, 'AUTONOMOUS');
    assert.equal(policyRows[0].pass, 'initial');

    // Build stream carries the live event for the cockpit.
    const stream = await readJsonl(join(workspace, '.compose', 'build-stream.jsonl'));
    const streamed = stream.filter(e => e.type === 'policy_violation');
    assert.equal(streamed.length, 1);
    assert.equal(streamed[0].stepId, 'work');
    assert.equal(streamed[0].suppressed, false);

    // The revised (clean) draft is what the step reported, and the step_done
    // event carries no policy violations.
    const done = stream.find(e => e.type === 'build_step_done' && e.stepId === 'work');
    assert.ok(done, 'expected a build_step_done for the step');
    assert.deepEqual(done.violations.filter(v => v.startsWith('policy:')), []);
    assert.equal(done.summary, CLEAN.summary);
  });

  test('a draft that stays violating is not blocked — the declared ensure governs', async () => {
    const memoryDir = seedCanonicalCatalog();
    cleanups.push(memoryDir);
    const code = 'BUG-POLICY-PERSIST';
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [VIOLATING],           // the revision returns the same violating draft
      task: 'do the whole thing',
      memoryDir,
    });
    cleanups.push(workspace, stateRoot);

    assert.equal(prompts.length, 2, 'still exactly one revision pass — the second result stands');

    // COMP-POLICY-CHECK-6: the count reached the step output, so the spec's
    // ensure (result.unsuppressed_violations == 0) failed the step. Compose
    // itself never hard-blocked.
    const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
    assert.equal(active.status, 'failed', 'the postcondition, not Compose, gates the step');

    const stream = await readJsonl(join(workspace, '.compose', 'build-stream.jsonl'));
    const done = stream.find(e => e.type === 'build_step_done' && e.stepId === 'work');
    if (done) {
      assert.ok(
        done.violations.some(v => v.startsWith('policy: Never suggest stopping points')),
        'unsuppressed violation strings join the existing violations surface',
      );
    }

    const events = await readJsonl(join(workspace, '.compose', 'data', 'feature-events.jsonl'));
    const passes = events.filter(e => e.tool === 'policy_check').map(e => e.pass);
    assert.deepEqual(passes.slice(0, 2), ['initial', 'policy_revision'],
      'both the draft and the re-scan are traced');
  });

  test('a PACED config override suppresses the match: no revision, no violations, build proceeds', async () => {
    const memoryDir = seedCanonicalCatalog();
    cleanups.push(memoryDir);
    const code = 'BUG-POLICY-PACED';
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [VIOLATING],
      // A build has no user turns; pacing is declared, never inferred from prose.
      task: 'walk me through this one step at a time',
      userMode: 'PACED',
      memoryDir,
    });
    cleanups.push(workspace, stateRoot);

    assert.equal(prompts.length, 1, 'user precedence — no revision pass');

    const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
    assert.notEqual(active.status, 'failed', 'a suppressed match leaves unsuppressed_violations at 0');

    const events = await readJsonl(join(workspace, '.compose', 'data', 'feature-events.jsonl'));
    const policyRows = events.filter(e => e.tool === 'policy_check');
    assert.equal(policyRows.length, 1, 'the suppressed match is still traced for measurement');
    assert.equal(policyRows[0].suppressed, true);
    assert.equal(policyRows[0].user_mode, 'PACED');

    const stream = await readJsonl(join(workspace, '.compose', 'build-stream.jsonl'));
    const done = stream.find(e => e.type === 'build_step_done' && e.stepId === 'work');
    assert.ok(done);
    assert.deepEqual(done.violations.filter(v => v.startsWith('policy:')), [],
      'a suppressed match never becomes a violation string');
  });

  test('a description that reads as paced does NOT pace the build', async () => {
    const memoryDir = seedCanonicalCatalog();
    cleanups.push(memoryDir);
    const code = 'BUG-POLICY-NOINFER';
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [VIOLATING, CLEAN],
      // The exact phrase that WOULD pace an interactive turn. A feature
      // description is written once and is not a user turn — inferring PACED
      // from it would silently disable the check for the whole build.
      task: 'walk me through the loader refactor',
      memoryDir,
    });
    cleanups.push(workspace, stateRoot);

    assert.equal(prompts.length, 2, 'the check still fires and still revises');
    const events = await readJsonl(join(workspace, '.compose', 'data', 'feature-events.jsonl'));
    const rows = events.filter(e => e.tool === 'policy_check');
    assert.equal(rows[0].user_mode, 'AUTONOMOUS');
    assert.equal(rows[0].suppressed, false);
  });

  test('a replacing revision bills BOTH agent calls into the step total', async () => {
    const memoryDir = seedCanonicalCatalog();
    cleanups.push(memoryDir);
    const code = 'BUG-POLICY-ACCOUNTING';
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [
        { ...VIOLATING, _usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.001 } },
        { ...CLEAN, _usage: { input_tokens: 200, output_tokens: 20, cost_usd: 0.002 } },
      ],
      task: 'do the whole thing',
      memoryDir,
    });
    cleanups.push(workspace, stateRoot);
    assert.equal(prompts.length, 2);

    const stream = await readJsonl(join(workspace, '.compose', 'build-stream.jsonl'));
    const stepUsage = stream.find(e => e.type === 'step_usage' && e.stepId === 'work');
    assert.ok(stepUsage, 'the step must report usage');
    assert.equal(stepUsage.input_tokens, 300, 'primary + revision input tokens');
    assert.equal(stepUsage.output_tokens, 30, 'primary + revision output tokens');
    assert.ok(Math.abs(stepUsage.cost_usd - 0.003) < 1e-9, 'primary + revision cost');

    // Same totals reach build_end, so build-history/accumulator agree.
    const end = stream.find(e => e.type === 'build_end');
    assert.ok(end, 'expected a build_end');
    assert.equal(end.total_input_tokens, 300);
    assert.equal(end.total_output_tokens, 30);
  });

  test('settleDispatches settles a policy revision alongside the run it replaced', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'policy-settle-'));
    cleanups.push(cwd);

    settleDispatches(cwd, 'b-1', 'work', {
      dispatchIds: { primary: 'd-primary', repair: null, revision: 'd-revision' },
      accepted: true,
    });
    const accepted = await readJsonl(join(cwd, '.compose', 'data', 'dispatch-ledger.jsonl'));
    const settled = accepted.filter(r => r.kind === 'settlement');
    assert.deepEqual(
      settled.map(r => [r.dispatch_id, r.accepted]),
      [['d-primary', true], ['d-revision', true]],
      'both ids settle on the same verdict — no dispatch left unsettled',
    );

    // A rejected step rejects both, with the same failure class.
    settleDispatches(cwd, 'b-1', 'work2', {
      dispatchIds: { primary: 'd-p2', repair: null, revision: 'd-r2' },
      accepted: false,
      failureClass: 'agent',
    });
    const all = await readJsonl(join(cwd, '.compose', 'data', 'dispatch-ledger.jsonl'));
    const rejected = all.filter(r => r.kind === 'settlement' && r.step_id === 'work2');
    assert.deepEqual(
      rejected.map(r => [r.dispatch_id, r.accepted, r.failure_class]),
      [['d-p2', false, 'agent'], ['d-r2', false, 'agent']],
    );
  });

  test('no catalog means no scan at all — structurally inert by default', async () => {
    const code = 'BUG-POLICY-INERT';
    const emptyDir = await mkdtemp(join(tmpdir(), 'policy-empty-'));
    const { workspace, stateRoot, prompts } = await runPolicyBuild(code, {
      drafts: [VIOLATING],
      task: 'do the whole thing',
      memoryDir: emptyDir,
    });
    cleanups.push(workspace, stateRoot, emptyDir);

    assert.equal(prompts.length, 1, 'no catalog → no revision');
    const events = await readJsonl(join(workspace, '.compose', 'data', 'feature-events.jsonl'));
    assert.deepEqual(events.filter(e => e.tool === 'policy_check'), []);
  });
});
