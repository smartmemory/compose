/**
 * receipts-gate.js — a claim written as a fact must carry its receipt.
 *
 * Runs on every push (pre-push hook, including docs-only pushes) over the ADDED
 * lines of the pushed range — never the corpus. Scope: every `*.md` at any depth
 * (git pathspecs match `*` across `/`; rules files are in, deliberately) plus
 * docs/ JSON files, and every commit message in the range. That is what makes it a gate
 * that fires at the moment of the mistake rather than a memory nobody reads at
 * that moment, and what lets it ship with no baseline to reconcile.
 *
 * It is narrow on purpose. Three claim shapes, each one that did measurable
 * damage in this repo (2026-09-07, five wrong facts in one sweep, one habit):
 *
 *   test-coverage  a CHECKED acceptance box or a commit line saying a test pins
 *                  something, with no test path. FOH-7 had three of these; the
 *                  boxes were ticked off an audit that sampled 2 of 17 citations.
 *                  Receipt: a `test/...` path.
 *   flake-label    `flake`/`flaky` written as a state. build-stream-smoke was
 *                  labelled that way in three places over two months and was a
 *                  live product defect the whole time (12a357a). Receipt: a
 *                  measurement (`14/450`, `0 of 40`, `15 runs`) or a resolution
 *                  pinned to a sha.
 *   suite-green    a commit message claiming the suite passes with no counts.
 *                  The prior session reported green off a wrapper's exit code
 *                  and put numbers measured on an older tree into a commit.
 *                  Receipt: `N/M` anywhere in the message.
 *
 * Talking ABOUT a phrase is not asserting it: inline code spans and fenced
 * blocks are stripped before matching, so `pinned by test` in backticks passes.
 * An UNCHECKED box may say "(pinned by test)" — that is a design intent, and the
 * gate fires when the box is ticked, which is when the claim becomes a fact.
 *
 * Extending it: add a shape here with the incident that justifies it, and a
 * fixture in test/receipts-gate.test.js that MUST fire and one that MUST pass.
 * A shape with no incident behind it is a philosophy checker, not a gate.
 */

import { execFileSync } from 'node:child_process';

const CHECKED_BOX = /^\s*[-*]\s+\[[xX]\]/;
const TEST_CLAIM = /\b(pinned|covered|guarded|locked|protected)\s+by\s+(a\s+|the\s+|its\s+)?tests?\b|\bhas\s+(a\s+|its\s+own\s+)?tests?\b|\btested\s+by\b/i;
const TEST_RECEIPT = /\btests?\/[\w./@-]+|\.test\.(m?js|jsx|ts)\b/;

const FLAKE_CLAIM = /\bflak(e|y|es|ed|ing|iness)\b/i;
const MEASUREMENT = /\b\d+\s*(\/|of|out\s+of|in)\s*\d+\b|\b\d+\s*(\w+\s+)?(runs?|x|times|iterations)\b/i;
const HEADING = /^\s*#{1,6}\s/;
// A flake claim is receipted by a measurement, or by being CLOSED the way this
// repo closes claims at their origin: an uppercase status word next to a sha
// or a date. Lowercase "fixed"/"closed" do NOT count — they are everywhere in
// prose and a neighbouring thread's "fixed @sha" was found vouching for an
// unrelated open flake claim. DISOWNED is for the line itself saying the flake
// was never one.
const CLOSED = /\b(RESOLVED|KILLED|SUPERSEDED|FIXED)\b/;
const CLOSER = /\b[0-9a-f]{7,40}\b|\b20\d\d-\d\d-\d\d\b/;
const DISOWNED = /\b(not\s+a\s+flake|never\s+a\s+flake|was\s+real|defect|root\s+cause)\b/i;

const GREEN_CLAIM = /\b(suite|tests?|everything|all)\s+(is\s+|are\s+|was\s+|were\s+|went\s+)?(green|pass(es|ed|ing)?)\b|\ball\s+green\b|\bgreen\s+suite\b/i;
const COUNTS = /\b\d+\s*\/\s*\d+\b/;

