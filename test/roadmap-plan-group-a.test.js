/**
 * roadmap-plan-group-a.test.js — COMP-ROADMAP-PLAN Group A (T1, T4).
 *
 * T1 (S6): the `complexity` JSDoc enum in lib/feature-json.js must document the
 *   SAME set that lib/feature-writer.js enforces (COMPLEXITIES = S|M|L|XL), not
 *   the stale low|medium|high. Contract test: the documented enum equals the
 *   enforced set.
 * T4 (S1a): the plan mode's runner.defaultTemplate must be 'plan' (not the
 *   stale 'new'), so the plan lifecycle resolves its own pipeline template.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = `${REPO_ROOT}/lib`;

// ---------------------------------------------------------------------------
// T1 (S6) — complexity enum doc matches the enforced COMPLEXITIES set
// ---------------------------------------------------------------------------

test('T1: complexity JSDoc in feature-json.js documents the enforced COMPLEXITIES set (S|M|L|XL)', () => {
  const src = readFileSync(`${LIB_DIR}/feature-json.js`, 'utf-8');
  // The @property line for `complexity`.
  const line = src.split('\n').find((l) => /@property\s+\{string\}\s+\[complexity\]/.test(l));
  assert.ok(line, 'a @property [complexity] JSDoc line must exist');

  // Extract the documented enum tokens from the JSDoc comment text.
  const documented = (line.match(/\b(S|M|L|XL|low|medium|high)\b/g) || []);
  const documentedSet = new Set(documented);

  // The enforced set is the single source of truth in feature-writer.js.
  const writerSrc = readFileSync(`${LIB_DIR}/feature-writer.js`, 'utf-8');
  const compMatch = writerSrc.match(/const COMPLEXITIES\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(compMatch, 'feature-writer.js must declare COMPLEXITIES = new Set([...])');
  const enforced = compMatch[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  const enforcedSet = new Set(enforced);

  assert.deepEqual([...documentedSet].sort(), [...enforcedSet].sort(),
    'the documented complexity enum must equal the enforced COMPLEXITIES set');
  assert.ok(!/low|medium|high/.test(line),
    'the stale low|medium|high vocab must be gone from the complexity doc');
});

// ---------------------------------------------------------------------------
// T4 (S1a) — plan mode's defaultTemplate is 'plan'
// ---------------------------------------------------------------------------

test('T4: getMode("plan").runner.defaultTemplate === "plan"', async () => {
  const { getMode } = await import(`${LIB_DIR}/lifecycle-modes.js`);
  assert.equal(getMode('plan').runner.defaultTemplate, 'plan',
    'plan mode must resolve its own "plan" pipeline template, not the legacy "new"');
});
