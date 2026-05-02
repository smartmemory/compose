# 2026-05-02 — Session 34: First MCP writer ships (COMP-MCP-ROADMAP-WRITER)

## What happened

After yesterday's architectural review surfaced "Claude has been doing feature-management work the MCP server should be doing," we filed `COMP-MCP-FEATURE-MGMT` as a parent ticket with ten sub-writers. This session shipped the first one.

The pattern is what we've been doing by free-text editing all week: scaffold a folder, add a ROADMAP row, flip a status, write a CHANGELOG entry, write a journal entry, file a follow-up, link an artifact. Every one of those is a typed mutation pretending to be prose. The fix is to route them through MCP tools that enforce schema and emit events.

We took the most-used surface first: the roadmap. Three tools. `add_roadmap_entry`, `set_feature_status`, `roadmap_diff`. The interesting design choice was where to put the writer logic. The architectural review had flagged "MCP tools shouldn't HTTP-call REST," so we put the writers in `lib/` instead of `server/` — pure file IO, callable from MCP handlers, the CLI, future REST routes, anywhere. No HTTP delegation. The lift was small because two of the three operations were just stitching existing primitives together: `lib/feature-json.js`'s `writeFeature` for the per-feature record, and `lib/roadmap-gen.js`'s `writeRoadmap` to regenerate `ROADMAP.md` from all `feature.json` files. The "writer" turned out to be 50 lines of glue with a transition policy on top.

Idempotency and events were folded in as part of this ticket rather than shipping as their own sub-tickets — they're framework code that all subsequent writers will inherit, and treating them as their own tickets would have been five files of design overhead for two helper modules. The idempotency cache uses `mkdir`-based advisory locking (atomic on POSIX, no new dependency) with stale-lock recovery so a crashed prior holder can't deadlock the next caller. The audit log is plain append-only JSONL at `.compose/data/feature-events.jsonl` — same shape as the existing `gate-log.jsonl`, no schema versioning yet (deliberately deferred; the `COMP-ARCH-CLEANUP` ticket has versioning as Track B).

Codex review went four iterations. Iteration 1 surfaced five real findings: audit-append failures were hard-erroring (should warn-and-continue per design), `KILLED`/`BLOCKED` weren't in `SKIP_STATUSES` so they'd surface as buildable, `COMPLETE → SUPERSEDED` was in the normal transitions table despite the design saying force-only, omitted `position` defaulted to `null` instead of "end of phase", and `commit SHA` was advertised in the design for the `since` parameter but `normalizeSince` only handled shorthand and ISO dates. All five fixed in iteration 2. Iteration 2 then found tool descriptions still claimed "atomically" while the audit step was best-effort. Fixed. Iteration 3 found the same wording surviving in the docs/mcp.md *table* rows (separate from the prose section). Fixed. Iteration 4: clean.

The interesting moment was iteration 1's `KILLED`/`BLOCKED` finding. The new writers added those statuses to the typed surface, but `lib/roadmap-parser.js`'s `SKIP_STATUSES` was a pre-existing constant in a different module. If we'd shipped without that fix, a feature marked `KILLED` by the new writer would still appear as "next up" in `compose roadmap` and the build selection path. The two modules had drifted because there was no reason for them to know about each other; the new writers happened to expand the set of possible statuses, and the consumer-side filter hadn't been updated. Codex caught it because it was looking across the call chain rather than just at the new files. This is exactly what a review should do.

We also fielded a parallel-work question mid-session: is `COMP-PLAN-SECTIONS-REPORT` safe to build at the same time? Yes — disjoint files, additive `feature.json` fields. We added coordination notes to its ROADMAP row: use `appendEvent` from the new audit log if it wants to record post-ship events; keep its `feature.json` field additions disjoint from this ticket's (`commit_sha`, `tags`, `parent`); and consider adopting `set_feature_status` for the completion flip when it ships.

This is the framework. Eight more writers to go. Each one should be smaller now that idempotency, events, and the testing pattern are established.

