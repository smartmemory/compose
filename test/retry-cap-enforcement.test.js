/**
 * retry-cap-enforcement.test.js — COMP-FIX-HARD T2 (real-path, I4).
 *
 * A bug-mode build whose {test,fix,diagnose} step exhausts its engine attempts must
 * write docs/bugs/<code>/checkpoint.md and regenerate the bug index. Round-1 tested
 * this against a fabricated failed-history entry; that masked the real bug — a
 * test/diagnose contract carries no `outcome` field, so the history entry reads
 * 'complete' and a history scan finds nothing. This drives the REAL terminal-failure
 * path: runBuild over the live TS bin, a step that genuinely exhausts its ensure, and
 * the exhausted step id passed directly into the checkpoint.
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { __setRegenerateBugIndexForTest } from '../lib/bug-checkpoint.js';

const TS_MCP_BIN = '/Users/ruze/reg/my/forge/stratum/ts/src/mcp/bin.mjs';

// A single-step pipeline whose step exhausts an ensure. CRUCIALLY the out
// contract has NO `outcome` field — exactly like the real test/diagnose
// contracts — so the stepHistory entry defaults to outcome:'complete' even
// though the ensure exhausted. That is precisely the case a failed-history scan
// misses (I4): only the directly-passed exhausted step id finds it. The flow
// input contract matches the mode's plan envelope (bug → { task }).
function bugFixSpec(stepId, mode) {
  const input = mode === 'bug'
    ? '      task: string'
    : '      featureCode: string\n      description: string\n      implementer_agent: string\n      reviewer_agent: string';
  const descRef = mode === 'bug' ? 'input.task' : 'input.description';
  return `
version: 1
contracts:
  R:
    passed: boolean
flows:
  entry: fix
  fix:
    input:
${input}
    output:
      from: \${${stepId}.output}
      contract: R
    steps:
      - id: ${stepId}
        do: "work \${${descRef}}"
        out: R
        attempts: 2
        ensure:
          - expr: "result.passed == true"
`;
}

// The agent always reports a NON-passing outcome, so the ensure never satisfies
// and the engine exhausts both attempts → terminal failure on this step.
function failingAgentFactory() {
  return function factory() {
    return {
      async *run() {
        // Reports a NON-passing result whose contract carries no `outcome` field,
        // so the ensure fails while the history entry still reads 'complete'.
        yield { type: 'assistant', content: JSON.stringify({ passed: false }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

async function setupWorkspace(code, stepId, mode) {
  const workspace = await mkdtemp(join(tmpdir(), 'retry-cap-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'retry-cap-state-'));
  await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
  await mkdir(join(workspace, 'pipelines'), { recursive: true });
  await mkdir(join(workspace, 'docs', 'bugs', code), { recursive: true });
  await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
  await writeFile(join(workspace, 'pipelines', 'bug-fix.stratum.yaml'), bugFixSpec(stepId, mode));
  await writeFile(join(workspace, 'docs', 'bugs', code, 'description.md'), `# ${code}\n`);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: workspace });
  return { workspace, stateRoot };
}

async function runBugFix(code, stepId, { mode }) {
  const { workspace, stateRoot } = await setupWorkspace(code, stepId, mode);
  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN], cwd: workspace,
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
  installAgentHarness(client, failingAgentFactory(), workspace);
  try {
    await runBuild(code, {
      cwd: workspace, stratum: client, template: 'bug-fix', mode,
      skipTriage: true, description: 'the failing step',
    });
  } finally {
    await client.close();
  }
  return { workspace, stateRoot };
}

describe('COMP-FIX-HARD T2 — bug checkpoint on real terminal failure (I4)', () => {
  const cleanups = [];
  afterEach(async () => {
    __setRegenerateBugIndexForTest(null);
    for (const p of cleanups.splice(0)) await rm(p, { recursive: true, force: true });
  });

  for (const stepId of ['test', 'fix', 'diagnose']) {
    test(`a bug-mode ${stepId} step that exhausts its attempts writes checkpoint.md + regenerates the index`, async () => {
      let regenCalled = false;
      __setRegenerateBugIndexForTest(() => { regenCalled = true; });
      const code = `BUG-CAP-${stepId.toUpperCase()}`;
      const { workspace, stateRoot } = await runBugFix(code, stepId, { mode: 'bug' });
      cleanups.push(workspace, stateRoot);

      const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
      assert.equal(active.status, 'failed', `the ${stepId} step must exhaust and fail`);
      assert.ok(
        existsSync(join(workspace, 'docs', 'bugs', code, 'checkpoint.md')),
        `checkpoint.md must be emitted for a bug-mode ${stepId} exhaustion`,
      );
      assert.ok(regenCalled, 'regenerateBugIndex must be called via emitCheckpoint');
      const md = await readFile(join(workspace, 'docs', 'bugs', code, 'checkpoint.md'), 'utf8');
      assert.match(md, new RegExp(`\\*\\*Step:\\*\\* ${stepId}`), 'the checkpoint records the exhausted step');
    });
  }

  test('feature mode never emits a checkpoint even when the step exhausts', async () => {
    __setRegenerateBugIndexForTest(() => { throw new Error('regen must not run in feature mode'); });
    const code = 'FEAT-CAP-1';
    const { workspace, stateRoot } = await runBugFix(code, 'test', { mode: 'feature' });
    cleanups.push(workspace, stateRoot);

    const active = JSON.parse(await readFile(join(workspace, '.compose', 'data', 'active-build.json'), 'utf8'));
    assert.equal(active.status, 'failed', 'the step still exhausts in feature mode');
    assert.ok(!existsSync(join(workspace, 'docs', 'bugs', code, 'checkpoint.md')), 'no checkpoint in feature mode');
  });
});
