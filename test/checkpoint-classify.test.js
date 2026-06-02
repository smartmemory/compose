/**
 * COMP-RESUME S3 — classify() drift detection (pure function).
 *
 * classify(prev, curr) → 'clean' | 'advanced' | 'diverged'
 * Table-driven over hand-built fingerprint-pair fixtures. No git needed:
 * classify only inspects the EnvFingerprint shape it is handed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { classify } = await import(`${REPO_ROOT}/lib/checkpoint/fingerprint.js`);

/**
 * Build a minimal EnvFingerprint. Overrides are shallow-merged into git and
 * phaseArtifacts so each row only states what it cares about.
 */
function fp({ git = {}, artifacts = {} } = {}) {
  return {
    capturedAt: '2026-06-02T00:00:00.000Z',
    git: {
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      branch: 'main',
      dirty: false,
      dirtyHash: null,
      ...git,
    },
    phaseArtifacts: {
      design: '/feat/design.md',
      blueprint: '/feat/blueprint.md',
      plan: '/feat/plan.md',
      implementFiles: [],
      contracts: [],
      ...artifacts,
    },
    testRef: null,
    buildStreamSeq: null,
    flowId: null,
  };
}

const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const cases = [
  {
    name: 'null prev → clean',
    prev: null,
    curr: fp(),
    expect: 'clean',
  },
  {
    name: 'identical head + identical dirtyHash → clean',
    prev: fp({ git: { head: HEAD_A, dirtyHash: null } }),
    curr: fp({ git: { head: HEAD_A, dirtyHash: null } }),
    expect: 'clean',
  },
  {
    name: 'same head + same non-null dirtyHash → clean',
    prev: fp({ git: { head: HEAD_A, dirty: true, dirtyHash: 'deadbeef' } }),
    curr: fp({ git: { head: HEAD_A, dirty: true, dirtyHash: 'deadbeef' } }),
    expect: 'clean',
  },
  {
    name: 'head moved + clean tree + same artifacts → advanced',
    prev: fp({ git: { head: HEAD_A, dirty: false, dirtyHash: null } }),
    curr: fp({ git: { head: HEAD_B, dirty: false, dirtyHash: null } }),
    expect: 'advanced',
  },
  {
    name: 'head moved + dirty tree → diverged',
    prev: fp({ git: { head: HEAD_A, dirty: false, dirtyHash: null } }),
    curr: fp({ git: { head: HEAD_B, dirty: true, dirtyHash: 'cafe' } }),
    expect: 'diverged',
  },
  {
    name: 'head moved + clean tree but artifact removed (blueprint) → diverged',
    prev: fp({ git: { head: HEAD_A } }),
    curr: fp({ git: { head: HEAD_B }, artifacts: { blueprint: null } }),
    expect: 'diverged',
  },
  {
    name: 'head moved + clean tree, prev had null artifact, curr still null → advanced',
    prev: fp({ git: { head: HEAD_A }, artifacts: { plan: null } }),
    curr: fp({ git: { head: HEAD_B }, artifacts: { plan: null } }),
    expect: 'advanced',
  },
  {
    name: 'same head but dirtyHash changed (uncommitted edits) → diverged',
    prev: fp({ git: { head: HEAD_A, dirty: true, dirtyHash: 'one' } }),
    curr: fp({ git: { head: HEAD_A, dirty: true, dirtyHash: 'two' } }),
    expect: 'diverged',
  },
];

for (const c of cases) {
  test(`classify: ${c.name}`, () => {
    assert.equal(classify(c.prev, c.curr), c.expect);
  });
}
