/**
 * Runs .claude/hooks/canon-guard.mjs the way Claude Code does: tool call as
 * JSON on stdin, deny envelope on stdout, empty stdout means allow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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
  test('unconditionally denies a judgment write through the real hook', () => {
    const r = runHook(TARGET);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /authorized write outside this hook's reach/);
  });

  test('allows an unguarded path', () => {
    assert.equal(runHook('src/anything.js').allowed, true);
  });
});
