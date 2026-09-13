/**
 * COMP-COST-OWNER 0d-1 / 0d-2 — the terminal result is load-bearing.
 *
 * `runBuild` reaches its terminal failure state WITHOUT throwing: it writes the failed
 * history row, prints "Build failed", and falls through its cleanup blocks. Before the
 * explicit terminal result it resolved `undefined` there, so every caller read a failed
 * build as a success — `compose build` exited 0 and `runBuildAll` counted it as built.
 *
 * These drive the REAL CLI and the REAL runBuildAll with a loader capture at the
 * `lib/build.js` boundary, so no engine, no agent and no paid dispatch is started. The
 * stub's resolved value is the ONLY thing that varies between the pass and fail cases.
 *
 * Note the shape of the earlier failed attempt this guards against: dropping the
 * `abort &&` guard in bin/compose.js was INERT on its own, because nothing ever
 * resolved `{ok:false}` to gate on. A test that only exercises the CLI branch would
 * have passed while the defect stood. Each case here runs end to end from the CLI
 * argv to the process exit code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BIN_URL = new URL('../bin/compose.js', import.meta.url);
const BUILD_ALL_URL = new URL('../lib/build-all.js', import.meta.url);

/**
 * A loader that replaces `lib/build.js` with a stub whose `runBuild` resolves
 * `resultJson` verbatim. Intercepts BOTH import sites: bin/compose.js (`../lib/build.js`)
 * and lib/build-all.js (`./build.js`).
 */
function writeLoader(dir, resultJson, capturePath) {
  const loader = join(dir, 'capture-loader.mjs');
  const stub = `
    import { appendFileSync } from 'node:fs';
    const RESULTS = ${JSON.stringify(resultJson)};
    export async function runBuild(featureCode, options) {
      appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ featureCode }) + '\\n');
      const hit = RESULTS[featureCode] ?? RESULTS['*'];
      return hit === 'undefined' ? undefined : hit;
    }
    export function deleteActiveBuild() {}
  `;
  writeFileSync(loader, `
    const STUB = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stub)});
    export async function resolve(specifier, context, nextResolve) {
      const fromBin = specifier === '../lib/build.js' && context.parentURL === ${JSON.stringify(BIN_URL.href)};
      const fromBuildAll = specifier === './build.js' && context.parentURL === ${JSON.stringify(BUILD_ALL_URL.href)};
      if (fromBin || fromBuildAll) return { url: STUB, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `);
  return loader;
}

function project(t, prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  mkdirSync(join(cwd, 'pipelines'));
  writeFileSync(join(cwd, '.compose/compose.json'), '{"version":2}');
  for (const spec of ['build', 'bug-fix', 'plan']) {
    writeFileSync(join(cwd, `pipelines/${spec}.stratum.yaml`), 'version: 1');
  }
  return cwd;
}