## What we built

**Added:**
- `compose/lib/idempotency.js` — `checkOrInsert(cwd, key, computeFn)`, file-locked, capped FIFO cache.
- `compose/lib/feature-events.js` — `appendEvent`, `readEvents` on `.compose/data/feature-events.jsonl`. Shorthand-date parsing for `since` (`24h`/`7d`/`30m`).
- `compose/lib/feature-writer.js` — `addRoadmapEntry`, `setFeatureStatus`, `roadmapDiff`. Pure file IO. Calls into existing `feature-json` + `roadmap-gen`. Transition policy with `force` escape hatch. `safeAppendEvent` wraps audit writes so they can never roll back a committed mutation. Default `position` = max-in-phase + 1.
- `compose/test/idempotency.test.js`, `feature-events.test.js`, `feature-writer.test.js`, `feature-writer-mcp.test.js` — 55 new tests including a 5-test end-to-end suite that spawns the MCP server as a child process and exercises the tools over stdio JSON-RPC. Full suite 2044/2044.

**Changed:**
- `compose/server/compose-mcp.js`, `compose/server/compose-mcp-tools.js` — three new tools registered with thin handlers that import the lib and pass `getTargetRoot()`.
- `compose/lib/roadmap-parser.js` — `SKIP_STATUSES` includes `KILLED` and `BLOCKED`.
- `compose/docs/mcp.md` — three rows + a "Roadmap writers" section documenting transition policy, idempotency, audit log path, and the no-HTTP design choice.
- `compose/CHANGELOG.md` — entry under 2026-05-02.
- `/Users/ruze/reg/my/forge/ROADMAP.md` — `COMP-MCP-ROADMAP-WRITER` flipped to COMPLETE; `COMP-PLAN-SECTIONS-REPORT` row gained parallel-work coordination notes.

## What we learned

1. **The "is this atomic?" question is best answered by the docs reading exactly the same as the code.** Codex flagged the word "atomically" three times across three documents, in the iteration where we'd "fixed" it twice already. There's a tool description, an MCP tool description, an inline code comment, a doc table row, a doc paragraph, and a design doc. Each one is its own surface and each one drifts independently. The fix isn't to be more careful; it's to consolidate the source of truth (next round of cleanup).

2. **Folding cross-cutting infra into the first ticket beats shipping it standalone.** Idempotency and events as their own tickets would have been five files of design overhead for two helper modules. Shipped together they're 200 lines of code, 26 lines of test, no design ceremony.

3. **`KILLED`/`BLOCKED` showed up because Codex looked across the call chain.** Adding statuses to a writer doesn't fail any local test — the failure is downstream, in a consumer that can't possibly fail because the input it would reject never arrives in tests. Cross-module review is what catches this; cross-file unit tests would have to anticipate the question. Useful pattern for future writers: when the surface adds a value that a consumer enumerates, audit every consumer of that enum.

4. **Best-effort writes need to be loudly best-effort.** "Audit-log append is best-effort" needs to appear in every place a caller might look: tool description, MCP description, code comment, doc prose, doc table. We missed the table row twice.

## Open threads

- [ ] Eight more writer sub-tickets to go: `COMP-MCP-ARTIFACT-LINKER`, `COMP-MCP-CHANGELOG-WRITER`, `COMP-MCP-JOURNAL-WRITER`, `COMP-MCP-FOLLOWUP`, `COMP-MCP-COMPLETION`, `COMP-MCP-VALIDATE`, `COMP-MCP-MIGRATION` (the parent design has the order).
- [ ] Track B of `COMP-ARCH-CLEANUP` (artifact versioning) eventually adds `_version` to `feature-events.jsonl`. Coordinate so we don't write a migration twice.
- [ ] When the cockpit picks up `feature-events.jsonl` for live updates, decide: file watcher, polling, or bridge to the existing event bus.

A typed writer beats a careful editor every time.
