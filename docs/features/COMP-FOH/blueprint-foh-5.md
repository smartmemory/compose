# Blueprint — FOH-5 CONTRADICTION (Compose side)

**Status:** REVISED after Codex pre-implementation review (2026-08-10) — all 7 findings accepted
and folded in below. Ready to implement. No code written yet.
**Feature:** COMP-FOH FOH-5, `CAP.CONTRADICTION`
**Depends on:** FOH-4 (CONVICTION) shipped @8a477bb; substrate findings in
[`foh-5-substrate-findings.md`](foh-5-substrate-findings.md) (revised 2026-08-10).

## What this builds

Close the contradiction loop entirely inside Compose, using SmartMemory endpoints that
already exist. Two halves:

1. **Write (populate):** when `resolveConflict(source, target)` lands a decay, ALSO write a
   durable `CONTRADICTS` graph edge `source → target`, best-effort, retried on its own.
2. **Read (the capability):** `contradictions(handle)` returns the records that contradict
   `handle` — the resolvable, itemized form of what `conviction(handle)` only shows as
   truncated history text.

Without the write, the read is structurally empty (the lesson FOH-5 already learned about
`/reasoning/conflicts`). The two ship together.

## Why these endpoints (settled in the substrate findings)

- **Write:** `POST /memory/edge` (`links.py:72`) → `SecureSmartMemory.add_edge`, which
  validates tenant ownership of BOTH nodes. `CONTRADICTS` is a first-class edge type.
- **Read:** `GET /memory/{item_id}/neighbors` (`links.py:149`) — walks outgoing and incoming
  separately and returns `direction` per neighbour. **NOT `/links`**: core `get_links`
  inverts direction on incoming edges and drops properties (`linking.py:77-113`).
- **No atomicity attempt.** FalkorDB `transaction_context()` is a no-op (`falkordb.py:272`).
  A resolve must never be retried (double-decay); an edge write is safe to retry (MERGE by
  identity, touches no confidence). So they are correctly separate operations.

## Decisions

### D1 — Edge direction and `contradictions()` semantics
`contradictions(handle)` returns records that **contradict** `handle` = **incoming**
`CONTRADICTS` edges (`X → handle`). This matches FOH-4: `resolveConflict(source, target)`
means source supersedes/contradicts target, so the edge is `source → target`, and from
`target`'s vantage those sources are its incoming contradictions — the itemized version of the
decay events in its conviction history.

### D2 — Edge write is a single post-success epilogue, OUTSIDE the lease *(revised — review H2)*
There are **two** exits that yield a landed resolution: the clean-response path
(`smartmemory-provider.js:1461`) and the reconciliation poll (`_reconcileResolution:1485`).
Hooking the edge write "after `verdict === 'landed'`" literally would link only the clean path.

So restructure: the `_withLease` closure returns `{ result, link }` where `link` is
`{ sourceId, targetId }` on **either** landed exit and `null` on every throw (no-op / conflict /
indeterminate write no edge). After `_withLease` returns and the lease is **released**, if
`link` is set, run the best-effort `_linkContradiction(sourceId, targetId)` (the edge write does
not need the lease — it is idempotent by MERGE), then return `result`. Doing the retryable I/O
outside the lease avoids holding the mutation lease across network retries.

Persistent link failure does **not** fail the resolution: the decay already succeeded and is
authoritative via `classifyResolution`. It is `process.emitWarning`-surfaced. `ConvictionResult`
(schema-locked in FOH-4) is **unchanged** — the link outcome is not part of the return.

### D2a — Honest durability claim *(revised — review H3)*
A decayed-but-unlinked state is **not** "repairable by a future resolve" — repeating
`resolveConflict` decays *again* (destructive; FOH-4 assigns dedup to the caller,
`provider.js:627`). A caller must never re-resolve merely to repair an edge. So v1 does **not**
claim durable completeness: bounded retry minimizes the unlinked window, and
**`contradictions()` is defined as a best-effort LOWER BOUND** — it may under-report if an edge
write was abandoned. The conviction-history text trail remains the complete record of decays. A
durable pending-link outbox is a named future item, not v1.

