/**
 * COMP-BUILD-QUICK — `compose build --quick`: trimmed build lifecycle.
 *
 * Three concerns:
 *  1. The build-quick pipeline is structurally a trimmed build.stratum.yaml —
 *     the entry flow is still `build` (zero runner coupling), Phase-7 enforcement
 *     intact, the dropped phases absent, review inputs repointed to the design.
 *  2. resolveTemplatePath('build-quick', composeRoot) finds the shipped file,
 *     and extractFlowName resolves it to the `build` flow.
 *  3. The CLI conflict guards: --quick is mutually exclusive with --template
 *     and with batch builds. These fire before any filesystem/init work.
 *
 * COMP-PIPELINE-QUARANTINE: these structural assertions were written against the
 * v0.3 dialect (`workflow.name`, `depends_on`, `on_approve` on a `function:` step,
 * an `inputs:` map). The spec is now v1 and the assertions are re-expressed in v1
 * terms — `flows.entry`, `after`, an inline `gate:` block, `with:` on a subflow
 * call. The INTENT each one protects is unchanged, which is the point: a trimmed
 * lifecycle that keeps Phase-7 enforcement and never dangles a reference to a
 * dropped phase.
 *
 * One assertion changed shape rather than syntax. The old spec had a
 * `parallel_review` SUB-FLOW; v1 permits fanout only in the entry flow, so the
 * build conversion flattened it into review_triage/review_lenses/review_merge
 * inline. The check is now "multi-lens review is present", not "a sub-flow with
 * that name exists" — the enforcement survived, its packaging did not.
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
  'explore_design', 'design_gate', 'decompose', 'execute', 'execute_merge',
  'review_triage', 'review_lenses', 'review_lenses_gate', 'review_merge', 'review_gate',
  'codex_review', 'coverage', 'test_review', 'docs', 'ship', 'ship_gate',
];
const DROPPED = ['prd', 'architecture', 'blueprint', 'verification', 'plan', 'plan_gate', 'report'];

describe('build-quick pipeline structure', () => {
  const spec = YAML.parse(readFileSync(QUICK_PATH, 'utf-8'));

  it('keeps the entry flow named "build" so the runner sees the identical flow', () => {
    // extractFlowName resolves the entry flow; keeping it `build` means
    // lib/build.js step-id couplings (execute|docs|ship) and flow lookup are
    // unchanged — only the step list differs.
    assert.equal(spec.flows.entry, 'build');
    assert.ok(spec.flows.build, 'the build flow itself must exist');
  });

  it('preserves Phase-7 enforcement: cross-model review, coverage, multi-lens review', () => {
    // review_check and coverage_check are still sub-flows. parallel_review is
    // not — v1 allows fanout only in the entry flow, so it lives inline as the
    // review_triage -> review_lenses -> review_merge spine.
    for (const sub of ['review_check', 'coverage_check']) {
      assert.ok(spec.flows[sub], `sub-flow ${sub} must be present`);
    }
    const ids = new Set(spec.flows.build.steps.map((s) => s.id));
    for (const inline of ['review_triage', 'review_lenses', 'review_merge', 'test_review']) {
      assert.ok(ids.has(inline), `Phase-7 step ${inline} must be present`);
    }
    const lenses = spec.flows.build.steps.find((s) => s.id === 'review_lenses');
    assert.ok(lenses.fanout, 'review_lenses must still fan out across lenses');
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
    assert.equal(gate.gate.on_approve, 'decompose');
  });

  it('the design gate is reached from explore_design, with no plan phase between', () => {
    const gate = spec.flows.build.steps.find((s) => s.id === 'design_gate');
    assert.deepEqual(gate.after, ['explore_design']);
  });

  it('no step references a dropped phase\'s output', () => {
    // The trim's real failure mode: a surviving step still reading
    // ${blueprint.output.artifact} or ${plan.output.artifact} would validate as
    // YAML and then fail at plan time.
    const yaml = readFileSync(QUICK_PATH, 'utf-8');
    for (const dropped of DROPPED) {
      assert.ok(
        !yaml.includes(`\${${dropped}.output`),
        `no step may reference the dropped ${dropped} step's output`,
      );
    }
  });

  it('review inputs reference the design artifact (no blueprint step exists)', () => {
    const codex = spec.flows.build.steps.find((s) => s.id === 'codex_review');
    assert.equal(
      codex.with.blueprint,
      '${explore_design.output.artifact}',
      'codex_review must read the design artifact, not a dropped blueprint step',
    );
    const coverage = spec.flows.build.steps.find((s) => s.id === 'coverage');
    assert.equal(
      coverage.with.plan,
      '${input.description}',
      'coverage must read the description, not a dropped plan step',
    );
  });

  it('docs follows test_review (the dropped report step is gone)', () => {
    const docs = spec.flows.build.steps.find((s) => s.id === 'docs');
    assert.deepEqual(docs.after, ['test_review']);
  });

  it('carries the escalation guardrail in the decompose step', () => {
    const decompose = spec.flows.build.steps.find((s) => s.id === 'decompose');
    assert.match(decompose.do, /GUARDRAIL/);
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
