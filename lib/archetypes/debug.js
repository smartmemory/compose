/**
 * debug archetype (COMP-STAGE-GRADING-3): failing repro -> fix.
 *
 * Interface: docs/features/COMP-MODEL-AB-DECISION/archetype-contract.json ($defs.descriptor, $defs.methodTable).
 * Scenario: the mini MCP notes server (test/fixtures/stage-grading/notes-server) with one planted bug.
 * Hidden material: test/fixtures/stage-grading/hidden/debug (fixture unit, bug patch, pristine repro, hidden suite).
 *
 * buildInput writes the notes server with the bug applied plus the failing repro. The patch, the answer key and
 * the hidden suites never enter the workspace. oracle copies the workspace to a temp dir OUTSIDE it, writes the
 * pristine repro and the hidden full suite there, and scores 1 only when both are green.
 *
 * All methods are synchronous so callers may `await` them or not.
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, lstatSync, cpSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import { applyPatch } from 'diff';

export const id = 'debug';
export const stage = 'debug';
export const runner = 'stage';
export const judged = false;
// Bump on ANY change to the oracle or to hidden/debug (archetype-contract.json rules.versionBump).
export const version = '1';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/stage-grading/', import.meta.url));
export const scenarioDir = join(FIXTURES, 'notes-server');
export const hiddenDir = join(FIXTURES, 'hidden', 'debug');
export const fixturePath = join(hiddenDir, 'fixture.json');

export const REPRO_PATH = 'test/repro.test.js';
export const REPRO_COMMAND = `node --test ${REPRO_PATH}`;
// The repro prints this and appends it to .test-log/repro.log when it runs. Its source builds the string at
// runtime, so reading the file does not produce it.
export const REPRO_MARKER = 'repro-executed-notes-search';
const TEST_LOG = join('.test-log', 'repro.log');

// Seeded from the scenario: everything but its golden tests.
const SEED_ENTRIES = ['package.json', 'README.md', 'bin', 'src'];
// Not part of the candidate's diff: sandbox state, dependencies, test logs, databases.
const IGNORED_TOP = new Set(['.git', '.compose', 'node_modules', '.test-log']);
const IGNORED_FILE = /(^\.DS_Store$|\.log$|\.db(-journal|-wal|-shm)?$|\.sqlite3?$)/;

const REPRO_TIMEOUT_MS = 60_000;
const SUITE_TIMEOUT_MS = 120_000;

function readFixture(hidden) {
  return JSON.parse(readFileSync(join(hidden, 'fixture.json'), 'utf8'));
}

/** The prompt-safe part of the fixture unit: no gold. */
export function publicScenario() {
  const { context, task, task_type } = readFixture(hiddenDir);
  return { context, task, task_type };
}

function assertNoHidden(scenario) {
  if (scenario && typeof scenario === 'object' && Object.hasOwn(scenario, 'gold')) {
    throw new Error('debug archetype: scenario carries gold; hidden material never reaches buildInput or prompt');
  }
}

