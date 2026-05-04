/**
 * followup-writer.js — orchestrator for `propose_followup` MCP tool
 * (COMP-MCP-FOLLOWUP, sub-ticket #8 of COMP-MCP-FEATURE-MGMT).
 *
 * Files a follow-up feature against a parent. Composes addRoadmapEntry +
 * linkFeatures + scaffold via ArtifactManager, plus a "## Why" rationale
 * block in the new design.md. Retry-safe via an inflight ledger; per-parent
 * file lock prevents allocation races.
 *
 * See docs/features/COMP-MCP-FOLLOWUP/design.md and blueprint.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  statSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { createHash } from 'crypto';

import { readFeature, listFeatures } from './feature-json.js';
import { addRoadmapEntry, linkFeatures } from './feature-writer.js';
import { writeRoadmap } from './roadmap-gen.js';
import { appendEvent } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';
import { FEATURE_CODE_RE_STRICT } from './feature-code.js';
import { loadFeaturesDir } from './project-paths.js';

const TERMINAL_STATUSES = new Set(['KILLED', 'SUPERSEDED']);
const VALID_STATUSES = new Set([
  'PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE',
  'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED',
]);
const VALID_COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 25;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function inputError(msg) {
  const err = new Error(msg);
  err.code = 'INVALID_INPUT';
  return err;
}

function parentNotFound(code) {
  const err = new Error(`propose_followup: parent "${code}" not found`);
  err.code = 'PARENT_NOT_FOUND';
  return err;
}

function parentTerminal(code, status) {
  const err = new Error(
    `propose_followup: parent "${code}" is in terminal status "${status}"; cannot file follow-ups`
  );
  err.code = 'PARENT_TERMINAL';
  return err;
}

function followupBusy(parent_code) {
  const err = new Error(
    `propose_followup: per-parent lock for "${parent_code}" timed out after ${LOCK_TIMEOUT_MS}ms`
  );
  err.code = 'FOLLOWUP_BUSY';
  return err;
}

function partialFollowup(stage, created_code, cause) {
  const err = new Error(
    `propose_followup: partial failure at stage "${stage}" for "${created_code}"; ` +
    `recover by replaying with the same idempotency_key, or by completing manually.`
  );
  err.code = 'PARTIAL_FOLLOWUP';
  err.stage = stage;
  err.created_code = created_code;
  if (cause) err.cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha16(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function fingerprint(args) {
  const canonical = JSON.stringify({
    parent_code: args.parent_code,
    description: args.description,
    rationale: args.rationale,
    phase: args.phase ?? null,
    status: args.status ?? 'PLANNED',
    complexity: args.complexity ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function ledgerDir(cwd) {
  return join(cwd, '.compose', 'inflight-followups');
}

function ledgerPath(cwd, key, parent_code) {
  // Namespace ledger filename by parent to prevent cross-parent collisions
  // when the same idempotency_key is reused across different parents. The
  // durable cache is also parent-namespaced (see cacheNamespacedKey), so
  // the two layers stay consistent.
  if (typeof parent_code !== 'string' || !parent_code) {
    throw new Error('ledgerPath: parent_code is required');
  }
  return join(ledgerDir(cwd), `${sha16(`${parent_code}:${key}`)}.json`);
}

function locksDir(cwd) {
  return join(cwd, '.compose', 'locks');
}

function lockPath(cwd, parent_code) {
  return join(locksDir(cwd), `followup-${sha16(parent_code)}.lock`);
}

function readLedger(cwd, key, parent_code) {
  const p = ledgerPath(cwd, key, parent_code);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeLedger(cwd, key, parent_code, payload, mode) {
  const p = ledgerPath(cwd, key, parent_code);
  mkdirSync(dirname(p), { recursive: true });
  if (mode === 'wx' && existsSync(p)) {
    const e = new Error(`ledger already exists: ${p}`);
    e.code = 'LEDGER_EEXIST';
    throw e;
  }
  writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
}

function deleteLedger(cwd, key, parent_code) {
  const p = ledgerPath(cwd, key, parent_code);
  try { unlinkSync(p); } catch { /* best-effort */ }
}

