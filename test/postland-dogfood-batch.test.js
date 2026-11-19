import './helpers/git-env-scrub.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEvidence, recordEvidence, verifyEvidence } from '../lib/evidence.js';
import { resolveLandSha } from '../lib/land-sha.js';
import { _testOnly_resetHistoryClient, _testOnly_setHistoryClient } from '../lib/completion-gate.js';
import { toolCompleteFeature } from '../server/compose-mcp-tools.js';
import { verifyCompletionEvidence } from '../server/lifecycle-guard.js';
import { withProjectContext } from '../server/project-root.js';
import { attachVisionRoutes } from '../server/vision-routes.js';
import { VisionStore } from '../server/vision-store.js';

const CODE = 'PROBE-DOGFOOD-1';
const AT = '2026-11-20T00:00:00.000Z';
const LIFECYCLE = '/api/vision/items/:id/lifecycle/';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'compose-dogfood-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(cwd, label) {
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', label);
  return git(cwd, 'rev-parse', 'HEAD');
}

function makeWorkspace(t, { guard = false, phase = 'execute', iterationState } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(AT) });
  const root = scratch(t);
  const dataDir = join(root, '.compose', 'data');
  const capabilities = { lifecycle: true, guard };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({
    version: 2, capabilities, paths: { features: 'docs/features' },
  }));
  const store = new VisionStore(dataDir);
  const item = store.createItem({ type: 'feature', title: CODE });
  store.updateLifecycle(item.id, { featureCode: CODE, currentPhase: phase, startedAt: AT, iterationState });
  return { root, dataDir, store, item, capabilities };
}

// Register the real routes without listening on a port or starting Compose.
function attach(workspace) {
  const { root, store, item, capabilities } = workspace;
  const routes = new Map();
  attachVisionRoutes({
    get() {},
    patch() {},
    delete() {},
    post: (path, ...handlers) => routes.set(path, handlers),
  }, { store, projectRoot: root, capabilities, scheduleBroadcast() {}, broadcastMessage() {} });

  return async (action, body) => {
    const [middleware, handler] = routes.get(LIFECYCLE + action);
    const req = { params: { id: item.id }, body };
    const response = { status: 200, body: undefined };
    const res = {
      status(code) { response.status = code; return res; },
      json(value) { response.body = value; },
    };
    await middleware(req, res, () => handler(req, res));
    return response;
  };
}

function shaEvidence(repo, sha) {
  return { kind: 'sha', repo, sha, at: AT, by: 'dogfood-probe' };
}

test('F1 refuses a tag-only name in the branch argument', { todo: 'F1' }, (t) => {
  const root = scratch(t);
  initRepo(root, 'tag fixture');
  git(root, 'tag', 'release-only');

  assert.throws(() => resolveLandSha({ code: CODE, branch: 'release-only' }, { root }), {
    code: 'BRANCH_NOT_FOUND',
  });
});

test('F2 guarded completion verifies a commit in the selected sibling repo', { todo: 'F2' }, async (t) => {
  const workspace = makeWorkspace(t, { guard: true, phase: 'ship' });
  const repo = join(scratch(t), 'sibling');
  initRepo(workspace.root, 'workspace commit');
  const sha = initRepo(repo, 'sibling commit');
  const evidence = shaEvidence(repo, sha);
  const accepted = await verifyCompletionEvidence({ commitSha: sha, cwd: repo, testsPassClaim: true });
  assert.equal(accepted.ok, true, accepted.reasons.join(', '));

  const featureDir = join(workspace.root, 'docs', 'features', CODE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'feature.json'), JSON.stringify({
    code: CODE, description: 'Completion probe', status: 'IN_PROGRESS', phase: 'Phase 1',
  }));

  // Stop after a successful evidence check, before any external guard call.
  _testOnly_setHistoryClient(async () => ({ error: { code: 'FIXTURE_GUARD_OFFLINE' } }));
  t.after(_testOnly_resetHistoryClient);
  const post = attach(workspace);
  t.mock.method(http, 'request', (options, callback) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.path, `/api/vision/items/${workspace.item.id}/lifecycle/complete`);
    return Object.assign(new EventEmitter(), {
      write(payload) { this.payload = payload; },
      end() {
        post('complete', JSON.parse(this.payload)).then(({ status, body }) => {
          const res = Object.assign(new EventEmitter(), { statusCode: status });
          callback(res);
          res.emit('data', JSON.stringify(body));
          res.emit('end');
        }).catch((error) => this.emit('error', error));
      },
    });
  });

  await assert.rejects(() => withProjectContext({ targetRoot: workspace.root, dataDir: workspace.dataDir },
    () => toolCompleteFeature({ id: workspace.item.id, repo, commit_sha: sha, tests_pass: true, evidence })),
  /guard unreachable/);
});

