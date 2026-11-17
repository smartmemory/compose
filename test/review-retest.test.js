/**
 * COMP-SETUP-PREFLIGHT-1 fix round 2 (MEDIUM-1 of review-fix-round-1.md): code a review
 * fixer changes after the tests passed must pass the tests again before ship.
 *
 * Real bundled pipelines (`pipelines/build.stratum.yaml`, `build-quick.stratum.yaml`)
 * copied into a throwaway git project, the live TS engine, the real runBuild. Only agent
 * inference is faked: the fake reads the project on disk, so a fixer that "breaks a test"
 * writes `broken.flag` and every later tests step (the fake `run_tests` agent and the fake
 * `pytest` ship runs) sees it. `dispatched` is the dispatch log, in order.
 *
 * Cases: docs/features/COMP-SETUP-PREFLIGHT-1/brief-fix-round-2.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPTS = { skip: !existsSync(TS_MCP_BIN) && 'TS engine unavailable', timeout: 240_000 };

/**
 * @param {object} o
 * @param {'build'|'build-quick'} [o.pipeline]
 * @param {boolean} [o.testsPassFirst]      false: the implementation already fails a test (broken.flag)
 * @param {'none'|'break'|'harmless'} [o.reviewFix]  what the review_gate fixer does (review dirty once)
 * @param {'readable'|'garbage'|'hang'} [o.shipRun]  what the ship-time `pytest` prints
 * @param {boolean} [o.guard]               capabilities.guard
 * @param {string}  [o.pipelineText]        override the pipeline file body
 */
