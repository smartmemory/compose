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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

import { mapLedger, applyReviewFile, CONFIDENCE } from '../lib/judgment-decisions.js';
import { createSmartmemoryClient } from '../lib/smartmemory-client.js';
import { getSmartmemoryConfig } from '../lib/smartmemory-config.js';
import { readSidecar, sidecarPath, writeJudgmentDecision } from '../lib/judgment-decision-write.js';

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


// ── P3: the backfill ────────────────────────────────────────────────────────

/**
 * Resume state is the SHARED idempotency ledger in `lib/judgment-decision-write.js`
 * (`docs/judgment/records/decision-ids.json`), NOT a private file.
 *
 * This backfill briefly kept its own under `.compose/data/`, keyed identically
 * but read separately from the live write path. Same key, two ledgers, neither
 * reading the other: a decision recorded live and then backfilled would be
 * written twice, and the create endpoint has no server-side idempotency to
 * catch it. That is the same "two mechanisms guarding one fact" failure D2
 * retired the markdown hash chain over. Merged 2026-08-22; the old file is
 * adopted on first read by `readSidecar` so a migration already run is not
 * repeated.
 *
 * The per-write flush and the verify-before-skip both survive the merge — they
 * moved INTO the shared writer, which is where the live path needed them too.
 */

/**
 * Resolve where the backfill writes.
 *
 * Flags override `.compose/compose.json#smartmemory`. Both a workspace and a
 * key-env name are REQUIRED and there is no default: a backfill that guesses
 * its destination can write 43 decisions into someone's working memory, and
 * that is not recoverable by re-running it.
 */
function resolveTarget(cwd, argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfg = getSmartmemoryConfig(cwd);
  const baseUrl = flag('--api-url') ?? cfg.baseUrl ?? process.env.SMARTMEMORY_API_URL;
  const workspaceId = flag('--workspace') ?? cfg.workspaceId;
  const apiKeyEnv = flag('--api-key-env') ?? cfg.apiKeyEnv;

  const missing = [];
  if (!baseUrl) missing.push('--api-url (or smartmemory.baseUrl)');
  if (!workspaceId) missing.push('--workspace (or smartmemory.workspaceId)');
  if (!apiKeyEnv) missing.push('--api-key-env (or smartmemory.apiKeyEnv)');
  if (missing.length) {
    throw new Error(
      `judgment-migrate --apply: refusing to guess a destination. Missing ${missing.join(', ')}.`,
    );
  }
  if (!process.env[apiKeyEnv]) {
    throw new Error(`judgment-migrate --apply: $${apiKeyEnv} is not set`);
  }
  return { baseUrl, workspaceId, apiKeyEnv, timeoutMs: 15000 };
}

/** The payload the HTTP contract accepts. Anything the mapper carries that the
 *  route has no field for rides in `context_snapshot`, never silently dropped. */
function toCreateBody(d) {
  return {
    content: d.content,
    decision_type: d.decision_type,
    confidence: d.confidence,
    domain: d.domain,
    tags: d.tags,
    rejected_alternatives: d.rejected_alternatives,
    rationale: d.rationale,
    source_type: d.source_type,
    context_snapshot: d.context_snapshot,
  };
}

async function backfill(cwd, mapped, target, opts) {
  const client = createSmartmemoryClient(target);
  const written = [];
  const skipped = [];
  const failed = [];

  for (const row of mapped.decisions) {
    const d = row.decision;
    const key = d.idempotency_key;
    try {
      // One write path for the live tool call and the bulk migration. It owns
      // the shared ledger, the verify-before-skip, the provenance check and the
      // per-write flush; this loop owns only batching and reporting.
      const res = await writeJudgmentDecision(cwd, d, { client, config: target });
      if (res === null) {
        failed.push({ seq: row.seq, key, stage: 'config', error: 'smartmemory coupling is disabled' });
        if (opts.failFast) break;
        continue;
      }
      (res.skipped ? skipped : written).push({ seq: row.seq, key, decision_id: res.decision_id });
    } catch (err) {
      // Fail-closed. A dropped decision silently un-governs a build, so the
      // backfill reports and stops counting it as done rather than warning on.
      failed.push({ seq: row.seq, key, stage: 'create', error: err.message });
      if (opts.failFast) break;
    }
  }

  return { written, skipped, failed, state: { written: readSidecar(cwd) } };
}

