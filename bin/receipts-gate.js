#!/usr/bin/env node
/**
 * receipts-gate — pre-push runner. `node bin/receipts-gate.js <base> <head>`.
 *
 * `base` may be git's all-zeros sha (a new ref); then the range is bounded by
 * the merge-base with origin/main, or head~1 when there is no origin/main —
 * fail CLOSED (scan something) rather than open (scan nothing).
 * Exit 1 on any violation. See lib/receipts-gate.js for what counts.
 */
import { execFileSync } from 'node:child_process';
import { scanRange, formatViolations } from '../lib/receipts-gate.js';

const ZERO = /^0{40}$/;
const [, , baseArg, headArg = 'HEAD'] = process.argv;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

let base = baseArg;
if (!base || ZERO.test(base)) {
  try { base = git(['merge-base', 'origin/main', headArg]); }
  catch { base = `${headArg}~1`; }
}

let found;
try {
  found = scanRange(base, headArg);
} catch (err) {
  // A gate that cannot read its input must not pass silently.
  console.error(`receipts-gate: could not scan ${base}..${headArg}: ${err.message}`);
  process.exit(2);
}

if (found.length) {
  console.error(formatViolations(found));
  process.exit(1);
}
console.error(`receipts-gate: ${base.slice(0, 7)}..${headArg} carries no unreceipted claims.`);
