# COMP-MCP-FOLLOWUP-1-1: Eager-preload followup-writer at MCP boot — Design

**Status:** COMPLETE (shipped 2026-06-19; 3-round Codex design review + 2-round impl review, all CLEAN)
**Date:** 2026-06-19
**Build path:** `/compose build --quick`
**Revised:** 2026-06-19 — Codex design review (preload the full deferred-import set, assert exports, boot-path test)

## Related Documents

- Parent: [COMP-MCP-FOLLOWUP-1](../COMP-MCP-FOLLOWUP-1/feature.json) — added the runtime actionable stale-server hint + import-graph contract test
- Roadmap row: `COMP-MCP-FOLLOWUP-1-1` (Phase 7: MCP Writers)

---

## Problem

`toolProposeFollowup` (`server/compose-mcp-tools.js:362`) loads its implementation
lazily — `await import('../lib/followup-writer.js')` runs only on the **first**
`propose_followup` call. A genuine on-disk export break anywhere in the
followup-writer import graph therefore stays invisible until a user first invokes
the tool, which may be long after a bad deploy.

COMP-MCP-FOLLOWUP-1 added two safeguards, but neither makes a *running* server
fail fast:
- A runtime try/catch that rethrows ESM module-skew errors with an actionable
  "stale MCP server — reconnect /mcp" hint. This fires only **on first call**.
- A CI contract test (`test/followup-writer-import.test.js`) that fails if the
  export goes missing. This guards CI, not a deployed/running server.

The gap: a server that boots against genuinely-broken on-disk code reports
success and only surfaces the break when someone files a follow-up.

## Goal

Eager-load the followup-writer module graph during MCP server initialization so a
genuinely-broken export crashes the server **at boot** (fail-fast),
complementing the CI contract test.

**In scope:** boot-time preload of the deferred-import set on the
`propose_followup` path; a clean boot error on failure; tests.

**Non-scope:** converting every lazy tool-wrapper import to eager (the rest stay
lazy by design — they are not the subject of this hardening ticket); changing the
live `toolProposeFollowup` lazy import or its actionable hint (kept as-is — see
Decision 2).

---

## Decision 1: A `preloadEagerModules()` helper, not a bare static import

A bare static side-effect `import '../lib/followup-writer.js'` at the top of
`compose-mcp.js` would also fail-fast (ESM links the graph before any code runs).
Rejected because it is **untestable** and **invisible** — nothing asserts the
preload happened, and a future reader sees an unexplained import.

Chosen: an exported `async function preloadEagerModules(specs?)` in
`server/compose-mcp-tools.js` that `await import()`s a list of boot-critical
modules and **asserts the expected named export is present on each**.
`compose-mcp.js` calls it right before `server.connect(transport)`.

The default list is the **genuinely-deferred** set on the `propose_followup`
path — exactly one module:

| Specifier | Expected export | Why deferred today |
|-----------|-----------------|--------------------|
| `../lib/followup-writer.js` | `proposeFollowup` (function) | lazy-imported in `toolProposeFollowup` |

**Why only one (Codex r2):** `followup-writer.js` dynamically imports
`server/artifact-manager.js` (lines 203, 484), but that module is **already
statically imported at boot** by `server/compose-mcp-tools.js:11`
(`import { ArtifactManager } from './artifact-manager.js'`), which the entrypoint
statically imports. So a missing `ArtifactManager` export already hard-fails
startup today, independent of this feature — adding it to the preload set would
be redundant coverage and falsely imply it was a gap. The one module that
escapes boot-time linking is `followup-writer.js` itself (only ever reached via
the lazy `import()` in `toolProposeFollowup`). Preloading it links its full
static subtree at boot; its lone dynamic import (`artifact-manager.js`) is
already covered. The injectable `specs` param keeps the door open if a future
lazy tool-wrapper needs the same treatment.

- **Co-located** with the tool wrappers whose lazy imports it mirrors.
- **Unit-testable** — `specs` is injectable, so a test drives both the happy path
  (real list resolves, exports present) and the failure path (a bad specifier or
  a missing-export entry → rejects with the offending module named).
- **Extensible** — the list can grow to other boot-critical lazy imports without
  touching the entrypoint again.

### Why the export assertion matters (correctness)

`await import('x')` does **not** throw when `x` loads but no longer exports the
expected name — it resolves with that binding `undefined`. So a bare
`await import()` would *not* fail-fast on a removed export (the exact
COMP-MCP-FOLLOWUP-1 failure class); the crash would still slip to first
invocation. The helper therefore asserts `typeof mod[name] === 'function'` per
entry and throws if absent — mirroring `test/followup-writer-import.test.js`.

## Decision 2: Keep the lazy import + actionable hint in `toolProposeFollowup`

The eager preload and the lazy-import hint guard **different** failure modes and
are complementary:
- Eager preload → catches a genuinely-broken export at **boot**.
- Lazy-import hint → catches **module-cache skew** in a server that booted fine
  and then had `lib/` change underneath it mid-session (the original
  COMP-MCP-FOLLOWUP-1 symptom). `/mcp` reconnect is the fix.

After preload the module is in the ESM cache, so `toolProposeFollowup`'s
`await import()` resolves from cache — **zero behavior change** for the live tool;
the hint stays as defense for the edit-after-boot case.

## Decision 3: Fail loudly, exit non-zero — with a test seam

On preload failure, print a single clear line to stderr identifying the failed
module + the underlying error, then `process.exit(1)`. This turns a silent
top-level-await unhandled rejection into a diagnosable boot failure. (Today the
process would crash on the unhandled rejection anyway; this makes the *reason*
legible.)

**Test seam (Codex r2):** a *positive* boot smoke can't prove the preload is
wired before `connect` — a healthy server reaches `connect` regardless. To prove
the wiring, `compose-mcp.js` appends any specifiers from an optional env var
(`COMPOSE_PRELOAD_PROBE`, comma-separated) to the default list before calling
`preloadEagerModules()`. The negative startup test sets it to a bogus specifier,
spawns the server, and asserts it prints the stderr boot error and exits `1`
**without** reaching `connect`. The env var doubles as an operator escape hatch
to force-validate extra modules at boot; absent/empty → default behavior,
byte-identical.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/compose-mcp-tools.js` | existing | Add exported `preloadEagerModules(specs?)` — `await import()`s each spec, asserts its expected export is a function, throws naming the offender on failure |
| `server/compose-mcp.js` | existing | Build the preload list (default + any `COMPOSE_PRELOAD_PROBE` specifiers), `await preloadEagerModules(list)` before `server.connect(transport)`, with a clean stderr boot error + `process.exit(1)` on failure |
| `test/followup-writer-eager-preload.test.js` | new | (a) default `preloadEagerModules()` resolves; (b) injecting a missing-module / missing-export spec rejects naming the offender; (c) **negative boot test**: spawn `node server/compose-mcp.js` with `COMPOSE_PRELOAD_PROBE=<bogus>`, assert stderr boot error + exit `1` (proves preload is wired before connect); (d) positive boot smoke: spawn with no probe, assert it boots and reaches connect, then close stdin |
| `CHANGELOG.md` | existing | Entry for the hardening |

## Open Questions

None — scope is narrow and single-component. No escalation to full `/compose build` warranted.
