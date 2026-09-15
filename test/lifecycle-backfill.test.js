/**
 * test/lifecycle-backfill.test.js — COMP-LIFECYCLE-BACKFILL blueprint §7.
 *
 * Golden flows against the REAL stratum CLI, plus a table-driven refusal
 * harness. No guard client is faked anywhere in this file — that is the seam a
 * fake client hid on 2026-09-05, and it is the reason §7.1 exists.
 *
 * Isolation is proven, not assumed:
 *  - `$HOME` is a temp dir for the whole file, because stratum's guard store is
 *    `join(homedir(), '.stratum', 'guards')` with no env override. The real
 *    store's entry count is asserted unchanged before and after.
 *  - `COMPOSE_STRATUM_TS_CLI_BIN` routes register, transition, history, policy,
 *    apply-upgrade and digest to an isolated COPY of the installed package, so
 *    the shipped symlink at node_modules/@smartmemory/stratum is never touched.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Never let the gate's default vision projector find a real cockpit on :4001.
process.env.COMPOSE_PORT = '19994';

import { createTestSigner } from './helpers/sshsig-sign.js';

// The custody test seam refuses outside NODE_ENV=test; `npm test` does not set it.
process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// §7.1 — the isolated runnable stratum copy
// ---------------------------------------------------------------------------

const STRATUM_DEPS_SMOKE = /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/;

/**
 * Resolve a dependency's package ROOT by DIRECTORY WALK (R3-8).
 *
 * `require.resolve` is NOT a package-location API: it answers "what file does
 * this specifier load", and an `exports` map is entitled to answer "nothing" for
 * both `<dep>/package.json` and the bare `<dep>`. Measured on stratum's own
 * tree, `@openai/codex-sdk` fails BOTH legs and `@modelcontextprotocol/sdk`
 * resolves `./package.json` to `dist/cjs/package.json` — a plausible path that
 * is the wrong directory. Hence the walk, and hence the name check on every
 * root INCLUDING the ones that resolved cleanly.
 */
function resolveDepRoot(fromDir, dep) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const cand = path.join(d, 'node_modules', dep);
    const pj = path.join(cand, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === dep) return cand;
      } catch { /* unreadable manifest: keep walking */ }
    }
    if (path.dirname(d) === d) return null;
  }
}

function smokeStratum(cliPath) {
  // `--help` is NOT a valid probe: a healthy CLI exits 2 on an unknown argument.
  // `guard` with no action is the documented failure — exit 1 with a known line.
  return spawnSync(process.execPath, [cliPath, 'guard'], { encoding: 'utf8' });
}