/** Remove inline code spans — a quoted phrase is mentioned, not asserted. */
function stripCodeSpans(line) {
  return line.replace(/`[^`]*`/g, '');
}

/** How far "beside it" reaches: a wrapped checkbox or sentence, or a
 *  RESOLVED annotation indented under the claim. Not a paragraph. */
export const RECEIPT_WINDOW = 3;

/**
 * Classify one ADDED line from a doc. The CLAIM must be on the line; the
 * RECEIPT may be anywhere in `context` (the line plus its neighbours within
 * RECEIPT_WINDOW added lines of the same file — `scanRange` builds it). With
 * no context given, the line is its own context.
 *
 * Headings are exempt from `flake-label`: a heading titles the body that
 * follows, and that body is scanned line by line on its own.
 *
 * @param {string} rawLine
 * @param {string} [context]
 * @returns {{shape: string, needs: string} | null}
 */
export function classifyDocLine(rawLine, context = rawLine) {
  // The CLAIM is read with code spans stripped (quoting a phrase is mentioning
  // it). The RECEIPT is read raw: a path or a count in backticks is still a
  // receipt — paths are conventionally written that way.
  const line = stripCodeSpans(rawLine);
  const near = context;
  if (CHECKED_BOX.test(line) && TEST_CLAIM.test(line) && !TEST_RECEIPT.test(near)) {
    return { shape: 'test-coverage', needs: `the test path (test/<file>.test.js[:line]) within ${RECEIPT_WINDOW} lines` };
  }
  if (!HEADING.test(line) && FLAKE_CLAIM.test(line) && !DISOWNED.test(line)
      && !MEASUREMENT.test(near) && !(CLOSED.test(near) && CLOSER.test(near))) {
    return { shape: 'flake-label', needs: `a measurement (e.g. "3/40 under load"), or RESOLVED/KILLED with a sha or date, within ${RECEIPT_WINDOW} lines` };
  }
  return null;
}

/**
 * Classify one commit message (whole body — receipts for a suite claim are
 * usually on their own line). Returns violations.
 * @param {string} message
 * @returns {Array<{shape: string, needs: string, excerpt: string}>}
 */
export function classifyCommitMessage(message) {
  const out = [];
  const stripped = stripFences(message).split('\n').map(stripCodeSpans);
  const whole = stripFences(message); // receipts are read raw, claims stripped
  for (const line of stripped) {
    if (TEST_CLAIM.test(line) && !TEST_RECEIPT.test(line) && !TEST_RECEIPT.test(whole)) {
      out.push({ shape: 'test-coverage', needs: 'a test path somewhere in the message', excerpt: line.trim() });
      break;
    }
  }
  for (const line of stripped) {
    if (GREEN_CLAIM.test(line) && !COUNTS.test(whole)) {
      out.push({ shape: 'suite-green', needs: 'pass/total counts (e.g. "node 6412/6412") somewhere in the message', excerpt: line.trim() });
      break;
    }
  }
  for (const line of stripped) {
    // A commit message is one unit: the disowning phrase, like every other
    // receipt here, may sit anywhere in it.
    const v = FLAKE_CLAIM.test(line) && !DISOWNED.test(whole)
      && !MEASUREMENT.test(whole) && !(CLOSED.test(whole) && CLOSER.test(whole))
      ? { shape: 'flake-label', needs: 'a measurement, or RESOLVED/KILLED with a sha or date, somewhere in the message', excerpt: line.trim() }
      : null;
    if (v) { out.push(v); break; }
  }
  return out;
}

/** Drop fenced code blocks (``` ... ```). */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Added doc lines in `base..head`, as {file, line, text}. Fenced blocks are
 * skipped by tracking fence state per file — the diff is unified=0 so context
 * is absent, which means a fence opened in an UNCHANGED line is invisible; a
 * miss there is a false positive the author fixes by quoting the phrase inline.
 */
export function addedDocLines(base, head, { cwd = process.cwd(), git = runGit } = {}) {
  const diff = git(['diff', '--unified=0', '--no-color', `${base}..${head}`, '--',
    'docs/**/*.md', 'docs/**/*.json', '*.md'], cwd);
  const out = [];
  let file = null;
  let lineNo = 0;
  let inFence = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); inFence = false; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      if (/^\s*```/.test(text)) { inFence = !inFence; lineNo++; continue; }
      if (!inFence && file && file !== '/dev/null') out.push({ file, line: lineNo, text });
      lineNo++;
    }
  }
  return out;
}

