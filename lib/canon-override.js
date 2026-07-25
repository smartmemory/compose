/**
 * canon-override.js — the canon override: grant-then-write, ledger-first.
 *
 * COMP-CANON-OVERRIDE S2, implementing COMP-CANON-GUARD Decision 4.
 *
 * WHAT THIS IS: audit and careless-drift tooling. It makes the cooperative
 * path logged and the accidental path hard. It is NOT enforcement and must
 * never be described as such — `Bash` and Codex writes never reach the hook,
 * and every piece of state here lives in the workspace the agent can write.
 * A determined actor who forges a token AND its ledger row AND the baseline
 * passes. See design.md, "The in-workspace ceiling".
 *
 * ORDERING IS THE ATOMICITY ANSWER. The bypass row and the attest baseline are
 * written BEFORE the token is minted, so the failure mode is over-recording,
 * never under-recording: a token cannot exist without its row. If the write
 * that follows never happens, a bypass entry exists for a write that did not
 * occur — deliberately the safe direction.
 *
 * SINGLE-USE IS A RENAME, NOT A LOCK. Each grant is its own file, claimed by
 * renaming it into `consumed/`. Exactly one caller can rename a given path;
 * every loser gets ENOENT. An earlier draft used one shared JSON file with
 * temp-write-plus-rename, which gives atomic *publication* but not mutual
 * exclusion — two readers could each drop the token from their own snapshot
 * and both succeed.
 */
import {
  mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, existsSync, appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isOverrideEligible } from './canon-registry.js';
import { baselineFor } from './append-integrity.js';

export const LEDGER_REL = '.compose/canon-overrides.jsonl';
export const ATTEST_REL = '.compose/canon-overrides-attest.json';
export const GRANTS_REL = '.compose/data/canon-grants';
const CONSUMED_SUBDIR = 'consumed';

/** 5 minutes: long enough for a grant-then-write round trip through an agent
 *  turn, short enough that a forgotten grant is not a standing hole. */
export const GRANT_TTL_MS = 5 * 60 * 1000;

function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** Read the bypass ledger as parsed rows. Malformed lines are skipped rather
 *  than thrown on — a corrupt row must not make every claim fail open. */
export function readOverrideLedger(cwd) {
  const path = join(cwd, LEDGER_REL);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a corrupt row */ }
  }
  return rows;
}

/**
 * Mint a single-use, path-scoped grant.
 *
 * @param {string} cwd workspace root
 * @param {{path:string, reason:string, operation?:string, featuresDir?:string}} args
 *   `actor` is deliberately NOT accepted — it is stamped here per Decision 3.
 * @returns {{token_id:string, path:string, expires_at:string}}
 */
export function mintGrant(cwd, { path, reason, operation, featuresDir = 'docs/features' } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw typedError(
      'CANON_OVERRIDE_REASON',
      'canon_override_grant: a non-empty reason is required — the bypass row is the whole point',
    );
  }
  if (typeof path !== 'string' || path.trim() === '') {
    throw typedError('CANON_OVERRIDE_PATH', 'canon_override_grant: path is required');
  }
  if (!isOverrideEligible(path, { featuresDir, point: 'hook' })) {
    throw typedError(
      'CANON_OVERRIDE_INELIGIBLE',
      `canon_override_grant: ${path} is not override-eligible. Either it is not guarded at the `
      + 'write-time hook (nothing is blocking it), or it is the override\'s own governance state, '
      + 'which is deliberately ungrantable so a bypass cannot authorise rewriting its own record.',
    );
  }

  const now = new Date();
  const tokenId = randomUUID();
  const row = {
    ts: now.toISOString(),
    actor: 'agent',                       // stamped here; never caller-supplied
    path,
    reason: reason.trim(),
    operation: typeof operation === 'string' ? operation : null,
    token_id: tokenId,
  };

  // ── Ledger and baseline FIRST ──────────────────────────────────────────────
  const ledgerPath = join(cwd, LEDGER_REL);
  ensureDir(dirname(ledgerPath));
  appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  writeAttestBaseline(cwd);

  // ── Then the token ─────────────────────────────────────────────────────────
  const grantsDir = join(cwd, GRANTS_REL);
  ensureDir(grantsDir);
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
  writeFileSync(
    join(grantsDir, `${tokenId}.json`),
    `${JSON.stringify({
      token_id: tokenId,
      path,
      actor: 'agent',
      operation: row.operation,
      issued_at: now.toISOString(),
      expires_at: expiresAt,
    }, null, 2)}\n`,
    { flag: 'wx' },                       // exclusive create: mint is serialized too
  );

  return { token_id: tokenId, path, expires_at: expiresAt };
}

/** Re-attest the bypass ledger. Called only from the append path — never as a
 *  standalone "fix", which would be the laundering step (S5 R1). */
function writeAttestBaseline(cwd) {
  const ledgerPath = join(cwd, LEDGER_REL);
  const bytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.alloc(0);
  const attestPath = join(cwd, ATTEST_REL);
  ensureDir(dirname(attestPath));
  writeFileSync(attestPath, `${JSON.stringify(baselineFor(bytes), null, 2)}\n`);
}

/**
 * Claim a live grant for exactly `path`. Returns true if the write may proceed.
 *
 * Never throws: the hook's policy is fail-open, and a claim that explodes must
 * not wedge the session. A false return means "no grant" and the caller denies
 * on its own terms.
 */
export function claimGrant(cwd, path) {
  try {
    const grantsDir = join(cwd, GRANTS_REL);
    if (!existsSync(grantsDir)) return false;

    // A token is only honoured if its row is in the ledger. This is what stops
    // a raw-written token file from being consumable — the Bash-forgery case.
    // It binds the two artifacts without pretending to be crypto: an actor who
    // writes BOTH still passes, which is the documented ceiling.
    const ledgerTokenIds = new Set(
      readOverrideLedger(cwd).filter((r) => r?.path === path).map((r) => r?.token_id),
    );
    if (ledgerTokenIds.size === 0) return false;

    const now = Date.now();
    for (const entry of readdirSync(grantsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const tokenPath = join(grantsDir, entry.name);

      let token;
      try { token = JSON.parse(readFileSync(tokenPath, 'utf8')); } catch { continue; }
      if (token?.path !== path) continue;
      if (!ledgerTokenIds.has(token?.token_id)) continue;

      // Expiry from the immutable stamp, NOT mtime: a checkout gives a file a
      // fresh mtime, which would revive a mistakenly committed token.
      const expiresAt = Date.parse(token?.expires_at ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;

      // The claim. Exactly one caller can rename a given path; losers get ENOENT.
      const consumedDir = join(grantsDir, CONSUMED_SUBDIR);
      ensureDir(consumedDir);
      try {
        renameSync(tokenPath, join(consumedDir, entry.name));
        return true;
      } catch {
        continue;                        // another process won; try the next token
      }
    }
    return false;
  } catch {
    return false;
  }
}
