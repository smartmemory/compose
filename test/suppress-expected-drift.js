import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_COMMIT_SENTINEL = 'compose-test-sentinel@invalid';

// Always replace inherited state roots (even a shell pointing at the real store).
// Each Node test worker owns its directory; only that process removes it.
const testStateRoot = mkdtempSync(join(tmpdir(), 'compose-test-flows-'));
process.env.STRATUM_STATE_ROOT = testStateRoot;
process.once('exit', () => rmSync(testStateRoot, { recursive: true, force: true }));

// Shared test preload: silence the ONE expected stderr line that many tests trip
// on purpose. Loaded by both suites — the node --test runner (via `--import` in
// the package.json `test` script) and the vitest tracker config (via setupFiles).
//
// Numerous tests create a phase whose heading override (e.g. PLANNED) is then made
// to diverge from the row rollup (IN_PROGRESS) to exercise the writer's override
// PRESERVATION. That makes lib/roadmap-drift.js `emitDrift` write its expected
//   WARN: phase "P1" override "PLANNED" diverges from rollup "IN_PROGRESS". ...
// to stderr (~100x across the suite). Drift DETECTION is covered directly by
// test/roadmap-drift.test.js and test/drift-emit.test.js, which replace
// process.stderr.write themselves to capture-and-assert — so this base-layer
// filter never hides their signal. Drop only that exact line; forward everything
// else untouched so real errors still surface.

// COMP-TEST-PORT-ISOLATION: pin the whole test run to a guaranteed-dead port so
// "server is DOWN" probes deterministically get ECONNREFUSED regardless of whether
// the dev server is holding :4001.  VisionWriter._serverAvailable() → false →
// falls back to direct file writes into the test's temp dir.  Tests that need a
// LIVE server (compose-mcp-tools-http.test.js) override COMPOSE_PORT themselves
// to their own listen(0) ephemeral port, so they are unaffected.  The same dead
// port (19997) is already used by the COMP-MODEL-AB sandbox harness, making it
// the de-facto convention for "no compose server here".
if (!process.env.COMPOSE_PORT) process.env.COMPOSE_PORT = '19997';

// COMP-GUARD-ONE-TAP follow-up (2026-09-06): stratum's guard registry lives in
// ~/.stratum/guards and, until stratum 2d26986+, could not be redirected. Tests
// that register guards against the live repo root therefore wrote fixture
// resources (BUG-1, FEAT-A, ...) into the OWNER'S real store — 32 of them were
// found by `stratum guard list` and ended up in a signed descriptor generation.
// Point the whole run at a throwaway store; an older installed stratum ignores
// the variable (and test/lifecycle-backfill.test.js keeps its isolated copy).
if (!process.env.STRATUM_GUARDS_DIR) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const guardsDir = mkdtempSync(join(tmpdir(), 'compose-test-guards-'));
  process.env.STRATUM_GUARDS_DIR = guardsDir;
  // Only the process that created it removes it (children inherit the variable and skip this branch).
  process.once('exit', () => rmSync(guardsDir, { recursive: true, force: true }));
}

// COMP-TRIAGE-6-2: mark the whole test run as a hermetic test context. Modules
// that would otherwise fall back to a shared, process-global path when no
// explicit project root is threaded (the dispatch-ledger connectors →
// process.cwd() = the live repo; codex-preflight/bug-escalation worktree bases →
// ~/.stratum/worktrees) redirect to a tmpdir under this flag. Without it, every
// full-suite run writes ~hundreds of fixture dispatch rows into the live
// .compose/data/dispatch-ledger.jsonl. Production paths never set this var.
if (!process.env.NODE_TEST_CONTEXT) process.env.NODE_TEST_CONTEXT = '1';

