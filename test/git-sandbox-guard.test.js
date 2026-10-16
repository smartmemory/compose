/**
 * COMPOSE-GOLDEN-LEAK-1 guard: git-calling tests must not be able to write to the real repo.
 * The scrub is an ALLOWLIST (fix2): every GIT_* variable is stripped except identity/dates and UI knobs.
 * Rows: (1) one per known redirector plus an unknown future name (dropped in-process, whether inherited or passed by
 * the caller; and proven in a child that runs a bare, unprotected writer against a decoy), (2) one per helper x
 * pollution (env polluted after import, or passed as the caller's opts.env), (3) one per path class, (4) the leak gate
 * itself (mismatched-cwd write fails the run, unreadable repo fails closed), (5) one per runner entry point,
 * (6) one per test file/helper that writes git identity or commits: loading it, WITHOUT the preload and with
 * GIT_DIR/GIT_CONFIG aimed at a decoy, must leave the decoy byte-identical (test/helpers/git-writer-probe.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  INHERITABLE_GIT_ENV, SCRUB_SET_GIT_ENV, assertOutsideRealRepo, commonDirOf, gitSync, initSandboxRepo, isolatedGitEnv,
  makeSandboxDir, removeWorktree,
} from './helpers/git-sandbox.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRUB = join(ROOT, 'test', 'helpers', 'git-env-scrub.js');
const PROBE = join(ROOT, 'test', 'helpers', 'git-writer-probe.js');

/** Every file under `dir` as `path sha256`, sorted: byte-identical before/after means nothing was written. */
function treeHash(dir) {
  const lines = [];
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { lines.push(`${relative(dir, p)}/`); visit(p); }
      else lines.push(`${relative(dir, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  visit(dir);
  return lines.join('\n');
}

/** A throwaway repo a leak would hit: identity `Decoy Original` and one commit, or unborn (an external ref store target). */
function makeDecoy({ unborn = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-decoy-')));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: isolatedGitEnv(), stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', '--local', 'user.name', 'Decoy Original');
  if (!unborn) git('-c', 'user.email=decoy@example.test', 'commit', '-q', '--allow-empty', '-m', 'decoy base');
  return { dir, git, snapshot: () => treeHash(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A child env that simulates a bare run: no GIT_* at all, none of the scrub's handoff vars, then `vars`. */
function bareChildEnv(vars) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  delete env.COMPOSE_TEST_GITCONFIG; delete env.XDG_CONFIG_HOME; delete env.NODE_TEST_CONTEXT;
  return { ...env, ...vars };
}

// Every redirector a review round or `man git` has named, plus one name no git has yet: the allowlist must drop them all.
// [row name, unborn decoy?, vars for decoy dir d]; `child: false` = no behavioural child row (the variable redirects nothing).
const ENV_ROWS = [
  ['GIT_DIR', false, (d) => ({ GIT_DIR: join(d, '.git') })],
  ['GIT_WORK_TREE', false, (d) => ({ GIT_WORK_TREE: d })],
  ['GIT_INDEX_FILE', false, (d) => ({ GIT_INDEX_FILE: join(d, '.git', 'index') })],
  ['GIT_COMMON_DIR', false, (d) => ({ GIT_COMMON_DIR: join(d, '.git') })],
  ['GIT_OBJECT_DIRECTORY', false, (d) => ({ GIT_OBJECT_DIRECTORY: join(d, '.git', 'objects') })],
  ['GIT_ALTERNATE_OBJECT_DIRECTORIES', false, (d) => ({ GIT_ALTERNATE_OBJECT_DIRECTORIES: join(d, '.git', 'objects') })],
  ['GIT_NAMESPACE', false, () => ({ GIT_NAMESPACE: 'decoy' })],
  ['GIT_PREFIX', false, () => ({ GIT_PREFIX: 'decoy' })],
  ['GIT_CEILING_DIRECTORIES', false, () => ({ GIT_CEILING_DIRECTORIES: '/' })],
  ['GIT_DISCOVERY_ACROSS_FILESYSTEM', false, () => ({ GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' })],
  ['GIT_CONFIG (review r1)', false, (d) => ({ GIT_CONFIG: join(d, '.git', 'config') })],
  ['GIT_CONFIG_SYSTEM', false, (d) => ({ GIT_CONFIG_SYSTEM: join(d, '.git', 'config') })],
  ['GIT_CONFIG_GLOBAL', false, (d) => ({ GIT_CONFIG_GLOBAL: join(d, '.git', 'config') })],
  ['GIT_CONFIG_PARAMETERS', false, () => ({ GIT_CONFIG_PARAMETERS: "'user.name=Leak'" })],
  ['GIT_CONFIG_COUNT/KEY_n/VALUE_n', false, () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Leak' })],
  ['GIT_REFERENCE_BACKEND files:// (review r2)', true, (d) => ({ GIT_REFERENCE_BACKEND: `files://${join(d, '.git')}` })],
  ['COMPOSE_TEST_GITCONFIG naming a foreign config (the scrub\'s own handoff var)', false, (d) => ({ COMPOSE_TEST_GITCONFIG: join(d, '.git', 'config') })],
  ['GIT_ZZZ_FUTURE (a name no git release has)', false, () => ({ GIT_ZZZ_FUTURE: '1' }), { child: false }],
];

for (const [name, unborn, mk, { child = true } = {}] of ENV_ROWS) {
  const vars = mk('/nonexistent');
  const gitVars = Object.keys(vars).filter((k) => k.startsWith('GIT_'));
  if (gitVars.length) {
    test(`env ${name}: isolatedGitEnv drops it, inherited or passed by the caller`, () => {
      const saved = Object.fromEntries(gitVars.map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      try {
        for (const env of [isolatedGitEnv(), isolatedGitEnv({ ...process.env }), isolatedGitEnv(vars)]) {
          for (const k of gitVars.filter((g) => !SCRUB_SET_GIT_ENV.includes(g))) assert.equal(env[k], undefined, k);
          assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
          assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
          assert.match(env.XDG_CONFIG_HOME ?? '', /compose-test-gitconfig-/);
        }
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    });
  }
  if (!child) continue;
  test(`env ${name}: a bare writer that only imports the scrub leaves the decoy byte-identical`, () => {
    const decoy = makeDecoy({ unborn });
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
          g('config', '--global', 'compose.probe', '1');
          g('commit', '-q', '--allow-empty', '-m', 'child'); console.log(g('log', '-1', '--format=%an')); } finally { rmSync(d, { recursive: true, force: true }); }`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: bareChildEnv(mk(decoy.dir)) });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), 'Child', 'the child commit must be authored by the identity the child itself wrote');
      assert.equal(decoy.snapshot(), before, 'the decoy repo must be byte-for-byte unchanged');
    } finally { decoy.cleanup(); }
  });
}

// One row per fixture entry point that runs git x each pollution. 'process' rows pollute process.env AFTER import;
// the 'opts' row passes the redirector as the caller's own env (`gitSync(..., { env: { ...process.env, ...redirect } })`).
const POLLUTIONS = [
  ['GIT_DIR+GIT_CONFIG', false, (d) => ({ GIT_DIR: join(d, '.git'), GIT_CONFIG: join(d, '.git', 'config') })],
  ['GIT_REFERENCE_BACKEND', true, (d) => ({ GIT_REFERENCE_BACKEND: `files://${join(d, '.git')}` })],
];
const gitSyncWrites = (env) => {
  const dir = makeSandboxDir('compose-guard-gitsync-');
  const opts = env ? { env } : {};
  try {
    gitSync(dir, ['init', '-q'], opts);
    gitSync(dir, ['config', 'user.name', 'Helper'], opts);
    gitSync(dir, ['-c', 'user.email=h@example.test', 'commit', '-q', '--allow-empty', '-m', 'helper'], opts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const HELPER_ROWS = [
  ['consumerWaveFixture', 'process', async () => {
    const { consumerWaveFixture } = await import('./helpers/consumer-wave-fixture.js');
    const after = []; try { consumerWaveFixture({ after: (fn) => after.push(fn) }); } finally { after.forEach((fn) => fn()); }
  }],
  ['initSandboxRepo', 'process', async () => { const { dir } = initSandboxRepo(); rmSync(dir, { recursive: true, force: true }); }],
  ['gitSync', 'process', async () => gitSyncWrites()],
  ['gitSync with the redirector in the caller\'s opts.env', 'opts', async (redirect) => gitSyncWrites({ ...process.env, ...redirect })],
];
for (const [helper, mode, run] of HELPER_ROWS) {
  for (const [pollution, unborn, mk] of POLLUTIONS) {
    test(`helper ${helper} under ${pollution} (${mode === 'opts' ? 'caller opts.env' : 'set after import'}) leaves the decoy byte-identical`, async () => {
      const decoy = makeDecoy({ unborn });
      const redirect = mk(decoy.dir);
      const saved = Object.fromEntries(Object.keys(redirect).map((k) => [k, process.env[k]]));
      const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
      try {
        const before = decoy.snapshot();
        if (mode === 'process') Object.assign(process.env, redirect);
        try { await run(redirect); } finally { restore(); }
        assert.equal(decoy.snapshot(), before);
      } finally { restore(); decoy.cleanup(); }
    });
  }
}

test('the test preload and the scrub left this process clean: every GIT_* here is on the allowlist', () => {
  const allowed = new Set([...INHERITABLE_GIT_ENV, ...SCRUB_SET_GIT_ENV]);
  for (const k of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) assert.ok(allowed.has(k), `${k} survived the scrub`);
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.match(process.env.GIT_CONFIG_GLOBAL ?? '', /compose-test-gitconfig-/);
  assert.match(process.env.XDG_CONFIG_HOME ?? '', /compose-test-gitconfig-/);
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

// One row per test file or helper that writes git identity, commits or adds worktrees. Behavioural, not textual:
// git-writer-probe.js loads the file's real import graph in a child WITHOUT the preload, with GIT_DIR/GIT_CONFIG aimed at
// a fresh decoy, then makes a bare git write in that process. The decoy must be byte-identical afterwards. Children run
// in a small pool (each takes ~0.5-2.5 s); each child gets its own TMPDIR, removed afterwards, so stubbed `after`
// hooks cannot leak temp dirs. Static extra: no file writes --global/--system config.
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
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
const EXEMPT = new Set([SELF, 'test/suppress-expected-drift.js', 'test/helpers/git-sandbox.js', 'test/helpers/git-env-scrub.js', 'test/helpers/git-writer-probe.js']);
const writers = [...walk(join(ROOT, 'test')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'scripts'))]
  .map((p) => relative(ROOT, p))
  .filter((rel) => !EXEMPT.has(rel) && !rel.startsWith('test/fixtures/'))
  .filter((rel) => { const src = readFileSync(join(ROOT, rel), 'utf8'); return GIT_WRITER.test(src) && /\bgit\b/.test(src); });

/** Run the probe on `abs` against a fresh decoy; resolves to { probe, stderr, status, changed }. */
function probeWriter(abs) {
  const decoy = makeDecoy();
  const childTmp = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-probe-tmp-')));
  const before = decoy.snapshot();
  const env = bareChildEnv({ GIT_DIR: join(decoy.dir, '.git'), GIT_CONFIG: join(decoy.dir, '.git', 'config'), TMPDIR: childTmp });
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [PROBE, abs], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const changed = decoy.snapshot() !== before;
      decoy.cleanup();
      rmSync(childTmp, { recursive: true, force: true });
      let probe = null;
      try { probe = JSON.parse(out.trim().split('\n').pop()); } catch { /* reported below */ }
      resolveP({ probe, stderr: err.slice(-2000), status, changed });
    });
  });
}
let pool = null;
/** Start every writer probe once, at most `width` at a time; returns rel -> Promise<result>. */
function probeAll(width = Math.max(2, Math.min(6, cpus().length - 1))) {
  if (pool) return pool;
  pool = new Map();
  const queue = [...writers];
  const resolvers = new Map(writers.map((rel) => [rel, null]));
  for (const rel of writers) pool.set(rel, new Promise((r) => resolvers.set(rel, r)));
  const next = () => {
    const rel = queue.shift();
    if (!rel) return;
    probeWriter(join(ROOT, rel)).then((res) => { resolvers.get(rel)(res); next(); });
  };
  for (let i = 0; i < width; i += 1) next();
  return pool;
}

test('the git-writer table is not empty (the walk found the known writers)', () => {
  assert.ok(writers.length >= 60, `found only ${writers.length}`);
  for (const known of ['test/ts-cutover-consumer-fanout-golden.test.js', 'test/checkpoint-anchor.test.js', 'test/helpers/consumer-wave-fixture.js']) assert.ok(writers.includes(known), known);
});

for (const rel of writers) {
  test(`git writer ${rel}: loaded without the preload under GIT_DIR/GIT_CONFIG=decoy, a git write leaves the decoy byte-identical`, async () => {
    assert.doesNotMatch(readFileSync(join(ROOT, rel), 'utf8'), /--global|--system/, 'identity must be local to a repo the file created');
    const { probe, stderr, status, changed } = await probeAll().get(rel);
    assert.equal(status, 0, `probe exited ${status}: ${stderr}`);
    assert.ok(probe?.loaded, `${rel} failed to load: ${probe?.loadError ?? stderr}`);
    assert.equal(probe.canary, 'Probe', `the probe's git write failed: ${probe.canaryError ?? ''}`);
    assert.equal(changed, false, `${rel} does not install the git env scrub when loaded: a git write in its process reached the decoy repo`);
  });
}
