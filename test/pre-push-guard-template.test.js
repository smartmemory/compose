/**
 * Static contract tests for the COMP-CANON-GUARD S5 pre-push gate.
 *
 * These inspect the source template directly: no hook is installed and no
 * fixture repository or temporary directory is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_VERSIONS } from '../lib/hooks-status.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(resolve(HERE, '..', 'bin', 'git-hooks', 'pre-push.template'), 'utf-8');
const VERIFY_CALL = '"$COMPOSE_NODE" "$COMPOSE_BIN" guard verify >> "$LOG" 2>&1';
const DOCS_ONLY_SKIP = 'if [ "$DOCS_ONLY" -eq 1 ]; then';

test('pre-push template bakes the current hook version', () => {
  assert.match(TEMPLATE, new RegExp(`^HOOK_VERSION="${HOOK_VERSIONS['pre-push']}"$`, 'm'));
});

test('judgment drift check runs before and outside the docs-only test skip', () => {
  const verifyIndex = TEMPLATE.indexOf(VERIFY_CALL);
  const docsOnlySkipIndex = TEMPLATE.indexOf(DOCS_ONLY_SKIP);

  assert.notEqual(verifyIndex, -1, 'template must invoke compose guard verify through COMPOSE_NODE/COMPOSE_BIN');
  assert.notEqual(docsOnlySkipIndex, -1, 'template must retain the docs-only test skip');
  assert.ok(
    verifyIndex < docsOnlySkipIndex,
    'compose guard verify must run before the docs-only conditional so canon-only pushes cannot skip it',
  );
  assert.equal(
    TEMPLATE.split(VERIFY_CALL).length - 1,
    1,
    'template must contain exactly one judgment drift check',
  );
});

test('judgment drift check logs output, aborts on failure, and documents the accepted bypass', () => {
  assert.match(TEMPLATE, /guard verify >> "\$LOG" 2>&1/);
  assert.match(TEMPLATE, /judgment drift detected — push aborted/);
  assert.match(TEMPLATE, /Run \\`compose guard verify\\` for details/);
  assert.match(TEMPLATE, /Accepted residual: git push --no-verify bypasses this hook/);
});
