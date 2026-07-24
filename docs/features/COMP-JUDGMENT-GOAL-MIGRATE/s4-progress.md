# COMP-JUDGMENT-GOAL-MIGRATE — S4: the live cutover

Blueprint authority: `blueprint.md` ("S4 — Owner-gated live cutover").
This slice has no test gate: it is a one-shot mutation of this repo's own
judgment store, executed once, owner-approved before commit.

## Preflight (S4.1) — matched the pinned source exactly

- `objective` live at r1, single revision, `via: import`, conviction low/inferred
- goal chain EMPTY (`docs/judgment/records/goal/` did not exist)
- NO pending intent (`docs/judgment/records/intents/` did not exist)
- all three canonical joints resolve: `horizon`, `success-criteria`,
  `commercial-intent`
- `git status docs/judgment/` clean, so the resulting diff is purely the cutover
- S1-S3 gates and the full judgment suite green (212), full node suite green (4960)

## Execution

Invoked the registered MCP surface over stdio — never a module import, never the
retired importer:

```
judgment_goal_write {"op":"migrate","idempotency_key":"COMP-JUDGMENT-GOAL-MIGRATE-live-v1"}
→ {"op":"migrate","status":"migrated","version":1,"ref":"goal:v1",
   "intent_id":"intent-1784859840816-37452-1"}
```

**The server was freshly spawned rather than the session's.** This session's
compose MCP server started at 08:52, before the S3 edit landed at 10:08, so its
advertised enum was still the pre-S3 four ops. Using it would have proven
nothing about S3 reachability. A fresh `server/compose-mcp.js` over stdio with
`COMPOSE_TARGET` pinned is the same binary and the same tool boundary, running
current code; its `tools/list` was asserted to advertise
`["cut","correct","joint_link","load_link","migrate"]` BEFORE the write. Any
session that predates commit `a31eb30` needs an MCP reconnect.

## Verification (S4.2)

| Check | Result |
|---|---|
| Pending intent after publication | none |
| Ledger records added | exactly two: the note + one attestation |
| Projections | `checkProjectionRoundtrip().fixedPoint === true` |
| `goal/v1.json` | `channel: inferred`, elicitation verbatim, `provocation: null`, NO `ratification`, `via: migration` |
| `goal/state.json` | `gj1 horizon`, `gj2 success-criteria`, `gj3 commercial-intent`, no load links |
| `positions/objective/r2.json` | `retracted: true`, `claims: []`, conviction carried from r1 |
| Objective derived status | `retracted`; `positions/objective.md` pruned, index link dropped |

The migration note (3,645 bytes, anchor `position:objective`, refs
`["objective#r1","goal:v1"]`) carries the legacy `OBJECTIVE.md` verbatim —
health warning, observed trade-off rankings table, open-joints table, and
consistency tally all present — and names `self-report-reliable` as unmigrated
because no canonical joint record exists for it.

## Accepted renderer narrowing (S4.3)

The owner reviewed the full `OBJECTIVE.md` diff and approved. The projection
narrows from the imported essay to the structured goal surface: current clauses
with channel and elicitation, ratification citation ("None — imported/migrated
draft"), the three goal joints, an empty load-link bill, and a trajectory table.
The prose the projection no longer renders is preserved verbatim in the ledger
note, so nothing is lost — only relocated from a generated surface to canon.

## One deviation from the File Plan, owner-approved

`docs/judgment/SITUATION.md` appeared as a new untracked file. It is NOT caused
by the migration: it is a projection the generator emits that had never been
generated on this store before (zero situation entities, so its body is "No
situation entities recorded"). The owner chose to include it in the cutover
commit so the store stays at a committed fixed point.

## Status
- [x] Preflight matched the pinned source
- [x] Cutover published through the MCP surface
- [x] Diff verified against the S4 File Plan
- [x] Owner approved the regenerated `OBJECTIVE.md`
- [x] Committed (owner-gated, never automatic)

COMP-JUDGMENT-GOAL-MIGRATE S1-S4 are complete. The goal store is live canon;
the legacy `objective` position is retired and terminal.
