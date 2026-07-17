/**
 * ts-cutover-review-gate-golden.test.js — I1 (real-path).
 *
 * The dirty-review recovery is engine-native: review_merge has NO ensure/attempts
 * loop; a review_gate after it is resolved by compose policy. A dirty merge runs
 * the corrective fixer, persists the dirty lens ids, and REVISES — the engine
 * reroutes to review_triage, whose RETRY PATH reads the sidecar and re-runs ONLY
 * the dirty lenses (+ the always-on baselines) on the fixed code, producing a clean
 * second round that completes.
 *
 * This drives the REAL runBuild over the live TS bin and asserts the convergence
 * through the ENGINE AUDIT (review_gate revise→approve) plus the observed lens
 * re-issuance — not helper booleans.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

// The isolation:none review lens items run on the local-claude seam, which uses
// stratum._localQuery (the harness stub) only under NODE_ENV=test.
process.env.NODE_ENV = 'test';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

// A minimal review-recovery flow: triage → lens fanout → lenses_gate → merge →
// review_gate. Mirrors the production review sub-sequence (same step ids + the
// RETRY/FIRST-RUN triage prompt) so the compose review_gate handler engages.
const REVIEW_SPEC = `
version: 1
contracts:
  TriageResult:
    tasks: object[]
  ReviewResult:
    clean: boolean
    summary: string
    findings: array
    meta: object
    lenses_run: string[]
    auto_fixes: array
    asks: array
flows:
  entry: build
  build:
    max_rounds: 10
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${review_merge.output}
      contract: ReviewResult
    steps:
      - id: review_triage
        agent: claude
        do: >
          Select review lenses. RETRY PATH — if .compose/prior_dirty_lenses.json exists,
          read its JSON array and activate all those lenses plus diff-quality and
          contract-compliance; skip all others. FIRST RUN PATH — otherwise include
          diff-quality, contract-compliance, and debug-discipline; add security and
          framework as triggered.
        out: TriageResult
      - id: review_lenses
        after: [review_triage]
        fanout:
          over: \${review_triage.output.tasks}
          dispatch: consumer
          concurrency: 4
          isolation: none
          require: all
          merge: sequential
          steps:
            - agent: claude
              do: "Run the review lens described by \${item}."
              out: ReviewResult
      - id: review_lenses_gate
        after: [review_lenses]
        gate:
          on_approve: review_merge
          on_revise: review_triage
          on_kill: null
          max_rounds: 10
      - id: review_merge
        agent: claude
        do: "Merge \${review_lenses.output} into one canonical ReviewResult."
        out: ReviewResult
      - id: review_gate
        after: [review_merge]
        gate:
          on_approve: null
          on_revise: review_triage
          on_kill: null
          max_rounds: 10
`;

// Drives the convergence. Round detection is by the sidecar (RETRY PATH) and the
// 'fixed' marker the corrective fixer writes. Records every lens run + the fixer.
function reviewAgentFactory(log) {
  return function factory(_agent, { cwd }) {
    const sidecarPath = join(cwd, '.compose', 'prior_dirty_lenses.json');
    const fixedPath = join(cwd, '.compose', 'fixed.marker');
    return {
      async *run(prompt) {
        const hadSidecar = existsSync(sidecarPath);
        const fixed = existsSync(fixedPath);
        let payload;
        if (/Select review lenses/.test(prompt)) {
          // FIRST RUN → security + framework (+ baselines). RETRY → read the sidecar
          // (dirty lenses) + baselines ONLY — framework must NOT rerun (selective).
          const lenses = hadSidecar
            ? [...JSON.parse(readFileSync(sidecarPath, 'utf8')), 'diff-quality', 'contract-compliance']
            : ['security', 'framework', 'diff-quality', 'contract-compliance', 'debug-discipline'];
          payload = { tasks: lenses.map((l) => ({ id: l, lens_name: l, lens_focus: '', confidence_gate: 7, exclusions: '' })) };
        } else if (/Run the review lens described by/.test(prompt)) {
          const lens = prompt.match(/"lens_name":"([^"]+)"/)?.[1] ?? 'unknown';
          log.push({ kind: 'lens', lens, round: hadSidecar ? 2 : 1 });
          // The 'security' lens is dirty until the fixer runs; everything else clean.
          const dirty = lens === 'security' && !fixed;
          payload = {
            clean: !dirty, summary: dirty ? `${lens} finding` : `${lens} ok`,
            // confidence >= gate so the finding survives ReviewResult normalization
            // (findings below the applied gate are dropped and clean recomputed).
            findings: dirty ? [{ file: 'src/a.js', line: 1, severity: 'must-fix', finding: 'sql injection', lens, confidence: 9 }] : [],
            meta: {}, lenses_run: dirty ? [lens] : [], auto_fixes: [], asks: [],
          };
        } else if (/^Merge /.test(prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt)) {
          // Reducer: clean once the fixer has run; otherwise dirty on 'security'.
          const clean = fixed;
          log.push({ kind: 'merge', round: hadSidecar ? 2 : 1, clean });
          payload = {
            clean, summary: clean ? 'all clean' : 'security dirty',
            findings: clean ? [] : [{ file: 'src/a.js', line: 1, severity: 'must-fix', finding: 'sql injection', lens: 'security', confidence: 9 }],
            meta: {}, lenses_run: clean ? [] : ['security'], auto_fixes: [], asks: [],
          };
        } else if (/Fix EVERY finding/.test(prompt)) {
          log.push({ kind: 'fixer' });
          await writeFile(fixedPath, 'fixed\n'); // the "fix" that makes the rerun clean
          payload = { outcome: 'complete', summary: 'fixed the finding' };
        } else {
          payload = { outcome: 'complete', summary: 'noop' };
        }
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {}, get isRunning() { return false; },
    };
  };
}

async function setupReviewWorkspace(workspace, feature) {
  await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
  await mkdir(join(workspace, 'pipelines'), { recursive: true });
  await mkdir(join(workspace, 'docs', 'features', feature), { recursive: true });
  await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
  await writeFile(join(workspace, '.compose', 'data', 'settings.json'), JSON.stringify({ policies: { review_lenses_gate: 'flag' } }));
  await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), REVIEW_SPEC);
  await writeFile(join(workspace, 'pipelines', 'build.profiles.json'), JSON.stringify({ _reduceSteps: ['review_merge'] }));
  await writeFile(join(workspace, 'docs', 'features', feature, 'description.md'), '# rev\n');
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workspace });
}

function connectReviewClient(client, workspace, stateRoot) {
  return client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN], cwd: workspace, env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
}

describe('review recovery is engine-native (I1)', () => {
  test('a dirty first round runs the fixer, revises via review_gate, reruns only dirty lenses, and completes clean', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'review-gate-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'review-gate-state-'));
    const client = new StratumMcpClient();
    const log = [];
    try {
      await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
      await mkdir(join(workspace, 'pipelines'), { recursive: true });
      await mkdir(join(workspace, 'docs', 'features', 'REV-1'), { recursive: true });
      await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
      // review_lenses_gate auto-approves (trivially-clean isolation:none merge).
      await writeFile(join(workspace, '.compose', 'data', 'settings.json'),
        JSON.stringify({ policies: { review_lenses_gate: 'flag' } }));
      await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), REVIEW_SPEC);
      // Production marks review_merge as the reducer in the profile sidecar; compose
      // stashes the reducer's result for the review_gate off `_reduceSteps`.
      await writeFile(join(workspace, 'pipelines', 'build.profiles.json'), JSON.stringify({ _reduceSteps: ['review_merge'] }));
      await writeFile(join(workspace, 'docs', 'features', 'REV-1', 'description.md'), '# rev\n');
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace });
      execFileSync('git', ['add', '-A'], { cwd: workspace });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workspace });

      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN], cwd: workspace,
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      installAgentHarness(client, reviewAgentFactory(log), workspace);

      await runBuild('REV-1', {
        cwd: workspace, stratum: client, template: 'build', skipTriage: true, description: 'x',
      });

      const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      assert.equal(active.status, 'complete', 'the review recovery must converge and complete');

      // Engine audit: review_gate resolved revise (round 1 dirty) then approve (round 2 clean).
      await client.connect({
        command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
        args: [TS_MCP_BIN], cwd: workspace,
        env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
      });
      const audit = await client.audit(active.flowId);
      const gateDecisions = audit.events
        .filter((e) => e.type === 'gate_resolved' && e.stepId === 'review_gate')
        .map((e) => e.detail.decision);
      assert.deepEqual(gateDecisions, ['revise', 'approve'],
        'review_gate must revise the dirty round then approve the clean rerun');

      // The corrective fixer ran exactly once.
      assert.equal(log.filter((e) => e.kind === 'fixer').length, 1, 'the fixer ran on the dirty round');
      // Selective rerun: 'security' ran in BOTH rounds; 'framework' only in round 1.
      const security = log.filter((e) => e.kind === 'lens' && e.lens === 'security').map((e) => e.round);
      const framework = log.filter((e) => e.kind === 'lens' && e.lens === 'framework').map((e) => e.round);
      assert.deepEqual(security.sort(), [1, 2], 'the dirty security lens reran in round 2');
      assert.deepEqual(framework, [1], 'framework (clean, non-baseline) did NOT rerun in round 2 (selective)');
      // The reducer went dirty then clean.
      assert.deepEqual(log.filter((e) => e.kind === 'merge').map((e) => e.clean), [false, true]);
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

// A CLEAN-from-the-start review factory: every lens + the merge report clean, so
// review_gate should approve (no fixer, no revise).
function cleanReviewFactory(log) {
  return function factory() {
    return {
      async *run(prompt) {
        let p;
        if (/Select review lenses/.test(prompt)) {
          p = { tasks: ['diff-quality', 'contract-compliance', 'debug-discipline'].map((l) => ({ id: l, lens_name: l, lens_focus: '', confidence_gate: 7, exclusions: '' })) };
        } else if (/Run the review lens described by/.test(prompt)) {
          log.push({ kind: 'lens' });
          p = { clean: true, summary: 'ok', findings: [], meta: {}, lenses_run: [], auto_fixes: [], asks: [] };
        } else if (/^Merge /.test(prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt)) {
          log.push({ kind: 'merge' });
          p = { clean: true, summary: 'all clean', findings: [], meta: {}, lenses_run: [], auto_fixes: [], asks: [] };
        } else {
          p = { outcome: 'complete', summary: 'noop' };
        }
        yield { type: 'assistant', content: JSON.stringify(p) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {}, get isRunning() { return false; },
    };
  };
}

describe('review_gate resume re-derives the review result from the audit (J1)', () => {
  test('a build interrupted at the waiting review_gate resumes and APPROVES a clean review (no phantom revise)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'review-gate-resume-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'review-gate-resume-state-'));
    const client1 = new StratumMcpClient();
    const client2 = new StratumMcpClient();
    try {
      await setupReviewWorkspace(workspace, 'REV-RESUME');
      await connectReviewClient(client1, workspace, stateRoot);
      installAgentHarness(client1, cleanReviewFactory([]), workspace);

      // Process 1: interrupt AT the waiting review_gate (after review_merge stepDone).
      await assert.rejects(
        () => runBuild('REV-RESUME', {
          cwd: workspace, stratum: client1, template: 'build', skipTriage: true, description: 'x',
          reviewGateInterrupt: () => { throw new Error('interrupt at review_gate'); },
        }),
        /interrupt at review_gate/,
      );
      await client1.close();
      const flowId = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8')).flowId;
      assert.ok(flowId, 'the interrupted build persisted its flow id for resume');

      // Process 2: a FRESH runBuild (lastReviewMergeResult is null) resumes the flow.
      // Without the audit re-derive it would treat the clean review as dirty (revise).
      await connectReviewClient(client2, workspace, stateRoot);
      installAgentHarness(client2, cleanReviewFactory([]), workspace);
      await runBuild('REV-RESUME', {
        cwd: workspace, stratum: client2, template: 'build', resumeFlowId: flowId,
        skipTriage: true, description: 'x',
      });

      const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      assert.equal(active.status, 'complete', 'the resumed clean review must complete');
      await connectReviewClient(client2, workspace, stateRoot);
      const audit = await client2.audit(flowId);
      const decisions = audit.events
        .filter((e) => e.type === 'gate_resolved' && e.stepId === 'review_gate')
        .map((e) => e.detail.decision);
      assert.deepEqual(decisions, ['approve'], 'the resumed clean review approves — no phantom revise round');
    } finally {
      await client1.close(); await client2.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

// A factory whose dirty merge finding carries NO `lens` (normalization stamps it
// 'general'), while the RAW reducer output's lenses_run names the TRUE dirty lens
// 'security'. The retry triage records what the sidecar actually held.
function lensErasureFactory(log) {
  return function factory(_a, { cwd }) {
    const sc = join(cwd, '.compose', 'prior_dirty_lenses.json');
    const fx = join(cwd, '.compose', 'fixed.marker');
    return {
      async *run(prompt) {
        const had = existsSync(sc);
        const fixed = existsSync(fx);
        let p;
        if (/Select review lenses/.test(prompt)) {
          if (had) log.push({ kind: 'retry_sidecar', lenses: JSON.parse(readFileSync(sc, 'utf8')) });
          const L = had
            ? [...JSON.parse(readFileSync(sc, 'utf8')), 'diff-quality', 'contract-compliance']
            : ['security', 'diff-quality', 'contract-compliance', 'debug-discipline'];
          p = { tasks: L.map((l) => ({ id: l, lens_name: l, lens_focus: '', confidence_gate: 7, exclusions: '' })) };
        } else if (/Run the review lens described by/.test(prompt)) {
          const lens = prompt.match(/"lens_name":"([^"]+)"/)?.[1] ?? '?';
          log.push({ kind: 'lens', lens, round: had ? 2 : 1 });
          const dirty = lens === 'security' && !fixed;
          // The finding has NO lens field — normalization will stamp it 'general'.
          p = { clean: !dirty, summary: 's', findings: dirty ? [{ file: 'a', line: 1, severity: 'must-fix', finding: 'x', confidence: 9 }] : [], meta: {}, lenses_run: dirty ? ['security'] : [], auto_fixes: [], asks: [] };
        } else if (/^Merge /.test(prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt)) {
          const clean = fixed;
          // RAW output: lenses_run carries the TRUE dirty lens; the finding omits lens.
          p = { clean, summary: 'm', findings: clean ? [] : [{ file: 'a', line: 1, severity: 'must-fix', finding: 'x', confidence: 9 }], meta: {}, lenses_run: clean ? [] : ['security'], auto_fixes: [], asks: [] };
        } else if (/Fix EVERY finding/.test(prompt)) {
          log.push({ kind: 'fixer' });
          await writeFile(fx, 'fixed');
          p = { outcome: 'complete', summary: 'fixed' };
        } else {
          p = { outcome: 'complete', summary: 'noop' };
        }
        yield { type: 'assistant', content: JSON.stringify(p) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {}, get isRunning() { return false; },
    };
  };
}

describe('review_gate persists the PRE-normalization dirty lens (J2)', () => {
  test('a dirty lens normalization would erase (finding lacks lens) is still captured from raw lenses_run', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'review-gate-erasure-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'review-gate-erasure-state-'));
    const client = new StratumMcpClient();
    const log = [];
    try {
      await setupReviewWorkspace(workspace, 'REV-ERASURE');
      await connectReviewClient(client, workspace, stateRoot);
      installAgentHarness(client, lensErasureFactory(log), workspace);

      await runBuild('REV-ERASURE', {
        cwd: workspace, stratum: client, template: 'build', skipTriage: true, description: 'x',
      });

      const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      assert.equal(active.status, 'complete', 'the review recovery converges');
      const retry = log.find((e) => e.kind === 'retry_sidecar');
      assert.ok(retry, 'a retry round ran (the sidecar was read)');
      assert.ok(retry.lenses.includes('security'), 'the sidecar carries the TRUE dirty lens (security), from raw lenses_run');
      assert.ok(!retry.lenses.includes('general'), 'the normalization-stamped "general" did NOT replace the true lens');
      const security = log.filter((e) => e.kind === 'lens' && e.lens === 'security').map((e) => e.round);
      assert.deepEqual(security.sort(), [1, 2], 'the true dirty lens (security) reran on the corrective round');
    } finally {
      await client.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
