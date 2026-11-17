/**
 * COMP-SETUP-PREFLIGHT-1 — one table of real-process rows. No mocked spawn: checks run
 * real commands, the engine is a real executable package on disk, the gate runs real
 * child commands, the run lock is a real directory held by a real `compose preflight
 * --gate` process, and the build row runs the real runBuild against the live TS engine
 * (only agent inference is faked; `dispatched` is the dispatch log).
 *
 * Hand-run cases and the two incident replays: docs/features/COMP-SETUP-PREFLIGHT-1/report.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runPreflight, runGate, runProjectCheck, engineDrift, refingerprint, checkEngine,
  classifyTapFailures, rerunCommand, engineMarkers, SETUP_EXIT, RUN_LOCK_REL, readPreflightConfig,
} from '../lib/preflight.js';
import { declaredTiers, tierSkipLine } from '../lib/gate-tiers.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_BIN = join(HERE, '..', 'bin', 'compose.js');
const PROBE_OK = JSON.stringify({ error: { code: 'NOT_FOUND', message: "Flow 'stratum-probe-nonexistent-run-0' not found" } });
const NO_SKIP = { ...process.env, COMPOSE_SKIP_PREFLIGHT: '' };
for (const k of ['COMPOSE_STRATUM_TS_CLI_BIN', 'COMPOSE_STRATUM_TS_MCP_BIN', 'COMPOSE_STRATUM_TS_BIN']) delete NO_SKIP[k];

/** A project depending on a real, executable engine package in its own node_modules. */
function project({ preflight, cliBody = `console.log(${JSON.stringify(PROBE_OK)}); process.exit(1);`, testScript } = {}) {
  // realpath: macOS tmpdir() is a symlink, and node resolves packages to real paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-preflight-')));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', dependencies: { '@smartmemory/stratum': '*' },
    scripts: { test: testScript ?? 'node --import ./x.js --test --test-concurrency=2 test/*.test.js' },
  }));
  const pkg = join(dir, 'node_modules', '@smartmemory', 'stratum');
  mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(pkg, 'dist', 'mcp'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: '@smartmemory/stratum', bin: { stratum: './dist/cli/stratum.js', 'stratum-mcp': './dist/mcp/main.js' },
    scripts: { build: 'tsc' },
  }));
  const cli = join(pkg, 'dist', 'cli', 'stratum.js');
  writeFileSync(cli, `#!/usr/bin/env node\n${cliBody}\n`);
  chmodSync(cli, 0o755);
  writeFileSync(join(pkg, 'dist', 'mcp', 'main.js'), '// mcp\n');
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
  if (preflight) writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ verify: { preflight } }));
  return { dir, cli, mcp: join(pkg, 'dist', 'mcp', 'main.js') };
}

function gate(dir, argv, opts = {}) {
  const lines = [];
  return runGate({ cwd: dir, argv, env: NO_SKIP, err: (l) => lines.push(l), ...opts })
    .then((code) => ({ code, out: lines.join('\n') }));
}

/** A real `compose preflight --gate` holder, returned once it holds the lock. */
async function startHolder(dir, seconds) {
  const child = spawn(process.execPath, [COMPOSE_BIN, 'preflight', '--gate', '--', process.execPath, '-e', `setTimeout(()=>{}, ${seconds * 1000})`],
    { cwd: dir, env: NO_SKIP, stdio: 'ignore' });
  const owner = join(dir, RUN_LOCK_REL, 'owner');
  for (let i = 0; i < 200 && !existsSync(owner); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(owner), 'holder took the lock');
  return child;
}
const exited = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode) r(); else child.on('exit', r); });

