# COMP-WORKSPACE-ID: Design

**Status:** DESIGN
**Date:** 2026-05-09

## Related Documents

- ROADMAP: `/Users/ruze/reg/my/forge/ROADMAP.md` — Phase 1, position 1
- Auto-memory feedback: `feedback_roadmap_ownership.md` — "a feature's ROADMAP row lives in the project that owns it"
- Future-dependent: COMP-IDEABOX-13 (parent workspace manifest, PLANNED)

---

## Problem

Compose has no concept of *which* workspace it is operating on when more than one is plausible. The monorepo `~/reg/` contains multiple sub-products (`my/forge`, `my/forge/compose`, `my/SmartMemory`, `my/ScaleMate`, `my/coder-config`); several of those carry their own `.compose/` and `.git/` markers. Today every surface (CLI, MCP server, git hooks) independently re-derives "the workspace" from `process.cwd()` plus a first-marker-wins upward walk, with no way for a user to say *"I'm sitting in forge-top but this feature belongs to compose."*

Concretely observed during this very feature's scaffolding: the user invoked `/compose build COMP-WORKSPACE-ID` from a Claude session whose primary cwd is `/Users/ruze/reg/my/forge` (forge-top). `add_roadmap_entry` resolved the workspace to forge-top and wrote the ROADMAP row + feature folder there, even though the feature semantically belongs to compose. The resolver was not buggy — the user had no channel to express intent.

### Root causes (from Phase 1 exploration)

1. **MCP module-level caching.** `server/project-root.js:30–40` computes `_targetRoot` once at module-load and never re-evaluates. `server/compose-mcp-tools.js:14` caches `PROJECT_ROOT` at import. Whatever cwd the MCP process happened to inherit at spawn time is the workspace forever.
2. **CLI scattered cwd reads.** `bin/compose.js` calls `process.cwd()` directly in 14+ places (lines 270, 519, 626, 667, 795, 961, 970, 989, 1110, 1653, 1728, 1815, 1890, 2189). Only `complete` (1267) and `hooks` (1863) go through `findProjectRoot`. There is no single chokepoint.
3. **Hook drift.** Templates at `bin/git-hooks/post-commit.template` and `pre-push.template` substitute `__COMPOSE_BIN__`/`__COMPOSE_NODE__` at install time but pass no workspace identity. Their CLI targets (`record-completion`, `validate`) re-resolve via `findProjectRoot(process.cwd())` at fire time, which can land on a different ancestor than the install location.
4. **First-marker-wins walk.** `server/find-root.js:11–28` walks `MARKERS = ['.compose', '.stratum.yaml', '.git']` and stops at the first hit. With both `/forge/.compose` and `/forge/compose/.compose` present, the result depends entirely on starting cwd.

## Goal

A single `resolveWorkspace(hint)` helper that all three surfaces share, plus a UX channel for expressing intent when detection is ambiguous.

**In scope:**
- One canonical resolver, one canonical "workspace identity" record (id + root path).
- Drop module-level caching in the MCP server; resolve per call from a typed hint.
- Auto-prompt the user when a parent cwd contains multiple candidate child workspaces, then remember the choice for the rest of the session.
- Explicit overrides for non-interactive paths: `--workspace=<id>` flag, `COMPOSE_TARGET` env var, `set_workspace({ workspaceId })` MCP tool (separate from feature-lifecycle `bind_session`).
- Hooks bake workspace ID at install; CLI targets accept it as an explicit arg and only fall back to detection if absent.

**Out of scope:**
- Cross-workspace coordination (an active build in compose blocking one in SmartMemory). Each workspace stays independent.
- A parent workspace *manifest* listing all child compose projects (that is COMP-IDEABOX-13, downstream).
- Migrating existing data — `.compose/data/active-build.json` etc. stay where they are.
- Concurrent multi-workspace MCP serving. One MCP, one bound workspace at a time.

---

## Decision 1: Detection model — Hybrid (recommended)

Three approaches were on the table.

| | A. Per-call chain | B. Explicit declaration | C. Hybrid (chosen) |
|---|---|---|---|
| Source of truth | walk `process.cwd()` every call | `.compose/compose.json` declares `workspaceId`, must `set_workspace` | discovery + stdio-MCP-local in-memory binding |
| Disambiguation UX | none — first marker wins | error if not bound | auto-prompt once, remember for MCP-process lifetime |
| Friction | low | high (forced binding) | low for happy path |
| Solves observed bug? | no — same forge-top default | yes — but every invocation forced | yes — prompt fires only when ambiguous |

