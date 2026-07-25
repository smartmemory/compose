/**
 * COMP-CANON-OVERRIDE S2 — grant lifecycle.
 *
 * The load-bearing properties, in the order they can fail:
 *   - ledger-and-baseline BEFORE the token exists (over-record, never under-record)
 *   - single-use, proven against real concurrent processes, not a mocked lock
 *   - expiry from immutable `expires_at`, never file mtime (a checkout resets mtime)
 *   - a token with no ledger row is not consumable
 *
 * Scope reminder: this is drift/audit tooling. A determined actor who writes a
 * token AND its ledger row AND the baseline passes — see design.md, "The
 * in-workspace ceiling".
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintGrant, claimGrant, readOverrideLedger, LEDGER_REL, ATTEST_REL, GRANTS_REL,
} from '../lib/canon-override.js';

const JUDGMENT = 'docs/judgment/records/joints/probe.json';
let ws;

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'canon-override-'));
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'judgment', 'records', 'joints'), { recursive: true });
  return dir;
}

beforeEach(() => { ws = makeWorkspace(); });

describe('mintGrant — validation', () => {
  test('rejects an empty or whitespace reason', () => {
    for (const reason of ['', '   ', '\n\t', undefined, null]) {
      assert.throws(
        () => mintGrant(ws, { path: JUDGMENT, reason, operation: 'repair' }),
        /reason/i,
        `reason ${JSON.stringify(reason)} must be rejected`,
      );
    }
  });

  test('rejects a path that is not override-eligible', () => {
    for (const path of [
      '.compose/canon-overrides.jsonl',      // governance — would authorise rewriting the audit trail
      '.compose/canon-overrides-attest.json',
      '.compose/data/canon-grants/x.json',
      'ROADMAP.md',                          // ship-only: the hook already allows it
      'src/unguarded.js',                    // nothing is blocking it
    ]) {
      assert.throws(
        () => mintGrant(ws, { path, reason: 'because', operation: 'repair' }),
        /eligible/i,
        `${path} must not be grantable`,
      );
    }
  });

  test('a rejected grant writes NOTHING — no ledger row, no token', () => {
    assert.throws(() => mintGrant(ws, { path: 'ROADMAP.md', reason: 'x', operation: 'y' }));
    assert.equal(existsSync(join(ws, LEDGER_REL)), false);
    assert.equal(existsSync(join(ws, GRANTS_REL)), false);
  });
});

describe('mintGrant — ledger-first', () => {
  test('writes the ledger row and the baseline before the token', () => {
    const grant = mintGrant(ws, { path: JUDGMENT, reason: 'malformed record', operation: 'repair' });

    const rows = readOverrideLedger(ws);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, JUDGMENT);
    assert.equal(rows[0].reason, 'malformed record');
    assert.equal(rows[0].operation, 'repair');
    assert.equal(rows[0].token_id, grant.token_id);
    assert.ok(rows[0].ts, 'row carries a timestamp');

    assert.ok(existsSync(join(ws, ATTEST_REL)), 'baseline exists');
    assert.ok(existsSync(join(ws, GRANTS_REL, `${grant.token_id}.json`)), 'token exists');
  });

  test('actor is stamped by the tool and cannot be supplied by the caller', () => {
    const grant = mintGrant(ws, {
      path: JUDGMENT, reason: 'r', operation: 'o', actor: 'owner',
    });
    assert.equal(readOverrideLedger(ws)[0].actor, 'agent');
    const token = JSON.parse(readFileSync(join(ws, GRANTS_REL, `${grant.token_id}.json`), 'utf8'));
    assert.equal(token.actor, 'agent');
  });

  test('the token carries immutable issued_at/expires_at, not an mtime dependency', () => {
    const grant = mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    const token = JSON.parse(readFileSync(join(ws, GRANTS_REL, `${grant.token_id}.json`), 'utf8'));
    assert.ok(Date.parse(token.issued_at) > 0);
    assert.ok(Date.parse(token.expires_at) > Date.parse(token.issued_at));
  });

  test('successive grants append rather than truncate, and the baseline tracks', () => {
    mintGrant(ws, { path: JUDGMENT, reason: 'one', operation: 'o' });
    mintGrant(ws, { path: JUDGMENT, reason: 'two', operation: 'o' });
    const rows = readOverrideLedger(ws);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.reason), ['one', 'two']);
  });
});

describe('claimGrant', () => {
  test('claims a live token for the exact path', () => {
    mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    assert.equal(claimGrant(ws, JUDGMENT), true);
  });

  test('is single-use — the second claim is denied', () => {
    mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    assert.equal(claimGrant(ws, JUDGMENT), true);
    assert.equal(claimGrant(ws, JUDGMENT), false);
  });

  test('is path-scoped — a grant for A does not permit a write to B', () => {
    mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    assert.equal(claimGrant(ws, 'docs/judgment/records/joints/other.json'), false);
    assert.equal(claimGrant(ws, JUDGMENT), true, 'the real path still works');
  });

  test('denies when there is no grant at all', () => {
    assert.equal(claimGrant(ws, JUDGMENT), false);
  });

  test('denies an expired token, and does not consume it', () => {
    const grant = mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    const tokenPath = join(ws, GRANTS_REL, `${grant.token_id}.json`);
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    token.expires_at = new Date(Date.now() - 1000).toISOString();
    writeFileSync(tokenPath, JSON.stringify(token));

    assert.equal(claimGrant(ws, JUDGMENT), false);
    assert.ok(existsSync(tokenPath), 'an expired token is rejected, not silently consumed');
  });

  test('a hand-written token with no ledger row is not consumable', () => {
    // The Bash-forgery case. Caught because the token is bound to a ledger row.
    mkdirSync(join(ws, GRANTS_REL), { recursive: true });
    writeFileSync(join(ws, GRANTS_REL, 'forged.json'), JSON.stringify({
      token_id: 'forged',
      path: JUDGMENT,
      actor: 'agent',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    assert.equal(claimGrant(ws, JUDGMENT), false);
  });

  test('a token whose ledger row was removed is not consumable', () => {
    mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    writeFileSync(join(ws, LEDGER_REL), '');   // the tamper
    assert.equal(claimGrant(ws, JUDGMENT), false);
  });
});

describe('claimGrant — real concurrency', () => {
  test('exactly one of six genuinely-parallel processes claims one token', async () => {
    const grant = mintGrant(ws, { path: JUDGMENT, reason: 'r', operation: 'o' });
    const claimer = join(ws, 'claim.mjs');
    // Each process busy-waits to a shared wall-clock start so the rename calls
    // actually contend. execFileSync would have run these in sequence, which
    // proves single-use but never exercises the race.
    writeFileSync(claimer, `
      import { claimGrant } from ${JSON.stringify(join(process.cwd(), 'lib/canon-override.js'))};
      const startAt = Number(process.argv[2]);
      while (Date.now() < startAt) { /* spin to the barrier */ }
      process.stdout.write(claimGrant(${JSON.stringify(ws)}, ${JSON.stringify(JUDGMENT)}) ? 'WON' : 'lost');
    `);

    const startAt = Date.now() + 400;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        execFile(process.execPath, [claimer, String(startAt)], (err, stdout) =>
          (err ? reject(err) : resolve(stdout.trim())));
      })),
    );

    assert.equal(results.filter((r) => r === 'WON').length, 1,
      `exactly one winner expected, got ${JSON.stringify(results)}`);
    assert.equal(readdirSync(join(ws, GRANTS_REL, 'consumed')).length, 1);
    assert.ok(grant.token_id);
  });
});
