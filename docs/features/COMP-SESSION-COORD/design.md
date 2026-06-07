# COMP-SESSION-COORD: Independent Session Coordination — Design

**Status:** PARKED — design complete and Codex-reviewed 2026-06-07; not scheduled for implementation. Phase-1 design document, not shipped code.
**Feature Code:** COMP-SESSION-COORD
**Reviewers:** Critique at the design level (architecture, races, failure modes, defaults, missing cases). Pseudocode/JSON shapes are illustrative.
**Review history:** Codex design pass 2026-06-07 — folded in claim-then-check ordering, recency rule, path canonicalization, noisy fail-open, orphan pruning, prune-scope, hybrid liveness, Bash heuristic, event log.

**Date:** 2026-06-07
**Author:** ruze + Claude (brainstorming session)

## Related Documents

- [COMP-AGT-COORD](../COMP-AGT-COORD/design.md) — coordination of *compose-spawned* agents (parent↔child messaging, parallel-batch merge). The **orchestrated** case; this feature is its inverse (independent, no parent). Contrast, not dependency.
- [COMP-WORKSPACE-SESSIONS](../COMP-WORKSPACE-SESSIONS/) — planned per-workspace SessionManager with session/activity routes. The compose-native substrate this feature *could* later ride on (see Relationship to compose's session infrastructure). Not a v1 dependency.
- Prior art (in-repo): `compose/lib/gsd.js` — GSD autonomous-mode lock (`run.lock`/`owner.json`, `pidAlive`, atomic rename-aside takeover). This design borrows the *pattern* (and `pidAlive`), not the module.
- Claude Code hooks: `SessionStart`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `permissionDecision`.

---

## Problem

You launch several `claude` sessions by hand — separate terminals, same folder (e.g. several sessions in the compose repo) — and none was spawned by a parent, so none knows the others exist. Two sessions edit the same file on disk and silently clobber each other's work.

**Goal:** make independent, same-machine, same-working-directory sessions aware of each other at the *file* grain, and surface a conflict to the human *before* an overwrite — without a coordinator, daemon, or network.

This is a **cooperative, advisory protocol**, not an enforcement boundary (see Inherent limitations). It is distinct from COMP-AGT-COORD: that coordinates agents compose *spawns and owns*; this coordinates sessions nobody spawned.

## Scope

Locked during brainstorming + review:

| Dimension | Decision |
|-----------|----------|
| Clobber grain | **Same-file edits** (finest grain, most common pain) |
| Enforcement | **Warn + ask** — surface the conflict; human decides per-collision. Not a mutex; no hard lock ⇒ no deadlock. |
| Boundary | **Same machine, same working directory** — multiple `claude` in the exact same folder, editing the same files on disk. |
| Liveness | **Hybrid:** pid-liveness primary, heartbeat-lease fallback. |
| Bash writes | **Best-effort heuristic in v1** (redirects / `sed -i` / `tee`). Detection-only. |
| Auditability | **Append-only `events.jsonl`** of conflicts + resolutions. |

**Out of scope (v1):** cross-worktree/cross-clone logical overlap, whole-workspace scope, cross-machine, git/branch collisions.

## Non-Goals

- Not a mutex. An edit is never *prevented* by the tool — only surfaced. The human can always take over.
- Not a coordinator/orchestrator. No parent process, no new daemon. (That is COMP-AGT-COORD; this is the opposite.)
- Not cross-machine. The registry is local-filesystem only.
- Not a coverage *guarantee*. A non-Claude editor (vim, VS Code) or a hook-less session bypasses it entirely (see Inherent limitations).

---

## Relationship to compose's session infrastructure (the key un-park decision)

[COMP-WORKSPACE-SESSIONS](../COMP-WORKSPACE-SESSIONS/) plans a per-workspace **SessionManager registry with session + activity routes**. That is the compose-native analog of what a clobber-detector needs: who-touched-which-file-by-session. Two integration paths, to decide when this is un-parked:

1. **Standalone filesystem registry (this design as written).** `~/.claude/coord/` files; no dependency on any compose server being up. Most robust (works headless / when the server is down), self-contained. **Recommended for v1.**
2. **Ride on the COMP-WORKSPACE-SESSIONS SessionManager.** Source conflict checks from compose's own session/activity registry; the web UI could surface live conflicts. No duplicate session×file store, but hard-depends on the compose server running and reachable — wrong for the bare-terminal case this feature targets.

**Recommendation:** ship (1) now with the `events.jsonl` feed so mirroring conflicts into the compose UI (a (1)+(2) hybrid) is a later additive step. Conflict *decisions* must not hard-depend on a server that may be down.

This feature is intentionally **independent of coder-config**; it ships and installs from compose.

The remainder of this document specifies path (1).

---

## Architecture

### Registry location

Machine-global root, partitioned by working directory:

```
~/.claude/coord/<cwd-hash>/
```

- `<cwd-hash>` = short hash of the absolute working directory.
- Same folder ⇒ same partition; elsewhere ⇒ separate partition, mutually invisible. The "same working dir" scope holds *by construction*.
- Outside any repo ⇒ no per-repo `.gitignore` churn, no risk of committing coordination files.

### Components

One self-contained script — `coord.js` — **shipped in compose** (e.g. `compose/lib/session-coord/`), dispatched by subcommand, backing the hooks below in global `~/.claude/settings.json` so every session everywhere participates. Installable via a `compose session-coord install` CLI subcommand (writes/merges the hook entries) rather than hand-editing settings.

Pure Node stdlib (`node:fs`, `node:crypto`, `node:child_process` for the pid walk). **No dependency on the compose server, stratum, or coder-config** — runs in a bare `claude` session in any repo. Reuses the *pattern* from `gsd.js` (atomic temp+rename writes, `pidAlive`, liveness pruning), not the module.

| Hook | Matcher | Job |
|------|---------|-----|
| `SessionStart` | — | register session; capture session pid via ppid-walk; **heavy prune** of dead/stale sessions + claims |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | gatekeeper: claim intent → detect live conflict → `ask` or allow (lean, O(this-file)) |
| `PreToolUse` | `Bash` | best-effort: extract write targets from the command, run conflict check on those paths |
| `PostToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit` | stamp `lastEditAt` on success; append resolution to `events.jsonl` |
| `SessionEnd` | — | deregister: remove this session's record + claims |

`SessionEnd` is the graceful release; pid-liveness is the crash backstop (immediate on next hook fire, not lease-delayed). Hook entries must **compose** with any other global hooks (chain, not clobber) — the installer merges rather than overwrites.

---

## Data model

One file per *(path, session)* — no two sessions ever write the same file ⇒ zero cross-session write contention. Every write is atomic (temp + `rename`).

```
~/.claude/coord/<cwd-hash>/
  meta.json                              { cwd }
  sessions/<session-id>.json             { sessionId, pid, pidConfident, startedAt, lastActive, tty, label? }
  claims/<path-sha>/<session-id>.json    { path, sessionId, claimedAt, lastEditAt }
  events.jsonl                           append-only conflict + resolution log
```

- **Path key.** `<path-sha>` = sha of the *canonical* path: `realpath` (resolve symlinks) then case-fold on a case-insensitive filesystem (macOS APFS default). Prevents two sessions editing the same inode through different spellings (`Foo.js` vs `foo.js`, `./a` vs `a`, symlink vs target) from missing each other. Readable `path` stored inside the claim.
- **`claimedAt`** = intent timestamp, refreshed each `PreToolUse` (announce *before* checking).
- **`lastEditAt`** = last *completed* edit, stamped at `PostToolUse`. Null until the session has actually edited the file.

---

## Liveness — hybrid (pid primary, heartbeat fallback)

A session record carries `pid` and `pidConfident`, captured at `SessionStart`:

- **pid capture:** walk the ppid ancestry from the hook process (hook → shell → `claude`) until the `claude` session process is found; record its pid and set `pidConfident: true`. If the walk is ambiguous (unexpected ancestry, container, etc.), set `pidConfident: false`.

**Is a session alive?**

- `pidConfident` → `alive = pidAlive(pid)` (GSD primitive: `kill(pid, 0)` → success/`EPERM` = alive, `ESRCH` = dead). Authoritative, machine-local.
- else → fallback: `alive = lastActive within window` (default **15 min**).

**Why hybrid resolves the review's liveness cluster:**

- *Crashed session* → pid dead → pruned immediately on the next hook fire by any session (no 30-min lease lingering, no repeated false prompts).
- *Idle-but-open session* → pid alive → stays live → **still warns**. Correction to the original assumption: an idle session may hold uncommitted reasoning about a file, so a second session must still be warned. A false-stale here is not "a missed nag" — it can be the very clobber this system exists to prevent.
- *pid uncertain* → degrades gracefully to the time window rather than failing.

Heartbeat (`lastActive`, refreshed every hook fire) still serves the fallback path and the human-readable "last active 2m ago" in the prompt.

---

## Conflict detection

Ordering matters — **claim-then-check**, not check-then-claim (the original TOCTOU bug):

`PreToolUse` (edit tools):
1. Canonicalize target → `<path-sha>`; refresh own session heartbeat.
2. **Write/refresh own intent claim** (`claimedAt = now`) — announce *before* reading others.
3. Glob `claims/<path-sha>/*.json`; drop own; for each other claim resolve its session and liveness.
4. **Conflict if a live other session** satisfies either:
   - **Recency:** its `lastEditAt` is newer than *my* `lastEditAt` (it completed an edit since I last did — including the common case where I've never edited it and it has), **or**
   - **Concurrent intent:** its `claimedAt` is open and effectively simultaneous with mine (both about to edit, neither completed) — the TOCTOU guard for two fresh sessions hitting a virgin file at once.
5. Conflict → `permissionDecision: "ask"`. No conflict → allow.

`PostToolUse` (edit tools): on success, stamp own `lastEditAt = now`. This makes **take-over self-resolving**: once you take over and edit, your `lastEditAt` is newest, so the recency rule stops firing until the other session edits *again*.

**Residual race:** the concurrent-intent guard narrows simultaneous-start to a sub-second window but cannot eliminate it without a lock — acceptable precisely because this is advisory, not a mutex.

**Orphan handling:** a claim whose session record is absent (crash between the two atomic writes) is treated as dead and pruned. Liveness is always resolved through the session record; no session record ⇒ not live.

**Fail-open but noisy:** if the registry is missing/corrupt/unreadable, allow the edit (never block real work on a coordination bug) **and** surface a visible notice — "coordination registry unreadable, proceeding without conflict check" — so it doesn't silently vanish exactly when filesystem state is least trustworthy.

**Prune scope:** heavy pruning (scan all sessions/claims, drop dead) runs at `SessionStart`. `PreToolUse` stays O(claims-on-this-one-file) so edit latency doesn't scale with total session/claim count.

---

## The warn + ask flow

On a detected live conflict, `PreToolUse` emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "⚠ Another Claude session (tty s004, started 14:02, last active 2m ago) edited lib/build.js — editing now may clobber its work."
  }
}
```

- Native allow/deny prompt — no new UI surface. Approve = take over; deny = Claude adapts (another file / wait).
- No conflict → hook exits 0, silent allow.
- Awareness in the reason string: *who* (tty/label), *when* (relative time), *what* (the file).

---

## Bash-write heuristic (best-effort, detection-only)

`PreToolUse` on `Bash` extracts likely write targets from the command string and runs the same conflict check on them:

- Patterns: `> FILE`, `>> FILE`, `tee [-a] FILE`, `sed -i ... FILE`, `cat > FILE`, `dd of=FILE`, `cp/mv … DEST`.
- Detection-only: it **reads** claims to warn, but does **not** record claims (parse reliability too low to pollute the registry).
- Explicitly fragile: misses dynamically-built paths, here-docs, variables, scripts that write internally. It *reduces* the Bash blind spot; it does not close it.

---

## Event log

`events.jsonl`, append-only, per partition:

- `PreToolUse` conflict → append `{ts, type:"conflict", path, holder:{sessionId,tty}, challenger:{sessionId}}`.
- `PostToolUse` after a surfaced conflict → append `{ts, type:"took_over", path, sessionId}` (an approved take-over; a denial leaves no PostToolUse, inferred by absence).

Durable record of what conflicted, when, and how it resolved — for debugging/reconciliation, and the natural feed for mirroring into the compose UI (integration path 1+2).

---

## Inherent limitations (cooperative protocol)

- **Bypassable.** A non-Claude editor (vim, VS Code, an IDE) or a Claude session with hooks disabled is invisible and can still clobber. Structural to an advisory protocol — not fixable without an enforcement layer (filesystem locks/FUSE), out of scope.
- **Bash coverage is partial** (heuristic above).
- **Intra-session parallel subagents** share the parent session id, so two subagents under one session editing the same file won't warn each other — that is COMP-AGT-COORD's concern, not this tool's.
- **Global path** (`~/.claude/coord/`) has no quota/permission/migration handling; degradation falls back to noisy fail-open.

---

## Testing

Compose testing rules: real filesystem, no mocks; assert hook-output JSON and on-disk registry effects.

**Golden flow:**
1. A `SessionStart` → record exists, pid captured.
2. A `PreToolUse` on `foo.js` → allow; intent claim written. A `PostToolUse` → `lastEditAt` stamped.
3. B `SessionStart` → record exists.
4. B `PreToolUse` on `foo.js` → `ask` (recency: A's `lastEditAt` newer than B's null), A's identity in the reason; conflict appended to `events.jsonl`.
5. B approves, B `PostToolUse` → B's `lastEditAt` newest; `took_over` logged.
6. B `PreToolUse` on `foo.js` again → allow (B now newest, take-over self-resolved).
7. A `SessionEnd` → A's record + claims removed.

**Error / edge harness:**
- **Concurrent virgin-file edit:** A and B both `PreToolUse` on an unedited file → at least one sees the other's open intent → `ask` (mutual visibility, not just "both files landed").
- **Crashed session:** record with a dead pid → claim ignored *and* pruned on next hook fire.
- **pid-uncertain fallback:** `pidConfident:false` + stale `lastActive` → treated stale; fresh `lastActive` → live.
- **Path canonicalization:** `Foo.js` and `foo.js` (case-insensitive FS), and symlink vs target, resolve to the same `<path-sha>` → conflict detected.
- **Orphan claim:** claim with no session record → treated dead, pruned.
- **Self-edit:** same session re-editing its own file → no warning.
- **Fail-open noisy:** corrupt registry file → edit allowed *and* notice surfaced.
- **Bash heuristic:** `echo x > foo.js` while another session holds `foo.js` → `ask`.
- **Hook composition:** the installer merges coord hooks with existing global hooks without dropping either.

**Unit:** canonical-path → `<path-sha>` is stable and collision-safe for realistic paths (symlinks, `.`/`..`, case variants).

---

## Open questions for un-park

1. Integration path 1 vs 1+2 (standalone vs COMP-WORKSPACE-SESSIONS-mirrored) — recommendation is 1 now, mirror later.
2. Fallback window default — 15 min reasonable when pid is unavailable? (Moot when `pidConfident`.)
3. Should the Bash heuristic eventually *record* intent for high-confidence single-target redirects, or stay detection-only?
4. Is a `compose session-coord ls` (list active sessions across partitions) worth adding, or scope creep?
