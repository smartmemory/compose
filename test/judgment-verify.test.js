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

test('empty non-structural directory is unexpected tree drift', async (t) => {
  const cwd = repo(t);
  mkdirSync(join(cwd, 'docs', 'judgment', 'stray'));

  const result = await verifyJudgmentCanon(cwd);
  assert.equal(result.ok, false);
  assert.deepEqual(result.treeDrift, [
    { path: 'docs/judgment/stray', kind: 'unexpected' },
  ]);
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
