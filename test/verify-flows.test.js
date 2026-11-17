/**
 * test/verify-flows.test.js — COMP-VERIFY-FLOW-1.
 *
 * Real child processes, no mock of spawn: each row is a flow command that a
 * project could declare, run through the real runner, judged by the real rule.
 * One row per pass/refuse rule of plan Decision 4, plus the config and
 * selection rules and the gate's two contracts (a failed flow refuses even with
 * tests_pass=true; no verify block takes exactly today's path).
 */
import './helpers/git-env-scrub.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deadPortSync } from './helpers/dead-port.js';

// The gate's default vision projector must never find a real cockpit; the evidence store is a temp file.
process.env.COMPOSE_PORT = deadPortSync();
const SCRATCH = mkdtempSync(path.join(process.env.SM_SCRATCH_ROOT || tmpdir(), 'verify-flows-'));
process.env.COMPOSE_EVIDENCE_STORE = path.join(SCRATCH, 'evidence.jsonl');

const { runFlows, validateVerifyBlock, selectFlows, verifyForCompletion, VERIFY_CODES, matchGlob: matchGlobForTest } = await import('../lib/verify-flows.js');
const { completionGate } = await import('../lib/completion-gate.js');
const { readEvidence, verifyEvidence } = await import('../lib/evidence.js');

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const node = (src) => [process.execPath, '-e', src];
const flow = (over) => ({ id: 'f', covers: ['src/**'], expect: ['EDGES build 18', 'KEY after'], timeout_s: 20, setup_exit_codes: [127], ...over });