/**
 * The `correct` -> supersede half of D3, which this backfill CANNOT complete.
 *
 * `POST /memory/decisions/{id}/supersede` mints its replacement from
 * `new_content` / `new_decision_type` / `new_confidence` alone — it accepts no
 * `source_type`, no `context_snapshot`, no tags. Calling it after writing the
 * 43 would produce a 44th, 45th and 46th decision with no idempotency key and
 * no provenance, and would break the "run it twice, get 43" property.
 *
 * So the link is recorded and reported, not faked. Closing it needs a service
 * change (supersede taking an existing decision id, or create taking
 * `supersedes`), which is a separate piece of work.
 */
function pendingSupersedes(mapped) {
  return mapped.decisions
    .filter((r) => r.decision.supersedes_slug)
    .map((r) => ({ seq: r.seq, slug: r.decision.supersedes_slug, content: r.decision.content }));
}

function writeReport(cwd, result, mapped, target) {
  const pend = pendingSupersedes(mapped);
  const lines = [];
  lines.push('# GOV-COMPOSE-SEAM-1 `canon-on-decisions` P3 — backfill report');
  lines.push('');
  lines.push(`**Target workspace:** \`${target.workspaceId}\` · **API:** \`${target.baseUrl}\``);
  lines.push('');
  lines.push(`- Decision-shaped ledger entries: **${mapped.decisions.length}**`);
  lines.push(`- Written this run: **${result.written.length}**`);
  lines.push(`- Already present (verified server-side, skipped): **${result.skipped.length}**`);
  lines.push(`- Failed: **${result.failed.length}**`);
  lines.push('');
  if (result.failed.length) {
    lines.push('## Failures');
    lines.push('');
    for (const f of result.failed) lines.push(`- [${f.seq}] ${f.stage}: ${f.error}`);
    lines.push('');
  }
  lines.push('## Superseding links NOT applied');
  lines.push('');
  lines.push('`POST /memory/decisions/{id}/supersede` builds its replacement from `new_content`,');
  lines.push('`new_decision_type` and `new_confidence` only — no `source_type`, no');
  lines.push('`context_snapshot`, no tags. Using it here would mint extra decisions with no');
  lines.push('idempotency key and break the run-it-twice property, so these links are recorded');
  lines.push('and left unapplied rather than faked. Closing them needs a service change.');
  lines.push('');
  for (const p of pend) lines.push(`- [${p.seq}] supersedes \`${p.slug}\` — ${p.content}`);
  lines.push('');
  const out = join(cwd, 'docs', 'features', 'GOV-COMPOSE-SEAM-1', 'migration-report.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  return out;
}

async function main(argv) {
  const opts = {
    dryRun: argv.includes('--dry-run'),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    reviewBatch: argv.includes('--review-batch'),
    failFast: !argv.includes('--keep-going'),
  };

  if (!opts.dryRun && !opts.apply) {
    process.stderr.write(
      'judgment-migrate: pass --dry-run (report only, writes nothing) or --apply (backfill).\n'
      + 'Refusing rather than doing something plausible.\n',
    );
    return 2;
  }

  const cwd = resolve(process.env.COMPOSE_CWD ?? process.cwd());
  const events = readLedger(cwd);
  const mapped = mapLedger(events);

  // The P2.5 gate runs BEFORE anything else, in both modes. It throws on the
  // first inferred conviction the owner has not ruled on, so the refusal shows
  // up before a single write rather than halfway through a backfill.
  opts.review = readReview(cwd);
  if (opts.review) applyReviewFile(mapped, opts.review);

  if (opts.dryRun) {
    report(mapped, opts);
    return 0;
  }

  // --apply
  if (!opts.review) {
    process.stderr.write(
      'judgment-migrate --apply: no conviction-review.json found. The P2.5 gate has not been\n'
      + 'ruled, so the inferred convictions cannot be written. Refusing.\n',
    );
    return 2;
  }

  const target = resolveTarget(cwd, argv);
  const result = await backfill(cwd, mapped, target, opts);
  const reportPath = writeReport(cwd, result, mapped, target);

  process.stdout.write(
    `judgment-migrate --apply -> ${target.workspaceId}\n`
    + `  written: ${result.written.length}  skipped(verified): ${result.skipped.length}  `
    + `failed: ${result.failed.length}\n`
    + `  report: ${reportPath}\n`,
  );
  return result.failed.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`judgment-migrate: ${err.message}\n`); process.exitCode = 1; },
);
