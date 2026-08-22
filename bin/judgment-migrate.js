#!/usr/bin/env node
/**
 * bin/judgment-migrate.js — ledger to SmartMemory decision migration
 * (GOV-COMPOSE-SEAM-1 step 1 `canon-on-decisions`).
 *
 * Phase P1 ships `--dry-run` ONLY. It reads `docs/judgment/records/ledger.jsonl`,
 * maps every decision-shaped entry through `lib/judgment-decisions.js`, and
 * prints the mapping plus the value-spike numbers. It writes nothing, anywhere.
 *
 * The write path is P2 and the backfill is P3; both are blocked until the spike
 * is reported against its pre-registered threshold, and the backfill is
 * additionally blocked on the P2.5 inferred-conviction review gate (D4).
 * Invoking this without `--dry-run` therefore refuses rather than doing
 * something plausible.
 *
 * Usage:
 *   node bin/judgment-migrate.js --dry-run [--json] [--review-batch]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { mapLedger, applyReviewFile, CONFIDENCE } from '../lib/judgment-decisions.js';

/** Pre-registered 2026-08-22, before any count was taken. */
const SPIKE_THRESHOLD_RULES = 10;

function readLedger(cwd) {
  const path = join(cwd, 'docs', 'judgment', 'records', 'ledger.jsonl');
  if (!existsSync(path)) {
    throw new Error(`judgment-migrate: no ledger at ${path}`);
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`judgment-migrate: ledger line ${i + 1} is not JSON: ${err.message}`);
      }
    });
}

/**
 * The owner's P2.5 verdicts. Absent, the dry run still reports (it writes
 * nothing), but it says so — a report that silently skipped the gate would read
 * exactly like one that passed it.
 */