/** Is anything listening on 127.0.0.1:port? */
const listening = (port) => new Promise((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// A grandchild server in the flow's group: prints its port, then the flow either hangs or exits leaving it behind.
const SERVER_THEN = (tail) => `
  const { spawn } = require('node:child_process');
  const c = spawn(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log('PORT '+s.address().port))"], { stdio: ['ignore', 'inherit', 'inherit'] });
  setTimeout(() => { ${tail} }, 400);`;

// ---------------------------------------------------------------------------
// Decision 4: the pass/refuse rule, one row each, real processes.
// ---------------------------------------------------------------------------
const ROWS = [
  { name: 'exit 0 with every expected line passes',
    f: flow({ command: node("console.log('EDGES build 18');console.log('KEY after')") }),
    verdict: 'PASS', code: null, detail: /2 of 2 expected lines/ },
  { name: 'exit 0 without an expected line fails, naming it and the nearest line (Case 8a)',
    f: flow({ command: node("console.log('EDGES build 0');console.log('KEY after')") }),
    verdict: 'FAIL', code: 'FLOW_FAILED', detail: /missing expected line "EDGES build 18" \(output had "EDGES build 0"\), exit 0/ },
  { name: 'exit 1 with every expected line present fails (Case 8b)',
    f: flow({ command: node("console.log('EDGES build 18');console.log('KEY after');process.exit(1)") }),
    verdict: 'FAIL', code: 'FLOW_FAILED', detail: /exit 1 with all 2 expected lines present: a failing exit is never a pass/ },
  { name: 'an expected line is a whole line, not a substring',
    f: flow({ command: node("console.log('EDGES build 180');console.log('KEY after')") }),
    verdict: 'FAIL', code: 'FLOW_FAILED', detail: /missing expected line "EDGES build 18"/ },
  { name: 'surrounding whitespace on an output line is ignored',
    f: flow({ command: node("console.log('   EDGES build 18  ');console.log('\\tKEY after')") }),
    verdict: 'PASS', code: null },
  { name: 'exit 127 is a setup error carrying the first stderr line (Case 6)',
    f: flow({ command: node("console.error('');console.error('playwright: command not found');process.exit(127)") }),
    verdict: 'FAIL', code: 'FLOW_SETUP_ERROR', detail: /could not start \(exit 127\): playwright: command not found/ },
  { name: 'a declared setup exit code is a setup error',
    f: flow({ command: node("console.error('port 4999 taken');process.exit(3)"), setup_exit_codes: [3] }),
    verdict: 'FAIL', code: 'FLOW_SETUP_ERROR', detail: /exit 3\): port 4999 taken/ },
  { name: 'a command that does not exist is a setup error (spawn ENOENT)',
    f: flow({ command: ['node_modules/.bin/definitely-not-installed', 'test'] }),
    verdict: 'FAIL', code: 'FLOW_SETUP_ERROR', detail: /could not start: spawn node_modules\/\.bin\/definitely-not-installed ENOENT/ },
  { name: 'a flow killed by a signal fails',
    f: flow({ command: node("console.log('EDGES build 18');console.log('KEY after');process.kill(process.pid,'SIGKILL')") }),
    verdict: 'FAIL', code: 'FLOW_FAILED', detail: /killed by SIGKILL/ },
];

for (const row of ROWS) {
  test(`judge: ${row.name}`, async () => {
    const ws = mkdtempSync(path.join(SCRATCH, 'ws-'));
    const [r] = await runFlows([row.f], { workspaceRoot: ws, featureCode: 'ROW-1', graceMs: 500 });
    assert.equal(r.verdict, row.verdict, r.detail);
    assert.equal(r.code, row.code, r.detail);
    if (row.detail) assert.match(r.detail, row.detail);
    assert.ok(existsSync(r.log), 'every run writes its log');
    if (row.verdict === 'PASS') {
      // The receipt re-verifies against the log it names.
      const rec = readEvidence(r.evidence_id);
      assert.ok(rec, `${r.evidence_id} is in the store`);
      assert.equal(rec.evidence.kind, 'command');
      assert.equal(rec.evidence.log, r.log);
      assert.equal(verifyEvidence(rec.evidence).ok, true);
      assert.equal(rec.subject.feature, 'ROW-1');
    } else {
      assert.equal(r.evidence_id, null, 'a failed run mints no receipt');
    }
    const runs = readFileSync(path.join(ws, '.compose', 'data', 'verify', 'ROW-1', 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(runs.length, 1);
  });
}

test('judge: a hung flow is FLOW_TIMEOUT and its whole process group is killed, port freed (Case 7)', async () => {
  const ws = mkdtempSync(path.join(SCRATCH, 'ws-'));
  const f = flow({ id: 'hang', timeout_s: 2, command: node(SERVER_THEN('setInterval(() => {}, 1000)')) });
  const [r] = await runFlows([f], { workspaceRoot: ws, graceMs: 500 });
  assert.equal(r.code, VERIFY_CODES.TIMEOUT);
  const port = Number(/PORT (\d+)/.exec(readFileSync(r.log, 'utf8'))[1]);
  assert.equal(await listening(port), false, `the server the flow started still holds :${port}`);
});

test('judge: a flow that exits and leaves a server behind has it killed, with a WARNING in its log', async () => {
  const ws = mkdtempSync(path.join(SCRATCH, 'ws-'));
  const f = flow({ id: 'leaky', command: node(SERVER_THEN("console.log('EDGES build 18');console.log('KEY after');process.exit(0)")) });
  const [r] = await runFlows([f], { workspaceRoot: ws, graceMs: 500 });
  assert.equal(r.verdict, 'PASS', r.detail);
  assert.equal(r.leftovers, true);
  const log = readFileSync(r.log, 'utf8');
  assert.match(log, /WARNING: the flow exited and left processes in its group/);
  assert.equal(await listening(Number(/PORT (\d+)/.exec(log)[1])), false);
});

// ---------------------------------------------------------------------------
// Config and selection.
// ---------------------------------------------------------------------------
const good = { flows: [{ id: 'a', command: ['x'], covers: ['src/**'], expect: ['OK'] }] };
const CONFIG_ROWS = [
  { name: 'the dogfood shape is valid', block: good, errors: [] },
  { name: 'an unknown field is refused by name',
    block: { flows: [{ ...good.flows[0], retries: 2 }] }, errors: [/verify\.flows\[0\] has unknown field "retries"/] },
  { name: 'a string command is refused by name',
    block: { flows: [{ ...good.flows[0], command: 'npm test' }] }, errors: [/verify\.flows\[0\]\.command must be array/] },
  { name: 'a duplicate id is refused',
    block: { flows: [good.flows[0], good.flows[0]] }, errors: [/verify\.flows\[1\]\.id "a" is declared twice/] },
];
for (const row of CONFIG_ROWS) {
  test(`config: ${row.name}`, () => {
    const { ok, errors } = validateVerifyBlock(row.block);
    assert.equal(ok, row.errors.length === 0, errors.join('; '));
    for (const re of row.errors) assert.ok(errors.some((e) => re.test(e)), `${re} in ${JSON.stringify(errors)}`);
  });
}

const DECLARED = [
  { id: 'pipeline-roundtrip', covers: ['src/lib/pipeline-model.js', 'src/components/vision/**', 'pipelines/*.stratum.yaml'] },
  { id: 'builder-save-blur', covers: ['src/components/cockpit/StratumBuilderPane.jsx'] },
];
const SELECT_ROWS = [
  { name: 'no list runs all and says so (Case 5)', files: [], ids: ['pipeline-roundtrip', 'builder-save-blur'],
    line: 'verify: no changed-file list, running all 2 declared flows' },
  { name: 'uncovered files run nothing and say so (Case 4)', files: ['docs/cli.md', 'lib/version-check.js'], ids: [],
    line: 'verify: no declared flow covers the 2 changed files' },
  { name: '** reaches any depth, * stays in one segment', files: ['src/components/vision/a/b/Editor.jsx', 'pipelines/x/build.stratum.yaml'],
    ids: ['pipeline-roundtrip'] },
];
for (const row of SELECT_ROWS) {
  test(`select: ${row.name}`, () => {
    const s = selectFlows(DECLARED, row.files);
    assert.deepEqual(s.flows.map((f) => f.id), row.ids);
    if (row.line) assert.equal(s.line, row.line);
  });
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------
function workspace(verify) {
  const root = mkdtempSync(path.join(SCRATCH, 'gate-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't');
  writeFileSync(path.join(root, 'README.md'), '# t\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  mkdirSync(path.join(root, '.compose'), { recursive: true });
  writeFileSync(path.join(root, '.compose', 'compose.json'), JSON.stringify({
    paths: { features: 'docs/features' }, capabilities: { guard: false }, ...(verify ? { verify } : {}),
  }));
  const fdir = path.join(root, 'docs', 'features', 'FEAT-1');
  mkdirSync(fdir, { recursive: true });
  writeFileSync(path.join(fdir, 'feature.json'), JSON.stringify({ code: 'FEAT-1', description: 'd', phase: 'P', status: 'IN_PROGRESS' }));
  const feature = () => JSON.parse(readFileSync(path.join(fdir, 'feature.json'), 'utf8'));
  return { root, sha: git('rev-parse', 'HEAD').trim(), feature };
}

const verifyBlock = (src) => ({ flows: [{ id: 'roundtrip', command: node(src), covers: ['src/**'], expect: ['EDGES build 18'], timeout_s: 20 }] });

test('gate: a failed flow refuses with FLOW_FAILED even with tests_pass=true, and writes nothing (Case 1 broken)', async () => {
  const ws = workspace(verifyBlock("console.log('EDGES build 0')"));
  const lines = [];
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true, force: true,
    filesChanged: ['src/lib/model.js'], workspaceRoot: ws.root, verifyLog: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.equal(r.refusedAt, 'verify');
  assert.equal(r.code, 'FLOW_FAILED');
  assert.match(r.reasons[0], /^FLOW_FAILED roundtrip: missing expected line "EDGES build 18" \(output had "EDGES build 0"\).*; log \//);
  assert.equal(ws.feature().status, 'IN_PROGRESS');
  assert.equal(ws.feature().completions, undefined);
  assert.ok(lines.some((l) => l.startsWith('verify: 1 of 1 declared flow cover the 1 changed file')), lines.join('\n'));
});

test('gate: a passing flow completes and the record keeps its evidence id (Case 1 fixed)', async () => {
  const ws = workspace(verifyBlock("console.log('EDGES build 18')"));
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true,
    filesChanged: ['src/lib/model.js'], workspaceRoot: ws.root });
  assert.equal(r.ok, true, r.reasons?.join('; '));
  const f = ws.feature();
  assert.equal(f.status, 'COMPLETE');
  const [vf] = f.completions[0].verify_flows;
  assert.equal(vf.verdict, 'PASS');
  assert.match(vf.evidence_id, /^ev:[0-9a-f]{16}$/);
  assert.equal(vf.commit_sha, ws.sha);
  assert.equal(readEvidence(vf.evidence_id).evidence.log, vf.log);
});

test('gate: a project with no verify block runs no flow and records exactly what it did before (Case 3)', async () => {
  const ws = workspace(null);
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    verifyLog: () => assert.fail('no verify line may print without a verify block') });
  assert.equal(r.ok, true, r.reasons?.join('; '));
  assert.equal('verify' in r, false);
  assert.equal('verify_flows' in ws.feature().completions[0], false);
  assert.equal(existsSync(path.join(ws.root, '.compose', 'data', 'verify')), false);
  assert.equal(await verifyForCompletion({ workspaceRoot: ws.root, featureCode: 'FEAT-1' }), null);
});

test('gate: an invalid verify block refuses at load with the field named (never read as "no flows")', async () => {
  const ws = workspace({ flows: [{ id: 'x', command: 'npm test', covers: ['a'], expect: ['b'] }] });
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VERIFY_CONFIG_INVALID');
  assert.match(r.reasons[0], /verify\.flows\[0\]\.command must be array/);
});

// Merge of COMP-SETUP-PREFLIGHT-1: the verify block's two keys are independent.
test('gate: a verify block holding only preflight runs no flow and records exactly what it did before', async () => {
  const ws = workspace({ preflight: { exclusive_runs: true } });
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root,
    verifyLog: () => assert.fail('no verify line may print without verify.flows') });
  assert.equal(r.ok, true, r.reasons?.join('; '));
  assert.equal('verify' in r, false);
  assert.equal('verify_flows' in ws.feature().completions[0], false);
  assert.equal(existsSync(path.join(ws.root, '.compose', 'data', 'verify')), false);
});

test('gate: a misspelled flows key next to preflight is refused, never read as "no flows"', async () => {
  const ws = workspace({ preflight: {}, flow: [{ id: 'x', command: ['x'], covers: ['a'], expect: ['b'] }] });
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true, workspaceRoot: ws.root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VERIFY_CONFIG_INVALID');
  assert.match(r.reasons[0], /unknown field "flow"/);
});

// COMP-SETUP-PREFLIGHT-1 fix round 1, P-2: an unparseable compose.json is a refusal that
// names the file, at the flow reader and at the completion gate, never "no flows".
test('P-2: an unparseable compose.json refuses (flow reader and completion gate), naming the file', async () => {
  const { loadVerifyConfig, VerifyConfigError } = await import('../lib/verify-flows.js');
  const { guardEnabled } = await import('../lib/completion-gate.js');
  const dir = mkdtempSync(path.join(SCRATCH, 'badjson-'));
  mkdirSync(path.join(dir, '.compose'));
  const file = path.join(dir, '.compose', 'compose.json');
  writeFileSync(file, '{"verify":{"flows":[{"id":"a","command":["x"],"covers":["src/**"],"expect":["OK"]}]},}');
  assert.throws(() => loadVerifyConfig(dir), (e) => e instanceof VerifyConfigError && e.message.includes(`${file} is not valid JSON`));
  assert.throws(() => guardEnabled(dir), /is not valid JSON/);
  const r = await completionGate({ featureCode: 'FEAT-BAD', commitSha: 'a'.repeat(40), testsPass: true, filesChanged: ['src/a.js'], workspaceRoot: dir });
  assert.equal(r.ok, false);
  assert.equal(r.refusedAt, 'config');
  assert.match(r.reasons[0], /compose\.json is not valid JSON/);
  rmSync(file);
  assert.equal(loadVerifyConfig(dir), null, 'an absent file is still "no flows"');
  assert.equal(guardEnabled(dir), false);
});

// ---------------------------------------------------------------------------
// COMP-SETUP-PREFLIGHT-1 fix round 1, F-1: `covers` written the habitual ways matches.
// ---------------------------------------------------------------------------
test('F-1: covers patterns are normalised at load (./, leading /, a folder) and match', async () => {
  const { normalizeCovers } = await import('../lib/verify-flows.js');
  const n = (g) => normalizeCovers([g], 'verify.flows[0].covers');
  assert.deepEqual(n('./src/**'), ['src/**']);
  assert.deepEqual(n('/src/**'), ['src/**']);
  assert.deepEqual(n('src/'), ['src/**']);
  assert.deepEqual(n('src'), ['src', 'src/**']);
  assert.deepEqual(n('src/components/vision'), ['src/components/vision', 'src/components/vision/**']);
  assert.deepEqual(n('src/**/*.js'), ['src/**/*.js'], 'a real glob is left alone');
  for (const g of ['./src/**', '/src/**', 'src/', 'src', 'src/**']) {
    const covers = n(g);
    assert.ok(covers.some((c) => matchGlobForTest(c, 'src/a.js')), `${g} covers src/a.js`);
  }
});

test('F-1: a covers pattern that can never match a repo path is refused at load, the pattern named', async () => {
  const { loadVerifyConfig, VerifyConfigError } = await import('../lib/verify-flows.js');
  for (const [bad, why] of [['../web/**', /outside the repository/], ['src\\a.js', /backslash/], ['./', /names nothing/], ['/', /names nothing/]]) {
    const dir = mkdtempSync(path.join(SCRATCH, 'covers-'));
    mkdirSync(path.join(dir, '.compose'));
    writeFileSync(path.join(dir, '.compose', 'compose.json'), JSON.stringify({ verify: { flows: [{ id: 'a', command: ['x'], covers: ['src/**', bad], expect: ['OK'] }] } }));
    assert.throws(() => loadVerifyConfig(dir), (e) => e instanceof VerifyConfigError && e.message.includes(`verify.flows[0].covers[1] ${JSON.stringify(bad)}`) && why.test(e.message), bad);
  }
});

test('F-1: a completion with covers "./src/**" runs the flow (it used to be silently skipped)', async () => {
  const ws = workspace({ flows: [{ id: 'roundtrip', command: node("console.log('EDGES build 0')"), covers: ['./src/**'], expect: ['EDGES build 18'], timeout_s: 20 }] });
  const lines = [];
  const r = await completionGate({ featureCode: 'FEAT-1', commitSha: ws.sha, testsPass: true,
    filesChanged: ['src/lib/model.js'], workspaceRoot: ws.root, verifyLog: (l) => lines.push(l) });
  assert.equal(r.ok, false, lines.join('\n'));
  assert.equal(r.code, 'FLOW_FAILED');
  assert.ok(lines.some((l) => l.startsWith('verify: 1 of 1 declared flow cover the 1 changed file')), lines.join('\n'));
});

test('F-1: a flow whose covers match no file in the repository prints one WARNING naming it', async () => {
  const ws = workspace({ flows: [
    { id: 'ghost', command: node("console.log('OK')"), covers: ['srcs/**'], expect: ['OK'], timeout_s: 20 },
    { id: 'readme', command: node("console.log('OK')"), covers: ['README.md'], expect: ['OK'], timeout_s: 20 },
  ] });
  const lines = [];
  const r = await verifyForCompletion({ workspaceRoot: ws.root, featureCode: 'FEAT-1', filesChanged: ['docs/x.md'], onLine: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  const warnings = lines.filter((l) => l.startsWith('WARNING:'));
  assert.equal(warnings.length, 1, lines.join('\n'));
  assert.match(warnings[0], /flow "ghost" covers no file in the repository \(covers: "srcs\/\*\*"\)/);
});

// COMP-SETUP-PREFLIGHT-1 fix round 1, F-2: a missing Playwright browser is "the flow cannot
// start" (FLOW_SETUP_ERROR), never FLOW_FAILED. Drives Compose's own builder-save-blur flow
// as declared in .compose/compose.json, with the browser cache pointed at an empty folder.
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const HAS_PLAYWRIGHT = existsSync(path.join(REPO, 'node_modules', '.bin', 'playwright'));
test('F-2: a missing Playwright browser is FLOW_SETUP_ERROR naming the install step, not FLOW_FAILED',
  { skip: !HAS_PLAYWRIGHT && 'node_modules/.bin/playwright absent (F-3: @playwright/test not installed here)', timeout: 180_000 }, async () => {
    const cfg = JSON.parse(readFileSync(path.join(REPO, '.compose', 'compose.json'), 'utf8'));
    const flowDecl = cfg.verify.flows.find((f) => f.id === 'builder-save-blur');
    const empty = mkdtempSync(path.join(SCRATCH, 'no-browsers-'));
    const [r] = await runFlows([{ ...flowDecl, timeout_s: 120 }], {
      workspaceRoot: REPO, featureCode: 'FEAT-F2', commitSha: null, onLine: () => {},
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty },
    });
    assert.equal(r.code, VERIFY_CODES.SETUP, JSON.stringify(r));
    assert.match(r.detail, /exit 3\): SETUP: the Playwright browser .* cannot start/);
    assert.match(r.detail, /npx playwright install/);
  });
