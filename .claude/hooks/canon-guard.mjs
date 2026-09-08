#!/usr/bin/env node
/**
 * canon-guard.mjs — COMP-CANON-GUARD S4 PreToolUse hook (runtime wrapper).
 *
 * Registered in .claude/settings.json by `compose guard install`. Claude Code
 * runs it before every Write/Edit/NotebookEdit and pipes the tool call as JSON
 * on stdin. All logic lives in lib/canon-guard.js (pure, tested); this wrapper
 * only does I/O: read stdin → decide → emit the deny envelope.
 *
 * Deny protocol (verified against code.claude.com/docs/en/hooks 2026-07-24):
 * exit 0 + stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 * "permissionDecision":"deny","permissionDecisionReason":"..."}}. No output =
 * allow. FAIL OPEN on any error — a guard that wedges the session is worse than
 * one that misses.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { decideCanonGuard, realpathCanonicalize } from '../../lib/canon-guard.js';

function allow() { process.exit(0); }

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  allow(); // unreadable/invalid stdin → don't block
}

try {
  // The hook lives at <repo>/.claude/hooks/canon-guard.mjs → repo root is two up.
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const decision = decideCanonGuard({
    toolName: payload?.tool_name,
    toolInput: payload?.tool_input,
    cwd: payload?.cwd,
    projectRoot,
    canonicalize: realpathCanonicalize,
  });
  if (decision.deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    }));
  }
} catch {
  // fall through to allow
}
process.exit(0);
