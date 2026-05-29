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
 * The status is the longest trailing run that begins, at a ` — ` boundary, with
 * a recognized status token; the title is everything before it. Scanning left to
 * right and returning the first qualifying boundary keeps status commentary that
 * itself contains an em-dash (`PARKED — needs X`) attached to the status, while
 * an em-dash that is part of the title (`Wave 6 — Situational Awareness`) stays
 * in the title. If no segment after a ` — ` begins with a status token, the whole
 * string is the title and the status is empty.
 *
 *   'Wave 6 — Situational Awareness — COMPLETE' → { title: 'Wave 6 — Situational Awareness', status: 'COMPLETE' }
 *   'A — PARKED — needs X'                       → { title: 'A', status: 'PARKED — needs X' }
 *   'Phase 0: Bootstrap — COMPLETE'              → { title: 'Phase 0: Bootstrap', status: 'COMPLETE' }
 *   'Wave 6 — Situational Awareness'             → { title: 'Wave 6 — Situational Awareness', status: '' }
 *
 * @param {string} text  heading content (without the leading `## `)
 * @returns {{ title: string, status: string }}
 */
export function splitPhaseHeading(text) {
  const s = String(text ?? '').trim();
  for (const m of s.matchAll(/\s+—\s+/g)) {
    const tail = s.slice(m.index + m[0].length);
    if (parseStatusToken(tail)) {
      return { title: s.slice(0, m.index).trim(), status: tail.trim() };
    }
  }
  return { title: s, status: '' };
}
