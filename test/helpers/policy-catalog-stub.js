/**
 * policy-catalog-stub.js — fixture builders for COMP-POLICY-CHECK tests.
 *
 * Writes real `feedback_*.md` rule files into a tmp memory dir so the loader is
 * exercised end-to-end (parse → cache → scan) rather than against a hand-rolled
 * catalog object. The two canonical fixtures mirror the real memory files:
 * `feedback_never_suggest_stopping.md` and `feedback_external_prose.md`
 * (including its comment line and `exclude_regex` entry).
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Create an empty tmp memory dir. */
export function freshMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), 'policy-catalog-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a rule file.
 * @param {string} dir
 * @param {string} filename e.g. 'feedback_x.md'
 * @param {string} content
 */
export function writeRuleFile(dir, filename, content) {
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf-8');
  return path;
}

/** Rule with a `(?i)` regex, a phrase, and suppression signals. */
export const NEVER_SUGGEST_STOPPING = `---
name: Never suggest stopping points
description: Never ask if the user wants to stop or pick up later
type: feedback
---

Never suggest stopping points.

## Detection patterns

\`\`\`yaml
patterns:
  - regex: '(?i)\\bwant me to (continue|proceed|keep going|go on)\\b'
  - regex: '(?i)\\bshould i (continue|proceed|keep going|stop here|pause)\\b'
  - phrase: "shall i continue"
suppression_signals:
  - regex: '(?i)\\bone by one\\b'
  - regex: '(?i)\\b(walk|step) me through\\b'
  - phrase: "step by step"
\`\`\`
`;

/** Rule with an `exclude_regex` span remover and a comment inside the yaml block. */
export const EXTERNAL_PROSE = `---
name: feedback-external-prose
description: "External prose: no em dashes, no semicolons"
metadata:
  type: feedback
---

In external prose, never use em dashes or semicolons.

## Detection patterns

\`\`\`yaml
# Scope caveat for consumers: this rule governs EXTERNAL prose only. Code blocks
# and internal docs are exempt.
patterns:
  - regex: ' — '
  - regex: '\\w—\\w'
  - regex: '\\w; [a-z]'
  - exclude_regex: '\`\`\`[\\s\\S]*?\`\`\`'
suppression_signals:
  - regex: '(?i)\\b(internal|commit message|changelog)\\b'
  - phrase: "keep the em dashes"
\`\`\`
`;

/** Detection block whose YAML does not parse. */
export const MALFORMED_YAML = `---
name: broken
type: feedback
---

## Detection patterns

\`\`\`yaml
patterns:
  - regex: 'unclosed
   bad: [indent
\`\`\`
`;

/** Detection block that parses but declares no usable patterns. */
export const NO_PATTERNS_KEY = `---
name: no-patterns
type: feedback
---

## Detection patterns

\`\`\`yaml
suppression_signals:
  - phrase: "whatever"
\`\`\`
`;

/** Rule file with no detection block at all (normal, silently ignored). */
export const NO_BLOCK = `---
name: plain-rule
type: feedback
---

Just a rule with no detection patterns.
`;

/** Seed a memory dir with the two canonical fixtures. Returns the dir. */
export function seedCanonicalCatalog(dir = freshMemoryDir()) {
  writeRuleFile(dir, 'feedback_never_suggest_stopping.md', NEVER_SUGGEST_STOPPING);
  writeRuleFile(dir, 'feedback_external_prose.md', EXTERNAL_PROSE);
  return dir;
}