function readReview(cwd) {
  const path = join(cwd, 'docs', 'features', 'GOV-COMPOSE-SEAM-1', 'conviction-review.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function truncate(s, n) {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function report(mapped, opts) {
  const { decisions, skipped } = mapped;

  const byKind = {};
  for (const d of decisions) {
    byKind[d.entry.kind] = (byKind[d.entry.kind] ?? 0) + 1;
  }

  const candidates = decisions.filter((d) => d.enforceability.verdict === 'candidate');
  const inferred = decisions.filter((d) => d.decision.context_snapshot.conviction_review_required);
  const reviewed = decisions.filter((d) => d.decision.context_snapshot.conviction_review);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      total_entries: decisions.length + skipped.length,
      decision_shaped: decisions.length,
      by_kind: byKind,
      skipped: skipped.length,
      enforceable_candidates: candidates.length,
      threshold: SPIKE_THRESHOLD_RULES,
      inferred_conviction_review_required: inferred.length,
      inferred_conviction_reviewed: reviewed.length,
      review_ruled_at: opts.review?.ruled_at ?? null,
      decisions: decisions.map((d) => ({
        seq: d.seq,
        kind: d.entry.kind,
        decision: d.decision,
        enforceability: d.enforceability,
      })),
    }, null, 2)}\n`);
    return candidates.length;
  }

  const out = [];
  out.push('# judgment-migrate --dry-run (GOV-COMPOSE-SEAM-1 canon-on-decisions P1)');
  out.push('');
  out.push('NOTHING WAS WRITTEN. This is the mapping and the spike measurement only.');
  out.push('');
  out.push(`Ledger entries:        ${decisions.length + skipped.length}`);
  out.push(`Decision-shaped:       ${decisions.length}  (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')})`);
  out.push(`Not decisions:         ${skipped.length}  (note/escalate/override/attest/calibrate — D3)`);
  out.push('');
  out.push('## Value spike (threshold pre-registered 2026-08-22)');
  out.push('');
  out.push(`Enforceable CANDIDATES: ${candidates.length}   (threshold to ship consume-bundle: >= ${SPIKE_THRESHOLD_RULES})`);
  out.push('');
  out.push('A candidate is NOT a counted rule. The classifier fires when all three D5');
  out.push('signals are present; the reported spike number is the ADJUDICATED count after a');
  out.push('human confirms each candidate actually names a step, names an observable, and');
  out.push('could be violated by a real build. Report the adjudicated number, not this one.');
  out.push('');
  out.push('## Enforceable candidates (adjudicate these)');
  out.push('');
  for (const d of candidates) {
    const s = d.enforceability.signals;
    out.push(`- [${d.seq}] ${d.entry.kind} / ${d.decision.decision_type}  step=${s.namesStep} obs=${s.namesObservable} violable=${s.violable}`);
    out.push(`      ${truncate(d.decision.content, 100)}`);
  }
  out.push('');
  out.push('## Inferred convictions (P2.5 review gate — D4)');
  out.push('');
  out.push(`Inferred scale: high=${CONFIDENCE.inferred.high} medium=${CONFIDENCE.inferred.medium} low=${CONFIDENCE.inferred.low}`);
  out.push(`Stated scale:   high=${CONFIDENCE.stated.high} medium=${CONFIDENCE.stated.medium} low=${CONFIDENCE.stated.low}`);
  out.push('');
  if (!opts.review) {
    out.push(`${inferred.length} decision-shaped entries carry an agent-inferred conviction, and NO`);
    out.push('verdict file was found. The backfill REFUSES these until the owner rules on each.');
    for (const d of inferred) {
      const c = d.decision.context_snapshot.conviction;
      out.push(`- [${d.seq}] ${c.level} (inferred -> ${d.decision.confidence})  ${truncate(d.decision.content, 90)}`);
    }
  } else {
    const byGroup = {};
    for (const d of reviewed) {
      const r = d.decision.context_snapshot.conviction_review;
      byGroup[r.verdict] = (byGroup[r.verdict] ?? 0) + 1;
    }
    out.push(`RULED ${reviewed.length}/${reviewed.length} by ${opts.review.ruled_by} on ${opts.review.ruled_at}:`);
    for (const [v, n] of Object.entries(byGroup)) out.push(`  ${v}: ${n}`);
    out.push('');
    for (const d of reviewed) {
      const snap = d.decision.context_snapshot;
      const marks = [
        snap.conviction_strength_dropped ? 'strength-dropped' : null,
        snap.conviction_unrated ? 'UNRATED, not rule-eligible' : null,
      ].filter(Boolean).join(', ');
      out.push(`- [${d.seq}] ${snap.conviction.level} ${snap.conviction_review.verdict} -> ${d.decision.confidence}/${d.decision.source_type}${marks ? `  (${marks})` : ''}`);
      out.push(`      ${truncate(d.decision.content, 90)}`);
    }
  }

  if (opts.reviewBatch) {
    out.push('');
    out.push('## Review batch (full text of each inferred entry)');
    for (const d of (opts.review ? reviewed : inferred)) {
      out.push('');
      out.push(`### [${d.seq}] ${d.entry.title}`);
      out.push(`conviction: ${d.decision.context_snapshot.conviction.level} (inferred)`);
      out.push('');
      out.push(d.entry.body ?? '(no body)');
    }
  }

  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);
  return candidates.length;
}

function main(argv) {
  const opts = {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    reviewBatch: argv.includes('--review-batch'),
  };

  if (!opts.dryRun) {
    process.stderr.write(
      'judgment-migrate: only --dry-run is implemented (P1).\n'
      + 'The write path (P2) and backfill (P3) are blocked on the value spike and on the\n'
      + 'P2.5 inferred-conviction review gate. Refusing rather than half-migrating.\n',
    );
    return 2;
  }

  const cwd = resolve(process.env.COMPOSE_CWD ?? process.cwd());
  const events = readLedger(cwd);
  const mapped = mapLedger(events);

  // Applying the gate here, in the dry run, is deliberate: it throws on the
  // first inferred conviction the owner has not ruled on, so the refusal shows
  // up before anything is written rather than halfway through a backfill.
  opts.review = readReview(cwd);
  if (opts.review) applyReviewFile(mapped, opts.review);

  report(mapped, opts);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
