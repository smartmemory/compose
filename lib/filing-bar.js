// lib/filing-bar.js — COMP-DOGFOOD-CONTROL-INCIDENT-1
//
// The FILING BAR bullet (claude/rules/review-loop.md:11 in smart-memory-ops):
// a new guard, daemon, gate, watcher or kill switch needs a PRIOR INCIDENT.
// validate_feature prints it as the message of CONTROL_NO_INCIDENT.
//
// filingBarText() reads the bullet fresh through readHardRules when the
// workspace configured a rules dir, else returns FILING_BAR verbatim with a
// WARNING. test/control-incident.test.js pins FILING_BAR to the ops file.

import { join } from 'node:path';
import { readHardRules, readStore } from './live-state.js';

export const FILING_BAR_HEAD = '- **FILING BAR**';

// Verbatim review-loop.md:11.
export const FILING_BAR = "- **FILING BAR** (OWNER 2026-10-29 14:3x via s1-chat: \"...even though you could just manually fix the state instead i'm going to overengineer some crazy lambda and cron that runs every 5 minutes ... we don't care about that shit\"; full quote in rules-detail): a finding becomes a unit only if HIGH, or MEDIUM with a named holder and a plausible path; the rest is a note in the review file. No hygiene units. A new guard, daemon, gate, watcher or kill switch needs a PRIOR INCIDENT (a ledger line); fix an unlikely bad state by hand once.";

/** { text, warning }: the bullet read fresh when possible, else the constant plus why not. */
export function filingBarText(root) {
  let reason;
  try {
    const store = readStore(join(root, '.compose', 'data'));
    const rules = readHardRules(root, store.rules_dir);
    for (const f of rules.files) {
      const hit = f.bullets.find((b) => b.startsWith(FILING_BAR_HEAD));
      if (hit) return { text: hit.split("\n")[0], warning: null };
    }
    reason = rules.error || 'no FILING BAR bullet in the core rule files';
  } catch (err) {
    reason = err.message;
  }
  return {
    text: FILING_BAR,
    warning: `WARNING filing bar: fresh copy not found (${reason}); using the built-in copy of review-loop.md:11`,
  };
}
