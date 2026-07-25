import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeRecordHashes,
  writeManifest,
} from '../lib/judgment-attest.js';
import { regenerateProjections } from '../lib/judgment-gen.js';
import { verifyJudgmentCanon } from '../lib/judgment-verify.js';
import { withJudgmentLock } from '../lib/judgment-writer.js';

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'jverify-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const records = join(cwd, 'docs', 'judgment', 'records', 'people');
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, 'ada.json'), `${JSON.stringify({
    slug: 'ada',
    display_name: 'Ada',
    facts: [],
    edges: [],
    open_fields: [],
    load_links: [],
  })}\n`);
  regenerateProjections(cwd);
  writeManifest(cwd, computeRecordHashes(cwd));
  return cwd;
}

test('clean generated tree is canon-clean', async (t) => {
  const cwd = repo(t);

  assert.deepEqual(await verifyJudgmentCanon(cwd), {
    ok: true,
    treeDrift: [],
    projectionDrift: [],
    recordDrift: [],
  });
});

test('stray root projection file is unexpected tree drift', async (t) => {
  const cwd = repo(t);
  writeFileSync(join(cwd, 'docs', 'judgment', 'FAKE.md'), '# fake\n');

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, [
    { path: 'docs/judgment/FAKE.md', kind: 'unexpected' },
  ]);
});

test('stray file in the people projection directory is unexpected', async (t) => {
  const cwd = repo(t);
  const people = join(cwd, 'docs', 'judgment', 'people');
  mkdirSync(people, { recursive: true });
  writeFileSync(join(people, 'fake.txt'), 'not a projection\n');

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, [
    { path: 'docs/judgment/people/fake.txt', kind: 'unexpected' },
  ]);
});

// Adjudicated (Task 2 review finding 3, partially refuted): an EMPTY directory
// carries no canon, and UndoLog.restore unlinks files without removing their
// directories — so a rolled-back op legitimately leaves an empty
// records/positions/<slug>/ behind. Reporting empty dirs would false-RED on
// correct behaviour, which is worse than tolerating a stray empty dir. A stray
// dir with anything IN it is still caught, via its files.
test('an EMPTY stray directory is not drift (rollback legitimately leaves these)', async (t) => {
  const cwd = repo(t);
  mkdirSync(join(cwd, 'docs', 'judgment', 'stray'));
  mkdirSync(join(cwd, 'docs', 'judgment', 'records', 'positions', 'rolled-back'), { recursive: true });

  const result = await verifyJudgmentCanon(cwd);
  assert.deepEqual(result.treeDrift, []);
  assert.equal(result.ok, true);
});

test('a NON-EMPTY stray directory is caught through its contents', async (t) => {
  const cwd = repo(t);
  mkdirSync(join(cwd, 'docs', 'judgment', 'stray'));
  writeFileSync(join(cwd, 'docs', 'judgment', 'stray', 'planted.md'), 'not canon\n');

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, [
    { path: 'docs/judgment/stray', kind: 'unexpected' },
    { path: 'docs/judgment/stray/planted.md', kind: 'unexpected' },
  ]);
});

// A planted file under records/ is caught by the RECORD tier, not the tree tier:
// recordFileSet() treats every file under records/** as a record, so the planted
// file is unknown to the manifest and reports as `added` drift. (Its parent dir
// therefore counts as expected — the file itself is the finding.)
test('a planted file under records/ is caught as added record drift', async (t) => {
  const cwd = repo(t);
  const garbage = join(cwd, 'docs', 'judgment', 'records', 'garbage');
  mkdirSync(garbage, { recursive: true });
  writeFileSync(join(garbage, 'planted.json'), '{"not":"canon"}\n');

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.ok(result.recordDrift.some(
    (d) => d.path === 'docs/judgment/records/garbage/planted.json' && d.kind === 'added',
  ));
});

test('symlink anywhere under the judgment tree is rejected without following it', async (t) => {
  const cwd = repo(t);
  symlinkSync('REGISTER.md', join(cwd, 'docs', 'judgment', 'register-link.md'));

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, [
    { path: 'docs/judgment/register-link.md', kind: 'symlink' },
  ]);
});

test('projection byte drift surfaces from the fixed-point checker', async (t) => {
  const cwd = repo(t);
  const projection = join(cwd, 'docs', 'judgment', 'REGISTER.md');
  writeFileSync(projection, `${readFileSync(projection, 'utf8')}\n`);

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, []);
  assert.deepEqual(result.projectionDrift, [
    'docs/judgment/REGISTER.md (drift)',
  ]);
  assert.deepEqual(result.recordDrift, []);
});

test('unstamped record tamper surfaces from record attestation', async (t) => {
  const cwd = repo(t);
  const record = join(cwd, 'docs', 'judgment', 'records', 'people', 'ada.json');
  const person = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(record, `${JSON.stringify({ ...person, tampered: true })}\n`);

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, []);
  assert.deepEqual(result.projectionDrift, []);
  assert.deepEqual(result.recordDrift, [
    { path: 'docs/judgment/records/people/ada.json', kind: 'modified' },
  ]);
});

test('verification waits for the writer lock before reading canon state', async (t) => {
  const cwd = repo(t);
  let verification;

  await withJudgmentLock(cwd, async () => {
    verification = verifyJudgmentCanon(cwd);
    const outcome = await Promise.race([
      verification.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 60)),
    ]);
    assert.equal(outcome, 'blocked');
  });

  assert.equal((await verification).ok, true);
});

// ── the fail-closed pair (Task 2 review findings 1 + 2, and the Task 1 High) ──
// All three shared one root cause: a baseline stored inside the tree it attests
// dies with that tree. The manifest now lives at .compose/judgment-attest.json,
// which is git-tracked but outside docs/judgment/**. These two tests pin the
// distinction that relocation buys — "never had a canon" vs "canon deleted".

test('a project with no judgment canon at all verifies GREEN', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'jverify-nocanon-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, true);
  assert.deepEqual(result.projectionDrift, []);
});

test('wiping the whole judgment tree is RED (the baseline survives outside it)', async (t) => {
  const cwd = repo(t);
  // baseline is established by repo(); now destroy the entire canon
  rmSync(join(cwd, 'docs', 'judgment'), { recursive: true, force: true });

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  // every remembered record reports removed — the deletion cannot hide
  assert.ok(result.recordDrift.length > 0);
  assert.ok(result.recordDrift.every((d) => d.kind === 'removed'));
});