async function runCase(featureCode, {
  pipeline = 'build', testsPassFirst = true, reviewFix = 'none', shipRun = 'readable', guard = false, pipelineText,
} = {}) {
  process.env.NODE_ENV = 'test';
  const { runBuild } = await import('../lib/build.js');
  const { runBuildWithAgentFactory } = await import('./helpers/ts-agent-harness.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-retest-')));
  const savedPath = process.env.PATH;
  const savedTimeout = process.env.COMPOSE_SHIP_TEST_TIMEOUT_MS;
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
    writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({
      version: 2, capabilities: { stratum: true, ...(guard ? { guard: true } : {}) },
    }));
    const gates = ['design_gate', 'plan_gate', 'execute_merge', 'review_lenses_gate', 'ship_gate'];
    writeFileSync(join(dir, '.compose', 'data', 'settings.json'), JSON.stringify({ policies: Object.fromEntries(gates.map((g) => [g, 'skip'])) }));
    mkdirSync(join(dir, 'docs', 'features', featureCode), { recursive: true });
    writeFileSync(join(dir, 'docs', 'features', featureCode, 'design.md'), `# ${featureCode}\n`);
    mkdirSync(join(dir, 'pipelines'));
    writeFileSync(join(dir, 'pipelines', `${pipeline}.stratum.yaml`),
      pipelineText ?? readFileSync(join(HERE, '..', 'pipelines', `${pipeline}.stratum.yaml`), 'utf8'));
    // Ship's test run: detectTestFramework reads pyproject's [tool.pytest] and runs `pytest`,
    // found on PATH. The fake prints a summary the real parser reads, or garbage, or hangs.
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    writeFileSync(join(dir, 'src.txt'), 'v1\n');
    if (!testsPassFirst) writeFileSync(join(dir, 'broken.flag'), 'the implementation fails a test\n');
    const bin = join(dir, '.fakebin');
    mkdirSync(bin);
    const body = {
      readable: 'if [ -f broken.flag ]; then echo "1 failed, 2 passed in 0.10s"; else echo "3 passed in 0.10s"; fi',
      garbage: 'echo "some output no parser reads"',
      hang: 'sleep 5; echo "3 passed in 5.00s"',
    }[shipRun];
    writeFileSync(join(bin, 'pytest'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'pytest'), 0o755);
    writeFileSync(join(dir, '.gitignore'), '.fakebin/\n.compose/\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
      spawnSync('git', args, { cwd: dir });
    }
    process.env.PATH = `${bin}:${savedPath}`;
    if (shipRun === 'hang') process.env.COMPOSE_SHIP_TEST_TIMEOUT_MS = '1000';

    let reviewMerges = 0;
    const outputs = {
      explore_design: { phase: 'design', artifact: `docs/features/${featureCode}/design.md`, outcome: 'skipped', summary: 'x', ...(pipeline === 'build' ? { explorations: [] } : {}) },
      blueprint: { phase: 'blueprint', artifact: `docs/features/${featureCode}/design.md`, outcome: 'complete', summary: 'x' },
      verification: { phase: 'verification', artifact: 'x', outcome: 'complete', summary: 'x' },
      plan: { phase: 'plan', artifact: `docs/features/${featureCode}/design.md`, outcome: 'complete', summary: 'x' },
      decompose: { tasks: [{ id: 't1', description: 'touch a.txt (no test: fixture)', files_owned: ['a.txt'], files_read: [], depends_on: [] }] },
      execute: { outcome: 'complete', summary: 'x', files_changed: [] },
      review_triage: { tasks: [{ id: 'l1', lens_name: 'diff-quality', lens_focus: 'x', confidence_gate: 7, exclusions: [] }] },
      review: { clean: true, summary: 'clean', findings: [], meta: {}, lenses_run: [], auto_fixes: [], asks: [] },
      other: { phase: 'x', artifact: 'x', outcome: 'complete', summary: 'x' },
    };
    const dispatched = [];
    const factory = (agentType) => ({
      async *run(prompt) {
        if (/code review is not clean/.test(prompt)) {
          dispatched.push(`review_fix(${agentType})`);
          if (reviewFix === 'break') writeFileSync(join(dir, 'broken.flag'), 'a review fix broke a test\n');
          if (reviewFix === 'harmless') writeFileSync(join(dir, 'src.txt'), 'v2\n');
          yield { type: 'assistant', content: 'fixed' };
          return;
        }
        const raw = prompt.match(/step "([^"]+)"/)?.[1] ?? 'unknown';
        dispatched.push(`${raw}(${agentType})`);
        if (/^Fix step /.test(prompt)) { yield { type: 'assistant', content: 'tried' }; return; }
        if (raw.split('/').at(-1) === 'run_tests') {
          const passing = !existsSync(join(dir, 'broken.flag'));
          yield { type: 'assistant', content: JSON.stringify(passing ? { passing: true, summary: 'all pass', failures: [] } : { passing: false, summary: '1 failing', failures: ['test_a.py'] }) };
          return;
        }
        if (raw === 'review_merge') {
          reviewMerges += 1;
          const dirty = reviewFix !== 'none' && reviewMerges === 1;
          yield { type: 'assistant', content: JSON.stringify(dirty
            ? { clean: false, summary: 'one finding', findings: [{ file: 'src.txt', line: 1, lens: 'diff-quality', finding: 'fix it', severity: 'must-fix', confidence: 9 }], meta: {}, lenses_run: ['diff-quality'], auto_fixes: [], asks: [] }
            : outputs.review) };
          return;
        }
        const known = Object.keys(outputs).find((k) => raw.split('/').includes(k));
        yield { type: 'assistant', content: JSON.stringify(outputs[known] ?? outputs.other) };
      },
      interrupt() {}, get isRunning() { return false; },
    });
    let error = null;
    let result = null;
    try {
      result = await runBuildWithAgentFactory(runBuild, featureCode, {
        cwd: dir, connectorFactory: factory, description: 'x', gateOpts: { nonInteractive: true },
        ...(pipeline === 'build' ? {} : { template: pipeline }),
      });
    } catch (err) { error = err; }
    const featureJson = join(dir, 'docs', 'features', featureCode, 'feature.json');
    const status = existsSync(featureJson) ? JSON.parse(readFileSync(featureJson, 'utf8')).status ?? null : null;
    const streamPath = join(dir, '.compose', 'build-stream.jsonl');
    const stream = existsSync(streamPath) ? readFileSync(streamPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const out = { dispatched, error, result, status, warned, stream };
    if (process.env.COMPOSE_FIX2_LOG) {
      writeFileSync(`${process.env.COMPOSE_FIX2_LOG}.${featureCode}`, `${dispatched.join('\n')}\nerror: ${error?.message ?? 'none'}\nresult: ${JSON.stringify(result)}\nfeature status: ${status}\nwarnings:\n${warned.filter((w) => /WARNING|completion|retest|re-run|tests/i.test(w)).join('\n')}\n`);
    }
    return out;
  } finally {
    console.warn = realWarn;
    process.env.PATH = savedPath;
    if (savedTimeout === undefined) delete process.env.COMPOSE_SHIP_TEST_TIMEOUT_MS; else process.env.COMPOSE_SHIP_TEST_TIMEOUT_MS = savedTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
}