function listFiles(root, rel = '') {
  const out = [];
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

/** The exact tree buildInput writes: relative path -> content. */
export function seedTree() {
  const tree = new Map();
  for (const entry of SEED_ENTRIES) {
    const abs = join(scenarioDir, entry);
    const files = lstatSync(abs).isDirectory() ? listFiles(abs).map((f) => join(entry, f)) : [entry];
    for (const f of files) tree.set(f, readFileSync(join(scenarioDir, f), 'utf8'));
  }
  const patch = readFileSync(join(hiddenDir, 'bug.patch'), 'utf8');
  const target = 'src/store.js'.split('/').join(sep);
  const buggy = applyPatch(tree.get(target), patch);
  if (buggy === false || buggy === tree.get(target)) throw new Error('debug archetype: bug.patch did not apply to src/store.js');
  tree.set(target, buggy);
  tree.set(REPRO_PATH.split('/').join(sep), readFileSync(join(hiddenDir, 'repro.test.js'), 'utf8'));
  return tree;
}

export function buildInput(workspace, scenario) {
  assertNoHidden(scenario);
  const stray = readdirSync(workspace).filter((n) => !IGNORED_TOP.has(n));
  if (stray.length) {
    // canary diffs against the seed tree, so it needs a workspace that holds nothing else.
    throw new Error(`debug archetype: workspace is not empty (${stray.join(', ')}); use a greenfield fixture`);
  }
  for (const [rel, content] of seedTree()) {
    mkdirSync(dirname(join(workspace, rel)), { recursive: true });
    writeFileSync(join(workspace, rel), content);
  }
}

export function prompt(scenario) {
  assertNoHidden(scenario);
  const base = publicScenario();
  const task = typeof scenario?.task === 'string' && scenario.task ? scenario.task : base.task;
  return [
    `You are in the working directory of a ${base.context}.`,
    '',
    `Bug report: ${task}`,
    '',
    `The failing repro is ${REPRO_PATH}; run it with \`${REPRO_COMMAND}\`.`,
    'Fix the bug in the source under src/. Do not edit or delete the repro. Keep every other behaviour of the server working.',
  ].join('\n');
}

function isInside(child, parent) {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

// TAP from `node --test --test-reporter=tap`: summary counts and the names of failed tests.
function parseTap(stdout) {
  const count = (k) => {
    const m = stdout.match(new RegExp(`^# ${k} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = count('tests');
  const passed = count('pass');
  const failed = count('fail');
  const cancelled = count('cancelled') ?? 0;
  const failedTests = [...stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1].trim());
  const passedTests = [...stdout.matchAll(/^\s*ok \d+ - (.*)$/gm)]
    .map((m) => m[1].trim())
    .filter((n) => !/ # (SKIP|TODO)\b/i.test(n));
  return { total, passed, failed, cancelled, failedTests, passedTests };
}

// Untrusted candidate code runs here: no inherited secrets, no parent test-runner context.
function cleanEnv() {
  const env = { NODE_ENV: 'test' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// Top-level test names declared in a hidden test file. Green requires each of them to report ok, so code that
// exits the process early (no tests run, exit 0) cannot pass.
function declaredTests(file) {
  return [...readFileSync(file, 'utf8').matchAll(/^test\('([^'\\]+)'/gm)].map((m) => m[1]);
}

function runTests(cwd, files, timeout, expected) {
  const res = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', ...files],
    { cwd, env: cleanEnv(), encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.error && res.error.code === 'ETIMEDOUT') {
    const { passedTests, ...tap } = parseTap(res.stdout ?? '');
    return { started: true, ok: false, timedOut: true, ...tap, missing: expected.filter((n) => !passedTests.includes(n)) };
  }
  if (res.error) return { started: false, error: `spawn failed: ${res.error.message}` };
  const { passedTests, ...tap } = parseTap(res.stdout);
  if (tap.total === null || tap.passed === null || tap.failed === null) {
    return { started: false, error: `no test summary (exit ${res.status}, signal ${res.signal})` };
  }
  const missing = expected.filter((n) => !passedTests.includes(n));
  const ok = res.status === 0 && tap.failed === 0 && tap.cancelled === 0 && missing.length === 0;
  return { started: true, ok, timedOut: false, exitCode: res.status, ...tap, missing };
}

function oracleError(message, detail = {}) {
  return { accuracy: null, detail, oracleError: message };
}

/**
 * Score 1 iff the pristine repro AND the hidden full suite are green against the candidate's code.
 * hidden defaults to this archetype's hidden dir; artifacts is unused (the workspace is the artifact).
 */
export function oracle(workspace, hidden = hiddenDir, artifacts = null) {
  void artifacts;
  hidden = hidden ?? hiddenDir;
  if (!workspace || !existsSync(workspace)) return oracleError(`workspace missing: ${workspace}`);
  if (isInside(hidden, workspace)) return oracleError('hidden material is inside the workspace');
  // The scenario needs node:sqlite (Node >= 22.5); without it every test fails at import, which is not the candidate's fault.
  if (!isBuiltin('node:sqlite')) return oracleError(`hidden suite cannot start: node:sqlite unavailable in node ${process.version}`);

  let fixture;
  let reproSrc;
  let suiteFiles;
  try {
    fixture = readFixture(hidden);
    reproSrc = join(hidden, fixture.gold.repro);
    if (!existsSync(reproSrc)) throw new Error(`repro ${fixture.gold.repro} not found`);
    suiteFiles = [];
    for (const dir of fixture.gold.suites) {
      const abs = resolve(hidden, dir);
      for (const f of readdirSync(abs).filter((n) => n.endsWith('.test.js')).sort()) suiteFiles.push(join(abs, f));
    }
    if (!suiteFiles.length) throw new Error('hidden suite has no test files');
    for (const f of [reproSrc, ...suiteFiles]) if (!declaredTests(f).length) throw new Error(`${f} declares no tests`);
  } catch (err) {
    return oracleError(`hidden suite cannot start: hidden material unreadable (${err.message})`);
  }

  const evalDir = mkdtempSync(join(tmpdir(), 'stage-grading-debug-'));
  try {
    cpSync(workspace, evalDir, {
      recursive: true,
      filter: (src) => {
        const top = relative(workspace, src).split(sep)[0];
        return !IGNORED_TOP.has(top);
      },
    });
    // Rebuilt from scratch: a candidate's test/ (possibly a symlink) never receives hidden files.
    rmSync(join(evalDir, 'test'), { recursive: true, force: true });
    mkdirSync(join(evalDir, 'test'));
    writeFileSync(join(evalDir, REPRO_PATH), readFileSync(reproSrc), { flag: 'wx' });
    const suiteRel = [];
    for (const abs of suiteFiles) {
      const rel = join('test', `hidden-${suiteRel.length}-${abs.split(sep).pop()}`);
      writeFileSync(join(evalDir, rel), readFileSync(abs), { flag: 'wx' });
      suiteRel.push(rel);
    }

    const repro = runTests(evalDir, [REPRO_PATH], REPRO_TIMEOUT_MS, declaredTests(reproSrc));
    const suite = runTests(evalDir, suiteRel, SUITE_TIMEOUT_MS, suiteFiles.flatMap(declaredTests));
    if (!repro.started) return oracleError(`repro cannot start: ${repro.error}`, { repro });
    if (!suite.started) return oracleError(`hidden suite cannot start: ${suite.error}`, { repro, suite });

    const failed = [];
    if (!repro.ok) failed.push('repro');
    if (!suite.ok) failed.push('suite');
    return { accuracy: failed.length ? 0 : 1, detail: { failed, repro, suite }, oracleError: null };
  } finally {
    rmSync(evalDir, { recursive: true, force: true });
  }
}

/** True iff the workspace differs from the seed tree: a seeded file changed or removed, or a file added. */
export function canary(workspace) {
  const seed = seedTree();
  for (const [rel, content] of seed) {
    const abs = join(workspace, rel);
    if (!existsSync(abs) || !readFileSync(abs).equals(Buffer.from(content))) return true;
  }
  const present = readdirSync(workspace)
    .filter((n) => !IGNORED_TOP.has(n))
    .flatMap((n) => (lstatSync(join(workspace, n)).isDirectory() ? listFiles(workspace, n) : [n]));
  return present.some((rel) => !seed.has(rel) && !IGNORED_FILE.test(rel.split(sep).pop()));
}

function transcriptText(transcript) {
  if (typeof transcript !== 'string' || !transcript) return '';
  // Accept the transcript itself or artifacts.transcriptPath.
  if (isAbsolute(transcript) && !transcript.includes('\n') && existsSync(transcript)) return readFileSync(transcript, 'utf8');
  return transcript;
}

/** True iff the repro was executed: its marker is in the transcript or in the workspace test log. */
export function mechanismEngaged(workspace, transcript) {
  if (transcriptText(transcript).includes(REPRO_MARKER)) return true;
  const log = join(workspace, TEST_LOG);
  return existsSync(log) && readFileSync(log, 'utf8').includes(REPRO_MARKER);
}