function buildStratumCopy(publicKeyLine) {
  const pkgRoot = path.dirname(require_.resolve('@smartmemory/stratum/package.json'));
  const copy = mkdtempSync(path.join(tmpdir(), 'bf-stratum-'));
  cpSync(path.join(pkgRoot, 'package.json'), path.join(copy, 'package.json'));
  // A bare `dist` copy cannot run: the CLI imports `yaml` eagerly.
  cpSync(path.join(pkgRoot, 'dist'), path.join(copy, 'dist'), { recursive: true });

  // The trust root MUST be under dist/contracts: prepare-dist rewrites
  // trust.ts's `../../contracts/` to `../contracts/` in the compiled output, and
  // the published package ships only `dist`.
  const signersFile = path.join(copy, 'dist', 'contracts', 'guard-signers.allowed');
  assert.ok(existsSync(signersFile), 'the copy must carry dist/contracts/guard-signers.allowed');
  writeFileSync(signersFile, `operator ${publicKeyLine}\n`);

  // Mirror stratum's own node_modules and let node resolve exactly as it does in
  // place. Node resolves symlinked directories through their real path, so a
  // pnpm `.pnpm/` layout keeps working unchanged.
  const pkgNm = path.join(pkgRoot, 'node_modules');
  if (existsSync(pkgNm)) symlinkSync(pkgNm, path.join(copy, 'node_modules'), 'dir');

  const cliPath = path.join(copy, 'dist', 'cli', 'stratum.js');
  let r = smokeStratum(cliPath);

  if (STRATUM_DEPS_SMOKE.test(`${r.stdout}${r.stderr}`)) {
    // Fallback for a partially hoisted install: one symlink per dependency,
    // each root found by directory walk and NAME-CHECKED.
    const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const deps = Object.keys(manifest.dependencies || {});
    rmSync(path.join(copy, 'node_modules'), { recursive: true, force: true });
    for (const dep of deps) {
      const root = resolveDepRoot(pkgRoot, dep);
      assert.ok(root, `could not locate the package root for ${dep} by directory walk`);
      const target = path.join(copy, 'node_modules', dep);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(root, target, 'dir');
    }
    r = smokeStratum(cliPath);
  }

  assert.equal(r.status, 1, `stratum copy is not runnable: ${r.stderr || r.stdout}`);
  assert.match(r.stderr, /Unknown guard action/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, STRATUM_DEPS_SMOKE);
  return { copy, cliPath };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODE = 'BF-1';

function gitAt(root) {
  return (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
}

/**
 * A REAL git repo with REAL commits at chosen author dates, a compose config, a
 * feature.json (build mode only) and a real VisionStore with a lifecycle.
 */
async function makeWorkspace({
  guard = true, status = 'PLANNED', mode = 'build', tracksJson = true,
  currentPhase = 'ship', startedAt = '2026-09-01T00:00:00.000Z', testCommand,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bfgate-'));
  const git = gitAt(root);
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');

  const shas = {};
  const commitAt = (name, when) => {
    writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
    git('add', '-A');
    execFileSync('git', ['commit', '-qm', name], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    shas[name] = git('rev-parse', 'HEAD').trim();
  };
  commitAt('blueprint', '2026-06-01T00:00:00Z');
  commitAt('execute', '2026-07-01T00:00:00Z');
  commitAt('ship', '2026-08-01T00:00:00Z');
  commitAt('head', '2026-08-15T00:00:00Z');

  mkdirSync(path.join(root, '.compose'), { recursive: true });
  writeFileSync(path.join(root, '.compose', 'compose.json'), JSON.stringify({
    paths: { features: 'docs/features' },
    capabilities: { guard },
    ...(testCommand ? { guard: { testCommand } } : {}),
  }, null, 2));

  const artifactRoot = tracksJson ? 'docs/features' : 'docs/bugs';
  const fdir = path.join(root, artifactRoot, CODE);
  mkdirSync(fdir, { recursive: true });
  if (tracksJson) {
    writeFileSync(path.join(fdir, 'feature.json'), JSON.stringify({
      code: CODE, description: 'backfill fixture', phase: 'Phase 1', status,
    }, null, 2));
  }

  const { VisionStore } = await import('../server/vision-store.js');
  const dataDir = path.join(root, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new VisionStore(dataDir);
  const created = store.createItem({ type: 'feature', title: CODE, status: 'in_progress' });
  store.updateLifecycle(created.id, {
    featureCode: CODE, mode, currentPhase, startedAt,
    phaseHistory: [{
      phase: 'explore_design', step: 'explore_design', enteredAt: startedAt, exitedAt: null,
      from: null, to: 'explore_design', outcome: null, timestamp: startedAt,
    }],
  });
  const item = store.items.get(created.id);

  return {
    root, shas, store, item, git,
    guardOn: guard,
    featureStatus: () => JSON.parse(readFileSync(path.join(fdir, 'feature.json'), 'utf8')).status,
    intentPath: path.join(root, '.compose', 'data', 'completion-intents', `${CODE}.json`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const occurrence = (phase, sha) => ({ phase, evidence: { kind: 'commit', ref: sha } });

/** The three H1 occurrences, in the pre-adoption window. */
const h1Occurrences = (shas) => [
  occurrence('blueprint', shas.blueprint),
  occurrence('execute', shas.execute),
  occurrence('ship', shas.ship),
];

async function runBackfill(ws, over = {}) {
  const { completionGate } = await import('../lib/completion-gate.js');
  const { _testOnly_resetGuardCache } = await import('../server/lifecycle-guard.js');
  _testOnly_resetGuardCache();
  return completionGate({
    intent: 'backfill',
    featureCode: CODE,
    commitSha: ws.shas.head,
    testsPass: true,
    filesChanged: ['lib/a.js'],
    reason: 'built before the lifecycle existed',
    occurrences: h1Occurrences(ws.shas),
    workspaceRoot: ws.root,
    mode: 'build',
    item: ws.item,
    store: ws.store,
    ...over,
  });
}

/** Read the guard ledger for a workspace through the REAL CLI. */
async function ledgerOf(ws, mode = 'build') {
  const { resourceId } = await import('../server/lifecycle-guard.js');
  const { guardHistory } = await import('../server/stratum-client.js');
  return guardHistory(resourceId(CODE, ws.root, mode));
}

async function policyOf(ws, mode = 'build') {
  const { resourceId } = await import('../server/lifecycle-guard.js');
  const { guardPolicy } = await import('../server/stratum-client.js');
  return guardPolicy(resourceId(CODE, ws.root, mode));
}

/**
 * Register the resource under the LEGACY policy — the one a resource registered
 * before this feature carries. Note it takes a POLICY, not a graph.
 */
async function registerLegacy(ws, mode = 'build', featureCode = CODE) {
  const { buildPhaseGraph, edgePredicates, legacyPolicyProjection, resourceId } =
    await import('../server/lifecycle-guard.js');
  const { terminalOf } = await import('../lib/lifecycle-modes.js');
  const { guardRegister } = await import('../server/stratum-client.js');
  const dir = mode === 'build' ? 'docs/features' : 'docs/bugs';
  const legacy = legacyPolicyProjection({
    graph: buildPhaseGraph(mode),
    edge_predicates: edgePredicates(`${dir}/${featureCode}`, mode),
    terminal: terminalOf(mode),
    stakes: {},
  });
  const res = await guardRegister({
    resourceId: resourceId(featureCode, ws.root, mode),
    graph: legacy.graph,
    edgePredicates: legacy.edge_predicates,
    initial: Object.keys(legacy.graph)[0],   // build: explore_design, fix: reproduce
    terminal: legacy.terminal,
    stakes: legacy.stakes,
    workspaceRoot: ws.root,
  });
  return res;
}

function testCustody(signer, confirmations, result = null) {
  return {
    backend: 'test',
    sign({ bytes, namespace }) {
      confirmations.push({ namespace, bytes: Buffer.from(bytes) });
      if (result) return result;
      return { ok: true, armored: signer.sign(bytes, namespace) };
    },
  };
}


/**
 * Make step 6.1 fail FOR REAL. `recordCompletion` writes feature.json, so an
 * unwritable feature directory is a genuine EACCES at exactly the step the crash
 * simulation needs — no ESM export patching (namespace objects are frozen) and
 * no fake writer standing in for the real one.
 */
function blockCompletionRecord(ws) {
  const dir = path.join(ws.root, 'docs', 'features', CODE);
  chmodSync(dir, 0o500);
  return () => chmodSync(dir, 0o700);
}

/**
 * A CLI shim that forwards every guard action to the real stratum copy EXCEPT
 * `transition`, which exits non-zero with no JSON — the process-died-before-the-
 * transition window. Nothing reaches stratum, so no ledger entry can exist.
 */
function transitionKillingCli(ws) {
  const shim = path.join(ws.root, 'stratum-shim.cjs');
  // The client execFiles the resolved bin DIRECTLY, so the shim needs a shebang
  // and the exec bit — exactly like the real dist/cli/stratum.js.
  writeFileSync(shim, `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (args[1] === 'transition') { process.exit(1); }
const r = spawnSync(process.execPath, [${JSON.stringify(STRATUM.cliPath)}, ...args], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
  chmodSync(shim, 0o755);
  return shim;
}

/**
 * A CLI stand-in that records the fact it was invoked and then fails. It needs a
 * shebang AND the exec bit: the client execFiles the resolved bin directly, so a
 * plain .js file cannot run at all and would never write the marker (Codex r1 #7).
 */
function spawnMarkerCli(ws) {
  const marker = path.join(ws.root, 'stratum-was-spawned');
  const script = path.join(ws.root, 'never-run.cjs');
  writeFileSync(script, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');
process.exit(1);
`);
  chmodSync(script, 0o755);
  return { marker, script };
}

/** Prove the marker detector actually fires, through the real transport. */
async function assertMarkerDetectsASpawn(ws, marker) {
  const { resourceId } = await import('../server/lifecycle-guard.js');
  const { guardHistory } = await import('../server/stratum-client.js');
  await guardHistory(resourceId(CODE, ws.root, 'build'));
  assert.ok(existsSync(marker),
    'the marker script must be invocable, or its absence proves nothing');
  rmSync(marker, { force: true });
}

/** Fail the Nth `_save` on this store instance, and only that one. */
function failNthSave(store, n) {
  const real = store._save.bind(store);
  let calls = 0;
  store._save = (...a) => {
    calls += 1;
    if (calls === n) return false;
    return real(...a);
  };
  return () => { store._save = real; };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });


// ---------------------------------------------------------------------------

let SIGNER;
let STRATUM;
let FAKE_HOME;
let REAL_GUARD_COUNT;
let CONFIRMATIONS;
const savedEnv = {};

function countRealGuards() {
  const dir = path.join(homedir(), '.stratum', 'guards');
  try { return readdirSync(dir).length; } catch { return -1; }
}

before(async () => {
  savedEnv.HOME = process.env.HOME;
  savedEnv.CLI = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
  REAL_GUARD_COUNT = countRealGuards();

  SIGNER = createTestSigner();
  STRATUM = buildStratumCopy(SIGNER.publicKeyLine);
  CONFIRMATIONS = [];
  const { _testOnly_setCustodyBackend } = await import('../lib/guard-custody.js');
  _testOnly_setCustodyBackend(testCustody(SIGNER, CONFIRMATIONS));
  FAKE_HOME = mkdtempSync(path.join(tmpdir(), 'bf-home-'));
  process.env.HOME = FAKE_HOME;
  process.env.COMPOSE_STRATUM_TS_CLI_BIN = STRATUM.cliPath;
});

after(async () => {
  // Fixture custody is scoped to this isolated stratum-copy suite only.
  // The signer key never enters a non-fixture trust root.
  const { _testOnly_setCustodyBackend } = await import('../lib/guard-custody.js');
  _testOnly_setCustodyBackend(null);
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.CLI === undefined) delete process.env.COMPOSE_STRATUM_TS_CLI_BIN;
  else process.env.COMPOSE_STRATUM_TS_CLI_BIN = savedEnv.CLI;
  rmSync(STRATUM.copy, { recursive: true, force: true });
  rmSync(FAKE_HOME, { recursive: true, force: true });
  // Isolation PROVEN, not assumed: the real guard store never grew.
  assert.equal(countRealGuards(), REAL_GUARD_COUNT,
    'the real ~/.stratum/guards was written to — $HOME isolation failed');
});

// ===========================================================================
// §7.5 Flow C — guard off
// ===========================================================================

describe('Flow C — guard off (BP-12)', () => {
  test('a backfill succeeds with NO stratum process spawned', async () => {
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    const { marker, script } = spawnMarkerCli(ws);
    const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
    try {
      // POSITIVE CONTROL FIRST (Codex r1 #7). The original script had neither a
      // shebang nor the exec bit, so an attempted invocation died in the spawn
      // and never wrote the marker — its absence proved nothing at all. Drive a
      // guard verb through the SAME transport the gate uses and assert the
      // marker appears, then clear it, so the negative assertion below has a
      // demonstrated detector behind it.
      await assertMarkerDetectsASpawn(ws, marker);

      const res = await runBackfill(ws);
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      assert.equal(res.status, 'finalized');
      assert.equal(res.guarded, false);
      // The filesystem proves it, which asserting on a flag cannot.
      assert.equal(existsSync(marker), false, 'no stratum process may be spawned with the guard off');
      assert.equal(res.ledgerRef, null);

      const intent = ws.intentPath;
      assert.equal(existsSync(intent), false, 'the intent is cleared last');
      assert.equal(ws.item.lifecycle.currentPhase, 'complete_backfilled');
      assert.equal(ws.item.lifecycle.backfills[0].state, 'finalized');
      assert.equal(ws.item.lifecycle.backfills[0].guardRef, null);
      assert.equal(ws.featureStatus(), 'COMPLETE');

      // fromState came from the lifecycle, not from a guard read.
      // Terminal legality is still enforced LOCALLY: a second backfill on the
      // now-terminal item refuses.
      const second = await runBackfill(ws, { reason: 'a second, different backfill' });
      assert.equal(second.ok, false);
      assert.equal(second.refusedAt, 'guard');
      assert.match(second.reasons.join(' '), /already terminal at "complete_backfilled"/);
    } finally {
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
      ws.cleanup();
    }
  });
});

// ===========================================================================
// §7.4 Flow B — fix mode, no feature.json
// ===========================================================================

describe('Flow B — fix mode, no feature.json (BP-11)', () => {
  test('lifecycle-only writes plus a DURABLE item.status', async () => {
    const ws = await makeWorkspace({ guard: true, mode: 'fix', tracksJson: false, currentPhase: 'ship' });
    try {
      const res = await runBackfill(ws, {
        mode: 'fix',
        occurrences: [
          occurrence('diagnose', ws.shas.blueprint),
          occurrence('fix', ws.shas.execute),
        ],
      });
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      // Not refused at preflight, even with no feature.json anywhere.
      assert.equal(res.refusedAt, undefined);
      assert.equal(res.status, 'finalized');
      assert.equal(res.result, null, 'no completion record for a mode that tracks no feature.json');

      // R2B-9 — the assertion that catches the missing durable write.
      const onDisk = JSON.parse(readFileSync(
        path.join(ws.root, '.compose', 'data', 'vision-state.json'), 'utf8',
      ));
      const stored = onDisk.items.find((i) => i.id === ws.item.id);
      assert.equal(stored.status, 'complete');
      assert.equal(stored.lifecycle.currentPhase, 'complete_backfilled');
      assert.equal(stored.lifecycle.backfills[0].state, 'finalized');

      // The guard transition really happened.
      const h = await ledgerOf(ws, 'fix');
      assert.equal(h.current_state, 'complete_backfilled');
      assert.ok(h.ledger.some((e) => e.kind === 'transition' && e.to_state === 'complete_backfilled'));
    } finally { ws.cleanup(); }
  });
});

// ===========================================================================
// §7.3 Flow A — build mode, registered LEGACY resource
// ===========================================================================

describe('Flow A — build mode, registered legacy resource', () => {
  test('descriptors are generated, signed, lazily applied, and the backfill lands', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      // 1. Register a LEGACY resource — the FULL policy object, then project it.
      const reg = await registerLegacy(ws);
      assert.equal(reg.status, 'registered', JSON.stringify(reg));
      const legacyChecksum = reg.checksum;
      assert.match(legacyChecksum, /^[0-9a-f]{64}$/);
      mkdirSync(path.join(ws.root, 'docs', 'features', 'BF-2'), { recursive: true });
      // Edge predicates embed the feature dir, so every legacy resource has its own checksum;
      // one generation enumerates and covers them all (the blueprint's "same checksum" wording was wrong).
      const second = await registerLegacy(ws, 'build', 'BF-2');
      assert.match(second.checksum, /^[0-9a-f]{64}$/);
      assert.notEqual(second.checksum, legacyChecksum, 'predicates embed the feature path');

      // 2. ensureGuard reports `legacy` — the C3/finding-2 rule proved against
      //    the REAL CLI, not a fake.
      const { ensureGuard, _testOnly_resetGuardCache } = await import('../server/lifecycle-guard.js');
      _testOnly_resetGuardCache();
      const probe = await ensureGuard(CODE, 'ship', ws.root, 'build');
      assert.equal(probe.status, 'legacy', JSON.stringify(probe));

      // 3. Backfill signs through test custody, then applies the resolved generation.
      const res = await runBackfill(ws);
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      assert.equal(res.status, 'finalized');
      assert.equal(CONFIRMATIONS.length, 1, 'the first candidate needs one confirmation');

      const { currentGeneration } = await import('../lib/guard-descriptors.js');
      const { guardDescriptors } = await import('../server/stratum-client.js');
      const generation = await currentGeneration(ws.root);
      assert.ok(generation, 'a signed generation must be published');
      assert.equal(path.basename(path.dirname(generation.file)), generation.sha);
      const descriptors = JSON.parse(readFileSync(generation.file, 'utf8')).descriptors;
      assert.deepEqual(descriptors.map((d) => d.from_checksum).sort(), [legacyChecksum, second.checksum].sort(),
        'one generation covers every registered legacy resource');
      const descriptor = [descriptors.find((d) => d.from_checksum === legacyChecksum)];
      assert.ok(descriptor[0].to_policy.terminal.includes('complete_backfilled'));
      const verified = await guardDescriptors(generation.file);
      assert.match(verified.signature, /^verified:/);
      const { applyBackfillUpgrade } = await import('../server/lifecycle-guard.js');
      const secondLegacy = await applyBackfillUpgrade({ featureCode: 'BF-2', workspaceRoot: ws.root });
      assert.equal(secondLegacy.ok, true);
      assert.equal(CONFIRMATIONS.length, 1, 'a second legacy resource already covered by the generation never prompts again');

      mkdirSync(path.join(ws.root, 'docs', 'bugs', 'BF-3'), { recursive: true });
      const changed = await registerLegacy(ws, 'fix', 'BF-3');
      assert.equal(changed.status, 'registered', JSON.stringify(changed));
      assert.notEqual(changed.checksum, legacyChecksum, 'a graph change produces a new checksum');
      const changedUpgrade = await applyBackfillUpgrade({ featureCode: 'BF-3', workspaceRoot: ws.root, mode: 'fix' });
      assert.equal(changedUpgrade.ok, true, JSON.stringify(changedUpgrade));
      assert.equal(CONFIRMATIONS.length, 2, 'a graph change requires one new confirmation');
      const r32Retry = await applyBackfillUpgrade({ featureCode: 'BF-3', workspaceRoot: ws.root, mode: 'fix' });
      assert.equal(r32Retry.status, 'unchanged', 'R32: a completed upgrade never re-enters descriptor signing');
      assert.equal(CONFIRMATIONS.length, 2);

      const h = await ledgerOf(ws);
      const upgradeEntry = h.ledger.find((e) => e.kind === 'graph_version');
      assert.ok(upgradeEntry, 'the lazy apply-upgrade must be ledgered');
      assert.equal(upgradeEntry.resolved_by, 'human');
      assert.match(upgradeEntry.rationale ?? '', new RegExp(descriptor[0].id));

      const applied = h.ledger.find((e) => e.kind === 'transition'
        && e.to_state === 'complete_backfilled' && e.outcome === 'applied');
      assert.ok(applied, 'the backfilled completion must be ledgered');
      assert.equal(applied.idempotency_key, res.operationId);

      const pol = await policyOf(ws);
      assert.equal(pol.graph_version, 2);
      assert.ok(pol.terminal.includes('complete_backfilled'));

      assert.equal(ws.featureStatus(), 'COMPLETE');
      assert.equal(ws.item.lifecycle.currentPhase, 'complete_backfilled');
      assert.equal(ws.item.lifecycle.backfills[0].state, 'finalized');
      assert.equal(ws.item.lifecycle.backfills[0].upgrade.status, 'applied');

      // H1's order and closures, plus the terminal occurrence carrying the op id.
      const phases = ws.item.lifecycle.phaseHistory.map((e) => e.phase);
      assert.deepEqual(phases,
        ['blueprint', 'execute', 'ship', 'explore_design', 'complete_backfilled']);
      const terminals = ws.item.lifecycle.phaseHistory.filter((e) => e.operation_id != null);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].operation_id, res.operationId);

      // The audit event is ASSERTED, not assumed (BP-5).
      const events = readFileSync(
        path.join(ws.root, '.compose', 'data', 'feature-events.jsonl'), 'utf8',
      );
      assert.match(events, /backfill_completion/);
      assert.match(events, new RegExp(res.operationId));

      assert.equal(existsSync(ws.intentPath), false, 'the intent is cleared last');

      // 5. Identical retry.
      const historyBefore = JSON.parse(JSON.stringify(ws.item.lifecycle.phaseHistory));
      const ledgerLenBefore = h.ledger.length;
      const retry = await runBackfill(ws);
      assert.equal(retry.ok, true, JSON.stringify(retry.reasons));
      assert.equal(retry.status, 'finalized');
      assert.equal(retry.operationId, res.operationId);
      assert.deepEqual(ws.item.lifecycle.phaseHistory, historyBefore);
      const h2 = await ledgerOf(ws);
      assert.equal(h2.ledger.length, ledgerLenBefore, 'a finalized retry writes no ledger entry');
      assert.equal(CONFIRMATIONS.length, 2, 'an unchanged checksum never asks again (still the two from BF-1 and BF-3)');
      assert.equal(
        ws.item.lifecycle.phaseHistory.filter((e) => e.operation_id != null).length, 1,
      );
    } finally { ws.cleanup(); }
  });

  test('6b — recovery AFTER step 6.0 resumes instead of refusing at history (R3-5)', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      await registerLegacy(ws);

      // Interrupt LATER than the transition: let the history write and the
      // pending marker reach disk, then fail before the completion record.
      const restore = blockCompletionRecord(ws);
      let first;
      try { first = await runBackfill(ws); } finally { restore(); }
      assert.equal(first.ok, false, JSON.stringify(first));
      assert.equal(first.refusedAt, 'write');
      assert.ok(existsSync(ws.intentPath), 'a durable write failure KEEPS the intent');

      // The stored phaseHistory already contains the terminal occurrence.
      assert.equal(
        ws.item.lifecycle.phaseHistory.filter((e) => e.operation_id != null).length, 1,
      );

      const historyBefore = JSON.parse(JSON.stringify(ws.item.lifecycle.phaseHistory));
      const resume = await runBackfill(ws);
      assert.equal(resume.ok, true, JSON.stringify(resume.reasons));
      assert.equal(resume.refusedAt, undefined);
      assert.equal(resume.recovered, true);
      assert.equal(resume.status, 'finalized');
      // The merge treated the terminal as ALREADY WRITTEN: the history is
      // byte-identical, including every recordedAt, and there is still exactly
      // one entry carrying the operation id. (`resume.written` reports the
      // PERSISTED plan's key list, which is what the batch record needs; the
      // replay's own `written` is internal to §5.4a's divergence rule.)
      assert.deepEqual(ws.item.lifecycle.phaseHistory, historyBefore);
      assert.equal(
        ws.item.lifecycle.phaseHistory.filter((e) => e.operation_id != null).length, 1,
      );
      assert.equal(ws.item.lifecycle.backfills.length, 1, 'no duplicate batch record');
    } finally { ws.cleanup(); }
  });

  test('7b — the PRE-transition crash window, policy unchanged, resumes and applies once', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      await registerLegacy(ws);

      // Interrupt after writeIntent and BEFORE the transition reaches stratum.
      const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = transitionKillingCli(ws);
      let crashed;
      try { crashed = await runBackfill(ws); } finally {
        process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
      }
      assert.equal(crashed.ok, false, JSON.stringify(crashed));
      assert.equal(crashed.refusedAt, 'guard', JSON.stringify(crashed.reasons));
      assert.ok(existsSync(ws.intentPath),
        `the intent survives the pre-transition crash: ${JSON.stringify(crashed.reasons)}`);

      const before = await ledgerOf(ws);
      assert.equal(
        before.ledger.filter((e) => e.kind === 'transition').length, 0,
        'nothing reached stratum',
      );
      const polBefore = await policyOf(ws);

      const resume = await runBackfill(ws);
      assert.equal(resume.ok, true, JSON.stringify(resume.reasons));
      const h = await ledgerOf(ws);
      const applies = h.ledger.filter((e) => e.kind === 'transition'
        && e.to_state === 'complete_backfilled' && e.outcome === 'applied');
      assert.equal(applies.length, 1, 'exactly one applied transition');
      // …and it applied under the policy the intent was written against.
      const polAfter = await policyOf(ws);
      assert.equal(polAfter.checksum, polBefore.checksum);
    } finally { ws.cleanup(); }
  });

  test('9 — the guard flag flipped OFF mid-operation does not weaken the resume (R3-7)', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      await registerLegacy(ws);

      const restore = blockCompletionRecord(ws);
      try { await runBackfill(ws); } finally { restore(); }
      assert.ok(existsSync(ws.intentPath));
      const intent = JSON.parse(readFileSync(ws.intentPath, 'utf8'));
      assert.equal(intent.guarded, true);
      assert.match(intent.policy_checksum, /^[0-9a-f]{64}$/);

      // Flip capabilities.guard OFF between the crash and the retry.
      const cfgPath = path.join(ws.root, '.compose', 'compose.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.capabilities.guard = false;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      // NO test callback: the PRODUCTION default projector is what has to carry
      // the persisted flag to the verifier. A hand-wired callback here is what
      // made §5.10a look wired when it was not (Codex r1 #4).
      const resume = await runBackfill(ws);
      assert.equal(resume.ok, true, JSON.stringify(resume.reasons));
      // The persisted flag governs, not live config.
      assert.equal(resume.guarded, true);
      assert.ok(resume.ledgerRef, 'guardRef is still stamped');
      // …and the flag reached the VERIFIER, not merely the projector.
      assert.equal(resume.visionProjection.verified_by, 'guarded');
      assert.equal(ws.store.items.get(ws.item.id).completion_projection.verified_by, 'guarded');
    } finally { ws.cleanup(); }
  });
});

