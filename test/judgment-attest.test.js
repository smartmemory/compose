import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFileSet, computeRecordHashes, writeManifest, verifyRecords, stampRecord, removeRecord } from '../lib/judgment-attest.js';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'jattest-'));
  mkdirSync(join(d, 'docs/judgment/records/joints'), { recursive: true });
  mkdirSync(join(d, 'docs/judgment/records/intents'), { recursive: true });
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'x' }));
  writeFileSync(join(d, 'docs/judgment/records/intents/pending.json'), JSON.stringify({ id: 'pending' }));
  writeFileSync(join(d, 'docs/judgment/records/ledger.jsonl'), '{"e":1}\n');
  return d;
}

test('recordFileSet includes ledger.jsonl, excludes .attest.json', () => {
  const d = repo();
  writeFileSync(join(d, 'docs/judgment/records/.attest.json'), '{}');
  const set = recordFileSet(d);
  assert.ok(set.some(p => p.endsWith('records/ledger.jsonl')));
  assert.ok(set.some(p => p.endsWith('joints/x.json')));
  assert.ok(set.some(p => p.endsWith('intents/pending.json')));
  assert.ok(!set.some(p => p.endsWith('.attest.json')));
});

test('verifyRecords: clean after stamping the full set', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  assert.equal(verifyRecords(d).ok, true);
});

test('verifyRecords: a content edit with stale manifest = modified drift', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'TAMPERED' }));
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some(x => x.kind === 'modified' && x.path.endsWith('joints/x.json')));
});

test('verifyRecords: a malformed json record fails CLOSED (not silently omitted)', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), '{not json');
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some(x => x.kind === 'malformed'));
});

test('verifyRecords: added record with no manifest entry = added drift', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  writeFileSync(join(d, 'docs/judgment/records/joints/new.json'), JSON.stringify({ id: 'n' }));
  assert.ok(verifyRecords(d).drift.some(x => x.kind === 'added'));
});

test('stampRecord updates only its own entry (does not re-bless a sibling)', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  // tamper a sibling, then legitimately stamp a DIFFERENT record
  writeFileSync(join(d, 'docs/judgment/records/joints/x.json'), JSON.stringify({ id: 'TAMPERED' }));
  writeFileSync(join(d, 'docs/judgment/records/joints/y.json'), JSON.stringify({ id: 'y' }));
  stampRecord(d, 'docs/judgment/records/joints/y.json');
  // x must STILL be flagged — stamping y did not launder x
  assert.ok(verifyRecords(d).drift.some(p => p.path.endsWith('joints/x.json')));
});

test('removeRecord drops a deleted record from the manifest', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  const relPath = 'docs/judgment/records/intents/pending.json';
  rmSync(join(d, relPath));
  removeRecord(d, relPath);
  assert.equal(verifyRecords(d).ok, true);
});

test('deleting a record without removeRecord reports removed drift', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  const relPath = 'docs/judgment/records/intents/pending.json';
  rmSync(join(d, relPath));
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some(x => x.kind === 'removed' && x.path === relPath));
});

test('fail-closed: wiping the whole records dir is RED (manifest survives outside it)', () => {
  const d = repo();
  writeManifest(d, computeRecordHashes(d));
  // Simulate `rm -rf docs/judgment/records`. The manifest lives at
  // .compose/judgment-attest.json, OUTSIDE docs/judgment, so it survives.
  rmSync(join(d, 'docs/judgment/records'), { recursive: true, force: true });
  const r = verifyRecords(d);
  assert.equal(r.ok, false);
  // every prior record now reads as removed drift, not a false green
  assert.ok(r.drift.length >= 3);
  assert.ok(r.drift.every(x => x.kind === 'removed'));
});

test('fresh repo (no manifest, no records) is legitimately GREEN', () => {
  const d = mkdtempSync(join(tmpdir(), 'jattest-fresh-'));
  const r = verifyRecords(d);
  assert.equal(r.ok, true);
  assert.equal(r.drift.length, 0);
});
