/**
 * roadmap-heading.js — Shared phase-heading parsing for ROADMAP.md.
 *
 * A phase heading is `## <title> — <status>`, where <title> may itself contain
 * em-dashes (e.g. `## Wave 6 — Situational Awareness — COMPLETE`). Splitting on
 * the FIRST ` — ` truncated such titles to their leading fragment and mis-read
 * the status — see issue #38. The status is instead the trailing segment that
 * begins, at an em-dash boundary, with a recognized status token.
 *
 * Single source of truth for the parser (roadmap-parser.js) and the typed-writer
 * preservers (roadmap-preservers.js), so they never disagree on a phaseId.
 */

// Canonical status enum. None is a prefix of another, so leading-token matching
// is unambiguous regardless of order.
export const STATUS_TOKENS = ['COMPLETE', 'IN_PROGRESS', 'PARTIAL', 'PLANNED', 'SUPERSEDED', 'PARKED', 'BLOCKED', 'KILLED'];

/**
 * Extract the leading status token from cell/override text. The token must be
 * the whole string OR be followed by whitespace or `(` — the only separators a
 * real status cell uses before commentary: `PARKED — needs X` → `PARKED`,
 * `PARTIAL (1a COMPLETE)` → `PARTIAL`, `COMPLETE` → `COMPLETE`. Deliberately
 * conservative: glued forms like `PLANNED-ish` or `PARKED/blocked` return null
 * (left for the validator to flag) rather than being coerced to a valid enum.
 * Case-insensitive; returns the canonical UPPERCASE token, or null if none.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseStatusToken(text) {
  const up = String(text ?? '').trim().toUpperCase();
  for (const t of STATUS_TOKENS) {
    if (up === t) return t;
    if (up.startsWith(t) && /[\s(]/.test(up[t.length])) return t;
  }
  return null;
}

// Matches a level-2 heading line and captures its content (everything after
// `## `). Excludes `###` milestones: the required `\s+` after `##` fails on a
// third `#`. Requires at least one content char, so a bare `## ` is not a phase.
export const PHASE_HEADING_TEXT_RE = /^##\s+(.+)$/;

/**
 * Split phase-heading content into { title, status }.
 *
 * The status is the run after the RIGHTMOST ` — ` boundary whose tail begins
 * with a recognized status token; the title is everything before it. Choosing
 * the rightmost (not the first) qualifying boundary is what lets a title
 * fragment that itself starts with a status word stay in the title
 * (`Phase 9 — BLOCKED API Cleanup — COMPLETE` → title `Phase 9 — BLOCKED API
 * Cleanup`, status `COMPLETE`) while still keeping status commentary that
 * contains an em-dash attached to the status (`A — PARKED — needs X` → status
 * `PARKED — needs X`, since `needs X` is not a status token so the PARKED
 * boundary stays the rightmost qualifying one). If no segment after a ` — `
 * begins with a status token, the whole string is the title.
 *
 * Limitation (inherent ambiguity): a segment of the form `TOKEN words` is
 * structurally identical whether it is a title fragment (`BLOCKED API Cleanup`)
 * or a status with trailing commentary (`SUPERSEDED by STRAT-1`). The rightmost
 * rule treats the LAST such segment as the status, so the rare heading whose
 * status commentary itself begins with another bare status token
 * (`X — PARKED — BLOCKED by upstream`) mis-splits. No real roadmap heading uses
 * that form (write `PARKED (blocked by upstream)` instead); the rightmost rule
 * is correct for every heading in the corpus and the common commentary forms.
 *
 *   'Wave 6 — Situational Awareness — COMPLETE' → { title: 'Wave 6 — Situational Awareness', status: 'COMPLETE' }
 *   'Phase 9 — BLOCKED API Cleanup — COMPLETE'  → { title: 'Phase 9 — BLOCKED API Cleanup', status: 'COMPLETE' }
 *   'A — PARKED — needs X'                       → { title: 'A', status: 'PARKED — needs X' }
 *   'Phase 0: Bootstrap — COMPLETE'              → { title: 'Phase 0: Bootstrap', status: 'COMPLETE' }
 *   'Wave 6 — Situational Awareness'             → { title: 'Wave 6 — Situational Awareness', status: '' }
 *
 * @param {string} text  heading content (without the leading `## `)
 * @returns {{ title: string, status: string }}
 */
export function splitPhaseHeading(text) {
  const s = String(text ?? '').trim();
  let best = null;
  for (const m of s.matchAll(/\s+—\s+/g)) {
    const tail = s.slice(m.index + m[0].length);
    if (parseStatusToken(tail)) best = { index: m.index, tail };
  }
  if (best) return { title: s.slice(0, best.index).trim(), status: best.tail.trim() };
  return { title: s, status: '' };
}