// ===========================================================================
// R2B-12 — the dir-lock heartbeat keeps firing during a slow evidence command
// ===========================================================================

test('the lock directory mtime advances while a slow test command runs (R2B-12)', async () => {
  // A 2-second block proves nothing: LOCK_STALE_MS is 20s. Assert the MECHANISM
  // instead — under spawnSync the event loop is blocked, setInterval never fires
  // and the mtime is frozen, so this fails on the synchronous runner.
  const ws = await makeWorkspace({
    guard: false, currentPhase: 'ship',
    testCommand: [process.execPath, '-e', 'setTimeout(()=>process.exit(0), 3000)'],
  });
  const lockDir = path.join(ws.root, '.compose', 'data', 'locks', `completion-${CODE}`);
  const samples = [];
  const sampler = setInterval(() => {
    try { samples.push(statSync(lockDir).mtimeMs); } catch { /* not held yet */ }
  }, 400);
  try {
    const res = await runBackfill(ws, { testsPass: undefined });
    clearInterval(sampler);
    assert.equal(res.ok, true, JSON.stringify(res.reasons));
    assert.equal(res.attestedTestsPass, true, 'a test command that exits 0 attests');
    const distinct = [...new Set(samples)];
    assert.ok(distinct.length >= 3,
      `the heartbeat must advance the lock mtime while the child runs; saw ${JSON.stringify(distinct)}`);
    for (let i = 1; i < distinct.length; i += 1) {
      assert.ok(distinct[i] > distinct[i - 1], 'mtime must strictly increase');
    }
  } finally { clearInterval(sampler); ws.cleanup(); }
});

