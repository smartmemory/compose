/**
 * lib/fluid/ideabox-dates.js — the date vocabulary of the markdown boundary.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-1.
 *
 * The record contract types every event date as `format: "date-time"`
 * (`contracts/fluid-record.schema.json` — `killed.at`, `discussion[].at`), but
 * the ideabox markdown has only ever carried a bare `YYYY-MM-DD`: the
 * discussion grammar is `- [YYYY-MM-DD] author: text`
 * (`lib/ideabox.js:53`) and `killIdea` stamps `…toISOString().slice(0, 10)`
 * (`lib/ideabox.js:546`).
 *
 * Two directions, and BOTH were wrong before this module existed:
 *
 *   import  markdown date  → record date-time   (widen)
 *   render  record date-time → markdown date    (narrow)
 *
 * The importer passed the bare date straight into the contract, so importing
 * any idea carrying a discussion entry or a kill date threw
 * `must match format "date-time"`. The renderer emitted the full ISO timestamp
 * straight into the markdown, where `DISCUSSION_ENTRY_RE` cannot match it — so
 * a provider-written discussion entry degraded to an unparsed extra line and
 * was silently lost on the next read.
 *
 * Neither defect was caught, because no idea on disk had ever carried a
 * discussion entry and the Killed Ideas section was empty. Both paths were
 * dead code with passing tests over them.
 *
 * They live together in one module deliberately: the two conversions are a
 * single round-trip contract, and their drifting apart is precisely the bug.
 * Splitting them across the importer and the renderer is what let it happen.
 *
 * Precision is intentionally asymmetric. A record keeps the full timestamp; the
 * projection is a view and shows the day. Rendering a date-time into a file
 * whose grammar is a date does not preserve information, it corrupts the line.
 */

/** A bare calendar date, the only date form the ideabox markdown can carry. */
const MARKDOWN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EPOCH = new Date(0).toISOString();

/**
 * Widen a markdown date to a contract-valid `date-time`.
 *
 * A value that already carries a time is passed through untouched, so this is
 * safe to apply to input of mixed provenance (an imported entry and a
 * provider-written one can sit in the same array).
 *
 * @param {string|null|undefined} value a `YYYY-MM-DD`, a full ISO timestamp, or nothing
 * @returns {string} an ISO 8601 date-time
 */
export function toRecordTimestamp(value) {
  if (!value) return EPOCH;
  if (MARKDOWN_DATE_RE.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}

/**
 * Narrow a contract `date-time` to the markdown's `YYYY-MM-DD`.
 *
 * Anything unparseable is returned unchanged rather than coerced: emitting a
 * wrong-but-well-formed date would be worse than emitting the raw value, which
 * is at least visibly odd.
 *
 * @param {string|null|undefined} value an ISO 8601 date-time
 * @returns {string} a `YYYY-MM-DD`
 */
export function toMarkdownDate(value) {
  if (typeof value !== 'string') return '';
  const head = value.slice(0, 10);
  return MARKDOWN_DATE_RE.test(head) ? head : value;
}