const ROWS = [
  ['engine present: SETUP-OK with a cli+mcp fingerprint', () => {
    const { dir } = project();
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP });
    assert.equal(pre.ok, true, JSON.stringify(pre.results));
    assert.deepEqual(Object.keys(pre.fingerprint).sort(), ['cli', 'mcp']);
    assert.equal(pre.results.length, 1, 'no project checks without a verify.preflight block');
  }],
  ['case 1a: engine file missing -> SETUP-FAIL <path> not found, fix names npm run build', () => {
    const { dir, cli } = project();
    unlinkSync(cli);
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP });
    assert.equal(pre.ok, false);
    assert.equal(pre.results[0].detail, `${cli} not found`);
    assert.match(pre.results[0].fix, /npm run build/);
  }],
  ['an env override pointing nowhere fails and names the variable (no silent fall-through)', () => {
    const { dir } = project();
    const res = checkEngine({ requireFrom: join(dir, 'package.json'), env: { ...NO_SKIP, COMPOSE_STRATUM_TS_CLI_BIN: '/nonexistent/stratum.js' } });
    assert.equal(res.ok, false);
    assert.match(res.detail, /\/nonexistent\/stratum\.js not found/);
    assert.match(res.fix, /COMPOSE_STRATUM_TS_CLI_BIN/);
  }],
  ['an engine file that does not speak the contract fails the probe', () => {
    const { dir } = project({ cliBody: 'console.log("[]")' });
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP });
    assert.equal(pre.ok, false);
    assert.match(pre.results[0].detail, /present but does not run/);
  }],
  ['case 6: a repo that does not use the engine is not checked by the gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-preflight-plain-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'plain' }));
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP });
    assert.equal(pre.ok, true);
    assert.equal(pre.results[0].skipped, true);
  }],
  ['case 6: COMPOSE_SKIP_PREFLIGHT skips every check with one WARNING naming them', () => {
    const { dir } = project({ preflight: { checks: [{ id: 'db', command: ['false'] }] } });
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: { ...NO_SKIP, COMPOSE_SKIP_PREFLIGHT: '1' } });
    assert.equal(pre.ok, true);
    assert.equal(pre.results.length, 0);
    assert.match(pre.warning, /^WARNING: COMPOSE_SKIP_PREFLIGHT is set: skipped setup checks stratum-engine, db;/);
  }],
  ['project check: expect found in output passes', () => {
    const r = runProjectCheck({ id: 'up', command: [process.execPath, '-e', 'console.log("PONG")'], expect: 'PONG' }, tmpdir());
    assert.equal(r.ok, true);
  }],
  ['case 3: project check expect missing -> expected "PONG", got "<first line>"', () => {
    const r = runProjectCheck({ id: 'falkordb-up', command: [process.execPath, '-e', 'console.error("Could not connect to Redis"); process.exit(1)'], expect: 'PONG', timeout_s: 5 }, tmpdir());
    assert.equal(r.ok, false);
    assert.equal(r.detail, 'expected "PONG", got "Could not connect to Redis"');
  }],
  ['project check: command not found', () => {
    const r = runProjectCheck({ id: 'x', command: ['definitely-not-a-command-xyz'] }, tmpdir());
    assert.equal(r.ok, false);
    assert.match(r.detail, /^command not found/);
  }],
  ['project check: killed at its timeout', () => {
    const t0 = Date.now();
    const r = runProjectCheck({ id: 'slow', command: [process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], timeout_s: 0.5 }, tmpdir());
    assert.equal(r.ok, false);
    assert.match(r.detail, /timed out after 0.5s/);
    assert.ok(Date.now() - t0 < 5000);
  }],
  ['an invalid verify.preflight block is a SETUP-FAIL config, never silently ignored', () => {
    const { dir } = project({ preflight: { checks: [{ id: 'stratum-engine', command: ['true'] }], extra: 1 } });
    const pre = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP });
    assert.equal(pre.ok, false);
    assert.equal(pre.results[0].id, 'config');
  }],
  ['engine drift: a same-content rewrite and a deletion both count', () => {
    const { dir, cli, mcp } = project();
    const before = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP }).fingerprint;
    const body = readFileSync(cli);
    unlinkSync(cli); writeFileSync(cli, body);
    const d1 = engineDrift(before, refingerprint(before));
    assert.equal(d1.changed, true);
    assert.match(d1.line, /^SETUP-INVALID stratum-engine changed during the run \(cli hash \w{12} -> \w{12}, rewritten with the same content\)$/);
    unlinkSync(mcp);
    assert.match(engineDrift(before, refingerprint(before)).line, /mcp hash \w{12} -> missing/);
  }],
  ['TAP attribution on a real node --test run: engine-path reds are setup, others product', () => {
    const { dir, cli } = project();
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'a.test.js'), `import {test} from 'node:test'; test('a', () => { throw new Error('Cannot find module ${cli}'); });`);
    writeFileSync(join(dir, 'test', 'b.test.js'), `throw new Error('not found: ${cli}');`);
    writeFileSync(join(dir, 'test', 'c.test.js'), "import {test} from 'node:test'; import assert from 'node:assert'; test('c', () => assert.equal(1, 2));");
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=3', 'test/a.test.js', 'test/b.test.js', 'test/c.test.js'],
      // Without NODE_TEST_CONTEXT: inherited from this runner, it makes the child speak the
      // runner's internal protocol instead of TAP (a pre-push hook never runs nested).
      { cwd: dir, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
    const fp = runPreflight({ cwd: dir, mode: 'gate', env: NO_SKIP }).fingerprint;
    const got = classifyTapFailures(r.stdout, engineMarkers(fp), dir);
    assert.deepEqual(got.setupInvalid.sort(), ['test/a.test.js', 'test/b.test.js']);
    assert.deepEqual(got.other, ['test/c.test.js']);
  }],
  ['rerun command keeps the test script options and drops its globs', () => {
    const { dir } = project();
    assert.equal(rerunCommand(dir, ['test/a.test.js']), 'node --import ./x.js --test --test-concurrency=2 test/a.test.js');
  }],
  ['gate: SETUP-FAIL exits 78 and the command never starts', async () => {
    const { dir, cli } = project();
    unlinkSync(cli);
    const marker = join(dir, 'ran');
    const { code, out } = await gate(dir, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`]);
    assert.equal(code, SETUP_EXIT.FAIL);
    assert.match(out, /SETUP-FAIL stratum-engine: .* not found/);
    assert.equal(existsSync(marker), false, 'the run must not start');
  }],
  ['case 1b: engine rebuilt mid-run, every red names it -> exit 79, rerun line, no retry', async () => {
    const { dir, cli } = project();
    const log = join(dir, 'run.log');
    const script = `const fs=require('fs');const b=fs.readFileSync(${JSON.stringify(cli)});fs.unlinkSync(${JSON.stringify(cli)});fs.writeFileSync(${JSON.stringify(cli)},b);`
      + `console.log("not ok 1 - test/a.test.js\\n  ---\\n  location: '${dir}/test/a.test.js:1:1'\\n  error: 'Cannot find module ${cli}'\\n  ...");process.exit(1);`;
    const { code, out } = await gate(dir, [process.execPath, '-e', script], { logPath: log });
    assert.equal(code, SETUP_EXIT.INVALID, out);
    assert.match(out, /SETUP-INVALID stratum-engine changed during the run/);
    assert.match(out, /rerun only those: node --import \.\/x\.js --test --test-concurrency=2 test\/a\.test\.js/);
    assert.match(out, /nothing was retried automatically/);
  }],
  ['case 1b: a product red alongside keeps the command exit code', async () => {
    const { dir, cli } = project();
    const log = join(dir, 'run.log');
    const script = `const fs=require('fs');const b=fs.readFileSync(${JSON.stringify(cli)});fs.unlinkSync(${JSON.stringify(cli)});fs.writeFileSync(${JSON.stringify(cli)},b);`
      + `console.log("not ok 1 - test/a.test.js\\n  ---\\n  location: '${dir}/test/a.test.js:1:1'\\n  error: '${cli}'\\n  ...\\nnot ok 2 - test/c.test.js\\n  ---\\n  location: '${dir}/test/c.test.js:1:1'\\n  ...");process.exit(1);`;
    const { code, out } = await gate(dir, [process.execPath, '-e', script], { logPath: log });
    assert.equal(code, 1);
    assert.match(out, /test failures \(reported as usual\): test\/c\.test\.js/);
  }],
  ['case 2: a live holder is never overridden -> SETUP-BUSY with its pid, exit 75', async () => {
    const { dir } = project({ preflight: { exclusive_runs: true } });
    const holder = await startHolder(dir, 4);
    try {
      const marker = join(dir, 'ran');
      const { code, out } = await gate(dir, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`]);
      assert.equal(code, SETUP_EXIT.BUSY);
      assert.match(out, new RegExp(`SETUP-BUSY: another verification run holds .* \\(pid ${holder.pid}, started `));
      assert.equal(existsSync(marker), false);
    } finally { holder.kill('SIGKILL'); await exited(holder); }
  }],
  ['case 2: a killed holder leaves a stale lock that the next run takes over', async () => {
    const { dir } = project({ preflight: { exclusive_runs: true } });
    const holder = await startHolder(dir, 30);
    holder.kill('SIGKILL'); await exited(holder);
    assert.ok(existsSync(join(dir, RUN_LOCK_REL)), 'the dead holder left its lock');
    const { code, out } = await gate(dir, [process.execPath, '-e', '0']);
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`taking over a stale lock \\(pid ${holder.pid} is not running`));
    assert.equal(existsSync(join(dir, RUN_LOCK_REL)), false, 'released after the run');
  }],
  ['case 2: busy_wait_s waits for the holder, then proceeds', async () => {
    const { dir } = project({ preflight: { exclusive_runs: true, busy_wait_s: 20 } });
    const holder = await startHolder(dir, 1.5);
    const { code, out } = await gate(dir, [process.execPath, '-e', '0']);
    await exited(holder);
    assert.equal(code, 0, out);
    assert.match(out, /waiting up to 20s/);
  }],
  ['case 4: the skipped line names only declared tiers never dispatched', () => {
    const spec = { flows: { entry: 'b', b: { steps: [{ id: 'lint' }, { id: 'review' }, { id: 'codex_review' }] } } };
    assert.deepEqual(declaredTiers(spec), ['T1', 'T3', 'T4']);
    assert.equal(tierSkipLine({ T1: false }, declaredTiers(spec)), 'skipped T3,T4: T1 failed');
    assert.equal(tierSkipLine({ T1: true, T3: true, T4: true }, declaredTiers(spec)), null);
  }],
  ['cases 3+5: a failing project check stops compose build before any dispatch; budget untouched', { skip: !existsSync(TS_MCP_BIN) && 'TS engine unavailable' }, async () => {
    const { runBuild } = await import('../lib/build.js');
    const { runBuildWithAgentFactory } = await import('./helpers/ts-agent-harness.js');
    const dir = mkdtempSync(join(tmpdir(), 'setup-preflight-build-'));
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true },
      verify: { preflight: { checks: [{ id: 'falkordb-up', command: [process.execPath, '-e', 'console.log("Could not connect")'], expect: 'PONG', timeout_s: 5 }] } } }));
    mkdirSync(join(dir, 'docs', 'features', 'FEAT-3'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'features', 'FEAT-3', 'design.md'), '# FEAT-3\n');
    mkdirSync(join(dir, 'pipelines'));
    writeFileSync(join(dir, 'pipelines', 'build.stratum.yaml'), `version: 1
contracts:
  PhaseResult: { phase: string, artifact: string, outcome: string }
flows:
  entry: build
  build:
    input: { featureCode: string, description: string, pre_merge_gate: "string[]?", implementer_agent: string, reviewer_agent: string }
    output: { from: "\${review.output}", contract: PhaseResult }
    steps:
      - { id: review, agent: claude, do: "review", out: PhaseResult, attempts: 1 }
`);
    const dispatched = [];
    const factory = () => ({ async *run(p) { dispatched.push(p.slice(0, 40)); yield { type: 'assistant', content: '{}' }; }, interrupt() {}, get isRunning() { return false; } });
    await assert.rejects(
      runBuildWithAgentFactory(runBuild, 'FEAT-3', { cwd: dir, connectorFactory: factory, description: 'x' }),
      /^Error: setup:falkordb-up$|setup:falkordb-up/,
    );
    assert.deepEqual(dispatched, [], 'no agent dispatched');
    const hist = readFileSync(join(dir, '.compose', 'data', 'build-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(hist.failureReason, 'setup:falkordb-up');
    assert.equal(hist.stepCount, 0);
    assert.equal(existsSync(join(dir, '.compose', 'data', 'budget-ledger.json')), false, 'no iteration budget charged');
    rmSync(dir, { recursive: true, force: true });
  }],
  ['case 4: a failed T1 step dispatches no T3/T4 agent (dispatch log, real build)', { skip: !existsSync(TS_MCP_BIN) && 'TS engine unavailable' }, async () => {
    const { runBuild } = await import('../lib/build.js');
    const { runBuildWithAgentFactory } = await import('./helpers/ts-agent-harness.js');
    const dir = mkdtempSync(join(tmpdir(), 'setup-preflight-t1-'));
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    mkdirSync(join(dir, 'docs', 'features', 'FEAT-4'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'features', 'FEAT-4', 'design.md'), '# FEAT-4\n');
    mkdirSync(join(dir, 'pipelines'));
    writeFileSync(join(dir, 'pipelines', 'build.stratum.yaml'), `version: 1
contracts:
  PhaseResult: { phase: string, artifact: string, outcome: string }
flows:
  entry: build
  build:
    input: { featureCode: string, description: string, pre_merge_gate: "string[]?", implementer_agent: string, reviewer_agent: string }
    output: { from: "\${codex_review.output}", contract: PhaseResult }
    steps:
      - { id: lint, agent: claude, do: "lint", out: PhaseResult, attempts: 1 }
      - { id: review, after: [lint], agent: claude, do: "review", out: PhaseResult, attempts: 1 }
      - { id: codex_review, after: [review], agent: codex, do: "codex", out: PhaseResult, attempts: 1 }
`);
    const dispatched = [];
    const factory = (agentType) => ({
      async *run(prompt) {
        const stepId = (prompt.match(/step "([^"]+)"/)?.[1] ?? 'unknown').split('/').at(-1);
        dispatched.push(`${stepId}(${agentType})`);
        yield { type: 'assistant', content: JSON.stringify({ phase: stepId, artifact: 'x.md', outcome: stepId === 'lint' ? 'failed' : 'complete' }) };
      },
      interrupt() {}, get isRunning() { return false; },
    });
    try { await runBuildWithAgentFactory(runBuild, 'FEAT-4', { cwd: dir, connectorFactory: factory, description: 'x' }); } catch { /* a failed build may throw; the dispatch log is the proof */ }
    assert.deepEqual(dispatched, ['lint(claude)'], 'only the T1 step was dispatched');
    const stream = readFileSync(join(dir, '.compose', 'build-stream.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const summary = stream.filter((e) => e.type === 'gate_tier_summary').at(-1);
    assert.equal(summary.skippedLine, 'skipped T3,T4: T1 failed');
    assert.ok(['T3', 'T4'].every((t) => summary.tiersSkipped.includes(t)));
    rmSync(dir, { recursive: true, force: true });
  }],
];

for (const [name, a, b] of ROWS) {
  if (typeof a === 'function') test(name, a);
  else test(name, a, b);
}

// Merge of COMP-VERIFY-FLOW-1: the verify block's two keys are independent.
test('a verify block holding only flows is "no preflight configured", and flows next to preflight do not break it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-merge-'));
  try {
    mkdirSync(join(dir, '.compose'));
    const flows = [{ id: 'a', command: ['x'], covers: ['src/**'], expect: ['OK'] }];
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ verify: { flows } }));
    assert.equal(readPreflightConfig(dir).configured, false);
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ verify: { flows, preflight: { exclusive_runs: true } } }));
    const c = readPreflightConfig(dir);
    assert.equal(c.configured, true);
    assert.equal(c.exclusive_runs, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Fix round 1, P-1: Case 4 on the SHIPPED pipeline, not a made-up one. The bundled
// pipelines/build.stratum.yaml is copied verbatim into a throwaway git project; every
// agent is faked and the tests step (run_tests, T2) reports failing. The dispatch log
// must show no paid review (review_triage, review lenses, review_merge, the codex
// review) and no test_review, before or after the failing tests.
const SHIPPED_PIPELINE_FAKE_OUTPUTS = (featureCode) => ({
  explore_design: { phase: 'design', artifact: `docs/features/${featureCode}/design.md`, outcome: 'skipped', summary: 'x', explorations: [] },
  blueprint: { phase: 'blueprint', artifact: `docs/features/${featureCode}/design.md`, outcome: 'complete', summary: 'x' },
  verification: { phase: 'verification', artifact: 'x', outcome: 'complete', summary: 'x' },
  plan: { phase: 'plan', artifact: `docs/features/${featureCode}/design.md`, outcome: 'complete', summary: 'x' },
  decompose: { tasks: [{ id: 't1', description: 'touch a.txt (no test: fixture)', files_owned: ['a.txt'], files_read: [], depends_on: [] }] },
  execute: { outcome: 'complete', summary: 'x', files_changed: [] },
  review_triage: { tasks: [{ id: 'l1', lens_name: 'diff-quality', lens_focus: 'x', confidence_gate: 7, exclusions: [] }] },
  review: { clean: true, summary: 'clean', findings: [], meta: {}, lenses_run: [], auto_fixes: [], asks: [] },
  run_tests: { passing: false, summary: '1 failing', failures: ['test/a.test.js'] },
  other: { phase: 'x', artifact: 'x', outcome: 'complete', summary: 'x' },
});

async function runShippedPipeline(featureCode, { testsPass, pipeline = 'build' }) {
  process.env.NODE_ENV = 'test';
  const { runBuild } = await import('../lib/build.js');
  const { runBuildWithAgentFactory } = await import('./helpers/ts-agent-harness.js');
  const dir = mkdtempSync(join(tmpdir(), 'setup-preflight-shipped-'));
  try {
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    const gates = ['design_gate', 'plan_gate', 'execute_merge', 'review_lenses_gate', 'ship_gate'];
    writeFileSync(join(dir, '.compose', 'data', 'settings.json'), JSON.stringify({ policies: Object.fromEntries(gates.map((g) => [g, 'skip'])) }));
    mkdirSync(join(dir, 'docs', 'features', featureCode), { recursive: true });
    writeFileSync(join(dir, 'docs', 'features', featureCode, 'design.md'), `# ${featureCode}\n`);
    mkdirSync(join(dir, 'pipelines'));
    writeFileSync(join(dir, 'pipelines', `${pipeline}.stratum.yaml`), readFileSync(join(HERE, '..', 'pipelines', `${pipeline}.stratum.yaml`), 'utf8'));
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
      spawnSync('git', args, { cwd: dir });
    }
    const outputs = SHIPPED_PIPELINE_FAKE_OUTPUTS(featureCode);
    if (pipeline === 'build-quick') delete outputs.explore_design.explorations; // its PhaseResult has no explorations field
    if (testsPass) outputs.run_tests = { passing: true, summary: 'all pass', failures: [] };
    const dispatched = [];
    const factory = (agentType) => ({
      async *run(prompt) {
        const raw = prompt.match(/step "([^"]+)"/)?.[1] ?? 'unknown';
        dispatched.push(`${raw}(${agentType})`);
        const known = Object.keys(outputs).find((k) => raw.split('/').includes(k));
        yield { type: 'assistant', content: JSON.stringify(outputs[known] ?? outputs.other) };
      },
      interrupt() {}, get isRunning() { return false; },
    });
    let error = null;
    try {
      await runBuildWithAgentFactory(runBuild, featureCode, { cwd: dir, connectorFactory: factory, description: 'x', gateOpts: { nonInteractive: true }, ...(pipeline === 'build' ? {} : { template: pipeline }) });
    } catch (err) { error = err; }
    if (process.env.COMPOSE_P1_DISPATCH_LOG) writeFileSync(`${process.env.COMPOSE_P1_DISPATCH_LOG}.${testsPass ? 'pass' : 'fail'}`, `${dispatched.join('\n')}\nerror: ${error?.message ?? 'none'}\n`);
    const streamPath = join(dir, '.compose', 'build-stream.jsonl');
    const stream = existsSync(streamPath) ? readFileSync(streamPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const skippedLine = stream.filter((e) => e.type === 'gate_tier_summary').at(-1)?.skippedLine ?? null;
    return { dispatched, error, skippedLine };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PAID = /(^|\/)(review_triage|review_lenses|review_merge|review|codex_review|test_review|docs|ship)(\/|\()/;
const SHIPPED_OPTS = { skip: !existsSync(TS_MCP_BIN) && 'TS engine unavailable', timeout: 240_000 };

test('P-1: on the shipped build pipeline a failing tests step (T2) dispatches no paid review', SHIPPED_OPTS, async () => {
  const { dispatched, skippedLine } = await runShippedPipeline('FEAT-P1', { testsPass: false });
  assert.equal(skippedLine, 'skipped T3,T4: T2 failed');
  assert.ok(dispatched.some((d) => /(^|\/)run_tests\(/.test(d)), `the tests step was dispatched: ${dispatched.join(' ')}`);
  const paid = dispatched.filter((d) => PAID.test(d) || d.endsWith('(codex)'));
  assert.deepEqual(paid, [], `no paid review dispatched; log: ${dispatched.join(' ')}`);
});

test('P-1 control: on the shipped build pipeline passing tests run first, then the Claude and Codex reviews, and the build completes', SHIPPED_OPTS, async () => {
  const { dispatched, error } = await runShippedPipeline('FEAT-P1C', { testsPass: true });
  const at = (re) => dispatched.findIndex((d) => re.test(d));
  const tests = at(/(^|\/)run_tests\(/);
  const triage = at(/^review_triage\(/);
  const codex = at(/^codex_review\/review\(codex\)/);
  const docs = at(/^docs\(/);
  assert.equal(error, null, 'the build completed');
  assert.ok(tests >= 0 && triage > tests && codex > triage && docs > codex, `order tests < triage < codex < docs; log: ${dispatched.join(' ')}`);
  assert.ok(at(/^review_lenses\//) > tests, 'a review lens ran after the tests');
});

test('P-1: the shipped build-quick pipeline also stops at failing tests before any paid review', SHIPPED_OPTS, async () => {
  const { dispatched } = await runShippedPipeline('FEAT-P1Q', { testsPass: false, pipeline: 'build-quick' });
  assert.ok(dispatched.some((d) => /(^|\/)run_tests\(/.test(d)), `the tests step was dispatched: ${dispatched.join(' ')}`);
  assert.deepEqual(dispatched.filter((d) => PAID.test(d) || d.endsWith('(codex)')), [], `log: ${dispatched.join(' ')}`);
});

test('P-1: a project-local pipeline that reviews before testing gets one WARNING naming the file', { skip: !existsSync(TS_MCP_BIN) && 'TS engine unavailable' }, async () => {
  const { runBuild } = await import('../lib/build.js');
  const { runBuildWithAgentFactory } = await import('./helpers/ts-agent-harness.js');
  const dir = mkdtempSync(join(tmpdir(), 'setup-preflight-oldorder-'));
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    mkdirSync(join(dir, 'docs', 'features', 'FEAT-OLD'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'features', 'FEAT-OLD', 'design.md'), '# FEAT-OLD\n');
    mkdirSync(join(dir, 'pipelines'));
    writeFileSync(join(dir, 'pipelines', 'build.stratum.yaml'), `version: 1
contracts:
  PhaseResult: { phase: string, artifact: string, outcome: string }
flows:
  entry: build
  build:
    input: { featureCode: string, description: string, pre_merge_gate: "string[]?", implementer_agent: string, reviewer_agent: string }
    output: { from: "\${run_tests.output}", contract: PhaseResult }
    steps:
      - { id: codex_review, agent: codex, do: "codex", out: PhaseResult, attempts: 1 }
      - { id: run_tests, after: [codex_review], agent: claude, do: "tests", out: PhaseResult, attempts: 1 }
`);
    const factory = () => ({ async *run() { yield { type: 'assistant', content: JSON.stringify({ phase: 'x', artifact: 'x', outcome: 'complete' }) }; }, interrupt() {}, get isRunning() { return false; } });
    try { await runBuildWithAgentFactory(runBuild, 'FEAT-OLD', { cwd: dir, connectorFactory: factory, description: 'x' }); } catch { /* the warning is the subject */ }
  } finally { console.warn = realWarn; rmSync(dir, { recursive: true, force: true }); }
  const hits = warned.filter((w) => w.startsWith('WARNING:') && w.includes('paid review step "codex_review" before the tests step "run_tests"'));
  assert.equal(hits.length, 1, `one WARNING; got: ${warned.join(' | ')}`);
  assert.match(hits[0], /pipelines\/build\.stratum\.yaml/);
});