// COMP-DEPS-AUTOINSTALL (2026-09-06): `compose setup` / `init` / `update` now
// INSTALL the plugins behind missing required deps. Dozens of tests spawn those
// commands as subprocesses, so without this the suite would either install
// plugins into the developer's real ~/.claude (whenever superpowers happens to
// be absent, e.g. CI or a fresh box) or git-clone a marketplace per test into a
// redirected HOME. Same failure shape as the STRATUM_GUARDS_DIR leak above: a
// test run must never mutate global state it did not create. Tests that exercise
// auto-install inject their own spawn and are unaffected by this flag.
// Production paths never set this var.
if (!process.env.COMPOSE_NO_PLUGIN_INSTALL) process.env.COMPOSE_NO_PLUGIN_INSTALL = '1';

// COMPOSE-GOLDEN-LEAK-1 (2026-10-17): tests that run `git config` / `git commit` must never reach the
// real repo. Importing git-env-scrub strips EVERY GIT_* variable except an explicit allowlist (identity/dates and UI
// knobs; see that file), so any variable that redirects git's repo, refs or config is gone, including ones a future git
// adds, and swaps the developer's global config for a throwaway fallback identity. The same module is imported by the git-calling helpers and test files, so a bare
// `node --test file` is protected too. Here we also gate the run: snapshot the real repo's local identity and
// worktree list now, fail the process at exit if the identity changed, a worktree appeared/vanished/switched, or a
// worktree's HEAD gained a commit not made by the repo's own identity. A probe that errors fails the gate (never "empty").
{
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  await import('./helpers/git-env-scrub.js');
  // COMPOSE-LEAK-GATE-IDENTITY-1: mark every commit THIS process tree makes. Git takes the identity from env before `-c` and repo
  // config, so a test whose cwd is wrong and that runs a bare `git commit` carries the sentinel instead of the repo identity.
  // Other sessions are separate processes and never inherit it. Email only: nothing reads %ae/%ce, and names stay as tests set them.
  process.env.GIT_AUTHOR_EMAIL = TEST_COMMIT_SENTINEL;
  process.env.GIT_COMMITTER_EMAIL = TEST_COMMIT_SENTINEL;
  const realRepo = dirname(dirname(fileURLToPath(import.meta.url)));
  const run = (...a) => {
    try { return execFileSync('git', ['-C', realRepo, ...a], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) {
      if (err.status === 1 && a[0] === 'config') return ''; // `git config --get-all` exits 1 when the key is absent
      return `PROBE-ERROR(${a.join(' ')}): ${err.status ?? ''} ${String(err.stderr ?? err.message).trim()}`;
    }
  };
  // COMP-GOLDEN-LEAK-RACE-1: other test processes running concurrently (codex-preflight probes, via build-flow-tag,
  // codex-impl, routing-calls, git-sandbox-guard) add and remove detached worktrees under `<tmpdir>/compose-test-worktrees/`
  // on this same repo. A per-process snapshot blamed whichever file was alive (archetype-debug in 2 of 2 full gates), so
  // blocks of `git worktree list --porcelain` under that directory are excluded.
  // COMPOSE-ORIGIN-RED-1: other SESSIONS work in this repo while a ~25 min suite runs. They add/remove operator
  // worktrees (`<repo>/.worktrees/<name>`, `SmartMemory/scratch/...`) and commit onto checked-out branches, and every
  // test file alive at that moment failed (34 of 34 file-level failures in the 2026-10-30 11:03 pre-push run,
  // `.worktrees/gate-0f3a` added; main moved 75887ddd -> 3cc816d4 in that day's A/B run). So only worktrees where test or
  // compose code can create one are gated: the checkout under test and its subtree (minus `.worktrees/`), `tmpdir()`
  // (fixtures; `lib/consumer-fanout.js` defaultArtifactRoot; stratum engine fanout) and `~/.stratum/` (the non-test
  // base in `lib/codex-preflight.js`, `lib/bug-escalation.js`). A moved HEAD on a gated worktree is a leak only when a
  // new commit carries an identity other than the repo's local user.email: the COMPOSE-GOLDEN-LEAK-1 incident's 354
  // commits carried the fixture identity it had written.
  const { homedir } = await import('node:os');
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const roots = (p) => [...new Set([p, real(p)])];
  const repoRoots = roots(realRepo);
  const gatedRoots = [...roots(tmpdir()), ...roots(join(homedir(), '.stratum'))].map((r) => `${r}/`);
  const isGated = (path) => repoRoots.includes(path) || gatedRoots.some((r) => path.startsWith(r))
    || repoRoots.some((r) => path.startsWith(`${r}/`) && !path.startsWith(`${r}/.worktrees/`));
  const parseWorktrees = (out) => out.split('\n\n').filter((blk) => blk.trim()).map((blk) => {
    const lines = blk.split('\n').filter(Boolean);
    return { path: lines[0].replace(/^worktree /, ''), head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '', rest: lines.filter((l) => !l.startsWith('HEAD ')).join('\n') };
  }).filter((w) => !/\/compose-test-worktrees\//.test(w.path));
  const probe = () => {
    const snap = { name: run('config', '--local', '--get-all', 'user.name'), email: run('config', '--local', '--get-all', 'user.email'), raw: run('worktree', 'list', '--porcelain') };
    return { ...snap, worktrees: snap.raw.includes('PROBE-ERROR') ? [] : parseWorktrees(snap.raw) };
  };
  const gated = (ws) => ws.filter((w) => isGated(w.path)).map((w) => w.rest).sort().join('\n\n');
  const before = probe();
  process.on('exit', () => {
    const after = probe();
    const problems = [];
    if ([after.name, after.email, after.raw].some((v) => v.includes('PROBE-ERROR'))) problems.push('the gate could not read the repo');
    if (after.name !== before.name || after.email !== before.email) problems.push('local git identity changed');
    if (gated(after.worktrees) !== gated(before.worktrees)) problems.push('a worktree in the checkout under test, tmpdir() or ~/.stratum/ was added, removed or switched');
    const repoEmail = before.email.trim().split('\n').at(-1);
    for (const w of after.worktrees.filter((x) => isGated(x.path))) {
      const was = before.worktrees.find((x) => x.path === w.path);
      if (!was?.head || !w.head || was.head === w.head) continue;
      // A rewind (reset --hard, checkout of an unrelated commit) leaves an EMPTY `was..now` range, so the identity check below
      // cannot see it: the snapshot must still be an ancestor of the new HEAD. Exit 1 = not an ancestor, anything else = error.
      try { execFileSync('git', ['-C', realRepo, 'merge-base', '--is-ancestor', was.head, w.head], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) {
        problems.push(err.status === 1 ? `HEAD of ${w.path} is no longer a descendant of its snapshot ${was.head} (rewound or switched to ${w.head})`
          : `cannot check ancestry ${was.head}..${w.head} on ${w.path}: PROBE-ERROR ${err.status ?? ''} ${String(err.stderr ?? err.message).trim()}`);
        continue;
      }
      const log = run('log', '--format=%H%x09%ae%x09%ce', `${was.head}..${w.head}`);
      if (log.includes('PROBE-ERROR')) { problems.push(`cannot list commits ${was.head}..${w.head} on ${w.path}: ${log}`); continue; }
      const foreign = log.split('\n').filter(Boolean).filter((l) => { const [, ae, ce] = l.split('\t'); return !repoEmail || ae !== repoEmail || ce !== repoEmail || ae === TEST_COMMIT_SENTINEL || ce === TEST_COMMIT_SENTINEL; });
      if (foreign.length) problems.push(`commits not made by the repo identity <${repoEmail}> landed on ${w.path}: ${foreign.join(', ')}`);
    }
    if (problems.length) {
      const show = (s) => JSON.stringify({ name: s.name, email: s.email, worktrees: s.raw });
      process.stderr.write(`\nGOLDEN-LEAK GATE: this test process changed the real repo's local git identity, worktree list or commits, or the gate could not read it (${realRepo}): ${problems.join('; ')}.\nbefore=${show(before)}\nafter=${show(after)}\n`);
      process.exitCode = 1;
    }
  });
}

const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) =>
  (typeof chunk === 'string' && chunk.includes('diverges from rollup'))
    ? true
    : _origStderrWrite(chunk, ...rest);
