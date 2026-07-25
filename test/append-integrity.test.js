/**
 * COMP-CANON-OVERRIDE S1 — append-only integrity.
 *
 * The load-bearing case is the one that killed the first design: a
 * length-preserving in-place edit of an EARLIER row. A `{length, tail_hash}`
 * scheme returns a byte-identical attestation for it. `{length, prefix_hash}`
 * must not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { baselineFor, verifyAppend } from '../lib/append-integrity.js';

const row = (id, verdict) => `${JSON.stringify({ id, op: 'decide', verdict })}\n`;
const LEDGER = Buffer.from(row(1, 'ship the thing') + row(2, 'park the other thing') + row(3, 'kill the third'));

describe('append-integrity', () => {
  test('baseline captures length and a hash of the whole prefix', () => {
    const b = baselineFor(LEDGER);
    assert.equal(b.length, LEDGER.length);
    assert.match(b.prefix_hash, /^[0-9a-f]{64}$/);
  });

  test('an unchanged file verifies clean', () => {
    assert.deepEqual(verifyAppend(LEDGER, baselineFor(LEDGER)), { ok: true, kind: 'clean' });
  });

  test('a legitimate append verifies clean', () => {
    const b = baselineFor(LEDGER);
    const appended = Buffer.concat([LEDGER, Buffer.from(row(4, 'ship the fourth'))]);
    assert.deepEqual(verifyAppend(appended, b), { ok: true, kind: 'clean' });
  });

  test('a LENGTH-PRESERVING edit to an earlier row is detected', () => {
    // The exact trap that sank {length, tail_hash}: "park" -> "ship", same bytes.
    const b = baselineFor(LEDGER);
    const tampered = Buffer.from(LEDGER.toString().replace('park the other', 'ship the other'));
    assert.equal(tampered.length, LEDGER.length, 'precondition: the tamper preserves total length');
    assert.deepEqual(verifyAppend(tampered, b), { ok: false, kind: 'prefix_changed' });
  });

  test('an earlier-row edit that also appends is still detected', () => {
    const b = baselineFor(LEDGER);
    const tampered = Buffer.concat([
      Buffer.from(LEDGER.toString().replace('park the other', 'ship the other')),
      Buffer.from(row(4, 'and carry on')),
    ]);
    assert.deepEqual(verifyAppend(tampered, b), { ok: false, kind: 'prefix_changed' });
  });

  test('truncation is detected as shrunk, not clean', () => {
    const b = baselineFor(LEDGER);
    assert.deepEqual(verifyAppend(LEDGER.subarray(0, 40), b), { ok: false, kind: 'shrunk' });
  });

  test('an empty baseline accepts any content as a first append', () => {
    const b = baselineFor(Buffer.alloc(0));
    assert.equal(b.length, 0);
    assert.deepEqual(verifyAppend(LEDGER, b), { ok: true, kind: 'clean' });
  });

  test('accepts strings as well as buffers', () => {
    const b = baselineFor(LEDGER.toString());
    assert.deepEqual(verifyAppend(LEDGER.toString(), b), { ok: true, kind: 'clean' });
  });

  test('a malformed baseline fails closed rather than passing', () => {
    for (const bad of [null, undefined, {}, { length: 5 }, { prefix_hash: 'x' }, { length: -1, prefix_hash: 'x' }]) {
      const result = verifyAppend(LEDGER, bad);
      assert.equal(result.ok, false, `baseline ${JSON.stringify(bad)} must not verify clean`);
      assert.equal(result.kind, 'malformed_baseline');
    }
  });
});