test('F3 a clean flag cannot close a review with a repeated MEDIUM class', { todo: 'F3' }, async (t) => {
  const post = attach(makeWorkspace(t));
  const started = await post('iteration/start', { loopType: 'review', tier: 'standard' });
  assert.equal(started.status, 200, JSON.stringify(started));
  const findings = [{ severity: 'MEDIUM', class: 'stale-output', title: 'Stale output' }];
  const first = await post('iteration/report', { result: { clean: false, findings } });
  assert.equal(first.body.continue, true, JSON.stringify(first));

  const second = await post('iteration/report', { result: { clean: true, findings } });
  assert.ok(
    (second.status === 200 && second.body.needs_redesign === true) ||
      ([400, 409, 422].includes(second.status) && /clean|redesign/i.test(second.body.error ?? '')),
    `expected redesign or refusal of the contradictory report, got ${JSON.stringify(second)}`,
  );
});

test('F4 a persisted legacy review cannot record a third standard round', { todo: 'F4' }, async (t) => {
  const iterations = [1, 2].map((n) => ({
    n, startedAt: AT, result: { clean: false, findings: ['Stale output'] },
  }));
  const workspace = makeWorkspace(t, { iterationState: {
    loopType: 'review', loopId: 'legacy-review', status: 'running', startedAt: AT,
    count: 2, maxIterations: 4, iterations,
  } });
  const store = new VisionStore(workspace.dataDir);
  const item = store.items.get(workspace.item.id);
  assert.equal(item.lifecycle.iterationState.count, 2);
  const post = attach({ ...workspace, store, item });

  const response = await post('iteration/report', {
    result: { clean: false, findings: [{ severity: 'MEDIUM', class: 'stale-output' }] },
  });
  const saved = store.items.get(item.id).lifecycle.iterationState;
  assert.ok(
    saved.count <= 2 && (response.body.continue === false || [400, 409, 422].includes(response.status)),
    `expected the cap to prevent round 3, got ${JSON.stringify(response)}; stored count=${saved.count}`,
  );
});

test('F5 a previously stored receipt with extra subject metadata remains readable by ID', { todo: 'F5' }, (t) => {
  const root = scratch(t);
  const sha = initRepo(root, 'receipt fixture');
  const store = join(root, 'evidence.jsonl');
  const evidence = shaEvidence(root, sha);
  const verified = verifyEvidence(evidence, { now: Date.parse(AT) });
  assert.equal(verified.ok, true, verified.reasons.join(', '));
  const subject = { unit: CODE, claim: 'LANDED' };
  const current = recordEvidence(evidence, { checks: verified.checks, subject, store, now: Date.parse(AT) });
  assert.deepEqual(readEvidence(current.id, { store }), current);

  // 26aaaeac's writer appended the same record shape with the caller's entire subject.
  const legacy = { ...current, id: 'ev:0123456789abcdef', subject: { ...subject, note: 'legacy context' } };
  appendFileSync(store, JSON.stringify(legacy) + '\n');
  assert.equal(readEvidence(legacy.id, { store })?.id, legacy.id, 'legacy receipt ID should still resolve');
});
