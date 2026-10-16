/**
 * COMPOSE-GOLDEN-LEAK-1 guard: git-calling tests must not be able to write to the real repo.
 * Rows: (1) one per git env variable that redirects repo or config (scrubbed in-process AND proven in a child
 * that runs a bare, unprotected writer), (2) one per helper under a polluted env, (3) one per path class,
 * (4) the leak gate itself (mismatched-cwd write fails the run, unreadable repo fails closed),
 * (5) one per runner entry point (package.json test* scripts + vitest configs carry the protection),
 * (6) one per test file/helper that writes git identity or commits: it must import the scrub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONFIG_REDIRECT_ENV, REPO_LOCATING_ENV, assertOutsideRealRepo, commonDirOf, gitSync, initSandboxRepo, isolatedGitEnv,
  makeSandboxDir, removeWorktree,
} from './helpers/git-sandbox.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRUB = join(ROOT, 'test', 'helpers', 'git-env-scrub.js');

/** A throwaway repo with a known identity and one commit: what a leak would hit. Returns a snapshot function. */
function makeDecoy() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-decoy-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Decoy Original', '-c', 'user.email=decoy@example.test', 'commit', '-q', '--allow-empty', '-m', 'decoy base');
  git('config', '--local', 'user.name', 'Decoy Original');
  const snapshot = () => JSON.stringify({ config: readFileSync(join(dir, '.git', 'config'), 'utf8'), log: git('log', '--all', '--format=%an|%s'), index: existsSync(join(dir, '.git', 'index')) });
  return { dir, git, snapshot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// One row per variable `man git` / `man git-config` document as redirecting the repo or its config.
const ENV_ROWS = [
  ...REPO_LOCATING_ENV.map((k) => [k, (d) => ({
    GIT_DIR: { GIT_DIR: join(d, '.git') }, GIT_WORK_TREE: { GIT_WORK_TREE: d }, GIT_INDEX_FILE: { GIT_INDEX_FILE: join(d, '.git', 'index') },
    GIT_COMMON_DIR: { GIT_COMMON_DIR: join(d, '.git') }, GIT_OBJECT_DIRECTORY: { GIT_OBJECT_DIRECTORY: join(d, '.git', 'objects') },
    GIT_ALTERNATE_OBJECT_DIRECTORIES: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(d, '.git', 'objects') },
  }[k] ?? { [k]: k === 'GIT_CEILING_DIRECTORIES' ? '/' : 'decoy' })]),
  ['GIT_CONFIG', (d) => ({ GIT_CONFIG: join(d, '.git', 'config') })],
  ['GIT_CONFIG_SYSTEM', (d) => ({ GIT_CONFIG_SYSTEM: join(d, '.git', 'config') })],
  ['GIT_CONFIG_PARAMETERS', () => ({ GIT_CONFIG_PARAMETERS: "'user.name=Leak'" })],
  ['GIT_CONFIG_COUNT/KEY_n/VALUE_n', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Leak' })],
];

test('the env table covers every name in the scrub lists', () => {
  const covered = new Set(ENV_ROWS.flatMap(([name, mk]) => Object.keys(mk('/x'))));
  for (const k of [...REPO_LOCATING_ENV, ...CONFIG_REDIRECT_ENV]) assert.ok(covered.has(k), `${k} has no row`);
});

for (const [name, mk] of ENV_ROWS) {
  test(`env ${name}: isolatedGitEnv drops it`, () => {
    const vars = mk('/nonexistent');
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      const env = isolatedGitEnv();
      for (const k of Object.keys(vars)) assert.equal(env[k], undefined, k);
      assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test(`env ${name}: a bare writer that only imports the scrub writes identity nowhere but its own repo`, () => {
    const decoy = makeDecoy();
    try {
      const before = decoy.snapshot();
      const script = `import ${JSON.stringify(pathToFileURL(SCRUB).href)};
        import { execFileSync } from 'node:child_process';
        import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const d = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-child-')));
        const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: 'pipe' }).trim();
        try { g('init', '-q'); g('config', 'user.name', 'Child'); g('config', 'user.email', 'c@example.test');
          g('commit', '-q', '--allow-empty', '-m', 'child'); console.log(g('log', '-1', '--format=%an')); } finally { rmSync(d, { recursive: true, force: true }); }`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, ...mk(decoy.dir) } });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), 'Child', 'the child commit must be authored by the identity the child itself wrote');
      assert.equal(decoy.snapshot(), before, 'the decoy repo must be byte-for-byte unchanged');
    } finally { decoy.cleanup(); }
  });
}

