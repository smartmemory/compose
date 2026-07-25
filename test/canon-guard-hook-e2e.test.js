/**
 * COMP-CANON-OVERRIDE S3 — end-to-end through the real hook process.
 *
 * Runs .claude/hooks/canon-guard.mjs the way Claude Code does: tool call as
 * JSON on stdin, deny envelope on stdout, empty stdout means allow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mintGrant } from '../lib/canon-override.js';

const ROOT = process.cwd();
const HOOK = join(ROOT, '.claude/hooks/canon-guard.mjs');
const TARGET = 'docs/judgment/records/joints/__hook_e2e_probe.json';

/** @returns {{allowed:boolean, reason:string|null}} */
function runHook(filePath) {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: join(ROOT, filePath) },
    cwd: ROOT,
  });
  const stdout = execFileSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8' });
  if (!stdout.trim()) return { allowed: true, reason: null };
  const parsed = JSON.parse(stdout);
  return {
    allowed: parsed?.hookSpecificOutput?.permissionDecision !== 'deny',
    reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? null,
  };
}

describe('canon-guard hook — end to end', () => {
  test('denies a judgment write, and the denial names the override tool', () => {
    const r = runHook(TARGET);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /canon_override_grant/);
  });

  test('allows an unguarded path', () => {
    assert.equal(runHook('src/anything.js').allowed, true);
  });

  test('denies governance state without advertising an override', () => {
    const r = runHook('.compose/canon-overrides.jsonl');
    assert.equal(r.allowed, false);
    assert.match(r.reason, /cannot be overridden/i);
  });

  test('grant → allowed once → denied again (single-use, end to end)', (t) => {
    // This mints a REAL grant in this workspace, because the hook resolves its
    // project root from its own location and cannot be pointed at a temp dir
    // (an env var that redirects the guard would itself be a bypass vector).
    //
    // So the test restores what it wrote. Append-only is a runtime invariant of
    // the writer, not of the test harness, and leaving rows behind would fill
    // the bypass ledger with test noise — defeating the one analysis it exists
    // for: bypasses concentrated on a path are a missing tool operation.
    const ledgerPath = join(ROOT, '.compose/canon-overrides.jsonl');
    const attestPath = join(ROOT, '.compose/canon-overrides-attest.json');
    const before = {
      ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath) : null,
      attest: existsSync(attestPath) ? readFileSync(attestPath) : null,
    };

    const grant = mintGrant(ROOT, {
      path: TARGET, reason: 'hook e2e test', operation: 'test',
    });
    t.after(() => {
      for (const p of [
        join(ROOT, '.compose/data/canon-grants', `${grant.token_id}.json`),
        join(ROOT, '.compose/data/canon-grants/consumed', `${grant.token_id}.json`),
      ]) rmSync(p, { force: true });
      for (const [path, prior] of [[ledgerPath, before.ledger], [attestPath, before.attest]]) {
        if (prior === null) rmSync(path, { force: true });
        else writeFileSync(path, prior);
      }
    });

    assert.equal(runHook(TARGET).allowed, true, 'the grant is honoured exactly once');
    assert.equal(runHook(TARGET).allowed, false, 'the token is burned');
  });
});