test('[COMP-COMPLETION-GATE-1] backfill short SHA refuses before a held lock or guard traffic', async () => {
  const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
  const { marker, script } = spawnMarkerCli(ws);
  const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
  const lockDir = path.join(ws.root, '.compose', 'data', 'locks', `completion-${CODE}`);
  let releaseHeldLock;
  try {
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
    await assertMarkerDetectsASpawn(ws, marker);

    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, 'owner'), 'pre-held-by-test');
    releaseHeldLock = setTimeout(
      () => rmSync(lockDir, { recursive: true, force: true }),
      1000,
    );
    const historyBefore = JSON.stringify(ws.item.lifecycle);
    const started = Date.now();
    const res = await runBackfill(ws, { commitSha: ws.shas.head.slice(0, 7) });
    const elapsed = Date.now() - started;

    assert.equal(res.ok, false);
    assert.equal(res.refusedAt, 'evidence');
    assert.match(res.reasons.join(' '), /full 40-char hex SHA/);
    assert.ok(elapsed < 700, `SHA refusal waited on the held lock (${elapsed}ms)`);
    assert.equal(existsSync(marker), false, 'pre-lock SHA refusal must not spawn the guard');
    assert.equal(JSON.stringify(ws.item.lifecycle), historyBefore, 'lifecycle history must not change');
    assert.equal(existsSync(ws.intentPath), false, 'pre-lock SHA refusal must not write an intent');
  } finally {
    if (releaseHeldLock) clearTimeout(releaseHeldLock);
    rmSync(lockDir, { recursive: true, force: true });
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
    ws.cleanup();
  }
});

test('[COMP-COMPLETION-GATE-1] malformed restored intent refuses before replay or history writes', async () => {
  const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
  const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
  try {
    const restore = blockCompletionRecord(ws);
    let first;
    try { first = await runBackfill(ws, { notes: 'valid on the first attempt' }); }
    finally { restore(); }
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.refusedAt, 'write');

    const persisted = JSON.parse(readFileSync(ws.intentPath, 'utf8'));
    const { backfillRequestDigest } = await import('../lib/completion-gate.js');
    assert.equal(persisted.request_digest, backfillRequestDigest({
      featureCode: CODE,
      commitSha: ws.shas.head,
      testsPass: true,
      mode: 'build',
      filesChanged: ['lib/a.js'],
      reason: 'built before the lifecycle existed',
      occurrences: h1Occurrences(ws.shas),
    }), 'the seeded intent must match the retry request digest');
    persisted.notes = 42;
    writeFileSync(ws.intentPath, JSON.stringify(persisted, null, 2));

    const historyBefore = JSON.stringify(ws.item.lifecycle);
    const intentBefore = readFileSync(ws.intentPath, 'utf8');
    const { marker, script } = spawnMarkerCli(ws);
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
    await assertMarkerDetectsASpawn(ws, marker);

    const retry = await runBackfill(ws);
    assert.equal(retry.ok, false);
    assert.equal(retry.refusedAt, 'recovery');
    assert.match(retry.reasons.join(' '), /notes must be a string/);
    assert.ok(retry.reasons.join(' ').includes(ws.intentPath),
      'the recovery refusal must name the persisted intent path');
    assert.equal(existsSync(marker), false, 'malformed recovery must make zero guard calls');
    assert.equal(JSON.stringify(ws.item.lifecycle), historyBefore,
      'malformed recovery must not change lifecycle history');
    assert.equal(readFileSync(ws.intentPath, 'utf8'), intentBefore,
      'malformed recovery must not rewrite the intent');
  } finally {
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
    ws.cleanup();
  }
});