### D3 — `contradictions()` read shape + canonical-handle rule *(revised — review M4)*
Returns `ContradictionHit[]`, mirroring `RecallHit` minus `score`: `{ handle, kind, record }`.
`handle` is the authority; `record` is a current snapshot. Building each hit needs a
`getItem(neighbor.item_id)` to recover the fluid handle+blob (neighbours return
`content`/`memory_type` but not `metadata.handle`).

**Canonical-handle contract:** `getRecord(handle)` resolves a duplicate handle to the *earliest*
item (D-FOH-4; recall does the same, `smartmemory-provider.js:1212`). A hit built from a later
duplicate's `record` would disagree with `getRecord(handle)`, breaking "handle is authority". So
emit a hit **only when the neighbour item is the canonical `_resolveOne(record.handle)` item**;
warn-and-skip later duplicates. This also collapses multiple edges from different duplicates of
one source handle to a single canonical hit.

### D3a — `contradictions()` failure semantics *(revised — review M6, M7)*
- **Target 404** (handle resolved, then target deleted before `/neighbors`) → `FluidRecordNotFound`,
  exactly as `conviction()` maps it (`:1351`). `neighbors()` client method **throws** on 404
  (not `nullOn404`); the provider maps it.
- **Per-neighbour `getItem` 404** → skip (deletion race).
- **Corrupt / non-fluid neighbour** (`_fromItem` → null) → warn/skip, as enumeration does.
- **Any other per-neighbour fetch failure** → **throw**, do not return an apparently-complete
  partial. A silent partial is worse than an error for a lower-bound read.
- Neighbour fetches run at **bounded concurrency** (v1: sequential). `/neighbors` returns the
  whole collection unpaginated, so the walk is bounded only by the edge count — sequential keeps
  it simple and the failure semantics exact. A property-bearing neighbour read is the real fix,
  filed as a future item.

### D4 — Edge type casing and read filter
Write edge_type `"CONTRADICTS"` (uppercase), matching the managed path (`framework.py:887`), so
`contradictions()` filters `link_type === 'CONTRADICTS'` and reads Compose-written and any
native-written edges uniformly.

### D5 — Idempotency is load-bearing, verified *(revised — review H1, M5)*
- **Write verification (H1):** `POST /memory/edge` returns `200 { status: "success", result }`
  **even when no edge was created** — FalkorDB catches write errors and returns `false`
  (`falkordb.py:899,906`), normalized to `{ edge_created: false }` (`smartgraph.py:394`). So the
  client `addEdge` wrapper must require `result.edge_created === true` (plus matching
  source/target/normalized type); `edge_created: false` is a **failed** write that triggers the
  retry/warn path. A wire test covers the deceptive `200 + status:success + edge_created:false`.
- **Idempotency (M5):** both backends dedup — FalkorDB `MERGE` (`falkordb.py:857`), SQLite upsert
  (`sqlite.py:649`). This is a **live-fire gate**, not opportunistic: write the same edge twice,
  assert one stored edge / one neighbour. Duplicates are not "cosmetic" — they inflate traversal
  cost and cardinality counts. The stub's edge store dedups by `(source, target, type)`.

### D6 — Edge properties
Write minimal `{ origin: 'fluid:resolveConflict' }`. Neighbours do not return props, so props
are forensic-only until a property-carrying read exists. The contradicting fact + timestamp
already live in conviction history; the edge exists for durable *linkage*, not detail.

## RUNTIME PRECONDITION (top risk — must verify in live-fire)
`enforce_declared_relation` (`relation_schema.py:203`) permits any **undeclared** relation
unconditionally (`resolve_declared_relation → None → return None`). A bare Compose fluid
workspace declares record *types*, not a `contradicts` *relation*, so the edge writes freely.
**But** if an installed ontology pack declares `contradicts` with domain/range constraints,
strict mode (`SMARTMEMORY_STRICT_RELATION_VALIDATION`, default true) would raise
`RelationValidationError` → the route 400s → the edge silently fails to land (best-effort, so
the resolution still succeeds, but `contradictions()` under-reports). Live-fire must confirm a
`CONTRADICTS` edge between two `fluid_<kind>` nodes lands in the target workspace. If it 400s,
the write half is blocked pending a workspace-ontology relation declaration — the read half and
the seam wiring still ship.

