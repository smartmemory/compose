/**
 * canon-guard.test.js — COMP-CANON-GUARD S4.
 *
 * Pure logic for the write-time PreToolUse hook:
 *   - decideCanonGuard: given a tool call, deny raw writes to hook-registered
 *     canon (docs/judgment/**), naming the tool; allow everything else; fail
 *     open on malformed input.
 *   - install/uninstall/status: idempotent .claude/settings.json transforms
 *     that register the hook without disturbing existing hooks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  decideCanonGuard,
  installGuardHook,
  uninstallGuardHook,
  guardHookStatus,
  realpathCanonicalize,
  HOOK_MATCHER,
  HOOK_COMMAND,
} from '../lib/canon-guard.js';

const ROOT = '/repo';

describe('decideCanonGuard — denies raw writes to hook-registered canon', () => {
  test('Write to a judgment record → deny, names judgment tools', () => {
    const d = decideCanonGuard({
      toolName: 'Write',
      toolInput: { file_path: 'docs/judgment/records/joints/x.json' },
      cwd: ROOT, projectRoot: ROOT,
    });
    assert.equal(d.deny, true);
    assert.match(d.reason, /judgment_/);
    assert.match(d.reason, /docs\/judgment\/records\/joints\/x\.json/);
  });

  test('Edit to a judgment projection (LEDGER.md) → deny', () => {
    const d = decideCanonGuard({
      toolName: 'Edit',
      toolInput: { file_path: 'docs/judgment/LEDGER.md' },
      cwd: ROOT, projectRoot: ROOT,
    });
    assert.equal(d.deny, true);
  });

  test('absolute path inside repo → normalized and denied', () => {
    const d = decideCanonGuard({
      toolName: 'Write',
      toolInput: { file_path: '/repo/docs/judgment/OBJECTIVE.md' },
      cwd: ROOT, projectRoot: ROOT,
    });
    assert.equal(d.deny, true);
  });
});

describe('decideCanonGuard — allows everything not hook-registered', () => {
  const allow = (name, toolInput) => {
    const d = decideCanonGuard({ toolName: name, toolInput, cwd: ROOT, projectRoot: ROOT });
    assert.equal(d.deny, false);
  };
  test('Write to ROADMAP.md (ship-only, not hook)', () => allow('Write', { file_path: 'ROADMAP.md' }));
  test('Write to feature.json (ship-only, not hook)', () => allow('Write', { file_path: 'docs/features/X/feature.json' }));
  test('Write to an authored design doc', () => allow('Write', { file_path: 'docs/features/X/design.md' }));
  test('Write to README', () => allow('Write', { file_path: 'README.md' }));
  test('Bash is not a guarded tool', () => allow('Bash', { command: 'sed -i s/a/b/ docs/judgment/LEDGER.md' }));
  test('a path outside the repo is ignored', () => allow('Write', { file_path: '/etc/passwd' }));
  test('near-miss dir docs/judgmentX is not matched', () => allow('Write', { file_path: 'docs/judgmentX/y.md' }));
});

describe('decideCanonGuard — fails open on malformed input', () => {
  const allow = (args) => assert.equal(decideCanonGuard(args).deny, false);
  test('missing file_path', () => allow({ toolName: 'Write', toolInput: {}, projectRoot: ROOT }));
  test('null toolInput', () => allow({ toolName: 'Write', toolInput: null, projectRoot: ROOT }));
  test('missing toolName', () => allow({ toolInput: { file_path: 'docs/judgment/LEDGER.md' }, projectRoot: ROOT }));
  test('non-string file_path', () => allow({ toolName: 'Write', toolInput: { file_path: 42 }, projectRoot: ROOT }));
  test('empty projectRoot still safe', () => allow({ toolName: 'Write', toolInput: { file_path: 'docs/judgment/LEDGER.md' } }));
});

describe('decideCanonGuard — canonicalization defeats path aliasing (Codex S4 finding 1)', () => {
  // Simulate a macOS firmlink: /alias/repo/... is the same file as /repo/...
  const canonicalize = (p) => p.replace(/^\/alias\/repo/, '/repo');

  test('aliased absolute path to canon → denied once canonicalized', () => {
    const d = decideCanonGuard({
      toolName: 'Edit',
      toolInput: { file_path: '/alias/repo/docs/judgment/LEDGER.md' },
      cwd: ROOT, projectRoot: ROOT, canonicalize,
    });
    assert.equal(d.deny, true);
  });

  test('same aliased path WITHOUT canonicalization slips through (documents why canon is required)', () => {
    const d = decideCanonGuard({
      toolName: 'Edit',
      toolInput: { file_path: '/alias/repo/docs/judgment/LEDGER.md' },
      cwd: ROOT, projectRoot: ROOT, // no canonicalize → lexical only
    });
    assert.equal(d.deny, false);
  });

  test('realpathCanonicalize returns a resolved path and never throws', () => {
    // Non-existent path under a real root → resolves lexically, no throw.
    const out = realpathCanonicalize('/definitely/not/here/docs/judgment/x.json');
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });

  test('realpathCanonicalize strips the macOS /System/Volumes/Data firmlink', () => {
    // realpath alone does NOT collapse this firmlink; the strip must.
    const out = realpathCanonicalize('/System/Volumes/Data/nope/docs/judgment/x.json');
    assert.ok(!out.startsWith('/System/Volumes/Data'), `expected firmlink stripped, got ${out}`);
    assert.equal(out, '/nope/docs/judgment/x.json');
  });

  test('a symlinked project root is resolved so canon under it is still denied (Codex S4 r2 finding 1)', () => {
    // altroot -> base (a symlinked alias of the repo root). A write addressed
    // through the alias must resolve to the same canon path and be denied.
    const base = mkdtempSync(join(tmpdir(), 'cg-sym-'));
    mkdirSync(join(base, 'docs', 'judgment'), { recursive: true });
    writeFileSync(join(base, 'docs', 'judgment', 'LEDGER.md'), 'x');
    const altroot = join(base, '..', `${basename(base)}-alias`);
    symlinkSync(base, altroot);
    const d = decideCanonGuard({
      toolName: 'Edit',
      toolInput: { file_path: join(altroot, 'docs', 'judgment', 'LEDGER.md') },
      cwd: base, projectRoot: base, canonicalize: realpathCanonicalize,
    });
    assert.equal(d.deny, true, 'a write through a symlinked root alias is still caught');
  });
});

describe('installGuardHook — idempotent settings.json transform', () => {
  test('adds PreToolUse group to empty settings', () => {
    const { settings, changed } = installGuardHook({});
    assert.equal(changed, true);
    const groups = settings.hooks.PreToolUse;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, HOOK_MATCHER);
    assert.equal(groups[0].hooks[0].command, HOOK_COMMAND);
    assert.equal(groups[0].hooks[0].type, 'command');
  });

  test('preserves existing unrelated hooks', () => {
    const existing = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x.sh' }] }] },
      enabledPlugins: { 'p': true },
    };
    const { settings } = installGuardHook(existing);
    assert.ok(settings.hooks.SessionStart);
    assert.deepEqual(settings.enabledPlugins, { p: true });
    assert.ok(settings.hooks.PreToolUse);
  });

  test('is idempotent — second install makes no change', () => {
    const once = installGuardHook({}).settings;
    const { changed } = installGuardHook(once);
    assert.equal(changed, false);
  });

  test('does not mutate the input object', () => {
    const input = {};
    installGuardHook(input);
    assert.deepEqual(input, {});
  });

  test('refreshes a drifted command in place (no duplicate group)', () => {
    const drifted = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node old/canon-guard.mjs' }] }] } };
    const { settings, changed } = installGuardHook(drifted);
    assert.equal(changed, true);
    const ours = settings.hooks.PreToolUse.filter(g => g.hooks.some(h => h.command.includes('canon-guard.mjs')));
    assert.equal(ours.length, 1);
    assert.equal(ours[0].hooks[0].command, HOOK_COMMAND);
    assert.equal(ours[0].matcher, HOOK_MATCHER);
  });
});

describe('install/uninstall preserve SIBLING hooks in a shared group (Codex S4 finding 2)', () => {
  const sibling = { type: 'command', command: 'node audit-write.mjs' };
  const mixedGroup = () => ({ hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [structuredClone(sibling), { type: 'command', command: HOOK_COMMAND }] }] } });

  test('install does not delete a sibling sharing our matcher group', () => {
    const { settings } = installGuardHook(mixedGroup());
    const allHooks = settings.hooks.PreToolUse.flatMap((g) => g.hooks);
    assert.ok(allHooks.some((h) => h.command === 'node audit-write.mjs'), 'sibling survived');
    assert.ok(allHooks.some((h) => h.command === HOOK_COMMAND), 'our hook present');
  });

  test('uninstall removes only our entry, keeping the sibling', () => {
    const { settings, changed } = uninstallGuardHook(mixedGroup());
    assert.equal(changed, true);
    const allHooks = (settings.hooks.PreToolUse ?? []).flatMap((g) => g.hooks);
    assert.ok(allHooks.some((h) => h.command === 'node audit-write.mjs'), 'sibling survived');
    assert.ok(!allHooks.some((h) => h.command === HOOK_COMMAND), 'our hook gone');
  });
});

describe('uninstallGuardHook', () => {
  test('removes our hook, leaves others', () => {
    const installed = installGuardHook({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 's.sh' }] }] } }).settings;
    const { settings, changed } = uninstallGuardHook(installed);
    assert.equal(changed, true);
    assert.ok(settings.hooks.Stop);
    assert.ok(!settings.hooks.PreToolUse || settings.hooks.PreToolUse.length === 0);
  });
  test('absent → no change', () => {
    const { changed } = uninstallGuardHook({});
    assert.equal(changed, false);
  });
});

describe('guardHookStatus', () => {
  test('absent', () => {
    assert.equal(guardHookStatus({}).state, 'absent');
  });
  test('installed (current)', () => {
    const s = installGuardHook({}).settings;
    assert.equal(guardHookStatus(s).state, 'installed');
  });
  test('stale when command drifted', () => {
    const s = { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: 'node old/canon-guard.mjs' }] }] } };
    assert.equal(guardHookStatus(s).state, 'stale');
  });
  test('stale when matcher drifted', () => {
    const s = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } };
    assert.equal(guardHookStatus(s).state, 'stale');
  });

  // Codex S4 finding 3 — ownership by executed-script leaf name, not loose substring.
  test('a drifted PATH to canon-guard.mjs is ours → stale (not absent)', () => {
    const s = { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: 'node old/canon-guard.mjs' }] }] } };
    assert.equal(guardHookStatus(s).state, 'stale');
  });
  test('a different script (canon-guard-v2.mjs) is NOT ours → absent', () => {
    const s = { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: 'node canon-guard-v2.mjs' }] }] } };
    assert.equal(guardHookStatus(s).state, 'absent');
  });
  test('a trailing-punctuation drift is still ours → stale (Codex S4 r2 finding 2)', () => {
    const s = { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: 'node old/canon-guard.mjs;' }] }] } };
    assert.equal(guardHookStatus(s).state, 'stale');
  });
  test('uninstall leaves a different script untouched', () => {
    const s = { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: 'node canon-guard-v2.mjs' }] }] } };
    const { changed } = uninstallGuardHook(s);
    assert.equal(changed, false);
  });
});
