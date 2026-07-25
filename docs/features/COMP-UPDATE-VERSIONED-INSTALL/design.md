# COMP-UPDATE-VERSIONED-INSTALL: Design — safe auto-update via versioned install

**Status:** PLANNED — not designed in full. Filed 2026-07-25 so the idea is not lost.
**Date:** 2026-07-25

## Related Documents

- COMP-UPDATE-NUDGE — the notify-only slice, designed and scoped to never mutate an install
- `bin/compose.js:643` `runUpdate` — today's manual update path

---

## Problem

Compose cannot safely update itself in place. `bin/compose.js` and `lib/**` contain **109 lazy
`await import()` sites** (75 in `bin/compose.js` alone), so an `npm install -g @latest` over a
running process leaves that process lazily importing *new* modules into an *old* module graph.
Mixed-version code inside one process is worse than stale code and is undebuggable from the
outside. The MCP server, being the longest-lived compose process, is the most exposed.

Because of that, COMP-UPDATE-NUDGE deliberately stops at printing a line. This feature is what
it would take to actually auto-update.

## Goal

Make auto-update safe by construction rather than by timing, so compose can update itself
without a running process ever observing a half-swapped module graph.

## The approach worth copying

Claude Code's native install, verified on this machine 2026-07-25:

```
~/.local/bin/claude -> ~/.local/share/claude/versions/2.1.220
~/.local/share/claude/versions/   ->   2.1.218  2.1.219  2.1.220
```

Versions are installed **side by side** and activated by flipping a symlink. Nothing a running
process depends on is ever overwritten, so a live session keeps a coherent module graph and
the next launch picks up the new version. Config carries `installMethod: "native"` and
`autoUpdatesProtectedForNative: true` — native installs keep auto-updating independently of
the `autoUpdates` user setting. Three versions are retained, which also provides rollback.

For comparison, `codex` (Homebrew here) exposes an explicit `codex update` and does not
silently self-update.

## Why this is its own feature

Adopting it means compose stops being a plain npm global:

- A version-directory layout plus a launcher shim
- A migration for every existing npm global and git-clone install
- Retention and rollback policy
- Interaction with `healStratumWiring` and `.mcp.json`, whose absolute paths would become
  version-scoped
- Stratum comes along inside the versioned tree, which incidentally fixes caret drift

## Files

| File | Action | Purpose |
|------|--------|---------|
| — | — | Not scoped yet; this is a placeholder design pending its own brainstorm |

## Open Questions

- Does compose keep npm as an install channel alongside a native layout, or replace it?
- Does the symlink flip happen on update, or on next launch after a staged download?
- How does a version-scoped path interact with `.mcp.json` entries already written by
  `healStratumWiring`?
- Retention count, and what rollback looks like as a user-facing command.
- Is auto-update opt-in, opt-out, or protected the way Claude Code protects native installs?