**Decision: C.** Detection by discovery (Decision 3) supplies a default; ambiguity (multiple `.compose/` markers under cwd, or a parent + child both qualifying) triggers an auto-prompt; the answer persists for the Claude session via `set_workspace` (Decision 5). Explicit `--workspace` and `COMPOSE_TARGET` skip the prompt.

## Decision 2: Workspace identity record

Each `.compose/compose.json` gains an optional top-level `workspaceId` field (string, kebab-case `[a-z][a-z0-9-]{1,63}`, e.g. `"forge-top"`, `"compose"`, `"smartmemory"`). Default when absent: basename of the directory containing `.compose/`.

**Collision handling.** Basename-derived IDs can collide (`packages/api`, `services/api`). The resolver computes IDs lazily for every candidate inside the discovery scope (Decision 3) and detects duplicates: when two candidates share an ID, both are tagged `ambiguous` and the resolver emits a `WorkspaceIdCollision` error listing the conflicting roots and instructing the user to set an explicit `workspaceId` in each `.compose/compose.json`. There is no auto-suffix — silent renumbering is worse than a clear failure.

The canonical record passed around is:

```ts
{ id: "compose", root: "/Users/ruze/reg/my/forge/compose", source: "session-binding" }
```

`source` is one of: `explicit-flag`, `env`, `mcp-binding`, `discovery`, `auto-prompt`. Surfaced in error messages and journal entries so a misroute is debuggable.

## Decision 3: Discovery algorithm (candidate set)

`findProjectRoot` today walks ancestors only. To make ambiguity prompting and `--workspace=<id>` lookup work, we need a **bounded bidirectional discovery**:

