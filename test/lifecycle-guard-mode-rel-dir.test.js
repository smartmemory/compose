/**
 * lifecycle-guard-mode-rel-dir.test.js — COMP-ROADMAP-PLAN T2 (S7).
 *
 * `_featureRelDir` (server/lifecycle-guard.js) must be MODE-AWARE so the guard's
 * per-edge evidence predicates point at the right artifact root:
 *   - build (artifactRoot === 'features'): KEEP the config-backed paths.features
 *     resolution — REGRESSION GUARD, build must not change.
 *   - plan  (artifactRoot 'docs/plans'):  docs/plans/<code>/...
 *   - fix   (artifactRoot 'docs/bugs'):   docs/bugs/<code>/...
 *
 * Exercised through ensureGuard → edgePredicates(_featureRelDir(mode), mode),
 * inspecting the stubbed register call's edgePredicates statements (matching the
 * existing "predicate paths derive from the SERVED workspaceRoot config" test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

const {
  ensureGuard,
  _testOnly_setGuardClient,
  _testOnly_resetGuardCache,
} = await import(`${SERVER_DIR}/lifecycle-guard.js`);

function stubClient() {
  const calls = { register: [] };
  return {
    calls,
    client: {
      register: async (a) => { calls.register.push(a); return { status: 'registered', guard_id: 'g' }; },
      transition: async () => ({ status: 'applied', verdict: { met: true } }),
    },
  };
}

function makeWorkspace(prefix, composeJson) {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, '.compose'), { recursive: true });
  if (composeJson) {
    writeFileSync(join(ws, '.compose', 'compose.json'), JSON.stringify(composeJson));
  }
  return ws;
}

// (a) REGRESSION GUARD: build mode keeps honoring the paths.features override.
test('T2a: build-mode evidence still resolves a paths.features override', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  const ws = makeWorkspace('lg-mode-build-', { paths: { features: 'custom/feat' } });
  await ensureGuard('FEAT-7', 'explore_design', ws); // legacy 3-arg → build

  const preds = s.calls.register[0].edgePredicates['explore_design->blueprint'];
  assert.equal(preds[0].statement, "server_file_exists('custom/feat/FEAT-7/design.md')",
    'build mode must keep the config-backed paths.features resolution (no regression)');
});

// (b) plan mode resolves docs/plans/<code>/design.md
test('T2b: plan-mode resolves docs/plans/<code>/design.md', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  // Even with a paths.features override present, plan's literal artifactRoot wins.
  const ws = makeWorkspace('lg-mode-plan-', { paths: { features: 'custom/feat' } });
  await ensureGuard('PLAN-WIDGET', 'explore_design', ws, 'plan');

  const reg = s.calls.register.find((r) => r.resourceId.includes(':plan:PLAN-WIDGET'));
  assert.ok(reg, 'plan registration present (mode-namespaced rid)');
  const preds = reg.edgePredicates['explore_design->plan'];
  assert.ok(preds, 'plan declares an explore_design->plan evidence edge');
  assert.equal(preds[0].statement, "server_file_exists('docs/plans/PLAN-WIDGET/design.md')",
    'plan evidence must resolve under docs/plans/<code>, NOT docs/features or paths.features');
});

// (c) fix/bug mode resolves docs/bugs/<code>
test('T2c: bug-mode resolves docs/bugs/<code>', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  // fix mode declares NO evidence edges, so assert the relDir feeds the
  // resource-graph register call by checking the workspaceRoot/rid + that any
  // predicate (none for fix) is empty — instead, assert via a mode whose root is
  // docs/bugs but carries an evidence edge would be ideal; fix has none. So we
  // assert the feature dir indirectly: register the bug under a workspace with a
  // paths.features override and confirm the (empty) predicate set never leaks
  // the features root. The load-bearing check is the plan case (b); for bug we
  // confirm the literal root is used by reading the relDir helper via the
  // exported test seam.
  const { _testOnly_featureRelDir } = await import(`${SERVER_DIR}/lifecycle-guard.js`);
  const ws = makeWorkspace('lg-mode-bug-', { paths: { features: 'custom/feat' } });
  assert.equal(_testOnly_featureRelDir('BUG-3', ws, 'fix'), 'docs/bugs/BUG-3',
    'bug/fix evidence must resolve under docs/bugs/<code>, ignoring paths.features');
  assert.equal(_testOnly_featureRelDir('PLAN-X', ws, 'plan'), 'docs/plans/PLAN-X',
    'plan evidence must resolve under docs/plans/<code>');
  assert.equal(_testOnly_featureRelDir('FEAT-7', ws, 'build'), 'custom/feat/FEAT-7',
    'build evidence must keep the config-backed paths.features resolution');
});