## File plan

| File | Type | Change |
|---|---|---|
| `lib/smartmemory-client.js` | existing | Add `addEdge({sourceId, targetId, relationType, properties})` → `POST /memory/edge`, **requiring `result.edge_created === true`** + matching src/tgt/type (H1); add `neighbors(itemId)` → `GET /memory/{id}/neighbors`, **throws on 404** (M7). Same `request()`/`requireShape` conventions. |
| `lib/fluid/provider.js` | existing | Add `ContradictionHit` typedef; flesh the `contradictions(_handle)` JSDoc contract on the base class (still `NI`) — best-effort lower bound (D2a). |
| `lib/fluid/smartmemory-provider.js` | existing | Declare `CAP.CONTRADICTION` in `capabilities()`. Implement `contradictions(handle)` (read; canonical-handle rule + failure semantics D3/D3a). Add `_linkContradiction(sourceId, targetId)` (best-effort edge write + bounded retry, checks `edge_created`). Refactor `resolveConflict` to the `{result, link}` post-success epilogue OUTSIDE the lease (D2). |
| `test/helpers/smartmemory-stub.js` | existing | Add edge store (**dedup by `(source,target,type)`**, M5) + `POST /memory/edge` (with an `edge_created:false` failure knob, H1) + `GET /memory/{id}/neighbors` (direction split, `(item_id,link_type,direction)` dedup, `HAS_VERSION` filter, `CONTRADICTS` passthrough, 404 on missing item). **Place the `/neighbors` handler BEFORE the generic `/memory/(.+)` catch-all (`stub:299`)** or it never runs. Wire-contract parity is a P1. |
| `test/fluid-smartmemory-provider.test.js` | existing | Cases below. |
| `test/smartmemory-client.test.js` | existing | `addEdge` (incl. `edge_created:false` under a 200) / `neighbors` request-shape + 404 cases. |

## Acceptance criteria

- [ ] `capabilities()` includes `CAP.CONTRADICTION`; `contradictions()` no longer throws `FluidCapabilityUnavailable`
- [ ] `resolveConflict` landed via the **clean** path → `CONTRADICTS` edge `source → target` exists
- [ ] `resolveConflict` landed via the **reconciliation** path (malformed-mutated / timeout-mutated) → edge also exists (H2)
- [ ] `resolveConflict` no-op / conflict / indeterminate → **no** edge written
- [ ] `addEdge` sees `200 { status:"success", result:{edge_created:false} }` → treated as failure, retried/warned (H1)
- [ ] `_linkContradiction` persistent failure → resolution still returns the `ConvictionResult`, one `process.emitWarning`, no throw
- [ ] Writing the same edge twice → **one** stored edge / one neighbour (M5 idempotency)
- [ ] `contradictions(handle)` returns one hit per incoming `CONTRADICTS` neighbour, `{handle, kind, record}`, handle resolvable via `getRecord`
- [ ] Later-duplicate source item → skipped; only the canonical `_resolveOne(handle)` item yields a hit (M4)
- [ ] `contradictions(handle)` on a record with no contradictions → `[]`
- [ ] `contradictions(unknownHandle)` → `FluidRecordNotFound`; target deleted before `/neighbors` (404) → `FluidRecordNotFound` (M7)
- [ ] Per-neighbour 404 → skipped; corrupt/non-fluid → warn+skip; **other** neighbour fetch failure → `contradictions()` throws (M6)
- [ ] Full suite green (`npm test`), FOH-5 suite targeted
- [ ] Live-fire: real `CONTRADICTS` edge lands between two `fluid_<kind>` nodes, reads back via `/neighbors`, and a double-write yields one edge (precondition + idempotency)

## Out of scope (v1)
- Edge properties beyond `origin` (unreadable over `/neighbors`)
- Repairing decayed-but-unlinked states (no reconciliation loop; tolerated)
- `outgoing` contradictions (records `handle` itself contradicts) — trivial later flip
- Making decay+link atomic (upstream, filed separately)