1. **Anchor.** Start at `process.cwd()`. Walk upward to the nearest `.compose/`, `.stratum.yaml`, or `.git` marker — the *anchor*. (Treat `.git` and `.stratum.yaml` only as anchors, never as selectable workspaces — see point 3.)
2. **Descendant scan.** From the anchor, scan for `.compose/` markers up to depth 3 and a hard cap of 200 directories visited. Skip `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `.turbo/`, anything matching `.gitignore` if cheaply readable. Cap is a hard fail — if exceeded, error out with `WorkspaceDiscoveryTooBroad` and ask for explicit `--workspace`.
3. **Selectable candidates = `.compose/` only.** A directory is a candidate workspace iff it contains a `.compose/` directory (the config home). Bare `.git`-only or `.stratum.yaml`-only roots are anchors, not workspaces.
4. **Result.** A list of `{ id, root, configPath }` records. Empty list → no workspace, hard fail.

This single discovery routine drives both the ambiguity check and the `--workspace=<id>` reverse lookup. Cost: one bounded fs walk per resolver call when no hint is supplied. With caps in place, worst case is bounded.

## Decision 4: Resolver chain (precedence)

`resolveWorkspace(hint)` consults, in order:

1. `hint.workspaceId` — explicit `--workspace=<id>` flag (Decision 7) or arg passed by a hook. Resolved against the discovery candidate set; missing ID → `WorkspaceUnknown`.
2. `process.env.COMPOSE_TARGET` — same lookup as above; tolerates either an ID or an absolute path.
3. **Active workspace binding** — module-local `currentWorkspace` in the stdio MCP child (Decision 5). Lifetime = MCP-process lifetime. CLI processes have no binding step (their lifetime is one invocation).
4. **Discovery + auto-prompt.** Run discovery (Decision 3): zero candidates → fail; one → use it; multiple → `WorkspaceAmbiguous` error listing candidates.
5. Hard-fail with a structured error listing all attempted sources.

No silent first-marker-wins. **Cache invalidation:** dropping the module-level cache in `server/project-root.js` (`_targetRoot`) is necessary but **not sufficient**. Verified import-time snapshots of `getTargetRoot()`/`PROJECT_ROOT`:

| File | Line |
|---|---|
| `server/compose-mcp-tools.js` | 14 |
| `server/vision-routes.js` | 53 |
| `server/vision-utils.js` | 15 |
| `server/session-manager.js` | 19 |
| `server/agent-spawn.js` | 13 |
| `server/file-watcher.js` | 14 |
| `server/summarizer.js` | 13 |

Other server modules (`index.js`, `vision-server.js`, `supervisor.js`, `agent-server.js`, `feature-scan.js`, `graph-export.js`) call `getTargetRoot()` at runtime — those need only a single-site swap to `resolveWorkspace(req).root`.

**Scope decision:** the seven import-time snapshots get replaced. `server/index.js` (HTTP) gains Express middleware that attaches `req.workspace = resolveWorkspace(reqHint)` from the `X-Compose-Workspace-Id` header (sent by `compose-mcp-tools.js`), and every route handler reads from `req.workspace.root`. The runtime callers (`vision-server.js`, etc.) likewise accept a workspace argument. Long-running watchers (`file-watcher.js`, `cc-session-watcher.js`) are out of scope for v1 — they capture a workspace at startup with a logged warning. Filed as follow-up `COMP-WORKSPACE-WATCHERS`.

## Decision 5: Caller identity & workspace binding

**Architecture observation that drives this decision.** Compose has *two* server processes per Claude session, not one:

- A **stdio MCP child** (`server/compose-mcp.js`) spawned per `claude` invocation by Claude Code. Lifetime ≈ Claude session lifetime. One per session.
- A **long-lived HTTP server** (`server/index.js`, Express on a fixed port) shared across all Claude sessions on the machine. Most MCP tools (`bind_session`, `get_current_session`, scaffolding, journal writes) are thin proxies that POST to `/api/...` on the HTTP server.

Module-local state in HTTP-server route handlers is HTTP-server-scoped — shared across every Claude session running concurrently. That is exactly the leakage problem the original design wanted to avoid. Workspace binding therefore must live **in the stdio MCP child**, never round-tripped to HTTP.

**Binding model: stdio-child-local, in-memory, MCP-process-lifetime.**

1. **Module-local state in the stdio child.** `server/compose-mcp.js` (or a new helper imported only by it) holds `let currentWorkspace = null`. The HTTP server has no notion of "current workspace" — it receives a resolved workspace per request via the `X-Compose-Workspace-Id` header (Decision 4) and uses it as request-scoped data only.

2. **New tools, separate from `bind_session`.** `bind_session` already means "bind the active *feature lifecycle session* to a featureCode" — it requires an active feature session and is single-shot. Overloading it with workspace state would collide both semantically (workspace must resolve *before* any feature session exists) and contractually (workspace is freely rebindable; feature binding is one-shot). Two new MCP tools:

   - `set_workspace({ workspaceId })` — sets `currentWorkspace` in the stdio child. Idempotent. Resolved against the discovery candidate set; unknown ID → `WorkspaceUnknown`. Returns the resolved record.
   - `get_workspace()` — returns the current resolved record or `null`.

3. **Resolver chain consumes `currentWorkspace`.** Decision 4 step 3 reads from this module-local state in the stdio child, not from any HTTP-side store.

4. **Forwarding to HTTP.** Every MCP tool that proxies to HTTP attaches `X-Compose-Workspace-Id: <id>` derived from `resolveWorkspace(...)`. The Express middleware in `server/index.js` reads the header and attaches `req.workspace`. Handlers read `req.workspace.root` instead of any import-time snapshot.

5. **No persistence to disk.** Lost on MCP restart by design — a fresh Claude session starts with no binding and the user re-disambiguates if needed. Persistent state across distinct sessions on the same project would silently bleed.

6. **CLI** invocations supply `--workspace` directly. Each CLI process is short-lived; no state to share. The CLI also never POSTs to HTTP for workspace state.

7. **Hooks** substitute workspace ID at install time (Decision 8) and pass it as a flag. They never read or mutate runtime binding.

**Trade-off:** stdio-child crash mid-session loses binding; next ambiguous call re-prompts. Acceptable — re-prompting is safer than wrong binding, and stdio-child crashes are rare. Filed as a forward-looking idea: `COMP-WORKSPACE-RESUME` (use `CLAUDE_SESSION_ID` env var if Claude Code starts injecting one into spawned MCPs — would let us safely persist binding keyed by a true session identifier).

## Decision 6: Auto-prompt UX

When discovery returns multiple candidates, the MCP returns a structured `WorkspaceAmbiguous` error to Claude listing `[{id, root}]` plus a suggested fix (`set_workspace({workspaceId: "..."})`). Claude surfaces this to the user, calls `set_workspace` with the answer, then retries the original tool call. The CLI mirrors this: prints candidates and the exact `--workspace` flag to add, then exits non-zero.

We do **not** make the MCP itself read stdin to prompt — that breaks RPC contract. Surfacing an error and letting the harness re-call is the cleaner pattern.

## Decision 7: CLI flag placement

`bin/compose.js` parses `cmd = argv[2]` (line 29) and uses per-subcommand `flagVal()` parsing — global flags before the subcommand are not supported today.

**Decision:** `--workspace=<id>` is **post-subcommand**, parsed by every subcommand via the existing `flagVal('--workspace')` pattern. Help text and error messages list it under "Global options (must follow subcommand)". A small wrapper `getWorkspaceFlag(args)` lives in `lib/resolve-workspace.js` and is called by every subcommand handler. Subcommands that don't currently use `flagVal` get migrated.

We do **not** introduce a global pre-parser — that's a larger refactor (`COMP-CLI-GLOBAL-FLAGS`, separate ticket).

## Decision 8: Hook integration & staleness detection

At install time (`compose hooks install`, in `bin/compose.js` ~line 1185), the resolver runs once, captures the `workspaceId`, and substitutes it into templates alongside existing path constants. New template variable: `__COMPOSE_WORKSPACE_ID__`. Hook scripts pass `--workspace=<id>` to `record-completion` and `validate`.

**Staleness:** `compose hooks status` (~line 1290) currently validates only `COMPOSE_NODE` and `COMPOSE_BIN`. It is extended to also:
- check that `__COMPOSE_WORKSPACE_ID__` was substituted (not the raw template token)
- compare the baked ID against `resolveWorkspace().id` for the install path
- report `STALE_WORKSPACE_ID` when they diverge, with a `compose hooks install` repair hint

Legacy hooks (no `__COMPOSE_WORKSPACE_ID__`) are detected and reported as `MISSING_WORKSPACE_ID`. The CLI targets re-resolve via discovery and emit a one-line warning, but do not fail — back-compat for users who haven't reinstalled hooks.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `compose/lib/resolve-workspace.js` | new | Single canonical resolver chain (Decisions 3–4); used by CLI, MCP, and HTTP middleware |
| `compose/lib/discover-workspaces.js` | new | Bounded bidirectional discovery (Decision 3) |
| `compose/server/find-root.js` | modify | Anchor-only walk; descendant scan extracted to `discover-workspaces.js` |
| `compose/server/project-root.js` | modify | Drop `_targetRoot` cache; export `resolveWorkspace`; extend `compose.json` config schema with `workspaceId` |
| `compose/server/compose-mcp-tools.js` | modify | Drop `PROJECT_ROOT` cache; per-call `resolveWorkspace()`; forward via `X-Compose-Workspace-Id` header to HTTP server |
| `compose/server/index.js` | modify | Express middleware: `req.workspace = resolveWorkspace(reqHint)`; remove import-time `PROJECT_ROOT` |
| `compose/server/{vision-server,vision-utils,vision-routes,session-manager,supervisor,agent-server,feature-scan,agent-spawn,graph-export,summarizer}.js` | modify | Read workspace from `req.workspace` (or function arg) instead of import-time snapshot |
| `compose/server/file-watcher.js` | modify | Capture workspace at startup; log warning; out-of-scope for runtime rebinding (filed as `COMP-WORKSPACE-WATCHERS`) |
| `compose/server/compose-mcp.js` | modify | Add `set_workspace`/`get_workspace` tools; module-local `currentWorkspace` (stdio-child-only, Decision 5) |
| `compose/server/compose-mcp-tools.js` | modify | Drop `PROJECT_ROOT` cache (line 14); every HTTP-proxy tool attaches `X-Compose-Workspace-Id` from resolver |
| `compose/bin/compose.js` | modify | Replace bare `process.cwd()` with `resolveWorkspace()`; add `--workspace=<id>` post-subcommand parsing; extend `compose hooks install` (~1185) and `compose hooks status` (~1290) |
| `compose/bin/git-hooks/post-commit.template` | modify | Inject `__COMPOSE_WORKSPACE_ID__`; pass `--workspace=<id>` |
| `compose/bin/git-hooks/pre-push.template` | modify | Same |
| `compose/test/resolve-workspace.test.js` | new | Unit tests for chain + collision + ambiguity error shape |
| `compose/test/discover-workspaces.test.js` | new | Bounded discovery: depth cap, candidate cap, ignore globs |
| `compose/test/hooks-workspace.test.js` | new | Hook install bakes ID; status detects `STALE_WORKSPACE_ID` and `MISSING_WORKSPACE_ID` |
| `compose/test/golden/multi-workspace.test.js` | new | Golden flow: invoke from forge-top, hit ambiguity, bind, scaffold lands in correct child |

## Open Questions

1. **Should this feature folder be moved to `compose/docs/features/COMP-WORKSPACE-ID/`?** It currently sits in forge-top — the very symptom the feature exists to fix. Proposal: move it as part of the implementation, after the resolver is in place, so the move itself exercises the new code path.
2. **Existing `.compose/compose.json` files without `workspaceId`** — auto-derive from basename and write back, or leave silent and only require for new ones? Lean: leave silent, derive on read.
3. ~~Claude session binding lifetime.~~ **Resolved in Decision 5:** stdio-MCP-child-local in-memory only. No persistence.

## Phase 1 unproven assumptions

None requiring a spike. All three surfaces are existing JS modules with clear chokepoints. Test fixtures need a tmpdir-with-multiple-`.compose/` setup, but that's straightforward.