test('[COMP-COMPLETION-GATE-1] malformed guarded intent refuses before guard replay', async () => {
  const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
  const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
  try {
    await registerLegacy(ws);

    process.env.COMPOSE_STRATUM_TS_CLI_BIN = transitionKillingCli(ws);
    let first;
    try { first = await runBackfill(ws); } finally {
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
    }
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.refusedAt, 'guard');

    const persisted = JSON.parse(readFileSync(ws.intentPath, 'utf8'));
    // The intent must be guarded so moving validation below replay becomes observable guard traffic.
    assert.equal(persisted.guarded, true);
    const { backfillRequestDigest } = await import('../lib/completion-gate.js');
    assert.equal(persisted.request_digest, backfillRequestDigest({
      featureCode: CODE,
      commitSha: ws.shas.head,
      testsPass: true,
      mode: 'build',
      filesChanged: ['lib/a.js'],
      reason: 'built before the lifecycle existed',
      occurrences: h1Occurrences(ws.shas),
    }), 'the seeded guarded intent must match the retry request digest');
    persisted.tests_attested = 'true';
    writeFileSync(ws.intentPath, JSON.stringify(persisted, null, 2));

    const historyBefore = JSON.stringify(ws.item.lifecycle);
    const { marker, script } = spawnMarkerCli(ws);
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
    await assertMarkerDetectsASpawn(ws, marker);

    const retry = await runBackfill(ws);
    assert.equal(retry.ok, false);
    assert.equal(retry.refusedAt, 'recovery');
    assert.match(retry.reasons.join(' '), /tests_pass must be a boolean/);
    assert.equal(existsSync(marker), false,
      'malformed guarded recovery must make zero guard transition or replay calls');
    assert.equal(JSON.stringify(ws.item.lifecycle), historyBefore,
      'malformed guarded recovery must not change lifecycle history');
  } finally {
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
    ws.cleanup();
  }
});

test('[COMP-COMPLETION-GATE-1] backfill SHA case shares one digest and lowercase intent evidence', async () => {
  const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
  try {
    const restore = blockCompletionRecord(ws);
    let first;
    try { first = await runBackfill(ws, { commitSha: ws.shas.head.toUpperCase() }); }
    finally { restore(); }
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.refusedAt, 'write');

    const persisted = JSON.parse(readFileSync(ws.intentPath, 'utf8'));
    assert.equal(persisted.commit_sha, ws.shas.head);
    assert.equal(persisted.envelope.artifacts.commit_sha, ws.shas.head);
    const canonicalDigest = persisted.request_digest;

    const retry = await runBackfill(ws, { commitSha: ws.shas.head });
    assert.equal(retry.ok, true, JSON.stringify(retry.reasons));
    assert.equal(retry.recovered, true);
    assert.equal(retry.operationId, persisted.operation_id);
    assert.equal(ws.item.lifecycle.backfills.length, 1, 'case-only retry must not create a second operation');
    assert.equal(ws.item.lifecycle.backfills[0].request_digest, canonicalDigest);
    assert.equal(ws.item.lifecycle.backfills[0].completionEvidence.commit_sha, ws.shas.head);
  } finally { ws.cleanup(); }
});

// ===========================================================================
// §7.6 Table-driven refusal harness
// ===========================================================================

/** Snapshot everything a refusal must leave untouched. */
async function snapshotOf(ws, mode = 'build') {
  const h = await (async () => {
    try { return await ledgerOf(ws, mode); } catch { return null; }
  })();
  return {
    status: (() => { try { return ws.featureStatus(); } catch { return null; } })(),
    ledgerLength: h && Array.isArray(h.ledger) ? h.ledger.length : null,
    history: JSON.stringify(ws.item.lifecycle.phaseHistory),
    backfills: JSON.stringify(ws.item.lifecycle.backfills ?? []),
    currentPhase: ws.item.lifecycle.currentPhase,
  };
}

async function assertNothingWritten(ws, before, mode = 'build') {
  const after_ = await snapshotOf(ws, mode);
  assert.equal(after_.status, before.status, 'feature status changed on a refusal');
  assert.equal(after_.ledgerLength, before.ledgerLength, 'a ledger entry was written on a refusal');
  assert.equal(after_.history, before.history, 'phaseHistory changed on a refusal');
  assert.equal(after_.backfills, before.backfills, 'backfills[] changed on a refusal');
  assert.equal(after_.currentPhase, before.currentPhase, 'currentPhase changed on a refusal');
}

