/**
 * lib/judgment-decisions.js — ledger event to SmartMemory decision mapping
 * (GOV-COMPOSE-SEAM-1 step 1 `canon-on-decisions`, phase P1).
 *
 * Pure. No I/O, no clock, no SmartMemory client. The write path (P2) and the
 * backfill (P3) both call these; the dry run (`bin/judgment-migrate.js`) calls
 * them and writes nothing, which is what makes the value spike measurable
 * before anything is committed.
 *
 * Design answers this file implements — see
 * smart-memory-docs/docs/features/GOV-COMPOSE-SEAM-1/design.md:
 *   D1  SmartMemory owns; markdown is a projection.
 *   D3  kind mapping (below).
 *   D4  an inferred conviction may NOT produce the same confidence as a stated
 *       one, and the distinction survives onto `source_type`.
 *   D5  enforceable = names a step + names an observable + a build could
 *       violate it. Fixed in writing before the count was taken.
 */

import { createHash } from 'node:crypto';

/** Ledger kinds that become a SmartMemory decision at all (D3). */
export const DECISION_KINDS = new Set(['decide', 'kill', 'open', 'correct']);

/**
 * Kinds that touch a decision without being one. `calibrate` amends an existing
 * decision's confidence; the rest are annotation, routing or integrity events
 * and must not inflate the decision store (D3).
 */
export const NON_DECISION_KINDS = new Set(['note', 'escalate', 'override', 'attest', 'calibrate']);

/**
 * Conviction to confidence.
 *
 * Two separate scales on purpose (D4). A conviction the owner stated is worth
 * more than one an agent inferred from a transcript, and the gap has to be
 * visible in the number as well as in `source_type` — otherwise a guess reads
 * as an assertion the moment it lands in a bundle rule.
 *
 * An inferred `high` (0.55) sits BELOW a stated `medium` (0.6) deliberately: we
 * would rather act on something the owner actually said with middling
 * conviction than on something we decided he probably meant.
 */
export const CONFIDENCE = {
  stated: { high: 0.9, medium: 0.6, low: 0.35 },
  inferred: { high: 0.55, medium: 0.4, low: 0.25 },
};

/** Confidence for a decision-shaped entry that carries no conviction at all. */
export const CONFIDENCE_UNSTATED = 0.5;

/**
 * Stable identity for a ledger entry.
 *
 * The jsonl carries no id — identity is position plus content. Hashing
 * (seq, kind, title, written_at) gives the backfill an idempotency key that
 * survives a re-run without a schema change, and changes if the entry is
 * rewritten, which is what we want: a rewritten entry is a different fact.
 */
