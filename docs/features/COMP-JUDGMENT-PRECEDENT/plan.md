# COMP-JUDGMENT-PRECEDENT — Precedent search over judgment records

**Status:** PLANNED | **Complexity:** M | **Impact:** high
**Promoted from:** IDEA-29 | **Source:** Semantica teardown 2026-08-08, re-grounded against code 2026-08-08

## Related Documents

- Ideabox origin: `docs/product/ideabox.md` (IDEA-29)
- Builds on: `docs/features/COMP-JUDGMENT-STORES/`, `docs/features/COMP-JUDGMENT-WRITER/`
- **Dependency removed:** formerly `depends_on COMP-JUDGMENT-BITEMPORAL`, which is
  now KILLED (premise disproved). Revisions already provide decision-time
  reconstruction, so nothing blocks this. See that feature's `killed.md`.

## Problem (verified against the code, 2026-08-08)

The judgment layer records decisions well and cannot read them back.

**What already exists:**

| Capability | Where |
|---|---|
| Revisions within a position (`r1..rN`) | `store.readPositionChain(slug)` — `lib/judgment/store/index.js:82` |
| Latest revision | `store.latestPositionRevision(slug)` |
| Supersession reference | `position_revision.supersedes = "<slug>#r<N>"` |
| Retraction tombstones | `latest.retracted === true` |
| "Am I superseded?" | `derivePositionStatus` — `lib/judgment/store/index.js:98` |

**What does not exist:**

1. **Forward supersession traversal.** `supersedes` points from the new position
   to the old one, but nothing follows it. Given a position you cannot ask "what
   did this replace, and what did *that* replace?"
2. **A usable reverse index.** "Who supersedes me" exists only inside
   `derivePositionStatus`, which scans **every other slug and reads each one's
   full chain** to answer it — O(n²) over the store, recomputed per call.
3. **Any read surface for history.** The only exposed reader,
   `get_judgment_state` (`lib/judgment-writer.js:3354`), returns the **latest
   revision per position** and drops everything behind it.

So the causal history is fully persisted on disk and completely invisible.
Records nobody can read are pure cost.

## Slice A — decision-chain trace (this feature)

Purely additive. No schema change, no migration, no external dependency.

**A1. Supersession index.** Build a `Map<slug, {supersedes: ref|null, supersededBy: ref|null}>`
in one pass over `listPositionSlugs()`, reading each latest revision once.
Replaces the O(n²) scan. `derivePositionStatus` becomes a lookup against it.

**A2. `traceposition(slug)`.** Returns the full causal ancestry:

```
{
  slug, status,                 // live | superseded | retracted
  revisions: [{rev, written_at, conviction, claim_count, delta}],
  supersedes:   {slug, rev, ...} | null,   // walked recursively, cycle-guarded
  supersededBy: {slug, rev, ...} | null,
  depth
}
```

**A3. Read surfaces.** A `judgment trace <slug>` CLI verb and a
`get_judgment_trace` MCP read tool. Read-only, so it joins `get_judgment_state`
on the reviewer-allowed list in `server/mcp-tool-policy.js:39` rather than the
owner-locked write set.

**Cycle safety is required, not optional.** `supersedes` is a free-form string
ref; nothing today prevents `a#r1 → b#r1 → a#r2`. The walk must carry a visited
set and terminate, reporting the cycle rather than hanging.

## Slice B — semantic precedent search (NOT in this feature)

> **BLOCKED.** SmartMemory recall drops 19 of 20 on live-fire and the root cause
> is unsolved (`project_livefire_recall_broken`). Building retrieval on it would
> ship a feature that silently returns nothing — the exact failure class this
> repo keeps getting bitten by. Slice A stands alone and is worth shipping alone.

## Acceptance criteria

- [ ] `buildSupersessionIndex(store)` returns forward + reverse refs in a single
      pass over the slugs
- [ ] `derivePositionStatus` uses the index; behaviour identical to today
- [ ] `tracePosition(store, slug)` returns revisions plus ancestry in both
      directions
- [ ] Recursive walk is cycle-guarded and reports the cycle instead of hanging
- [ ] Retracted positions surface as `retracted`, and a tombstone still traces
- [ ] Unknown slug returns a typed `JUDGMENT_NOT_FOUND`, not null
- [ ] `compose judgment trace <slug>` renders the chain
- [ ] `get_judgment_trace` MCP tool, on the reviewer-allowed read list
- [ ] Golden flow: create → amend → supersede → trace shows all three, in order,
      with the pre-amendment state still visible
- [ ] Unit test: a synthetic `a → b → a` cycle terminates and reports
- [ ] No write path touched; no judgment record schema change

## Out of scope

- Semantic similarity (slice B, blocked)
- Any change to the write tools or the record schema
- Valid-time / `as_of()` — a separate open question (IDEA-31)
- Backfill: existing records already carry everything needed

## Open questions

- [ ] Should `trace` follow supersession across *kinds* (a position superseded by
      a goal clause), or stay within positions? Positions-only for v1.
- [ ] Does the cockpit render the chain, or is CLI + MCP enough for v1?
      CLI + MCP first.