describe('§7.6 refusal harness', () => {
  const rows = [
    {
      id: 'R1', name: 'no reason', refusedAt: 'request',
      run: (ws) => runBackfill(ws, { reason: '  ' }),
    },
    {
      id: 'R2', name: 'no commit_sha', refusedAt: 'request',
      run: (ws) => runBackfill(ws, { commitSha: undefined }),
    },
    {
      id: 'R3', name: 'an occurrence phase outside the mode graph (BP-9)', refusedAt: 'request',
      run: (ws) => runBackfill(ws, { occurrences: [occurrence('not_a_phase', ws.shas.blueprint)] }),
    },
    {
      id: 'R4', name: 'commit_sha that is not a commit in the repo', refusedAt: 'evidence',
      run: (ws) => runBackfill(ws, { commitSha: 'a'.repeat(40) }),
    },
    {
      id: 'R5', name: 'tests_pass omitted with no configured test command', refusedAt: 'evidence',
      run: (ws) => runBackfill(ws, { testsPass: undefined }),
    },
    {
      id: 'R6', name: 'evidence path escaping the repo', refusedAt: 'history',
      run: (ws) => runBackfill(ws, {
        occurrences: [{ phase: 'blueprint', evidence: { kind: 'path', ref: '../../etc/passwd' } }],
      }),
    },
    {
      id: 'R7', name: 'evidence path that is a repo-internal symlink to outside', refusedAt: 'history',
      setup: (ws) => {
        const outside = mkdtempSync(path.join(tmpdir(), 'bf-out-'));
        writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
        symlinkSync(path.join(outside, 'secret.txt'), path.join(ws.root, 'leak.md'));
      },
      run: (ws) => runBackfill(ws, {
        occurrences: [{ phase: 'blueprint', evidence: { kind: 'path', ref: 'leak.md' } }],
      }),
    },
    {
      id: 'R9', name: 'two incoming occurrences sharing an instant', refusedAt: 'history',
      run: (ws) => runBackfill(ws, {
        occurrences: [
          occurrence('blueprint', ws.shas.blueprint),
          occurrence('execute', ws.shas.blueprint),
        ],
      }),
    },
    {
      id: 'R10', name: 'an occurrence at exactly lifecycle.startedAt', refusedAt: 'history',
      startedAt: '2026-06-01T00:00:00.000Z',
      run: (ws) => runBackfill(ws, { occurrences: [occurrence('blueprint', ws.shas.blueprint)] }),
    },
    {
      id: 'R11', name: 'an occurrence strictly inside a closed live interval', refusedAt: 'history',
      mutate: (ws) => {
        ws.item.lifecycle.startedAt = '2026-05-01T00:00:00.000Z';
        ws.item.lifecycle.phaseHistory = [
          { phase: 'explore_design', step: 'explore_design', enteredAt: '2026-05-01T00:00:00.000Z',
            exitedAt: '2026-07-15T00:00:00.000Z', from: null, to: 'explore_design',
            outcome: null, timestamp: '2026-05-01T00:00:00.000Z' },
          { phase: 'blueprint', step: 'blueprint', enteredAt: '2026-07-15T00:00:00.000Z',
            exitedAt: null, from: 'explore_design', to: 'blueprint',
            outcome: null, timestamp: '2026-07-15T00:00:00.000Z' },
        ];
      },
      run: (ws) => runBackfill(ws, { occurrences: [occurrence('execute', ws.shas.execute)] }),
    },
    {
      id: 'R12', name: 'an unreachable consecutive pair within one episode (H4)', refusedAt: 'history',
      mutate: (ws) => {
        ws.item.lifecycle.startedAt = '2026-05-01T00:00:00.000Z';
        ws.item.lifecycle.phaseHistory = [
          { phase: 'ship', step: 'ship', enteredAt: '2026-06-15T00:00:00.000Z', exitedAt: null,
            from: null, to: 'ship', outcome: 'resumed', timestamp: '2026-06-15T00:00:00.000Z' },
        ];
      },
      run: (ws) => runBackfill(ws, { occurrences: [occurrence('execute', ws.shas.execute)] }),
    },
    {
      id: 'R13', name: 'evidence dated AFTER the completion being recorded (H7)', refusedAt: 'history',
      setup: (ws) => {
        writeFileSync(path.join(ws.root, 'future.txt'), 'f\n');
        ws.git('add', '-A');
        execFileSync('git', ['commit', '-qm', 'future'], {
          cwd: ws.root,
          env: { ...process.env, GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' },
        });
        ws.shas.future = ws.git('rev-parse', 'HEAD').trim();
      },
      run: (ws) => runBackfill(ws, { occurrences: [occurrence('execute', ws.shas.future)] }),
    },
    {
      id: 'R20', name: 'feature already KILLED (build mode)', refusedAt: 'preflight',
      status: 'KILLED',
      run: (ws) => runBackfill(ws),
    },
    {
      id: 'R22', name: 'vision item missing or has no lifecycle', refusedAt: 'preflight',
      run: (ws) => runBackfill(ws, { item: { id: 'x' } }),
    },
    {
      id: 'R23', name: 'a pending batch record with no matching intent (BP-3)', refusedAt: 'recovery',
      guard: false,
      mutate: async (ws) => {
        const { backfillRequestDigest } = await import('../lib/completion-gate.js');
        ws.item.lifecycle.backfills = [{
          operation_id: '00000000-0000-4000-8000-000000000000',
          request_digest: backfillRequestDigest({
            featureCode: CODE, commitSha: ws.shas.head, testsPass: true, mode: 'build',
            filesChanged: ['lib/a.js'], reason: 'built before the lifecycle existed',
            occurrences: h1Occurrences(ws.shas),
          }),
          state: 'pending', reason: 'r', recordedAt: '2026-09-01T00:00:00.000Z',
          completionEvidence: { commit_sha: ws.shas.head, tests_attested: true },
          actor: 'agent:rest',
        }];
      },
      run: (ws) => runBackfill(ws),
    },
    {
      id: 'R24', name: 'a different backfill operation in flight', refusedAt: 'recovery',
      guard: false,
      setup: (ws) => {
        const p = path.join(ws.root, '.compose', 'data', 'completion-intents');
        mkdirSync(p, { recursive: true });
        writeFileSync(path.join(p, `${CODE}.json`), JSON.stringify({
          intent: 'backfill', request_digest: 'f'.repeat(64),
          operation_id: '00000000-0000-4000-8000-000000000001',
        }));
      },
      run: (ws) => runBackfill(ws),
    },
    {
      id: 'R25', name: 'an intent with `notes` ABSENT is a corrupt DTO (R3-4)', refusedAt: 'recovery',
      guard: false,
      before: async (ws) => {
        // Drive a real operation to a pending state, then remove one required
        // nullable field from the persisted intent.
        const restore = blockCompletionRecord(ws);
        try { await runBackfill(ws); } finally { restore(); }
        const intent = JSON.parse(readFileSync(ws.intentPath, 'utf8'));
        delete intent.notes;
        writeFileSync(ws.intentPath, JSON.stringify(intent, null, 2));
      },
      run: (ws) => runBackfill(ws),
      message: /missing notes/,
      // This row's setup deliberately writes; the snapshot is taken AFTER it.
    },
    {
      id: 'R26', name: 'a stored entry under this operation_id with a different enteredAt (R3-5)',
      refusedAt: 'history', guard: false,
      before: async (ws) => {
        const restore = blockCompletionRecord(ws);
        try { await runBackfill(ws); } finally { restore(); }
        const terminal = ws.item.lifecycle.phaseHistory.find((e) => e.operation_id != null);
        terminal.enteredAt = '2020-01-01T00:00:00.000Z';
        ws.store.updateLifecycle(ws.item.id, ws.item.lifecycle);
      },
      run: (ws) => runBackfill(ws),
      message: /already stored with different immutable fields/,
    },
    {
      id: 'R26b', name: 'guard unreachable: the CLI env points at an EXISTING non-CLI file',
      refusedAt: 'guard',
      env: (ws) => {
        // MUST be an existing file: resolveStratumBin only takes the env
        // candidate `if (envCandidate && existsSync(envCandidate))`, so a
        // nonexistent path silently falls back to the installed binary and the
        // guard is perfectly reachable.
        const f = path.join(ws.root, 'not-a-cli.txt');
        writeFileSync(f, 'this is not a CLI\n');
        assert.ok(existsSync(f));
        return f;
      },
      run: (ws) => runBackfill(ws),
    },
  ];

  for (const row of rows) {
    test(`${row.id} — ${row.name}`, async () => {
      const ws = await makeWorkspace({
        guard: row.guard ?? true,
        status: row.status ?? 'PLANNED',
        currentPhase: 'ship',
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      });
      const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
      try {
        if (row.setup) await row.setup(ws);
        if (row.mutate) {
          await row.mutate(ws);
          ws.store.updateLifecycle(ws.item.id, ws.item.lifecycle);
        }
        if (row.before) await row.before(ws);
        if (row.env) process.env.COMPOSE_STRATUM_TS_CLI_BIN = row.env(ws);

        const before = await snapshotOf(ws);
        const res = await row.run(ws);
        assert.equal(res.ok, false, `${row.id} must refuse: ${JSON.stringify(res)}`);
        assert.equal(res.refusedAt, row.refusedAt,
          `${row.id}: ${JSON.stringify(res.reasons)}`);
        if (row.message) assert.match(res.reasons.join(' '), row.message);
        await assertNothingWritten(ws, before);
      } finally {
        process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
        ws.cleanup();
      }
    });
  }

  test('R8 — a workspace reached through the macOS firmlink SUCCEEDS', {
    skip: !existsSync('/System/Volumes/Data') ? 'not macOS' : false,
  }, async () => {
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    try {
      const { realpathSync } = await import('node:fs');
      const firmlinked = `/System/Volumes/Data${realpathSync(ws.root)}`;
      assert.ok(existsSync(firmlinked));
      // An ABSOLUTE /System/Volumes/Data/... evidence ref would be refused as
      // non-repo-relative, which is correct. The strip matters on the CWD side,
      // which is what this row exercises: an ordinary repo-relative path, with
      // the workspace root itself reached through the firmlink.
      const when = new Date('2026-06-20T00:00:00.000Z');
      utimesSync(path.join(ws.root, 'blueprint.txt'), when, when);
      const res = await runBackfill(ws, {
        workspaceRoot: firmlinked,
        evidenceRoot: firmlinked,
        occurrences: [{ phase: 'blueprint', evidence: { kind: 'path', ref: 'blueprint.txt' } }],
      });
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      const occ = ws.item.lifecycle.phaseHistory.find((e) => e.phase === 'blueprint');
      assert.equal(occ.confidence, 0.6, 'a path is weaker evidence than a commit');
      assert.equal(occ.evidence.observedTime, when.toISOString());
    } finally { ws.cleanup(); }
  });

  test('R19 — an UNREGISTERED resource with no descriptor file succeeds', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      // No registerLegacy: the gate registers fresh, with the NEW graph, so no
      // upgrade is needed and the missing descriptor file is irrelevant.
      assert.equal(existsSync(path.join(ws.root, '.compose', 'guard-upgrades.json')), false);
      const res = await runBackfill(ws);
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      assert.equal(res.status, 'finalized');
      assert.equal(ws.item.lifecycle.backfills[0].upgrade, null, 'a fresh registration needs no upgrade');
      assert.equal(ws.item.lifecycle.backfills[0].guard_initial.registered, 'ship');
      const pol = await policyOf(ws);
      assert.ok(pol.terminal.includes('complete_backfilled'));
    } finally { ws.cleanup(); }
  });

  test('R27–R29 — custody refusals preserve code, hint, and the conditional manual recovery line', async () => {
    const { _testOnly_setCustodyBackend, HINT_ENROL, HINT_APPROVE } = await import('../lib/guard-custody.js');
    const rows = [
      { name: 'not approved', result: { ok: false, code: 'signature_not_approved', message: 'approval cancelled', hint: HINT_APPROVE }, hint: HINT_APPROVE, manual: false },
      { name: 'no backend', result: { ok: false, code: 'upgrade_descriptor_unavailable', message: 'no signing custody', hint: HINT_ENROL }, hint: HINT_ENROL, manual: true, backend: 'none' },
      { name: 'infrastructure failure', result: { ok: false, code: 'upgrade_descriptor_unavailable', message: 'signer unavailable', hint: HINT_ENROL }, hint: HINT_ENROL, manual: false },
    ];
    for (const row of rows) {
      const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
      try {
        await registerLegacy(ws);
        _testOnly_setCustodyBackend(row.backend ?? { backend: 'test', sign: () => row.result });
        const res = await runBackfill(ws);
        assert.equal(res.ok, false, row.name);
        assert.equal(res.refusedAt, 'upgrade');
        assert.equal(res.error.code, row.result.code);
        assert.equal(res.error.hint, row.hint);
        assert.equal(res.reasons.includes('regenerate with `compose guard descriptors`, have the operator re-sign it, and commit both files'), row.manual);
      } finally {
        _testOnly_setCustodyBackend(testCustody(SIGNER, CONFIRMATIONS));
        ws.cleanup();
      }
    }
  });

  test('R30/R31 — corrupt or group-writable published generations refuse without moving current or signing', async () => {
    const { ensureSignedDescriptors, currentGeneration } = await import('../lib/guard-descriptors.js');
    const { guardDescriptors } = await import('../server/stratum-client.js');
    for (const variant of ['corrupt-signature', 'group-writable']) {
      const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
      try {
        await registerLegacy(ws);
        const seeded = await ensureSignedDescriptors({
          workspaceRoot: ws.root, needChecksums: [], custody: testCustody(SIGNER, CONFIRMATIONS), verifier: guardDescriptors,
        });
        assert.equal(seeded.status, 'signed');
        const before = await currentGeneration(ws.root);
        const logsBefore = CONFIRMATIONS.length;
        if (variant === 'corrupt-signature') writeFileSync(before.sig, 'not a signature\n');
        else chmodSync(before.file, 0o660);
        const res = await runBackfill(ws);
        assert.equal(res.ok, false, variant);
        assert.equal(res.refusedAt, 'upgrade');
        assert.equal(res.error.code, 'upgrade_descriptor_unavailable');
        assert.equal((await currentGeneration(ws.root)).sha, before.sha, 'current never moves on an invalid generation');
        assert.equal(CONFIRMATIONS.length, logsBefore, 'invalid published bytes never trigger a replacement signature');
        if (variant === 'group-writable') assert.match(res.reasons.join(' '), /writable|mode/i);
      } finally { ws.cleanup(); }
    }
  });

  test('R21 — a guard already at a terminal state refuses at guard', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      const res = await runBackfill(ws);
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      const before = await snapshotOf(ws);
      const second = await runBackfill(ws, { reason: 'a genuinely different second backfill' });
      assert.equal(second.ok, false);
      assert.equal(second.refusedAt, 'guard');
      assert.match(second.reasons.join(' '), /already terminal/);
      await assertNothingWritten(ws, before);
    } finally { ws.cleanup(); }
  });
});