/** Run the real CLI with the stub wired in. Returns { status, stdout, stderr, calls }. */
function runCli(t, { cwd, argv, results }) {
  const capture = join(cwd, 'calls.jsonl');
  const loader = writeLoader(cwd, results, capture);
  const result = spawnSync(process.execPath,
    ['--experimental-loader', loader, fileURLToPath(BIN_URL), ...argv],
    { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test' } });
  const calls = existsSync(capture)
    ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  return { ...result, calls };
}

const FAILED = { ok: false, status: 'failed', featureCode: 'X', flowId: 'f1', failureReason: 'contract violated' };
const COMPLETE = { ok: true, status: 'complete', featureCode: 'X', flowId: 'f1', failureReason: null };

describe('COMP-COST-OWNER 0d-1 — a failed build exits non-zero', () => {
  function featureProject(t) {
    const cwd = project(t, 'exit-build-');
    mkdirSync(join(cwd, 'docs/features/X'), { recursive: true });
    writeFileSync(join(cwd, 'docs/features/X/feature.json'), '{"code":"X","status":"PLANNED"}');
    return cwd;
  }

  test('compose build exits 1 when the build resolves ok:false', t => {
    const cwd = featureProject(t);
    const r = runCli(t, { cwd, argv: ['build', 'X', '--skip-triage'], results: { '*': FAILED } });
    assert.equal(r.calls.length, 1, `runBuild must be reached: ${r.stdout}${r.stderr}`);
    assert.equal(r.status, 1, `a failed build must exit 1: ${r.stdout}${r.stderr}`);
  });

  test('compose build still exits 0 when the build resolves ok:true', t => {
    const cwd = featureProject(t);
    const r = runCli(t, { cwd, argv: ['build', 'X', '--skip-triage'], results: { '*': COMPLETE } });
    assert.equal(r.calls.length, 1, `runBuild must be reached: ${r.stdout}${r.stderr}`);
    assert.equal(r.status, 0, `a clean build must exit 0: ${r.stdout}${r.stderr}`);
  });

  test('compose fix exits 1 when the run resolves ok:false', t => {
    const cwd = project(t, 'exit-fix-');
    mkdirSync(join(cwd, 'docs/bugs/BUG-1'), { recursive: true });
    writeFileSync(join(cwd, 'docs/bugs/BUG-1/description.md'), '# BUG-1: it breaks\n');
    const r = runCli(t, { cwd, argv: ['fix', 'BUG-1'], results: { '*': FAILED } });
    assert.equal(r.calls.length, 1, `runBuild must be reached: ${r.stdout}${r.stderr}`);
    assert.equal(r.status, 1, `a failed fix must exit 1: ${r.stdout}${r.stderr}`);
  });

  test('compose plan exits 1 when the run resolves ok:false', t => {
    const cwd = project(t, 'exit-plan-');
    const r = runCli(t, { cwd, argv: ['plan', 'a thing worth planning'], results: { '*': FAILED } });
    assert.equal(r.calls.length, 1, `runBuild must be reached: ${r.stdout}${r.stderr}`);
    assert.equal(r.status, 1, `a failed plan must exit 1: ${r.stdout}${r.stderr}`);
  });
});

describe('COMP-COST-OWNER 0d-2 — batch builds do not count a failure as built', () => {
  /**
   * Drives the REAL runBuildAll in a child process with the same stub. runBuildAll
   * takes `roadmapPath`, so no repo ROADMAP.md is touched.
   */
  function runAll(t, results, roadmap) {
    const cwd = project(t, 'exit-all-');
    const roadmapPath = join(cwd, 'ROADMAP.md');
    writeFileSync(roadmapPath, roadmap);
    const loader = writeLoader(cwd, results, join(cwd, 'calls.jsonl'));
    const driver = join(cwd, 'driver.mjs');
    writeFileSync(driver, `
      const { runBuildAll } = await import(${JSON.stringify(new URL('../lib/build-all.js', import.meta.url).href)});
      const out = await runBuildAll({ cwd: ${JSON.stringify(cwd)}, roadmapPath: ${JSON.stringify(roadmapPath)} });
      console.log('RESULT_JSON:' + JSON.stringify(out));
    `);
    const r = spawnSync(process.execPath, ['--experimental-loader', loader, driver],
      { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test' } });
    const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT_JSON:'));
    assert.ok(line, `driver must report a result: ${r.stdout}${r.stderr}`);
    return JSON.parse(line.slice('RESULT_JSON:'.length));
  }

  const ROADMAP = [
    '# Roadmap',
    '',
    '| Feature | Description | Status | Depends On |',
    '|---|---|---|---|',
    '| A-1 | first | PLANNED | |',
    '| A-2 | second | PLANNED | |',
    '',
  ].join('\n');

  // Same-phase roadmap entries are implicitly chained by buildDag, so A-2 depends on
  // A-1. That makes this case cover BOTH halves of the defect: the failure is counted
  // as failed rather than built, and — because it now lands in `failed` — it blocks its
  // dependent. Previously A-1 was reported as built and A-2 ran on top of it.
  test('a build resolving ok:false is counted failed and blocks its dependent', t => {
    const out = runAll(t, { 'A-1': FAILED, 'A-2': COMPLETE }, ROADMAP);
    assert.deepEqual(out.failed, ['A-1'], 'the ok:false build must be counted as failed');
    assert.deepEqual(out.built, [], 'a failed build must not be counted as built');
    assert.deepEqual(out.skipped, ['A-2'], 'the dependent must be skipped, not built on a failure');
  });

  test('a build resolving ok:true is still counted as built', t => {
    const out = runAll(t, { '*': COMPLETE }, ROADMAP);
    assert.deepEqual(out.built, ['A-1', 'A-2']);
    assert.deepEqual(out.failed, []);
  });
});
