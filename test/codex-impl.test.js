/**
 * COMP-CODEX-IMPL — `compose build --codex`: Codex implements, Claude reviews.
 *
 * Concerns:
 *  1. Spec wiring (STRAT-AGENT-INTERP): execute.agent + the codex sub-flow review
 *     agents are interpolated from flow inputs; both input declarations carry the
 *     role fields; the main-flow steps thread reviewer_agent into the sub-flows.
 *  2. CLI guards: --codex is single-feature, full-build only (rejects --quick,
 *     --template, batch).
 *  3. startFresh injects implementer_agent/reviewer_agent into the plan inputs and
 *     persists the roles into active-build state (durable across resume).
 *  4. The preflight Codex-in-worktree probe: env-skip, cache, success/failure, and
 *     the fail-fast abort message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { startFresh } from '../lib/build.js';
import {
  preflightCodexWorktreeProbe,
  codexProbeAbortMessage,
  readProbeCache,
  PROBE_SENTINEL,
} from '../lib/codex-preflight.js';

const COMPOSE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const COMPOSE_BIN = join(COMPOSE_ROOT, 'bin', 'compose.js');
const BUILD_PATH = join(COMPOSE_ROOT, 'pipelines', 'build.stratum.yaml');

// ---------------------------------------------------------------------------
// 1. Spec wiring
// ---------------------------------------------------------------------------

describe('COMP-CODEX-IMPL build.stratum.yaml role interpolation', () => {
  const specYaml = readFileSync(BUILD_PATH, 'utf-8');
  const spec = YAML.parse(specYaml);
  const buildFlow = spec.flows.build;
  const step = (id) => buildFlow.steps.find((s) => s.id === id);

  it('declares implementer_agent/reviewer_agent in BOTH input blocks', () => {
    for (const key of ['implementer_agent', 'reviewer_agent']) {
      assert.ok(spec.workflow.input[key], `workflow.input must declare ${key}`);
      assert.ok(buildFlow.input[key], `flows.build.input must declare ${key}`);
    }
  });

  it('execute step resolves its agent from the implementer_agent input', () => {
    assert.equal(step('execute').agent, '$.input.implementer_agent');
  });

  it('codex review sub-flows resolve their reviewer from reviewer_agent', () => {
    assert.equal(spec.flows.review_check.steps[0].agent, '$.input.reviewer_agent');
    assert.equal(spec.flows.test_review.steps[0].agent, '$.input.reviewer_agent');
    assert.ok(spec.flows.review_check.input.reviewer_agent, 'review_check must declare reviewer_agent input');
    assert.ok(spec.flows.test_review.input.reviewer_agent, 'test_review must declare reviewer_agent input');
  });

  it('main-flow steps thread reviewer_agent into the codex sub-flows', () => {
    assert.equal(step('codex_review').inputs.reviewer_agent, '$.input.reviewer_agent');
    assert.equal(step('test_review').inputs.reviewer_agent, '$.input.reviewer_agent');
  });

  it('parallel_review lenses stay Claude (the always-on primary review)', () => {
    // Lens reviewers are claude:* templates regardless of implementer — they are
    // cross-model whenever Codex implements.
    const lensAgents = JSON.stringify(spec.flows.parallel_review);
    assert.ok(/claude/.test(lensAgents), 'parallel_review must keep Claude reviewers');
  });
});

// ---------------------------------------------------------------------------
// 2. CLI guards
// ---------------------------------------------------------------------------

describe('compose build --codex CLI guards', () => {
  const run = (extraArgs) =>
    spawnSync(process.execPath, [COMPOSE_BIN, 'build', ...extraArgs], { encoding: 'utf-8' });

  it('rejects --codex combined with --quick', () => {
    const r = run(['--codex', '--quick', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--codex and --quick are mutually exclusive/);
  });

  it('rejects --codex combined with --template', () => {
    const r = run(['--codex', '--template', 'custom', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--codex and --template are mutually exclusive/);
  });

  it('rejects --codex combined with --all (batch)', () => {
    const r = run(['--codex', '--all']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--codex cannot be combined with --all/);
  });

  it('rejects --codex combined with a prefix (batch)', () => {
    const r = run(['--codex', 'FOO']); // no trailing digit ⇒ prefix ⇒ batch
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--codex cannot be combined with/);
  });
});

// ---------------------------------------------------------------------------
// 3. startFresh role injection + persistence
// ---------------------------------------------------------------------------

describe('COMP-CODEX-IMPL startFresh role injection', () => {
  const specYaml = readFileSync(BUILD_PATH, 'utf-8');

  function fakeStratum() {
    const calls = {};
    return {
      calls,
      async plan(_spec, flowName, planInputs) {
        calls.planInputs = planInputs;
        calls.flowName = flowName;
        return { flow_id: 'flow-1', step_id: 'explore_design', step_number: 1, total_steps: 10 };
      },
    };
  }

  function withDataDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'cci-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('defaults inject claude/codex (byte-identical to today) and persist them', async () => {
    await withDataDir(async (dataDir) => {
      const stratum = fakeStratum();
      await startFresh(stratum, specYaml, 'FEAT-1', 'desc', dataDir, 'build', 'feature', undefined, undefined);
      assert.equal(stratum.calls.planInputs.implementer_agent, 'claude');
      assert.equal(stratum.calls.planInputs.reviewer_agent, 'codex');
      const active = JSON.parse(readFileSync(join(dataDir, 'active-build.json'), 'utf-8'));
      assert.equal(active.implementerAgent, 'claude');
      assert.equal(active.reviewerAgent, 'codex');
    });
  });

  it('--codex roles inject codex/claude and persist them', async () => {
    await withDataDir(async (dataDir) => {
      const stratum = fakeStratum();
      const roles = { implementerAgent: 'codex', reviewerAgent: 'claude' };
      await startFresh(stratum, specYaml, 'FEAT-1', 'desc', dataDir, 'build', 'feature', undefined, roles);
      assert.equal(stratum.calls.planInputs.implementer_agent, 'codex');
      assert.equal(stratum.calls.planInputs.reviewer_agent, 'claude');
      const active = JSON.parse(readFileSync(join(dataDir, 'active-build.json'), 'utf-8'));
      assert.equal(active.implementerAgent, 'codex');
      assert.equal(active.reviewerAgent, 'claude');
    });
  });

  it('bug mode does NOT inject the feature role inputs', async () => {
    await withDataDir(async (dataDir) => {
      const stratum = fakeStratum();
      await startFresh(stratum, specYaml, 'BUG-1', 'desc', dataDir, 'bug-fix', 'bug', undefined, { implementerAgent: 'codex', reviewerAgent: 'claude' });
      assert.equal(stratum.calls.planInputs.implementer_agent, undefined);
      assert.ok(stratum.calls.planInputs.task, 'bug mode uses { task }');
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Preflight probe
// ---------------------------------------------------------------------------

describe('COMP-CODEX-IMPL preflight worktree probe', () => {
  function withGitRepo(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'cci-git-'));
    try {
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
      writeFileSync(join(dir, 'README.md'), '# probe\n');
      execSync('git add -A && git commit -q -m init', { cwd: dir });
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('env override COMPOSE_SKIP_CODEX_PROBE short-circuits to ok', async () => {
    const prev = process.env.COMPOSE_SKIP_CODEX_PROBE;
    process.env.COMPOSE_SKIP_CODEX_PROBE = '1';
    try {
      const r = await preflightCodexWorktreeProbe({ cwd: '/nonexistent', stratum: {}, dataDir: '/nonexistent', ts: 'x' });
      assert.equal(r.ok, true);
      assert.equal(r.skipped, true);
    } finally {
      if (prev === undefined) delete process.env.COMPOSE_SKIP_CODEX_PROBE;
      else process.env.COMPOSE_SKIP_CODEX_PROBE = prev;
    }
  });

  it('passes when Codex writes the sentinel inside the worktree (and caches)', async () => {
    await withGitRepo(async (dir) => {
      const dataDir = join(dir, '.compose', 'data');
      // Fake Codex that honors the probe: write the sentinel into its cwd.
      const stratum = {
        async runAgentText(_type, prompt, { cwd }) {
          // Honor the probe: write the file it asked for (unique per-run name).
          const m = prompt.match(/named (\S+)/);
          writeFileSync(join(cwd, m[1]), PROBE_SENTINEL + '\n');
          return 'done';
        },
      };
      const r = await preflightCodexWorktreeProbe({ cwd: dir, stratum, dataDir, ts: 'pass1' });
      assert.equal(r.ok, true, r.reason);
      // cached
      const cached = readProbeCache(dataDir);
      assert.equal(cached.ok, true);
      // a second call returns the cached pass without invoking the agent again
      let invoked = false;
      const r2 = await preflightCodexWorktreeProbe({
        cwd: dir,
        stratum: { async runAgentText() { invoked = true; return ''; } },
        dataDir,
        ts: 'pass2',
      });
      assert.equal(r2.ok, true);
      assert.equal(r2.cached, true);
      assert.equal(invoked, false, 'cached pass must not re-invoke Codex');
    });
  });

  it('fails (no abort thrown by the probe itself) when Codex does not write the sentinel', async () => {
    await withGitRepo(async (dir) => {
      const dataDir = join(dir, '.compose', 'data');
      const stratum = { async runAgentText() { return 'I did nothing'; } };
      const r = await preflightCodexWorktreeProbe({ cwd: dir, stratum, dataDir, ts: 'fail1' });
      assert.equal(r.ok, false);
      assert.match(r.reason, /did not write the sentinel/);
    });
  });

  it('treats a non-git dir as a pass (worktree isolation is not used there)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cci-nogit-'));
    try {
      const r = await preflightCodexWorktreeProbe({ cwd: dir, stratum: {}, dataDir: join(dir, 'data'), ts: 'ng' });
      assert.equal(r.ok, true);
      assert.match(r.reason, /not a git repo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codexProbeAbortMessage is actionable (names the spike + the escape hatch)', () => {
    const msg = codexProbeAbortMessage('some reason');
    assert.match(msg, /COMP-CODEX-IMPL-SPIKE/);
    assert.match(msg, /without --codex/);
    assert.match(msg, /COMPOSE_SKIP_CODEX_PROBE/);
  });
});