/** Commit messages in `base..head`, oldest first, as {sha, message}. */
export function commitMessages(base, head, { cwd = process.cwd(), git = runGit } = {}) {
  const sep = '\u001e'; // record separator — commit bodies contain every printable char
  const raw = git(['log', '--reverse', `--format=%H${sep}%B${sep}`, `${base}..${head}`], cwd);
  const out = [];
  const parts = raw.split(sep);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const sha = parts[i].trim();
    if (!sha) continue;
    out.push({ sha, message: parts[i + 1] });
  }
  return out;
}

/**
 * Scan a range. Returns every violation with its location.
 * @returns {Array<{where: string, shape: string, needs: string, excerpt: string}>}
 */
export function scanRange(base, head, opts = {}) {
  const found = [];
  const added = addedDocLines(base, head, opts);
  const { cwd = process.cwd(), git = runGit } = opts;
  const filesAtHead = new Map();
  const fileAtHead = (file) => {
    if (!filesAtHead.has(file)) {
      let body = '';
      try { body = git(['show', `${head}:${file}`], cwd); } catch { body = ''; }
      filesAtHead.set(file, body);
    }
    return filesAtHead.get(file);
  };
  for (let i = 0; i < added.length; i++) {
    const { file, line, text } = added[i];
    const context = CHECKED_BOX.test(text)
      ? listItemOf(fileAtHead(file), line)
      : neighboursOf(added, i);
    const v = classifyDocLine(text, context);
    if (v) found.push({ where: `${file}:${line}`, ...v, excerpt: text.trim() });
  }
  for (const { sha, message } of commitMessages(base, head, opts)) {
    for (const v of classifyCommitMessage(message)) {
      found.push({ where: `commit ${sha.slice(0, 7)}`, ...v });
    }
  }
  return found;
}

/**
 * Prose context: same file, within RECEIPT_WINDOW by LINE NUMBER — two hunks
 * far apart in one file are not "beside" each other just because the diff
 * lists them consecutively.
 */
function neighboursOf(added, i) {
  const { file, line } = added[i];
  return added
    .slice(Math.max(0, i - RECEIPT_WINDOW), i + RECEIPT_WINDOW + 1)
    .filter((n) => n.file === file && Math.abs(n.line - line) <= RECEIPT_WINDOW)
    .map((n) => n.text)
    .join('\n');
}

/**
 * Checklist context: the item ITSELF — its line plus the indented continuation
 * lines under it, up to the next item, heading, or blank line. Checklists are
 * dense and every item is its own claim, so a symmetric window let a
 * neighbouring item's test path vouch for a box that had none (that is exactly
 * how the FOH-7 audit commit slipped through a first draft of this gate).
 *
 * Read from the FILE AT `head`, not the diff: a box flipped [ ]→[x] with its
 * receipt already on an unchanged continuation line is fine, and a zero-context
 * diff cannot see that line.
 */
function listItemOf(fileAtHead, lineNo) {
  const lines = fileAtHead.split('\n');
  const parts = [lines[lineNo - 1] ?? ''];
  for (let j = lineNo; j < lines.length; j++) {
    const t = lines[j];
    if (!/^\s+\S/.test(t) || /^\s*[-*]\s+\[/.test(t) || HEADING.test(t)) break;
    parts.push(t);
  }
  return parts.join('\n');
}

/** Render violations for the hook. */
export function formatViolations(found) {
  const lines = [`receipts-gate: ${found.length} claim(s) written as fact with no receipt beside them:`, ''];
  for (const v of found) {
    lines.push(`  ${v.where}  [${v.shape}]`);
    lines.push(`    ${truncate(v.excerpt, 140)}`);
    lines.push(`    needs: ${v.needs}`);
    lines.push('');
  }
  lines.push('A fact without a measurement is a guess with good posture. Add the receipt, or');
  lines.push('quote the phrase in backticks if you are talking about it rather than asserting it.');
  return lines.join('\n');
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
