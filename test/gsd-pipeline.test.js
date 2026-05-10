/**
 * COMP-GSD-2 T5: pipelines/gsd.stratum.yaml structural validation.
 *
 * Asserts the YAML parses, has the three steps GSD-2 specifies, and uses
 * ONLY Stratum-supported intent_template tokens per
 * stratum-mcp/src/stratum_mcp/spec.py:567-590.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YAML = await import('yaml');

const SPEC_PATH = join(REPO_ROOT, 'pipelines', 'gsd.stratum.yaml');
const text = readFileSync(SPEC_PATH, 'utf-8');
const spec = YAML.parse(text);

test('YAML parses', () => {
  assert.ok(spec, 'spec should parse');
  assert.equal(spec.version, '0.3');
  assert.equal(spec.workflow.name, 'gsd');
});

test('Stratum parse_and_validate accepts the spec (real validator)', () => {
  // Invokes the real Stratum validator via python subprocess. This is the
  // canonical schema check per plan.md T5 acceptance.
  const code = `import sys
sys.path.insert(0, 'stratum-mcp/src')
from stratum_mcp.spec import parse_and_validate
parse_and_validate(sys.stdin.read())
print('OK')
`;
  const r = spawnSync('python3', ['-c', code], {
    input: text,
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    assert.fail(`Stratum validator rejected the spec:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  assert.match(r.stdout, /OK/);
});

test('flow has three steps with expected ids', () => {
  const steps = spec.flows.gsd.steps;
  assert.equal(steps.length, 3);
  const ids = steps.map((s) => s.id);
  assert.deepEqual(ids, ['decompose_gsd', 'execute', 'ship_gsd']);
});

test('flow inputs include featureCode and gateCommands', () => {
  const inputs = spec.flows.gsd.input;
  assert.ok(inputs.featureCode);
  assert.ok(inputs.gateCommands);
  assert.equal(inputs.gateCommands.type, 'array');
});

test('decompose_gsd has correct ensure postconditions', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'decompose_gsd');
  assert.equal(step.type, 'decompose');
  // Stratum v0.3 reserves TaskGraph and requires it as the decompose output_contract.
  // Per-task produces/consumes (the GSD-specific shape) is enforced post-step by
  // lib/gsd-decompose-enrich.js against contracts/taskgraph-gsd.json.
  assert.equal(step.output_contract, 'TaskGraph');
  assert.ok(step.ensure.includes('no_file_conflicts(result.tasks)'));
  assert.ok(step.ensure.includes('len(result.tasks) >= 1'));
});

test('execute has GSD-2 v1 dispatch params', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'execute');
  assert.equal(step.type, 'parallel_dispatch');
  assert.equal(step.max_concurrent, 1, 'sequential by default');
  assert.equal(step.isolation, 'worktree');
  assert.equal(step.capture_diff, true);
  assert.equal(step.merge, 'sequential_apply');
  assert.equal(step.require, 'all');
  assert.equal(step.retries, 2);
});

test('execute intent_template uses ONLY supported tokens', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'execute');
  const tpl = step.intent_template;
  // Stratum supports: {task.id}, {task.description}, {task.files_owned},
  // {task.files_read}, {task.depends_on}, {task.index}, {input.<field>}.
  // Find every {token} and check.
  const tokens = [...tpl.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  const allowed = new Set([
    'task.id',
    'task.description',
    'task.files_owned',
    'task.files_read',
    'task.depends_on',
    'task.index',
  ]);
  const inputAllowed = /^input\.[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const tok of tokens) {
    const ok = allowed.has(tok) || inputAllowed.test(tok);
    assert.ok(ok, `unsupported intent_template token: {${tok}}`);
  }
});

test('ship_gsd intent enumerates ROADMAP, CHANGELOG, optional CLAUDE.md, commit (push deferred to user)', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'ship_gsd');
  assert.match(step.intent, /ROADMAP\.md/);
  assert.match(step.intent, /CHANGELOG\.md/);
  assert.match(step.intent, /CLAUDE\.md/);
  assert.match(step.intent, /COMPLETE/);
  assert.match(step.intent, /[Cc]ommit/);
  // Push is intentionally NOT auto-performed in v1 — runBuild's ship doesn't
  // auto-push either, and runGsd's executeShipStep delegate doesn't push.
});

test('ship_gsd does NOT precondition on plan.md or report.md', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'ship_gsd');
  // The build pipeline's ship checks for plan.md to extract acceptance items.
  // GSD must not have that — it doesn't produce plan.md.
  assert.doesNotMatch(step.intent, /plan\.md/);
  assert.doesNotMatch(step.intent, /report\.md/);
});

test('decompose_gsd intent embeds gateCommands input reference', () => {
  const step = spec.flows.gsd.steps.find((s) => s.id === 'decompose_gsd');
  assert.match(step.intent, /\{input\.gateCommands\}/);
  assert.equal(step.inputs.gateCommands, '$.input.gateCommands');
});
