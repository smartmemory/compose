import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeRecordHashes,
  writeManifest,
} from '../lib/judgment-attest.js';
import { regenerateProjections } from '../lib/judgment-gen.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');
const RECORD_REL = join('docs', 'judgment', 'records', 'people', 'ada.json');
const PROJECTION_REL = join('docs', 'judgment', 'REGISTER.md');

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'canon-guard-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const recordPath = join(cwd, RECORD_REL);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify({
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

function emptyFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'canon-guard-cli-empty-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function runGuardVerify(cwd, ...args) {
  return spawnSync(
    process.execPath,
    [COMPOSE_BIN, 'guard', 'verify', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, COMPOSE_TARGET: cwd },
      timeout: 15000,
    },
  );
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test('compose guard verify exits 0 for a clean judgment canon', (t) => {
  const cwd = fixture(t);

  const result = runGuardVerify(cwd);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Judgment canon drift detection passed\./);
});

test('compose guard verify reports a raw-edited projection', (t) => {
  const cwd = fixture(t);
  const projectionPath = join(cwd, PROJECTION_REL);
  writeFileSync(projectionPath, `${readFileSync(projectionPath, 'utf8')}\nraw edit\n`);

  const result = runGuardVerify(cwd);

  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /Projection drift \(records-anchored\):/);
  assert.match(output(result), /docs\/judgment\/REGISTER\.md \[drift\]/);
});

test('compose guard verify reports a stray judgment file', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'docs', 'judgment', 'FAKE.md'), '# fake\n');

  const result = runGuardVerify(cwd);

  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /Tree drift \(records-anchored file set\):/);
  assert.match(output(result), /docs\/judgment\/FAKE\.md \[unexpected\]/);
});

test('compose guard verify reports a raw-edited record', (t) => {
  const cwd = fixture(t);
  const recordPath = join(cwd, RECORD_REL);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, `${JSON.stringify({ ...record, raw_edit: true })}\n`);

  const result = runGuardVerify(cwd);

  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /Record drift detection \(careless changes only\):/);
  assert.match(output(result), /docs\/judgment\/records\/people\/ada\.json \[modified\]/);
});

test('compose guard verify --fix repairs projection-only drift and exits 0', (t) => {
  const cwd = fixture(t);
  const projectionPath = join(cwd, PROJECTION_REL);
  const generated = readFileSync(projectionPath, 'utf8');
  writeFileSync(projectionPath, `${generated}\nraw edit\n`);

  const result = runGuardVerify(cwd, '--fix');

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Fixed projection drift:/);
  assert.match(result.stdout, /docs\/judgment\/REGISTER\.md \[drift\]/);
  assert.equal(readFileSync(projectionPath, 'utf8'), generated);
});

test('compose guard verify --fix never blesses modified record drift', (t) => {
  const cwd = fixture(t);
  const recordPath = join(cwd, RECORD_REL);
  const manifestPath = join(cwd, '.compose', 'judgment-attest.json');
  const manifestBefore = readFileSync(manifestPath, 'utf8');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, `${JSON.stringify({ ...record, raw_edit: true })}\n`);

  const fixed = runGuardVerify(cwd, '--fix');

  assert.equal(fixed.status, 1, output(fixed));
  assert.match(output(fixed), /Record drift was deliberately not fixed/);
  assert.match(output(fixed), /docs\/judgment\/records\/people\/ada\.json \[modified\]/);
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore);

  const verifiedAgain = runGuardVerify(cwd);
  assert.equal(verifiedAgain.status, 1, output(verifiedAgain));
  assert.match(output(verifiedAgain), /docs\/judgment\/records\/people\/ada\.json \[modified\]/);
});

test('compose guard verify exits 0 when the repo has no judgment canon', (t) => {
  const cwd = emptyFixture(t);

  const result = runGuardVerify(cwd);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Judgment canon drift detection passed\./);
});

// ── `compose guard init` — the trust-on-first-use bootstrap ────────────────────
// This subcommand exists BECAUSE `verify --fix` correctly refuses to stamp
// records: without a separate deliberate bootstrap there is no way to create the
// first baseline, and drift detection would report every record as `added`
// forever. It is kept distinct so that trusting the current records is an
// explicit, auditable act rather than a side effect of a repair flag.

function runGuardInit(cwd, ...args) {
  return spawnSync(
    process.execPath,
    [COMPOSE_BIN, 'guard', 'init', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, COMPOSE_TARGET: cwd }, timeout: 15000 },
  );
}

function unbaselinedFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'canon-guard-init-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), '{}\n');
  const recordPath = join(cwd, RECORD_REL);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify({
    slug: 'ada', display_name: 'Ada', facts: [], edges: [], open_fields: [], load_links: [],
  })}\n`);
  regenerateProjections(cwd);
  return cwd;                       // deliberately NO writeManifest — that is init's job
}

const MANIFEST_REL = join('.compose', 'judgment-attest.json');

test('guard init baselines an unbaselined canon and makes verify green', (t) => {
  const cwd = unbaselinedFixture(t);

  // before init: every record is unknown to drift detection
  assert.equal(runGuardVerify(cwd).status, 1);

  const init = runGuardInit(cwd);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /trusted AS-IS/);
  assert.ok(JSON.parse(readFileSync(join(cwd, MANIFEST_REL), 'utf8'))[
    'docs/judgment/records/people/ada.json'
  ]);

  assert.equal(runGuardVerify(cwd).status, 0);
});

test('guard init REFUSES to overwrite an existing baseline (else it is the laundering tool)', (t) => {
  const cwd = fixture(t);                       // already baselined
  const before = readFileSync(join(cwd, MANIFEST_REL), 'utf8');

  // raw-edit a record, then try to bless it by re-initing
  const recordPath = join(cwd, RECORD_REL);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, `${JSON.stringify({ ...record, raw_edit: true })}\n`);

  const init = runGuardInit(cwd);
  assert.equal(init.status, 1, init.stdout + init.stderr);
  assert.match(init.stderr, /already exists/);
  assert.equal(readFileSync(join(cwd, MANIFEST_REL), 'utf8'), before, 'baseline must be untouched');
  // and the edit is still drift
  assert.equal(runGuardVerify(cwd).status, 1);
});

test('guard init rejects --cwd instead of silently baselining the wrong repo', (t) => {
  const cwd = unbaselinedFixture(t);
  const other = mkdtempSync(join(tmpdir(), 'canon-guard-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));

  const init = runGuardInit(cwd, '--cwd', other);
  assert.equal(init.status, 1, init.stdout + init.stderr);
  assert.match(init.stderr, /not supported here/);
  // "no baseline written ANYWHERE" — the invocation workspace AND the named one.
  // Asserting only the former was tautological: an implementation that wrote the
  // baseline into `other` and then exited 1 would have satisfied it.
  assert.throws(() => readFileSync(join(cwd, MANIFEST_REL), 'utf8'));
  assert.throws(() => readFileSync(join(other, MANIFEST_REL), 'utf8'));
});

// ── Task 4 review fixes ────────────────────────────────────────────────────────

test('guard init refuses a manifest whose contents are literally null (EEXIST, not "absent")', (t) => {
  const cwd = unbaselinedFixture(t);
  // A parsed-value check reads JSON `null` as "no baseline" and overwrites a real
  // file. Existence must be decided by the filesystem + an exclusive write.
  mkdirSync(dirname(join(cwd, MANIFEST_REL)), { recursive: true });
  writeFileSync(join(cwd, MANIFEST_REL), 'null\n');

  const init = runGuardInit(cwd);
  assert.equal(init.status, 1, init.stdout + init.stderr);
  assert.match(init.stderr, /already exists/);
  assert.equal(readFileSync(join(cwd, MANIFEST_REL), 'utf8'), 'null\n', 'must not overwrite');
});

test('guard init refuses to baseline a malformed ledger.jsonl (R4 fail-closed)', (t) => {
  const cwd = unbaselinedFixture(t);
  writeFileSync(
    join(cwd, 'docs', 'judgment', 'records', 'ledger.jsonl'),
    '{"kind":"note"}\n{ this line is not json\n',
  );

  const init = runGuardInit(cwd);
  assert.equal(init.status, 1, init.stdout + init.stderr);
  assert.match(init.stderr, /Refusing to baseline/);
  assert.throws(() => readFileSync(join(cwd, MANIFEST_REL), 'utf8'), 'no baseline on malformed canon');
});

test('a malformed ledger.jsonl is drift, not a silent pass', (t) => {
  const cwd = fixture(t);                       // already baselined and clean
  assert.equal(runGuardVerify(cwd).status, 0);

  writeFileSync(
    join(cwd, 'docs', 'judgment', 'records', 'ledger.jsonl'),
    '{ not json at all\n',
  );
  const verify = runGuardVerify(cwd);
  assert.equal(verify.status, 1, verify.stdout + verify.stderr);
});

test('guard verify --fix never writes the record manifest at all', (t) => {
  const cwd = fixture(t);
  const before = readFileSync(join(cwd, MANIFEST_REL), 'utf8');

  // projection drift ONLY — the branch that used to re-stamp the manifest
  const projectionPath = join(cwd, PROJECTION_REL);
  writeFileSync(projectionPath, `${readFileSync(projectionPath, 'utf8')}\nraw projection edit\n`);

  const fixed = runGuardVerify(cwd, '--fix');
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.equal(
    readFileSync(join(cwd, MANIFEST_REL), 'utf8'), before,
    '--fix must leave the record manifest byte-identical even when records are clean',
  );
});