async function acquireParentLock(cwd, parent_code) {
  const path = lockPath(cwd, parent_code);
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(path);
      return () => {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale-lock recovery
      try {
        const { mtimeMs } = statSync(path);
        if (Date.now() - mtimeMs > LOCK_TIMEOUT_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch { /* stat raced; loop */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw followupBusy(parent_code);
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

function nextNumberedCode(cwd, parent_code) {
  const all = listFeatures(cwd, loadFeaturesDir(cwd));
  const re = new RegExp(`^${parent_code.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const f of all) {
    const m = re.exec(f.code);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${parent_code}-${max + 1}`;
}

// ---------------------------------------------------------------------------
// scaffoldDesignWithRationale — atomic scaffold + rationale block, with rollback
// ---------------------------------------------------------------------------

async function scaffoldDesignWithRationale(cwd, code, rationale) {
  const { ArtifactManager } = await import('../server/artifact-manager.js');
  const featureRoot = resolve(cwd, loadFeaturesDir(cwd));
  mkdirSync(featureRoot, { recursive: true });
  const manager = new ArtifactManager(featureRoot);
  const scaffolded = manager.scaffold(code, { only: ['design.md'] });

  const designPath = join(featureRoot, code, 'design.md');
  let priorContent = null;
  try {
    priorContent = readFileSync(designPath, 'utf-8');
  } catch (err) {
    // The file should exist after scaffold; if not, propagate
    throw err;
  }

  try {
    const lines = priorContent.split('\n');
    const firstH1 = lines.findIndex(l => /^# /.test(l));
    let insertIdx;
    if (firstH1 === -1) {
      insertIdx = 0;
    } else {
      insertIdx = firstH1 + 1;
      while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
    }
    // Idempotent: skip if a `## Why` block already exists at the insert point
    const lookahead = lines.slice(insertIdx, insertIdx + 4).join('\n');
    if (!/^## Why\b/m.test(lookahead)) {
      const block = ['', '## Why', '', rationale.trim(), ''];
      lines.splice(insertIdx, 0, ...block);
      writeFileSync(designPath, lines.join('\n'), 'utf-8');
    }
    return scaffolded;
  } catch (err) {
    // Rollback: if we just created the file in this scaffold call, delete it;
    // otherwise restore the prior content
    try {
      if (scaffolded.created.includes('design.md')) {
        unlinkSync(designPath);
      } else {
        writeFileSync(designPath, priorContent, 'utf-8');
      }
    } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.parent_code
 * @param {string} args.description
 * @param {string} args.rationale
 * @param {'S'|'M'|'L'|'XL'} [args.complexity]
 * @param {string} [args.phase]
 * @param {string} [args.status]
 * @param {string} [args.idempotency_key]
 * @returns {Promise<object>}
 */
export async function proposeFollowup(cwd, args = {}) {
  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  const { parent_code, description, rationale } = args;

  if (typeof parent_code !== 'string' || !FEATURE_CODE_RE_STRICT.test(parent_code)) {
    throw inputError(`propose_followup: invalid parent_code ${JSON.stringify(parent_code)}`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw inputError('propose_followup: description must be a non-empty string');
  }
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    throw inputError('propose_followup: rationale must be a non-empty string');
  }
  if (args.complexity !== undefined && !VALID_COMPLEXITIES.has(args.complexity)) {
    throw inputError(`propose_followup: invalid complexity ${JSON.stringify(args.complexity)}`);
  }
  if (args.status !== undefined && !VALID_STATUSES.has(args.status)) {
    throw inputError(`propose_followup: invalid status ${JSON.stringify(args.status)}`);
  }

  const parent = readFeature(cwd, parent_code, loadFeaturesDir(cwd));
  if (!parent) throw parentNotFound(parent_code);
  if (TERMINAL_STATUSES.has(parent.status)) throw parentTerminal(parent_code, parent.status);

  const phase = args.phase ?? parent.phase;
  if (typeof phase !== 'string' || phase.trim() === '') {
    throw inputError(
      `propose_followup: phase is required (parent "${parent_code}" has no phase to inherit)`
    );
  }
  const status = args.status ?? 'PLANNED';
  const requestFingerprint = fingerprint({ ...args, phase, status });

  // -------------------------------------------------------------------------
  // Cache hit (fast path) — only when idempotency_key provided
  // -------------------------------------------------------------------------
  const cacheNamespacedKey = args.idempotency_key
    ? `propose_followup:${parent_code}:${args.idempotency_key}`
    : null;

  // Drive the orchestration. If idempotency_key provided, wrap the whole
  // thing in checkOrInsert which handles cache hits transparently. We rely
  // on the cache layer to dedup full successes; partial state is handled by
  // the inflight ledger inside the compute function.
  const compute = () => orchestrate({
    cwd,
    parent_code,
    parent,
    args,
    phase,
    status,
    requestFingerprint,
  });

  if (cacheNamespacedKey) {
    const { result } = await checkOrInsert(cwd, cacheNamespacedKey, compute);
    // Cache write succeeded (or hit) — now safe to delete the inflight
    // ledger. Crash between checkOrInsert and this delete is harmless: the
    // next same-key call will hit the cache and skip the ledger entirely.
    deleteLedger(cwd, args.idempotency_key, parent_code);
    return result;
  }
  return compute();
}

// ---------------------------------------------------------------------------
// orchestrate — the main flow, behind cache layer when idempotent
// ---------------------------------------------------------------------------

async function orchestrate({ cwd, parent_code, parent, args, phase, status, requestFingerprint }) {
  const idempotency_key = args.idempotency_key;

  // Resume from inflight ledger if present
  let allocated_code;
  let stage = 'pending';
  let releaseLock = null;

  if (idempotency_key) {
    const ledger = readLedger(cwd, idempotency_key, parent_code);
    if (ledger) {
      if (ledger.idempotency_key !== idempotency_key
          || ledger.parent_code !== parent_code
          || ledger.request_fingerprint !== requestFingerprint) {
        throw inputError(
          'propose_followup: idempotency_key reused with different arguments'
        );
      }
      allocated_code = ledger.allocated_code;
      stage = ledger.stage;
    }
  }

  try {
    // -----------------------------------------------------------------------
    // Stage: pending — allocate and call addRoadmapEntry
    // -----------------------------------------------------------------------
    if (stage === 'pending') {
      releaseLock = await acquireParentLock(cwd, parent_code);
      try {
        if (!allocated_code) {
          allocated_code = nextNumberedCode(cwd, parent_code);
        }
        if (idempotency_key) {
          // Write ledger before mutating (wx if first time, overwrite on resume)
          const ledgerPayload = {
            idempotency_key,
            parent_code,
            allocated_code,
            stage: 'pending',
            request_fingerprint: requestFingerprint,
            ts: new Date().toISOString(),
          };
          // Use a non-exclusive write — resume might reach here with a
          // pre-existing ledger we already validated above.
          writeLedger(cwd, idempotency_key, parent_code, ledgerPayload, 'overwrite');
        }

        try {
          await addRoadmapEntry(cwd, {
            code: allocated_code,
            description: args.description,
            phase,
            complexity: args.complexity,
            status,
            parent: parent_code,
          });
          stage = 'roadmap_done';
          if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
        } catch (err) {
          if (err && err.code === 'ROADMAP_PARTIAL_WRITE') {
            stage = 'roadmap_committed_regen_failed';
            if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
            throw partialFollowup('roadmap_regen', allocated_code, err);
          }
          if (err && /already exists/.test(err.message || '')) {
            // Resume duplicate: code was allocated in a prior attempt.
            // Verify ownership: the existing feature's parent must match.
            const existing = readFeature(cwd, allocated_code, loadFeaturesDir(cwd));
            if (existing && existing.parent === parent_code) {
              try {
                writeRoadmap(cwd);
              } catch (regenErr) {
                // Surface as a partial — design requires regeneration to
                // succeed before advancing past step 3.
                stage = 'roadmap_committed_regen_failed';
                if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
                throw partialFollowup('roadmap_regen', allocated_code, regenErr);
              }
              stage = 'roadmap_done';
              if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
            } else {
              // Foreign feature owns this code — bail out
              if (idempotency_key) deleteLedger(cwd, idempotency_key, parent_code);
              throw err;
            }
          } else {
            // Unrelated error — clean up ledger and rethrow
            if (idempotency_key) deleteLedger(cwd, idempotency_key, parent_code);
            throw err;
          }
        }
      } finally {
        if (releaseLock) { releaseLock(); releaseLock = null; }
      }
    }

    // -----------------------------------------------------------------------
    // Stage: roadmap_committed_regen_failed — regen ROADMAP, then proceed
    // -----------------------------------------------------------------------
    if (stage === 'roadmap_committed_regen_failed') {
      try {
        writeRoadmap(cwd);
      } catch (err) {
        // Still failing — surface the partial again
        throw partialFollowup('roadmap_regen', allocated_code, err);
      }
      stage = 'roadmap_done';
      if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
    }

    // -----------------------------------------------------------------------
    // Stage: roadmap_done | link_failed — call linkFeatures
    // -----------------------------------------------------------------------
    if (stage === 'roadmap_done' || stage === 'link_failed') {
      try {
        await linkFeatures(cwd, {
          from_code: allocated_code,
          to_code: parent_code,
          kind: 'surfaced_by',
        });
        stage = 'link_done';
        if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
      } catch (err) {
        stage = 'link_failed';
        if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
        throw partialFollowup('link', allocated_code, err);
      }
    }

    // -----------------------------------------------------------------------
    // Stage: link_done | scaffold_failed — scaffold + rationale
    // -----------------------------------------------------------------------
    let scaffolded;
    if (stage === 'link_done' || stage === 'scaffold_failed') {
      try {
        scaffolded = await scaffoldDesignWithRationale(cwd, allocated_code, args.rationale);
        stage = 'scaffold_done';
        if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
      } catch (err) {
        stage = 'scaffold_failed';
        if (idempotency_key) advanceLedger(cwd, idempotency_key, { allocated_code, parent_code, request_fingerprint: requestFingerprint, stage });
        throw partialFollowup('scaffold', allocated_code, err);
      }
    } else if (stage === 'scaffold_done') {
      // Resume after success — recompute scaffolded shape (idempotent re-scan)
      const featureRoot = resolve(cwd, loadFeaturesDir(cwd));
      const { ArtifactManager } = await import('../server/artifact-manager.js');
      const manager = new ArtifactManager(featureRoot);
      scaffolded = manager.scaffold(allocated_code, { only: ['design.md'] });
    }

    // -----------------------------------------------------------------------
    // Audit + return
    // -----------------------------------------------------------------------
    try {
      appendEvent(cwd, {
        tool: 'propose_followup',
        parent_code,
        code: allocated_code,
        rationale: args.rationale,
        idempotency_key,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[followup-writer] audit append failed: ${err.message}`);
    }

    const created = readFeature(cwd, allocated_code, loadFeaturesDir(cwd));

    const result = {
      code: allocated_code,
      parent_code,
      phase: created?.phase ?? phase,
      position: created?.position,
      roadmap_path: resolve(cwd, 'ROADMAP.md'),
      scaffolded: scaffolded ?? { created: [], skipped: ['design.md'] },
      link: { kind: 'surfaced_by', from_code: allocated_code, to_code: parent_code },
    };

    // Note: when idempotency_key is set, the inflight ledger is deleted by
    // the caller (proposeFollowup) AFTER checkOrInsert persists the success
    // result. That ordering keeps cache+ledger crash-safe: a process death
    // between cache-write and ledger-delete is harmless (next replay hits
    // the cache); a death before cache-write leaves the ledger so resume
    // works.
    if (!idempotency_key) {
      // No-key path has no ledger to delete — nothing to do.
    }

    return result;
  } catch (err) {
    if (releaseLock) { try { releaseLock(); } catch { /* */ } }
    throw err;
  }
}

function advanceLedger(cwd, key, { allocated_code, parent_code, request_fingerprint, stage }) {
  writeLedger(cwd, key, parent_code, {
    idempotency_key: key,
    parent_code,
    allocated_code,
    stage,
    request_fingerprint,
    ts: new Date().toISOString(),
  }, 'overwrite');
}

// ---------------------------------------------------------------------------
// Test/diagnostic exports
// ---------------------------------------------------------------------------

export const _internals = {
  sha16,
  fingerprint,
  ledgerPath,
  lockPath,
  nextNumberedCode,
  scaffoldDesignWithRationale,
};