// ===========================================================================
// Codex impl-review round 1 — regression tests, one per finding
// ===========================================================================

describe('Codex r1 regressions', () => {
  test('#1 — the completion lock is held THROUGH the write sequence', async () => {
    // A test command that runs inside the lock (§5.2) gives a contender time to
    // start queueing while the operation is still only part-way through.
    const ws = await makeWorkspace({
      guard: false, currentPhase: 'ship',
      testCommand: [process.execPath, '-e', 'setTimeout(()=>process.exit(0), 1500)'],
    });
    const { acquireDirLock } = await import('../lib/dir-lock.js');
    const lockDir = path.join(ws.root, '.compose', 'data', 'locks', `completion-${CODE}`);
    // The projector is the one point inside the write sequence a caller can
    // observe from. It runs at step 6.4, long after the early-release point.
    const observed = { lockDirExists: null, owner: null };
    try {
      const gateP = runBackfill(ws, {
        testsPass: undefined,
        visionProjector: async (payload) => {
          observed.lockDirExists = existsSync(lockDir);
          try { observed.owner = readFileSync(path.join(lockDir, 'owner'), 'utf8'); }
          catch { observed.owner = null; }
          const { applyVerifiedProjection } = await import('../server/completion-projection.js');
          return applyVerifiedProjection(ws.store, {
            itemId: payload.visionItemId, featureCode: CODE, cwd: ws.root,
            consultGuard: payload.guarded ?? true, guardEnabledOverride: payload.guarded,
            evidence: { commitSha: payload.commitSha, ledgerRef: payload.ledgerRef },
          });
        },
      });

      // Wait until the gate is demonstrably inside the critical section.
      const deadline = Date.now() + 5000;
      while (!existsSync(lockDir) && Date.now() < deadline) await sleep(5);
      assert.ok(existsSync(lockDir), 'the gate must take the lock');

      const ownerFile = path.join(lockDir, 'owner');
      const ownerAtStart = readFileSync(ownerFile, 'utf8');

      let intentAtLockTime = null;
      let phaseAtLockTime = null;
      const contender = acquireDirLock(lockDir).then((release) => {
        // What the second caller observes the instant it wins the lock is what a
        // concurrent retry would have raced against.
        intentAtLockTime = existsSync(ws.intentPath);
        phaseAtLockTime = JSON.parse(readFileSync(
          path.join(ws.root, '.compose', 'data', 'vision-state.json'), 'utf8',
        )).items.find((i) => i.id === ws.item.id)?.lifecycle?.backfills?.[0]?.state ?? null;
        release();
      });

      const res = await gateP;
      await contender;
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      assert.equal(intentAtLockTime, false,
        'the second caller must not get the lock until the intent has been cleared');
      assert.equal(phaseAtLockTime, 'finalized',
        'the second caller must not get the lock until the record is finalized on disk');
      // The contender assertions above are necessary but not sufficient on their
      // own: a 25 ms poll can miss a short unlocked window entirely, and it did.
      // `sawLockDeepInside` is the discriminating one — the projector runs at
      // step 6.4, well past the point where the un-awaited return released the
      // lock (its first suspension, before the completion record).
      assert.equal(observed.lockDirExists, true,
        'the lock must still exist at step 6.4, deep inside the write sequence');
      assert.equal(observed.owner, ownerAtStart,
        'the lock must still be held by the SAME owner at step 6.4');
    } finally { ws.cleanup(); }
  });

  test('#2 — the PRODUCTION default projector writes through the live store', async () => {
    // No visionProjector argument anywhere: the default path is the one under
    // test. Before the fix it wrote a separately loaded disk snapshot, and
    // finalization then serialized the stale in-memory item straight over it.
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    try {
      const res = await runBackfill(ws);
      assert.equal(res.ok, true, JSON.stringify(res.reasons));
      assert.equal(res.status, 'finalized');
      assert.equal(res.visionProjection.ok, true);

      const onDisk = JSON.parse(readFileSync(
        path.join(ws.root, '.compose', 'data', 'vision-state.json'), 'utf8',
      )).items.find((i) => i.id === ws.item.id);
      assert.equal(onDisk.status, 'complete',
        'finalization must not serialize a stale item over the projection');
      assert.ok(onDisk.completion_projection, 'the projection stamp must survive finalization');
      assert.equal(onDisk.completion_projection.verified_by, 'canonical-status-only');
      // …and the live store agrees with disk.
      assert.equal(ws.store.items.get(ws.item.id).status, 'complete');
    } finally { ws.cleanup(); }
  });

  test('#3 — a projection that RETURNS {ok:false} keeps the record pending and the intent', async () => {
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    // Fail the save the projection itself performs: 6.0 writes the history and
    // the pending marker, then applyVerifiedProjection writes the item. No
    // throw is involved anywhere — the production projector REPORTS the failure,
    // and handling only exceptions finalized the operation regardless.
    const restore = failNthSave(ws.store, 2);
    try {
      const res = await runBackfill(ws);
      restore();
      assert.equal(res.ok, true, 'a projection failure is collected, not a refusal');
      assert.equal(res.partial, true);
      assert.equal(res.status, 'pending');
      assert.equal(res.visionProjection.ok, false);
      assert.ok(res.failures.some((f) => f.step === 'vision'),
        `the projection failure must be collected: ${JSON.stringify(res.failures)}`);
      assert.equal(res.backfill.state, 'pending');
      assert.ok(existsSync(ws.intentPath), 'the intent must survive so a retry resumes');

      // …and a retry then finishes the job.
      const retry = await runBackfill(ws);
      assert.equal(retry.ok, true, JSON.stringify(retry.reasons));
      assert.equal(retry.status, 'finalized');
      assert.equal(existsSync(ws.intentPath), false);
    } finally { restore(); ws.cleanup(); }
  });

  test('#4 — the persisted guard flag reaches the default verifier in BOTH directions', async () => {
    // Half two of §5.10a: guard OFF at the crash, flipped ON before the resume.
    // The operation must still complete WITHOUT consulting a guard, and the
    // filesystem proves it rather than a flag reading true.
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
    try {
      const restore = blockCompletionRecord(ws);
      try { await runBackfill(ws); } finally { restore(); }
      assert.ok(existsSync(ws.intentPath));
      assert.equal(JSON.parse(readFileSync(ws.intentPath, 'utf8')).guarded, false);

      const cfgPath = path.join(ws.root, '.compose', 'compose.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      cfg.capabilities.guard = true;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      const { marker, script } = spawnMarkerCli(ws);
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = script;
      await assertMarkerDetectsASpawn(ws, marker);

      const resume = await runBackfill(ws);
      assert.equal(resume.ok, true, JSON.stringify(resume.reasons));
      assert.equal(resume.guarded, false, 'the persisted flag governs, not live config');
      assert.equal(resume.status, 'finalized');
      assert.equal(existsSync(marker), false,
        'a resumed guard-off operation must consult no guard, in the projector OR the verifier');
      assert.equal(
        ws.store.items.get(ws.item.id).completion_projection.verified_by,
        'canonical-status-only',
      );
    } finally {
      process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
      ws.cleanup();
    }
  });

  test('#6 — a rolled-back finalization returns the RESTORED, still-pending record', async () => {
    const ws = await makeWorkspace({ guard: false, mode: 'fix', tracksJson: false, currentPhase: 'ship' });
    // fix mode: _save #1 is 6.0, #2 is the durable item.status write, #3 is 6.6.
    const restore = failNthSave(ws.store, 3);
    try {
      const res = await runBackfill(ws, {
        mode: 'fix',
        occurrences: [
          occurrence('diagnose', ws.shas.blueprint),
          occurrence('fix', ws.shas.execute),
        ],
      });
      restore();
      assert.equal(res.ok, true);
      assert.equal(res.partial, true);
      assert.equal(res.status, 'pending');
      assert.ok(res.failures.some((f) => f.step === 'finalize'));
      // The returned record must agree with disk and memory, both of which say
      // pending. It was previously the detached object already mutated to
      // `finalized`, so a caller reading it saw a completion that never happened.
      assert.equal(res.backfill.state, 'pending');
      assert.equal(res.backfill.finalizedAt, null);
      assert.equal(ws.item.lifecycle.backfills[0].state, 'pending');
      const onDisk = JSON.parse(readFileSync(
        path.join(ws.root, '.compose', 'data', 'vision-state.json'), 'utf8',
      )).items.find((i) => i.id === ws.item.id);
      assert.equal(onDisk.lifecycle.backfills[0].state, 'pending');
      assert.ok(existsSync(ws.intentPath), 'the intent survives so a retry resumes');
    } finally { restore(); ws.cleanup(); }
  });

  test('#5 — the intent the gate ACTUALLY persists validates against the production contract', async () => {
    const ws = await makeWorkspace({ guard: true, currentPhase: 'ship' });
    try {
      const restore = blockCompletionRecord(ws);
      try { await runBackfill(ws); } finally { restore(); }
      const intent = JSON.parse(readFileSync(ws.intentPath, 'utf8'));

      const Ajv = (await import('ajv')).default;
      const addFormats = (await import('ajv-formats')).default;
      const schema = JSON.parse(readFileSync(
        path.join(here, '..', 'contracts', 'lifecycle-backfill.schema.json'), 'utf8',
      ));
      const ajv = new Ajv({ strict: false, allErrors: true, $data: true });
      addFormats(ajv);
      const validate = ajv.compile({
        ...schema, $ref: '#/definitions/BackfillIntent', $id: `${schema.$id}#live`,
      });
      assert.equal(validate(intent), true, ajv.errorsText(validate.errors));
      assert.equal(intent.guarded, true);
      assert.equal(intent.envelope.expected_policy_checksum, intent.policy_checksum);
    } finally { ws.cleanup(); }
  });
});

// ===========================================================================
// Codex impl-review round 2 — the live path's error boundary (finding #2)
// ===========================================================================

describe('Codex r2 regressions', () => {
  /**
   * Make the step-6.2 re-read return null, and ONLY that read.
   *
   * The re-read is identified by what has already happened on disk: it is the
   * first `getFeature` after `recordCompletion` appended to `completions[]`.
   * `providerFor` builds a fresh LocalFileProvider per call, so the seam is the
   * prototype, which is an ordinary mutable object rather than a frozen ESM
   * namespace.
   */
  async function nullTheStatusReread() {
    const { LocalFileProvider } = await import('../lib/tracker/local-provider.js');
    const real = LocalFileProvider.prototype.getFeature;
    LocalFileProvider.prototype.getFeature = async function patched(code) {
      const f = await real.call(this, code);
      if (f && Array.isArray(f.completions) && f.completions.length > 0) return null;
      return f;
    };
    return () => { LocalFileProvider.prototype.getFeature = real; };
  }

  test('#2 — a null re-read on the LIVE path still THROWS, it does not refuse at write', async () => {
    // Parity with 82ef056: the re-read and the status preparation sat outside the
    // persistence try, so a broken precondition propagated. Folding them into the
    // shared helper turned it into `refusedAt:'write'`, which moves
    // /lifecycle/complete from HTTP 400 to 422 and replaces record_completion's
    // real exception with COMPLETION_GATE_REFUSED.
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    const restore = await nullTheStatusReread();
    try {
      const { completionGate } = await import('../lib/completion-gate.js');
      await assert.rejects(
        () => completionGate({
          featureCode: CODE,
          commitSha: ws.shas.head,
          testsPass: true,
          filesChanged: ['lib/a.js'],
          workspaceRoot: ws.root,
          mode: 'build',
        }),
        (e) => {
          // Any thrown error is the point; what must NOT happen is a resolved
          // `{ok:false, refusedAt:'write'}`.
          assert.ok(e instanceof Error);
          assert.doesNotMatch(String(e.message), /COMPLETION_GATE_REFUSED/);
          return true;
        },
      );
    } finally { restore(); ws.cleanup(); }
  });

  test('#2 — a failed PERSIST on the live path still refuses at write', async () => {
    // The other half of the boundary: a genuine write failure keeps its old
    // `refusedAt:'write'` shape, so restoring the throw did not turn real write
    // failures into exceptions.
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    const { LocalFileProvider } = await import('../lib/tracker/local-provider.js');
    const real = LocalFileProvider.prototype.persistFeatureRaw;
    // Only the STATUS write, not the completion-record write at step 6.1 — both
    // go through this primitive, and 6.1 would otherwise fail first.
    LocalFileProvider.prototype.persistFeatureRaw = async function patched(code, obj) {
      if (obj?.status === 'COMPLETE') throw new Error('injected: disk full');
      return real.call(this, code, obj);
    };
    try {
      const { completionGate } = await import('../lib/completion-gate.js');
      const res = await completionGate({
        featureCode: CODE,
        commitSha: ws.shas.head,
        testsPass: true,
        filesChanged: ['lib/a.js'],
        workspaceRoot: ws.root,
        mode: 'build',
      });
      assert.equal(res.ok, false);
      assert.equal(res.refusedAt, 'write');
      assert.match(res.reasons.join(' '), /status could not be set: injected: disk full/);
    } finally {
      LocalFileProvider.prototype.persistFeatureRaw = real;
      ws.cleanup();
    }
  });

  test('#2 — the BACKFILL door keeps refusing at write, and keeps its intent', async () => {
    // Deliberately asymmetric with the live path: a backfill holds a write-ahead
    // intent, and §5.11 requires a durable-write failure to refuse at `write`
    // with the intent kept so a retry resumes. A thrown read would strand it.
    const ws = await makeWorkspace({ guard: false, currentPhase: 'ship' });
    const restore = await nullTheStatusReread();
    try {
      const res = await runBackfill(ws);
      restore();
      assert.equal(res.ok, false);
      assert.equal(res.refusedAt, 'write');
      assert.ok(existsSync(ws.intentPath), 'the intent is kept so a retry resumes');

      // …and the retry then completes, proving the refusal really was resumable.
      const retry = await runBackfill(ws);
      assert.equal(retry.ok, true, JSON.stringify(retry.reasons));
      assert.equal(retry.status, 'finalized');
      assert.equal(ws.featureStatus(), 'COMPLETE');
    } finally { restore(); ws.cleanup(); }
  });
});
