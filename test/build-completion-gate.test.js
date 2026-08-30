/**
 * test/build-completion-gate.test.js — COMP-COMPLETION-GATE slice 2.
 *
 * Slice 1 gated the *deliberate* completion (`record_completion`). This is the
 * one that mattered: the BUILD RUNNER, which is how essentially every one of the
 * 230 COMPLETE features actually got there — none of them through the guard.
 *
 * Three defects are pinned here, and the first is the headline:
 *
 *  1. The health gate can downgrade a finished build to `failed`, and it runs
 *     AFTER the terminal block that used to write COMPLETE. So a build the system
 *     itself judged a failure was left marked complete — and once gated, the very
 *     first thing the append-only ledger would ever durably attest would be that
 *     rejected build. The health verdict is a PRECONDITION of completion.
 *  2. Ship recorded the completion itself, swallowed every failure, and returned
 *     success regardless. Ship now hands over evidence; exactly one completion
 *     happens, at terminalization, through the gate, after health.
 *  3. A resumed cross-repo build reconstructs the agent cwd from the CURRENT
 *     invocation, so without a persisted `evidence_root` the gate would verify the
 *     project repo's HEAD instead of the repo the work was committed to.
 *
 * These drive the real `runBuild` through a real ship step against a stub engine.
 * The defect is in the ORDER of the runner's finalization, so no unit of it can
 * show the behaviour — only the whole sequence can.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBuild, readBuildAccumulator } from '../lib/build.js';
import {
  _testOnly_setHistoryClient, _testOnly_resetHistoryClient,
} from '../lib/completion-gate.js';
import {
  _testOnly_setGuardClient, _testOnly_resetGuardCache,
} from '../server/lifecycle-guard.js';

const FEATURE = 'GATEB-1';

// A one-step pipeline whose single step is `ship`, so the run goes through the
// real ship interception (tests → commit → evidence) and then terminalizes.
const SHIP_SPEC = `
version: 1
contracts:
  PhaseResult:
    phase: string
    artifact: string
    outcome: string
    summary: string
    files_changed: string[]?
    commit_hash: string?
flows:
  entry: build
  build:
    input:
      featureCode: string?
      description: string?
      implementer_agent: string?
      reviewer_agent: string?
    output:
      from: "\${ship.output}"
      contract: PhaseResult
    steps:
      - id: ship
        agent: claude
        do: "commit the work"
        out: PhaseResult
        attempts: 1
`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A git repo with one commit, so HEAD resolves to real, verifiable evidence. */
function makeRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  // Unique content per repo: two repos with identical trees, messages, authors
  // and timestamps produce the SAME sha, which would make a cross-repo assertion
  // pass for the wrong reason.
  writeFileSync(join(root, 'README.md'), `# ${prefix}${root}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function head(root) {
  return git(root, 'rev-parse', 'HEAD');
}

function makeProject({ guard = true, healthThreshold = null, tests = 'passing' } = {}) {
  const root = makeRepo('compose-gateb-');
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'pipelines'), { recursive: true });
  writeFileSync(
    join(root, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, paths: { features: 'docs/features' }, capabilities: { guard } }),
  );
  writeFileSync(join(root, 'pipelines', 'build.stratum.yaml'), SHIP_SPEC);
  if (healthThreshold !== null) {
    // The health gate downgrades buildStatus to 'failed' when the composite
    // score falls below this. 101 is unreachable, so the build is always rejected.
    writeFileSync(
      join(root, '.compose', 'data', 'settings.json'),
      JSON.stringify({ health: { gate_threshold: healthThreshold } }),
    );
  }
  // `tests: 'unreadable'` leaves no framework to detect — the run cannot be
  // parsed, which is the 'no-signal' case.
  if (tests !== 'unreadable') writeFileSync(join(root, 'pytest.ini'), '[pytest]\n');

  const fdir = join(root, 'docs', 'features', FEATURE);
  mkdirSync(fdir, { recursive: true });
  writeFileSync(join(fdir, 'description.md'), `# ${FEATURE}\n`);
  writeFileSync(
    join(fdir, 'feature.json'),
    JSON.stringify({ code: FEATURE, description: 'gate fixture', phase: 'Phase 1', status: 'PLANNED' }, null, 2),
  );
  return root;
}

/**
 * Shim `pytest` onto PATH so the ship step's test run produces a real, parseable
 * summary. The attestation path runs end to end (detect → run → parse → derive)
 * with no network install.
 */