const testsSteps = (d) => d.filter((x) => /(^|\/)run_tests\(/.test(x));
const PAID = /(^|\/)(review_triage|review_lenses|review_merge|review|codex_review|test_review|docs|ship|review_fix)(\/|\()/;

for (const pipeline of ['build', 'build-quick']) {
  const tag = pipeline === 'build' ? 'B' : 'Q';
  test(`case 1 (${pipeline}): failing tests before any review dispatch no paid review`, OPTS, async () => {
    const { dispatched, result, error } = await runCase(`F2-C1-${tag}`, { pipeline, testsPassFirst: false });
    assert.ok(testsSteps(dispatched).length >= 1, dispatched.join(' '));
    assert.deepEqual(dispatched.filter((d) => PAID.test(d) || d.endsWith('(codex)')), [], dispatched.join(' '));
    assert.notEqual(result?.ok, true, `the build did not complete: ${JSON.stringify(result)} ${error?.message}`);
  });

  test(`case 2 (${pipeline}): a review fix that breaks a test is re-tested and the build refuses`, OPTS, async () => {
    const { dispatched, result, error, status, stream } = await runCase(`F2-C2-${tag}`, { pipeline, reviewFix: 'break' });
    const fix = dispatched.indexOf('review_fix(claude)');
    assert.ok(fix >= 0, `the review fixer ran: ${dispatched.join(' ')}`);
    const lastFix = dispatched.lastIndexOf('review_fix(claude)');
    assert.ok(dispatched.slice(lastFix + 1).some((d) => /^retest\/run_tests\(/.test(d)), `tests ran after the last review fix: ${dispatched.join(' ')}`);
    assert.ok(!stream.some((e) => e.type === 'build_step_start' && e.stepId === 'ship'), 'ship was never reached');
    assert.notEqual(result?.ok, true, `the build did not complete: ${JSON.stringify(result)} ${error?.message}`);
    assert.notEqual(status, 'COMPLETE');
  });

  test(`case 3 (${pipeline}): reviews that change nothing do not run the tests twice`, OPTS, async () => {
    const { dispatched, result, stream } = await runCase(`F2-C3-${tag}`, { pipeline, reviewFix: 'none' });
    assert.equal(result?.ok, true, `the build completed: ${JSON.stringify(result)}`);
    assert.deepEqual(testsSteps(dispatched), ['coverage/run_tests(claude)'], `one tests run: ${dispatched.join(' ')}`);
    const skip = stream.find((e) => e.type === 'build_step_skipped' && e.stepId === 'retest/run_tests');
    assert.match(skip?.reason ?? '', /^no code changed since the tests passed at coverage\/run_tests \(tree [0-9a-f]{12}\)$/, JSON.stringify(skip));
  });

  test(`case 4 (${pipeline}): a harmless review fix is re-tested and the build completes`, OPTS, async () => {
    const { dispatched, result, status } = await runCase(`F2-C4-${tag}`, { pipeline, reviewFix: 'harmless' });
    const lastFix = dispatched.lastIndexOf('review_fix(claude)');
    assert.ok(lastFix >= 0, dispatched.join(' '));
    assert.ok(dispatched.slice(lastFix + 1).some((d) => /^retest\/run_tests\(/.test(d)), `re-tested: ${dispatched.join(' ')}`);
    assert.equal(result?.ok, true, `the build completed: ${JSON.stringify(result)}`);
    // build-quick in this bare fixture has no feature.json to mark (its completion gate
    // says `feature "…" not found`, the same with or without a review fix).
    if (pipeline === 'build') assert.equal(status, 'COMPLETE');
  });
}

for (const [shipRun, cause] of [['garbage', /could not be read/], ['hang', /timed out/]]) {
  for (const guard of [false, true]) {
    test(`case 5: a review-fixed build whose ship test run ${shipRun === 'hang' ? 'times out' : 'cannot be parsed'} is not COMPLETE (guard ${guard})`, OPTS, async () => {
      const { status, warned } = await runCase(`F2-C5-${shipRun === 'hang' ? 'HANG' : 'GARBAGE'}-${guard ? 'G' : 'U'}`, { reviewFix: 'harmless', shipRun, guard });
      assert.notEqual(status, 'COMPLETE');
      const msg = warned.find((w) => /\[completion-gate\].*NOT marked COMPLETE/.test(w));
      assert.ok(msg, `a refusal message: ${warned.join(' | ')}`);
      assert.match(msg, cause);
    });
  }
}

test('case 5 control: an unguarded build with no review fix keeps the old degrade (unreadable ship run still completes)', OPTS, async () => {
  const { status } = await runCase('F2-C5-CTL', { reviewFix: 'none', shipRun: 'garbage' });
  assert.equal(status, 'COMPLETE');
});

// Case 6: a project-local copy in the order every copy had before round 1 (reviews, then
// one `coverage`, no `retest`). Built from today's bundled text so it tracks the file:
// drop the early coverage block, rename `retest` back to `coverage`. Clean review only:
// with a dirty review this order fails `no runnable steps remain` after the review_gate
// revise, on main 76e9235b too (report-fix-round-2.md, "Found on the way").
function oldOrderBuildPipeline() {
  const text = readFileSync(join(HERE, '..', 'pipelines', 'build.stratum.yaml'), 'utf8');
  const early = /\n {6}- id: coverage\n {8}run: coverage_check\n {8}with:\n(?: {10}.*\n)+/;
  assert.match(text, early);
  const out = text
    .replace(early, '\n')
    .replace('on_approve: coverage', 'on_approve: review_triage')
    .replace('        after: [coverage]\n', '')
    .replace('      - id: retest\n', '      - id: coverage\n')
    .replace('        after: [retest]\n', '        after: [coverage]\n');
  assert.ok(!out.includes('retest\n') && out.indexOf('id: coverage') > out.indexOf('id: codex_review'), 'old order built');
  return out;
}

test('case 6: a project-local copy in the old order runs as before (one tests run after the reviews, no skip) and gets the WARNING', OPTS, async () => {
  const { dispatched, result, warned, stream } = await runCase('F2-C6', { reviewFix: 'none', pipelineText: oldOrderBuildPipeline() });
  assert.equal(result?.ok, true, `the build completed: ${JSON.stringify(result)}`);
  assert.deepEqual(testsSteps(dispatched), ['coverage/run_tests(claude)'], dispatched.join(' '));
  assert.ok(dispatched.indexOf('coverage/run_tests(claude)') > dispatched.indexOf('codex_review/review(codex)'), dispatched.join(' '));
  assert.ok(!stream.some((e) => e.type === 'build_step_skipped'), 'no skip');
  assert.equal(warned.filter((w) => w.startsWith('WARNING:') && w.includes('paid review step "review_triage" before the tests step "coverage"')).length, 1, warned.join(' | '));
});