export function stableEntryKey(entry, seq) {
  const material = [
    String(seq),
    entry.kind ?? '',
    entry.title ?? '',
    entry.provenance?.written_at ?? '',
  ].join(' ');
  return `compose-ledger-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

/**
 * Split a ledger title of the form `slug — prose` into its two halves.
 * Both em dash and hyphen separators appear in the imported canon.
 */
export function splitTitle(title = '') {
  const m = title.match(/^([a-z0-9][a-z0-9-]*)\s+[—-]\s+([\s\S]*)$/);
  if (!m) return { slug: null, statement: (title || '').trim() };
  return { slug: m[1], statement: m[2].trim() };
}

/**
 * `decide` to `policy` when the entry states a forward-going rule, else
 * `choice`.
 *
 * This is the D3 split that feeds the spike, so it is deliberately narrow: a
 * policy has to read as an instruction that outlives the moment. Anything
 * ambiguous stays a `choice`, which counts for less. Erring the other way would
 * be the motivated counting the plan warns about.
 */
const POLICY_MARKERS = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bmust\b/i,
  /\bfrom (?:here|now) on\b/i,
  /\bgoing forward\b/i,
  /\bby default\b/i,
  /\bno new\b/i,
];

export function decideSubtype(entry) {
  const text = `${entry.title ?? ''}\n${entry.body ?? ''}`;
  return POLICY_MARKERS.some((re) => re.test(text)) ? 'policy' : 'choice';
}

/**
 * D5 — the enforceability test, applied as three independent signals.
 *
 * Returns the signals, not just a verdict, because the reported spike number is
 * an ADJUDICATED count: this classifier proposes, a human confirms. A regex
 * cannot tell "reviews run before merge" from "reviewing is how we work", and
 * pretending otherwise would produce exactly the motivated number D5 exists to
 * prevent. `verdict: 'candidate'` means "bring this one to the adjudication
 * pass", never "counted".
 */
const STEP_MARKERS = [
  /\b(?:design|blueprint|implement|review|merge|commit|push|deploy|release|ingest|recall|migrate|build|test)\b/i,
  /\bstep\b/i,
  /\bgate\b/i,
  /\bpipeline\b/i,
];

const OBSERVABLE_MARKERS = [
  /\bfiles?\b/i,
  /\bstatus\b/i,
  /\bcount\b/i,
  /\bexit code\b/i,
  /\btests?\b/i,
  /\bimports?\b/i,
  /\bcontract\b/i,
  /\bschema\b/i,
  /\bversion\b/i,
  /\bcommit\b/i,
  /\bfields?\b/i,
];

/**
 * A rule true by construction cannot be violated, so it is not enforceable —
 * it is a description of how the system already works. These read as claims
 * about identity or belief rather than constraints on a run.
 */
const NON_VIOLABLE_MARKERS = [
  /\bis what\b/i,
  /\bthe product is\b/i,
  /\bwe are\b/i,
  /\bthe point is\b/i,
  /\bframing\b/i,
];

export function classifyEnforceable(entry) {
  const text = `${entry.title ?? ''}\n${entry.body ?? ''}`;
  const namesStep = STEP_MARKERS.some((re) => re.test(text));
  const namesObservable = OBSERVABLE_MARKERS.some((re) => re.test(text));
  const violable = !NON_VIOLABLE_MARKERS.some((re) => re.test(text));
  const signals = { namesStep, namesObservable, violable };
  const all = namesStep && namesObservable && violable;
  return {
    signals,
    // Three-way on purpose. `historical` is a confident no; `candidate` is
    // "all three signals fired, a human must confirm"; nothing here is ever a
    // confident yes, because the yes is the judgement the spike is measuring.
    verdict: all ? 'candidate' : 'historical',
    adjudicated: null,
  };
}

/**
 * Map one ledger event to a SmartMemory decision payload (D3).
 *
 * Returns `null` for kinds that are not decisions — callers filter, they do not
 * branch on kind themselves, so the D3 table has exactly one implementation.
 *
 * `correct` maps to a supersede, which needs a target that only the backfill
 * knows (the decision written for the entry it corrects). The payload therefore
 * carries `supersedes_slug` and the caller resolves it; mapping it here would
 * require I/O and this file stays pure.
 */
export function ledgerEntryToDecision(entry, seq) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = entry.kind;
  if (!DECISION_KINDS.has(kind)) return null;

  const { slug, statement } = splitTitle(entry.title ?? '');
  const conviction = entry.conviction ?? null;
  const source = conviction?.source === 'stated'
    ? 'stated'
    : conviction?.source === 'inferred' ? 'inferred' : null;
  const level = conviction?.level ?? null;

  const confidence = source && level && CONFIDENCE[source]?.[level] !== undefined
    ? CONFIDENCE[source][level]
    : CONFIDENCE_UNSTATED;

  // D4: the guess/assertion distinction survives onto the decision itself, not
  // only into the confidence number, so a bundle rule built on a guess is
  // visibly built on a guess wherever it is read.
  const sourceType = source === 'stated'
    ? 'explicit'
    : source === 'inferred' ? 'inferred' : 'imported';

  const decision = {
    idempotency_key: stableEntryKey(entry, seq),
    content: statement,
    decision_type: kind === 'decide' ? decideSubtype(entry) : 'choice',
    confidence,
    source_type: sourceType,
    status: kind === 'open' ? 'pending' : 'active',
    domain: 'compose',
    tags: ['compose-judgment', `ledger:${kind}`, ...(slug ? [`slug:${slug}`] : [])],
    rationale: entry.body ?? '',
    rejected_alternatives: [],
    context_snapshot: {
      ledger_seq: seq,
      ledger_kind: kind,
      ledger_slug: slug,
      ledger_anchor: entry.anchor ?? null,
      written_at: entry.provenance?.written_at ?? null,
      via: entry.provenance?.via ?? null,
      actor: entry.provenance?.actor ?? null,
      conviction,
      // D4 review gate: an inferred conviction is not written at stated
      // confidence until the owner has ruled on it. The backfill REFUSES on
      // this flag rather than warning (no silent degradation).
      conviction_review_required: source === 'inferred',
      conviction_review: null,
    },
  };

  if (Array.isArray(entry.rejected)) {
    decision.rejected_alternatives = entry.rejected.map((r) => ({
      option: r.what ?? String(r),
      reason: r.why ?? '',
    }));
  }

  // A kill is a live decision NOT to do something, so it stays `active` with
  // the killed option recorded as the rejected alternative (D3). Mapping it to
  // `abandoned` would say the decision itself was dropped, which is the
  // opposite of what a kill means.
  if (kind === 'kill') {
    decision.rejected_alternatives.unshift({
      option: statement,
      reason: entry.reason ?? entry.body ?? '',
    });
    decision.content = `Do not: ${statement}`;
  }

  if (kind === 'correct') {
    decision.supersedes_slug = slug;
  }

  return decision;
}

/** Read a whole ledger stream into mapped decisions plus the skipped tail. */
export function mapLedger(events) {
  const decisions = [];
  const skipped = [];
  events.forEach((entry, i) => {
    const seq = i + 1;
    const mapped = ledgerEntryToDecision(entry, seq);
    if (mapped) {
      decisions.push({
        seq,
        entry,
        decision: mapped,
        enforceability: classifyEnforceable(entry),
      });
    } else {
      skipped.push({ seq, kind: entry?.kind ?? null, title: entry?.title ?? '' });
    }
  });
  return { decisions, skipped };
}
