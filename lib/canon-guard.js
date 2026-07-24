/**
 * canon-guard.js — COMP-CANON-GUARD S4 (pure logic for the write-time hook).
 *
 * Two responsibilities, both pure (no I/O — the runtime wrapper
 * .claude/hooks/canon-guard.mjs and bin/compose.js do the I/O):
 *
 *   1. decideCanonGuard — the PreToolUse decision. Deny a raw Write/Edit to a
 *      path the registry marks hook-enforced (docs/judgment/**), naming the
 *      tool that owns it. Allow everything else. FAIL OPEN on any malformed
 *      input — a guard that wedges the session is worse than one that misses.
 *
 *   2. installGuardHook / uninstallGuardHook / guardHookStatus — idempotent
 *      transforms over a parsed .claude/settings.json object that register the
 *      hook under hooks.PreToolUse without disturbing existing hooks.
 *
 * The hook is the 'hook' enforcement point of the shared canon-registry. It is
 * Claude-runtime-scoped: Codex-dispatched edits and Bash (sed/heredoc) bypass
 * it — the runtime-neutral backstop is S5/S6 (see design.md honest limits).
 */
import { relative, resolve, isAbsolute, dirname, basename, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { matchEntry } from './canon-registry.js';

/** Tools whose file writes the hook intercepts. */
export const GUARDED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** How the hook registers in .claude/settings.json. */
export const HOOK_MATCHER = 'Write|Edit|NotebookEdit';
export const HOOK_COMMAND = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/canon-guard.mjs"';

/**
 * A command is ours iff it executes a file whose leaf name is exactly
 * canon-guard.mjs. This is stricter than a loose substring: it matches our
 * command and a drifted path (node old/canon-guard.mjs → still ours, so status
 * reports 'stale'), but NOT a different script (canon-guard-v2.mjs) and not an
 * unrelated command that merely names the file inside a larger word.
 */
const OUR_SCRIPT_RE = /(?:^|[\s"'/\\=])canon-guard\.mjs(?:$|[\s"';:&|)(<>])/;

/** True if a hook entry is our canon-guard hook (by executed-script leaf name). */
function isOurHookEntry(h) {
  return !!h && h.type === 'command' && typeof h.command === 'string' && OUR_SCRIPT_RE.test(h.command);
}

/**
 * Strip the macOS data-volume firmlink prefix. /System/Volumes/Data mirrors /,
 * so /System/Volumes/Data/Users/x IS /Users/x — but realpath does NOT collapse
 * firmlinks (unlike symlinks), so this must be done by hand.
 */
function stripFirmlink(x) {
  return x.replace(/^\/System\/Volumes\/Data(?=\/)/, '') || x;
}

/**
 * Canonicalize a path to defeat filesystem aliasing before lexical matching:
 * realpath collapses symlinks and case folding; stripFirmlink handles the macOS
 * /System/Volumes/Data firmlink realpath leaves alone. The target of a Write may
 * not exist yet, so realpath the longest existing ancestor and re-append the
 * not-yet-created tail. Best-effort — falls back to a lexical resolve on any
 * error (the caller fails open regardless).
 *
 * NOT alias-proof against every vector (bind mounts, hardlinks) — those are the
 * same runtime-scoped bucket as the Bash bypass, closed by S5/S6 on the tree.
 */
export function realpathCanonicalize(p) {
  try {
    // Do NOT resolve(p) up front: resolve() collapses `..` LEXICALLY before any
    // symlink resolves, so `symlink/../real` mis-normalizes (Codex S4 r2 finding
    // 1). realpath resolves `..` and symlinks together but needs an existing
    // path — so walk up the RAW path to the longest existing prefix, realpath
    // THAT, and re-append the not-yet-created tail.
    let cur = p;
    const tail = [];
    while (cur && !existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) { cur = ''; break; } // reached root, nothing existed
      tail.unshift(basename(cur));
      cur = parent;
    }
    if (!cur) return stripFirmlink(resolve(p)); // nothing existed → lexical fallback
    let base;
    try { base = realpathSync.native(cur); } catch { base = resolve(cur); }
    const full = tail.length ? join(base, ...tail) : base;
    return stripFirmlink(full);
  } catch {
    return resolve(p);
  }
}

/**
 * Decide whether to deny a PreToolUse tool call.
 *
 * @param {object} args
 * @param {string} [args.toolName]
 * @param {object} [args.toolInput]     - the tool's arguments (file_path / notebook_path)
 * @param {string} [args.cwd]           - session cwd (for resolving a relative file_path)
 * @param {string} [args.projectRoot]   - repo root the registry patterns are relative to
 * @param {string} [args.featuresDir='docs/features']
 * @param {(p:string)=>string} [args.canonicalize] - map a path to its real, alias-free form.
 *   The runtime wrapper passes realpathCanonicalize; pure tests inject a stub or omit it.
 * @returns {{deny: boolean, reason?: string, path?: string}}
 */
export function decideCanonGuard({ toolName, toolInput, cwd, projectRoot, featuresDir = 'docs/features', canonicalize } = {}) {
  try {
    if (!GUARDED_TOOLS.has(toolName)) return { deny: false };
    const raw = toolInput && (toolInput.file_path ?? toolInput.notebook_path);
    if (typeof raw !== 'string' || !raw) return { deny: false };
    if (typeof projectRoot !== 'string' || !projectRoot) return { deny: false };

    // Canonicalize BOTH root and target with the same function so an aliased
    // target (firmlink/symlink/case) can't slip a real canonical write past a
    // lexical relative() (Codex S4 finding 1). Default = identity (lexical).
    const canon = typeof canonicalize === 'function' ? canonicalize : (x) => x;
    const abs = isAbsolute(raw) ? raw : resolve(cwd || projectRoot, raw);
    const rel = relative(canon(projectRoot), canon(abs));
    // Outside the repo (empty, parent-relative, or still absolute) → not our canon.
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { deny: false };
    // Normalize Windows separators defensively so registry patterns (forward-slash) match.
    const relPosix = rel.split(/[\\/]/).join('/');

    const entry = matchEntry(relPosix, { featuresDir, point: 'hook' });
    if (!entry) return { deny: false };

    const tools = entry.tools.join(', ');
    return {
      deny: true,
      path: relPosix,
      reason:
        `${relPosix} is tool-owned canon (COMP-CANON-GUARD). A direct ${toolName} is blocked — ` +
        `write it through one of: ${tools}. These tools stamp provenance and regenerate the ` +
        `docs/judgment/** projections from records; a hand-edit is unattributed and overwritten on the next regen. ` +
        `To override deliberately, use the canon override path (not yet available this slice — remove the path from ` +
        `the registry hook set if you truly must hand-edit).`,
    };
  } catch {
    return { deny: false }; // fail open — never wedge the session
  }
}

// ── settings.json registration ───────────────────────────────────────────────

function clone(obj) {
  return obj == null ? {} : structuredClone(obj);
}

/** Our canonical PreToolUse group. */
function ourGroup() {
  return { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] };
}

/**
 * Remove OUR hook ENTRIES from each group, preserving sibling hooks that happen
 * to share the group, and dropping only groups left empty. Operates at the hook
 * level, not the group level (Codex S4 finding 2 — a group-level "any child is
 * ours → delete the group" wiped unrelated sibling hooks).
 *
 * @returns {Array<object>} the pruned groups
 */
function pruneOurHooks(groups) {
  const out = [];
  for (const g of groups) {
    if (!Array.isArray(g.hooks)) { out.push(g); continue; }
    const kept = g.hooks.filter((h) => !isOurHookEntry(h));
    if (kept.length === 0) continue;              // group had only our hook → drop it
    if (kept.length === g.hooks.length) { out.push(g); continue; } // nothing of ours here
    out.push({ ...g, hooks: kept });              // keep siblings, our entry removed
  }
  return out;
}

/**
 * Ensure our hook is registered with the current matcher + command in its own
 * dedicated group, preserving every other hook. Idempotent.
 *
 * @returns {{settings: object, changed: boolean}}
 */
export function installGuardHook(settings) {
  const s = clone(settings);
  s.hooks = s.hooks ?? {};
  const before = Array.isArray(s.hooks.PreToolUse) ? JSON.stringify(s.hooks.PreToolUse) : null;
  const existing = Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse.map((g) => structuredClone(g)) : [];

  // Strip any prior copy of our hook (from anywhere, incl. mixed groups), then
  // append one clean dedicated group. Siblings in mixed groups are preserved.
  const next = pruneOurHooks(existing);
  next.push(ourGroup());
  s.hooks.PreToolUse = next;

  const changed = before !== JSON.stringify(next);
  return { settings: s, changed };
}

/**
 * Remove our hook registration, preserving sibling hooks, pruning emptied
 * groups and an emptied PreToolUse array. Idempotent.
 *
 * @returns {{settings: object, changed: boolean}}
 */
export function uninstallGuardHook(settings) {
  const s = clone(settings);
  if (!s.hooks || !Array.isArray(s.hooks.PreToolUse)) return { settings: s, changed: false };
  const before = JSON.stringify(s.hooks.PreToolUse);
  const next = pruneOurHooks(s.hooks.PreToolUse.map((g) => structuredClone(g)));
  if (next.length === 0) delete s.hooks.PreToolUse;
  else s.hooks.PreToolUse = next;
  const after = s.hooks.PreToolUse ? JSON.stringify(s.hooks.PreToolUse) : null;
  return { settings: s, changed: before !== after };
}

/**
 * Report the guard hook's registration state.
 * @returns {{state: 'installed'|'stale'|'absent'}}
 */
export function guardHookStatus(settings) {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return { state: 'absent' };
  const ours = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.some(isOurHookEntry));
  if (ours.length === 0) return { state: 'absent' };
  const current = ours.some(
    (g) => g.matcher === HOOK_MATCHER && g.hooks.length === 1 && g.hooks[0].command === HOOK_COMMAND,
  );
  return { state: current && ours.length === 1 ? 'installed' : 'stale' };
}
