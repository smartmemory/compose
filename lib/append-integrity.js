/**
 * append-integrity.js — integrity for append-only canon files.
 *
 * COMP-CANON-OVERRIDE S1. Shared with COMP-CANON-ATTEST, which needs the same
 * primitive for `docs/judgment/records/ledger.jsonl`.
 *
 * A whole-file hash over an append-only file churns on every append and so
 * carries no signal about history. The useful question is narrower: **is the
 * prefix we previously attested still byte-identical?** That is what
 * `{length, prefix_hash}` answers — `prefix_hash` is sha256 over
 * `bytes[0, length)`, so a legitimate append (which only extends) verifies
 * clean while any rewrite of earlier content does not.
 *
 * A `{length, tail_hash}` variant was tried first and rejected: hashing the
 * trailing bytes says nothing about the prefix, so an in-place edit of an
 * early row that preserves total byte length — the shape a careless
 * `sed -i 's/park/ship/'` takes — produced a byte-identical attestation.
 *
 * SCOPE: this is drift detection, not enforcement. It catches careless and
 * accidental corruption. A deliberate actor who rewrites the file AND
 * recomputes the baseline passes, because both live in the workspace the
 * actor can write. See design.md, "The in-workspace ceiling".
 *
 * Pure — no I/O. Callers own reading the file and storing the baseline.
 */
import { createHash } from 'node:crypto';

/** @typedef {{ length: number, prefix_hash: string }} AppendBaseline */
/** @typedef {{ ok: boolean, kind: 'clean'|'shrunk'|'prefix_changed'|'malformed_baseline' }} AppendVerdict */

const HEX64 = /^[0-9a-f]{64}$/;

function toBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Capture the attestable state of an append-only file.
 *
 * @param {Buffer|string} bytes current file contents
 * @returns {AppendBaseline}
 */
export function baselineFor(bytes) {
  const buf = toBuffer(bytes);
  return { length: buf.length, prefix_hash: sha256(buf) };
}

/**
 * Verify that `bytes` is `baseline` plus zero or more appended bytes.
 *
 * Fails closed on a malformed baseline: a missing or nonsensical baseline is
 * never treated as "nothing to check". That mirrors the malformed-record rule
 * the judgment attestation already follows (S5 R4).
 *
 * @param {Buffer|string} bytes current file contents
 * @param {AppendBaseline} baseline previously attested state
 * @returns {AppendVerdict}
 */
export function verifyAppend(bytes, baseline) {
  if (
    !baseline
    || typeof baseline !== 'object'
    || !Number.isInteger(baseline.length)
    || baseline.length < 0
    || typeof baseline.prefix_hash !== 'string'
    || !HEX64.test(baseline.prefix_hash)
  ) {
    return { ok: false, kind: 'malformed_baseline' };
  }

  const buf = toBuffer(bytes);
  if (buf.length < baseline.length) return { ok: false, kind: 'shrunk' };
  if (sha256(buf.subarray(0, baseline.length)) !== baseline.prefix_hash) {
    return { ok: false, kind: 'prefix_changed' };
  }
  return { ok: true, kind: 'clean' };
}
