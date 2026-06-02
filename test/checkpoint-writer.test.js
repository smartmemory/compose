/**
 * COMP-RESUME S9 — checkpoint-writer (writeCheckpoint + anchorBoundary).
 * Real git repo + real fs in a tmp dir; real jsonl backend.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { writeCheckpoint, anchorBoundary, checkpointConfig } =
  await import(`${REPO_ROOT}/lib/checkpoint/checkpoint-writer.js`);
const { SchemaValidator } = await import(`${REPO_ROOT}/server/schema-validator.js`);

const CODE = 'COMP-RESUME';

function makeProject({ enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-writer-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  writeFileSync(
    join(root, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, checkpoint: { enabled, backend: 'jsonl', confidenceThreshold: 0.6 } }),
  );
  const featureDir = join(root, 'docs', 'features', CODE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'), '# design\n');
  writeFileSync(join(featureDir, 'feature.json'), JSON.stringify({ code: CODE, phase: 'implementation' }));
  // real git repo so the fingerprint has a head
  execSync('git init -q -b main', { cwd: root });
  execSync('git config user.email t@t.io && git config user.name t && git config commit.gpgsign false', { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.compose/\n');
  execSync('git add -A && git commit -q -m init', { cwd: root });
  return root;
}

describe('writeCheckpoint', () => {
  let root;
  before(() => { root = makeProject(); });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('anchor write (no soft) → soft:null + a scribePrompt; persisted', () => {
    const { checkpoint, scribePrompt } = writeCheckpoint(root, { featureCode: CODE, trigger: 'phase-transition' });
    assert.equal(checkpoint.soft, null);
    assert.equal(checkpoint.featureCode, CODE);
    assert.equal(typeof checkpoint.fingerprint.git.head, 'string');
    assert.equal(typeof scribePrompt, 'string');
    assert.match(scribePrompt, /JSON/i);
    // persisted to the feature-scoped jsonl
    assert.ok(existsSync(join(root, '.compose', 'data', `checkpoints-${CODE}.jsonl`)));
  });

  test('narrative write (soft provided) → soft set, scribePrompt null', () => {
    const soft = { goal: 'g', nextStep: 'n', risks: [] };
    const { checkpoint, scribePrompt } = writeCheckpoint(root, { featureCode: CODE, trigger: 'manual', soft });
    assert.deepEqual(checkpoint.soft, soft);
    assert.equal(scribePrompt, null);
  });

  test('produced checkpoint validates against the contract', () => {
    const v = new SchemaValidator(join(REPO_ROOT, 'contracts', 'checkpoint.schema.json'));
    const { checkpoint } = writeCheckpoint(root, { featureCode: CODE, trigger: 'manual', phase: 'implementation' });
    const { valid, errors } = v.validateRoot(checkpoint);
    assert.ok(valid, `contract errors: ${JSON.stringify(errors)}`);
  });

  test('missing featureCode throws', () => {
    assert.throws(() => writeCheckpoint(root, { trigger: 'manual' }), /featureCode/);
  });
});

describe('anchorBoundary', () => {
  test('enabled → writes an anchor for a live item', () => {
    const root = makeProject({ enabled: true });
    try {
      const item = { lifecycle: { featureCode: CODE, currentPhase: 'implementation' } };
      const cp = anchorBoundary(root, { item, trigger: 'gate-resolution' });
      assert.ok(cp && cp.soft === null);
      assert.equal(cp.trigger, 'gate-resolution');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disabled (checkpoint.enabled:false) → returns null, writes nothing', () => {
    const root = makeProject({ enabled: false });
    try {
      assert.equal(checkpointConfig(root).enabled, false);
      const item = { lifecycle: { featureCode: CODE, currentPhase: 'implementation' } };
      const cp = anchorBoundary(root, { item, trigger: 'phase-transition' });
      assert.equal(cp, null);
      assert.equal(existsSync(join(root, '.compose', 'data', `checkpoints-${CODE}.jsonl`)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('best-effort: item without featureCode → null, never throws', () => {
    const root = makeProject();
    try {
      assert.doesNotThrow(() => {
        const cp = anchorBoundary(root, { item: { lifecycle: {} }, trigger: 'manual' });
        assert.equal(cp, null);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