function withPytestShim(summaryLine, fn) {
  const shimDir = mkdtempSync(join(tmpdir(), 'pytest-shim-'));
  const shim = join(shimDir, 'pytest');
  writeFileSync(shim, `#!/bin/sh\necho "${summaryLine}"\n`);
  execFileSync('chmod', ['755', shim]);
  const origPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${origPath}`;
  return (async () => {
    try { return await fn(); } finally {
      process.env.PATH = origPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
  })();
}

const PASSING = '===================== 4 passed in 0.02s =====================';
const FAILING = '========== 2 failed, 5 passed in 0.10s ==========';

/** An engine that issues exactly one `ship` step, then terminalizes. */
function shipStratum() {
  let issued = false;
  return {
    async plan() {
      issued = true;
      return {
        status: 'ready',
        runId: 'flow-1',
        ready: [{ id: 'ship', agent: 'claude', do: 'commit the work', dispatchToken: 'tok-1' }],
      };
    },
    async stepDone() { return { status: 'completed', runId: 'flow-1', trace: [] }; },
    async audit() { return { status: issued ? 'completed' : 'running' }; },
    async close() {},
  };
}

function spyVisionWriter() {
  const statuses = [];
  return {
    statuses,
    async ensureFeatureItem(featureCode) { return featureCode; },
    async updateItemStatus(_id, status) { statuses.push(status); },
    // Slice 3: the gate projects completion through completeItem (AC-4b), never
    // through updateItemStatus('complete'). Record it under the same key so the
    // assertions read as "the vision item was completed".
    async completeItem(_id, evidence) {
      statuses.push('complete');
      return { ok: true, verified_by: 'test', evidence };
    },
    async updateItemPhase() {},
  };
}

/** A guard that applies everything, and records every call it saw. */
function applyingGuard(calls) {
  return {
    register: async (a) => { calls.push({ op: 'register', ...a }); return { status: 'registered' }; },
    transition: async (a) => {
      calls.push({ op: 'transition', ...a });
      return { status: 'applied', current_state: 'complete', ledger_ref: 'ledger#1', verdict: { met: true } };
    },
  };
}

function feature(root) {
  return JSON.parse(readFileSync(join(root, 'docs', 'features', FEATURE, 'feature.json'), 'utf8'));
}

function run(root, visionWriter, extra = {}) {
  return runBuild(FEATURE, {
    cwd: root,
    stratum: shipStratum(),
    visionWriter,
    template: 'build',
    skipTriage: true,
    description: 'a feature',
    ...extra,
  });
}

/** Run `fn` with the guard/history clients injected, always restoring them. */
function withGuard(calls, fn) {
  _testOnly_setGuardClient(applyingGuard(calls));
  _testOnly_setHistoryClient(async () => ({ error: { code: 'guard_not_found' } }));
  return (async () => {
    try { return await fn(); } finally {
      _testOnly_resetGuardCache();
      _testOnly_resetHistoryClient();
    }
  })();
}

function captureWarnings() {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.map(String).join(' '));
  return { seen, restore: () => { console.warn = orig; } };
}

// ---------------------------------------------------------------------------

test('CONTROL: a healthy build with attested tests completes THROUGH the guard', async () => {
  const root = makeProject();
  const calls = [];
  const vision = spyVisionWriter();
  try {
    await withPytestShim(PASSING, () => withGuard(calls, () => run(root, vision)));

    const f = feature(root);
    assert.equal(f.status, 'COMPLETE', 'the feature completes');
    assert.equal(f.completions?.length, 1, 'exactly one completion record — not the old two writers');
    assert.equal(f.completions[0].tests_pass, true);
    assert.equal(f.completions[0].commit_sha, head(root), 'bound to the commit ship made');
    assert.ok(vision.statuses.includes('complete'), 'the vision item is completed');

    const transition = calls.find((c) => c.op === 'transition');
    assert.ok(transition, 'the completion reached the guard — the transition that never used to happen');
    assert.equal(transition.toState, 'complete');
    assert.ok(transition.artifacts.operation_id, 'operation_id rides in the artifacts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HEADLINE: a health-downgraded build writes NOTHING', async () => {
  // Identical to the control but for the unreachable health threshold, so any
  // difference is caused by the downgrade and nothing else.
  const root = makeProject({ healthThreshold: 101 });
  const calls = [];
  const vision = spyVisionWriter();
  try {
    await withPytestShim(PASSING, () => withGuard(calls, () => run(root, vision)));

    const f = feature(root);
    assert.notEqual(f.status, 'COMPLETE', 'a build judged a failure must not be marked COMPLETE');
    assert.equal(f.completions, undefined, 'no completion record');
    assert.equal(
      vision.statuses.includes('complete'), false,
      `the vision item must not be completed (saw: ${vision.statuses.join(',')})`,
    );
    assert.deepEqual(calls, [], 'the ledger is append-only — a rejected build must never reach it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unattestable test run ('no-signal') refuses, and names the remedy", async () => {
  // No framework to detect → the output cannot be parsed. The old code called
  // this `true` and wrote it onto a permanent record.
  const root = makeProject({ tests: 'unreadable' });
  const calls = [];
  const vision = spyVisionWriter();
  const warn = captureWarnings();
  try {
    await withGuard(calls, () => run(root, vision));

    assert.notEqual(feature(root).status, 'COMPLETE', 'absence of signal is never attestation');
    assert.equal(feature(root).completions, undefined);
    assert.deepEqual(calls, [], 'refused before the guard was touched');
    assert.equal(vision.statuses.includes('complete'), false);
    assert.ok(
      warn.seen.some((w) => w.includes('guard.testCommand')),
      `the refusal must name the remedy (saw: ${JSON.stringify(warn.seen)})`,
    );
    assert.equal(
      readBuildAccumulator(root, FEATURE)?.tests_attested ?? 'no-signal', 'no-signal',
      'and the sidecar says so too',
    );
  } finally {
    warn.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a red suite refuses — a failing test run is evidence AGAINST completion', async () => {
  const root = makeProject();
  const calls = [];
  const vision = spyVisionWriter();
  const warn = captureWarnings();
  try {
    await withPytestShim(FAILING, () => withGuard(calls, () => run(root, vision)));

    assert.notEqual(feature(root).status, 'COMPLETE');
    assert.equal(feature(root).completions, undefined);
    assert.equal(vision.statuses.includes('complete'), false);
    // The commit still stands — the work is durable, the CLAIM is what is refused.
    assert.ok(existsSync(join(root, '.git')));
  } finally {
    warn.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CROSS-REPO: the attested SHA is the work repo HEAD, not the project repo HEAD', async () => {
  // The work lives in the agent's tree; feature metadata lives in the project.
  // `runBuild` rebuilds the agent cwd from THIS invocation, so the evidence root
  // is persisted rather than re-derived — otherwise a resumed cross-repo build
  // would attest a commit containing none of the work.
  const root = makeProject();
  const work = makeRepo('compose-gateb-work-');
  writeFileSync(join(work, 'pytest.ini'), '[pytest]\n');
  const calls = [];
  const vision = spyVisionWriter();
  try {
    const projectHeadBefore = head(root);
    await withPytestShim(PASSING, () => withGuard(calls, () => run(root, vision, { workingDirectory: work })));

    const f = feature(root);
    assert.equal(f.status, 'COMPLETE');
    assert.equal(f.completions[0].commit_sha, head(work), 'attested against the repo the work went into');
    assert.notEqual(f.completions[0].commit_sha, projectHeadBefore);
    assert.equal(
      readBuildAccumulator(root, FEATURE), null,
      'a completed build clears its sidecar',
    );
    const transition = calls.find((c) => c.op === 'transition');
    assert.equal(transition.artifacts.commit_sha, head(work), 'and that is what the ledger records');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('OPT-OUT: `capabilities.guard:false` still completes on an unattestable run', async () => {
  // The reversal made once already in slice 1, and re-made here: the guard flag
  // is a real opt-out. Enforcing attestation outside the guarded regime breaks
  // every opted-out project — including non-git workspaces, where the evidence
  // can never pass at all. An opted-out project keeps `deriveTestsPass`'s
  // degrade contract, so 'no-signal' reads as a pass there and only an OBSERVED
  // failure blocks. (The full suite caught this: three integration builds with
  // no ship step went from completing to refusing.)
  const root = makeProject({ guard: false, tests: 'unreadable' });
  const calls = [];
  const vision = spyVisionWriter();
  try {
    await withGuard(calls, () => run(root, vision));

    const f = feature(root);
    assert.equal(f.status, 'COMPLETE', 'an opted-out project is not gated');
    assert.equal(f.completions?.length, 1);
    assert.equal(f.completions[0].tests_pass, true, "'no-signal' degrades to true OUTSIDE the guard");
    assert.deepEqual(calls, [], 'and nothing is ledgered — there is no guard here');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OPT-OUT: an observed test FAILURE is still recorded honestly', async () => {
  const root = makeProject({ guard: false });
  const calls = [];
  const vision = spyVisionWriter();
  try {
    await withPytestShim(FAILING, () => withGuard(calls, () => run(root, vision)));

    // Opting out of the guard opts out of *evidence verification*, not of the
    // difference between "we did not look" and "we looked and it was red". The
    // opted-out project still completes (that is what opting out means), but the
    // record does not claim a pass that did not happen.
    const f = feature(root);
    assert.equal(f.completions?.[0]?.tests_pass, false, 'the record tells the truth about the run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