// One row per fixture entry point that runs git: with the env polluted AFTER import, it must still leave the decoy alone.
const HELPER_ROWS = [
  ['consumerWaveFixture', async () => {
    const { consumerWaveFixture } = await import('./helpers/consumer-wave-fixture.js');
    const after = []; consumerWaveFixture({ after: (fn) => after.push(fn) }); after.forEach((fn) => fn());
  }],
  ['initSandboxRepo', async () => { const { dir } = initSandboxRepo(); rmSync(dir, { recursive: true, force: true }); }],
  ['gitSync', async () => {
    const dir = makeSandboxDir('compose-guard-gitsync-');
    try { gitSync(dir, ['init', '-q']); gitSync(dir, ['config', 'user.name', 'Helper']); } finally { rmSync(dir, { recursive: true, force: true }); }
  }],
];
for (const [name, run] of HELPER_ROWS) {
  test(`helper ${name} ignores GIT_DIR and GIT_CONFIG set after it was imported`, async () => {
    const decoy = makeDecoy();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG: process.env.GIT_CONFIG };
    try {
      const before = decoy.snapshot();
      process.env.GIT_DIR = join(decoy.dir, '.git');
      process.env.GIT_CONFIG = join(decoy.dir, '.git', 'config');
      await run();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      assert.equal(decoy.snapshot(), before);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      decoy.cleanup();
    }
  });
}

test('the test preload and the scrub left this process clean', () => {
  for (const k of [...REPO_LOCATING_ENV, ...CONFIG_REDIRECT_ENV]) assert.equal(process.env[k], undefined, k);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.match(process.env.GIT_CONFIG_GLOBAL ?? '', /compose-test-gitconfig-/);
});

const PATH_ROWS = [
  ['the repo root itself', () => ROOT, true],
  ['a subdirectory of the repo', () => join(ROOT, 'test'), true],
  ['a fresh tmp dir', () => makeSandboxDir('compose-guard-row-'), false],
];
for (const [name, dir, rejected] of PATH_ROWS) {
  test(`assertOutsideRealRepo: ${name} is ${rejected ? 'rejected' : 'accepted'}`, () => {
    const d = dir();
    try {
      if (rejected) assert.throws(() => assertOutsideRealRepo(d), /real repo/);
      else assert.doesNotThrow(() => assertOutsideRealRepo(d));
    } finally { if (!rejected) rmSync(d, { recursive: true, force: true }); }
  });
}

test('a linked worktree shares its repo common dir and is rejected when that repo is "real"; removeWorktree cleans it up', () => {
  // Never touch the real repo's worktree list here: parallel test processes gate on it.
  const { dir: stand, git } = initSandboxRepo();
  const wt = join(makeSandboxDir('compose-guard-wt-'), 'linked');
  try {
    git('commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const standIn = commonDirOf(stand);
    assert.equal(commonDirOf(wt), standIn);
    assert.throws(() => assertOutsideRealRepo(wt, standIn), /real repo/);
    assert.doesNotThrow(() => assertOutsideRealRepo(wt), 'against the actual real repo it is outside');
  } finally {
    removeWorktree(stand, wt);
    rmSync(dirname(wt), { recursive: true, force: true });
    rmSync(stand, { recursive: true, force: true });
  }
  assert.doesNotMatch(execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env: isolatedGitEnv() }), /compose-guard-wt-/);
});

