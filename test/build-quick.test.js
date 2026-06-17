/**
 * COMP-BUILD-QUICK — `compose build --quick`: trimmed build lifecycle.
 *
 * Three concerns:
 *  1. The build-quick pipeline is structurally a trimmed build.stratum.yaml —
 *     workflow.name kept as `build` (zero runner coupling), Phase-7 sub-flows
 *     intact, the dropped phases absent, review inputs repointed to the design.
 *  2. resolveTemplatePath('build-quick', composeRoot) finds the shipped file,
 *     and extractFlowName resolves it to the `build` flow.
 *  3. The CLI conflict guards: --quick is mutually exclusive with --template
 *     and with batch builds. These fire before any filesystem/init work.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { resolveTemplatePath } from '../lib/build.js';

const COMPOSE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const COMPOSE_BIN = join(COMPOSE_ROOT, 'bin', 'compose.js');
const QUICK_PATH = join(COMPOSE_ROOT, 'pipelines', 'build-quick.stratum.yaml');

const KEPT = [
  'explore_design', 'design_gate', 'decompose', 'execute',
  'review', 'codex_review', 'coverage', 'test_review', 'docs', 'ship', 'ship_gate',
];
const DROPPED = ['prd', 'architecture', 'blueprint', 'verification', 'plan', 'plan_gate', 'report'];

describe('build-quick pipeline structure', () => {
  const spec = YAML.parse(readFileSync(QUICK_PATH, 'utf-8'));

  it('keeps workflow.name as "build" so the runner sees the identical flow', () => {
    // extractFlowName prioritizes workflow.name; keeping it `build` means
    // lib/build.js step-id couplings (execute|docs|ship) and flow lookup are
    // unchanged — only the step list differs.
    assert.equal(spec.workflow.name, 'build');
  });

  it('preserves the Phase-7 enforcement sub-flows verbatim', () => {
    for (const sub of ['parallel_review', 'review_check', 'coverage_check', 'test_review']) {
      assert.ok(spec.flows[sub], `sub-flow ${sub} must be present`);
    }
  });

  it('main build flow is the trimmed design → implement → ship sequence', () => {
    const ids = spec.flows.build.steps.map((s) => s.id);
    assert.deepEqual(ids, KEPT, 'step IDs must match the quick lifecycle exactly');
  });

  it('omits every full-lifecycle-only phase (not just self-skipping)', () => {
    const ids = new Set(spec.flows.build.steps.map((s) => s.id));
    for (const dropped of DROPPED) {
      assert.ok(!ids.has(dropped), `phase ${dropped} must be omitted from the quick flow`);
    }
  });

  it('design gate routes straight to decompose (no plan_gate)', () => {
    const gate = spec.flows.build.steps.find((s) => s.id === 'design_gate');
    assert.equal(gate.on_approve, 'decompose');
  });

  it('decompose depends on the design gate, not a plan gate', () => {
    const decompose = spec.flows.build.steps.find((s) => s.id === 'decompose');
    assert.deepEqual(decompose.depends_on, ['design_gate']);
  });

  it('review steps reference the design artifact (no blueprint step exists)', () => {
    for (const id of ['review', 'codex_review', 'test_review']) {
      const step = spec.flows.build.steps.find((s) => s.id === id);
      assert.equal(
        step.inputs.blueprint,
        '$.steps.explore_design.output.artifact',
        `${id} must read the design artifact, not a dropped blueprint step`,
      );
    }
  });

  it('docs depends on test_review (the dropped report step is gone)', () => {
    const docs = spec.flows.build.steps.find((s) => s.id === 'docs');
    assert.deepEqual(docs.depends_on, ['test_review']);
  });

  it('carries the escalation guardrail in the design + decompose intents', () => {
    const design = spec.flows.build.steps.find((s) => s.id === 'explore_design');
    const decompose = spec.flows.build.steps.find((s) => s.id === 'decompose');
    assert.match(design.intent, /GUARDRAIL/);
    assert.match(decompose.intent, /GUARDRAIL/);
  });
});

describe('build-quick template resolution', () => {
  it('resolveTemplatePath finds the shipped build-quick pipeline', () => {
    assert.equal(resolveTemplatePath('build-quick', COMPOSE_ROOT), QUICK_PATH);
  });
});

describe('build-quick provisioning', () => {
  // COMP-BUILD-QUICK + Codex review finding: --quick needs the pipeline present.
  // compose init must seed it so fresh workspaces can run --quick.
  it('compose init seeds pipelines/build-quick.stratum.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbq-init-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir });
      execFileSync(process.execPath, [COMPOSE_BIN, 'init', '--no-stratum', '--no-lifecycle'], {
        cwd: dir,
        stdio: 'ignore',
      });
      assert.ok(
        existsSync(join(dir, 'pipelines', 'build-quick.stratum.yaml')),
        'init must copy build-quick.stratum.yaml into the workspace pipelines/',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compose build --quick CLI guards', () => {
  // These fire before auto-init, so no workspace scaffolding is needed.
  const runBuild = (extraArgs) =>
    spawnSync(process.execPath, [COMPOSE_BIN, 'build', ...extraArgs], { encoding: 'utf-8' });

  it('rejects --quick combined with --template', () => {
    const r = runBuild(['--quick', '--template', 'custom', 'FOO-1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--quick and --template are mutually exclusive/);
  });

  it('rejects --quick combined with --all (batch)', () => {
    const r = runBuild(['--quick', '--all']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--quick cannot be combined with --all/);
  });

  it('rejects --quick combined with a prefix (batch)', () => {
    // A code with no trailing digit is treated as a prefix → batch.
    const r = runBuild(['--quick', 'FOO']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--quick cannot be combined with/);
  });

  it('lists --quick in the build usage help', () => {
    const r = runBuild([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--quick\s+Trimmed lifecycle/);
  });
});