test('initSandboxRepo writes identity only into the repo it created; the real repo config is untouched', () => {
  const local = (cwd) => { try { return execFileSync('git', ['-C', cwd, 'config', '--local', '--get', 'user.name'], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' }).trim(); } catch { return ''; } };
  const before = local(ROOT);
  const { dir, git } = initSandboxRepo();
  try {
    assert.equal(git('config', '--local', 'user.name'), 'Compose Test');
    assert.equal(local(ROOT), before);
    assert.notEqual(local(ROOT), 'Compose Test');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The leak gate, run against a disposable stand-in "real repo" (copies of the preload + scrub inside a throwaway checkout).
function runGateStandIn(writer, { corruptConfig = false, env = () => ({}) } = {}) {
  const stand = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-gate-')));
  try {
    mkdirSync(join(stand, 'test', 'helpers'), { recursive: true });
    for (const f of ['suppress-expected-drift.js', 'helpers/git-env-scrub.js']) copyFileSync(join(ROOT, 'test', f), join(stand, 'test', f));
    const git = (...a) => execFileSync('git', ['-C', stand, ...a], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' });
    git('init', '-q');
    git('config', '--local', 'user.name', 'Stand Original');
    writeFileSync(join(stand, 'writer.test.js'), writer);
    // NODE_TEST_CONTEXT (set by the preload) would make the inner `node --test` act as a nested test child, not a runner.
    const { NODE_TEST_CONTEXT: _ctx, ...childEnv } = process.env;
    if (corruptConfig) writeFileSync(join(stand, '.git', 'config'), '[user\n\tname = broken');
    const run = spawnSync(process.execPath, ['--import', './test/suppress-expected-drift.js', '--test', 'writer.test.js'], { cwd: stand, encoding: 'utf8', env: { ...childEnv, ...env(stand) } });
    return { status: run.status, output: run.stdout + run.stderr, name: corruptConfig ? '' : git('config', '--local', 'user.name').trim() };
  } finally { rmSync(stand, { recursive: true, force: true }); }
}
const WRITER_PRELUDE = "import test from 'node:test'; import { execFileSync } from 'node:child_process'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';\n";

const OWN_REPO_WRITER = WRITER_PRELUDE + "test('x', () => { const tmp = mkdtempSync(join(tmpdir(), 'gate-tmp-')); execFileSync('git', ['init', '-q'], { cwd: tmp }); execFileSync('git', ['config', 'user.name', 'Own'], { cwd: tmp }); });";
const GATE_ROWS = [
  ['a writer that inits a tmp dir but configures identity in the real repo (mismatched cwd) fails the run',
    WRITER_PRELUDE + "test('x', () => { const tmp = mkdtempSync(join(tmpdir(), 'gate-tmp-')); execFileSync('git', ['init', '-q'], { cwd: tmp }); execFileSync('git', ['config', 'user.name', 'Review Leak'], { cwd: process.cwd() }); });", undefined, 1, 'Review Leak'],
  ['a writer that only touches its own tmp repo passes', OWN_REPO_WRITER, undefined, 0, 'Stand Original'],
  ['an inherited GIT_CONFIG naming the real repo config neither redirects the write nor blinds the gate',
    OWN_REPO_WRITER, (stand) => ({ GIT_CONFIG: join(stand, '.git', 'config') }), 0, 'Stand Original'],
];
for (const [name, writer, env, status, identity] of GATE_ROWS) {
  test(`leak gate: ${name}`, () => {
    const out = runGateStandIn(writer, { env });
    assert.equal(out.status, status, out.output);
    if (status === 1) assert.match(out.output, /GOLDEN-LEAK GATE/);
    assert.equal(out.name, identity);
  });
}

test('leak gate fails closed when the real repo cannot be read (corrupt config), instead of comparing empty strings', () => {
  const out = runGateStandIn(WRITER_PRELUDE + "test('x', () => {});", { corruptConfig: true });
  assert.equal(out.status, 1, out.output);
  assert.match(out.output, /GOLDEN-LEAK GATE/);
  assert.match(out.output, /PROBE-ERROR/);
});

// One row per runner entry point: every package.json script that runs tests, and the vitest config it uses.
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PROTECTED = /suppress-expected-drift|git-env-scrub/;
const RUNNER_ROWS = [];
for (const [script, cmd] of Object.entries(PKG.scripts).filter(([k]) => k === 'test' || k.startsWith('test:'))) {
  for (const seg of cmd.split('&&').map((x) => x.trim())) {
    if (/^npm run /.test(seg)) continue; // delegated: that script has its own row
    if (/\bnode\b.*--test\b/.test(seg)) RUNNER_ROWS.push([`${script}: ${seg.slice(0, 60)}`, () => assert.match(seg, /--import \.\/test\/suppress-expected-drift\.js/)]);
    else if (/\bvitest\b/.test(seg)) {
      const cfg = /--config\s+(\S+)/.exec(seg)?.[1] ?? 'vitest.config.js';
      RUNNER_ROWS.push([`${script}: vitest (${cfg})`, () => {
        const text = readFileSync(join(ROOT, cfg), 'utf8');
        const setup = /setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
        assert.match(setup, PROTECTED, `${cfg} setupFiles must load the preload or the scrub`);
      }]);
    }
  }
}
test('runner table found the known runners', () => {
  const names = RUNNER_ROWS.map(([n]) => n).join('\n');
  for (const s of ['test:', 'test:ui: vitest', 'test:tracker: vitest', 'test:integration', 'test:wave-6']) assert.ok(names.includes(s), `no row for ${s}`);
});
for (const [name, check] of RUNNER_ROWS) test(`runner ${name} carries the git protection`, check);

// One row per test file or helper that writes git identity, commits or adds worktrees. Static rows prove the file
// loads the scrub (so no inherited GIT_* can redirect it) and never writes global/system config. That a write lands
// in the right repo is proven behaviourally above (env rows, helper rows, the leak gate), not by token order.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const GIT_WRITER = /user\.(name|email)|'commit'|'worktree'/;
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
const EXEMPT = new Set([SELF, 'test/suppress-expected-drift.js', 'test/helpers/git-sandbox.js', 'test/helpers/git-env-scrub.js']);
const writers = [...walk(join(ROOT, 'test')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'scripts'))]
  .map((p) => relative(ROOT, p))
  .filter((rel) => !EXEMPT.has(rel) && !rel.startsWith('test/fixtures/'))
  .filter((rel) => { const src = readFileSync(join(ROOT, rel), 'utf8'); return GIT_WRITER.test(src) && /\bgit\b/.test(src); });

test('the git-writer table is not empty (the walk found the known writers)', () => {
  assert.ok(writers.length >= 60, `found only ${writers.length}`);
  for (const known of ['test/ts-cutover-consumer-fanout-golden.test.js', 'test/checkpoint-anchor.test.js', 'test/helpers/consumer-wave-fixture.js']) assert.ok(writers.includes(known), known);
});

for (const rel of writers) {
  test(`git writer ${rel}: loads the scrub, never writes --global/--system`, () => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /--global|--system/, 'identity must be local to a repo the file created');
    assert.match(src, /git-env-scrub|git-sandbox|runGit|test\/helpers\//, `${rel} does not import the scrub or a helper that does`);
  });
}
