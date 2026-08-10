# FOH-5 CONTRADICTION — progress ledger

**Feature:** COMP-FOH FOH-5, `CAP.CONTRADICTION` (Compose side).
**Status:** IMPLEMENTED, full suite green, post-impl Codex review DONE (1 Medium, fixed),
**LIVE-FIRE PASSED** against the real service. Ready to commit. No SmartMemory code changed.

## LIVE-FIRE PASSED (2026-08-10)
Self-contained script provisioned a throwaway tenant, declared `fluid_decision`+`fluid_event`
(kind:record), ran the shipped provider path, and tore the tenant down. Verified on the real wire:
- `resolveConflict(A,B,accept_new)` decayed B `1.0→0.5` AND wrote a durable `CONTRADICTS` edge.
- `contradictions(B)` returned `[{handle: DEC-1(=A), kind: decision}]` through the shipped path.
- Raw `GET /neighbors(B)` showed one incoming `CONTRADICTS` from A's RECORD item (content
  "the datastore is Postgres") — direction correct.
- `contradictions(A)` = `[]` (the winner has no incoming contradictions).
- Second resolve → `0.0` AND still exactly ONE edge (idempotency / MERGE held on the real backend).
- **The runtime relation precondition HOLDS:** the undeclared `CONTRADICTS` relation wrote freely,
  no strict-validation 400. (Confirmed independently: `POST /ontology/relations` docstring says edge
  writes are NOT validated against domain/range/cardinality yet — P3.)
- Script: session scratchpad `livefire-foh5.mjs`. Two script-only bugs found+fixed en route (must
  declare `fluid_event` too; `/list` by handle returns record AND event items — filter by
  `fluid_ns===compose.fluid.v1` to get the record item_id). Neither was a provider bug.

## POST-IMPL Codex review (1 Medium, FIXED)
A parseable-but-schema-invalid neighbour blob (`{"handle":"X"}` with no kind, or `{}`) slipped past
`_fromItem` (which only guards bad JSON / wrong ns) and would be emitted as a malformed hit, or —
for a handleless `{}` — throw in `_resolveOne`'s paired metadata filter, breaking the whole read.
Recall is accidentally shielded by its `RECALLABLE_KINDS.has(kind)` filter; contradictions() was not.
FIX: `contradictions()` now validates each `_fromItem` record against the `record` schema
(`getFluidValidator().validate('record', …).valid`) and warn-skips on failure — honoring D3a
"corrupt → skip". Test added (`bad-partial` + `bad-empty` blobs). Review confirmed everything else
correct (both landed exits link, no throwing exit links, edge_created check, 404 mapping, canonical
dedup, direction filter).

## What shipped in the working tree (uncommitted)
- `lib/smartmemory-client.js` — `addEdge()` (POST /memory/edge, requires `result.edge_created===true`
  + matching src/tgt/type, else MALFORMED) and `neighbors()` (GET /{id}/neighbors, throws on 404).
- `lib/fluid/provider.js` — `ContradictionHit` typedef + `contradictions()` base-class contract
  (best-effort lower bound, canonicalized, handle is authority).
- `lib/fluid/smartmemory-provider.js` — declares `CAP.CONTRADICTION`; `resolveConflict` refactored
  to `{result, link}` epilogue OUTSIDE the lease (links on BOTH landed exits); `_linkContradiction`
  (best-effort edge write, bounded retry, warns and never throws); `contradictions()` read.
- `test/helpers/smartmemory-stub.js` — edge store (dedup by src,tgt,type), `POST /memory/edge`
  (+ `__edgeMode` knob: ok|not-created|fail), `GET /{id}/neighbors` (+ `__extraNeighbors`,
  `__neighbors404`, `__getFail` knobs). `/neighbors` placed BEFORE the generic catch-all.
- `test/fluid-smartmemory-provider.test.js` — 13-test FOH-5 suite; updated the FOH-4-era seam test
  (CONTRADICTION now declared, only CALIBRATION undeclared).
- `test/smartmemory-client.test.js` — addEdge (incl. edge_created:false), neighbors (incl. 404).
- Committed already: `blueprint-foh-5.md` (@b181040), `foh-5-substrate-findings.md` (@b657827).

## Test state
Full suite: node **5590/0**, ui **581/0**, tracker **100/0**. FOH-5 provider suite 13 tests, client
+7 tests. No live services touched (local http stubs, SM_FLUID_KEY set/deleted per test).

## Load-bearing decisions (do not re-derive)
- **Direction:** `resolveConflict(source,target)` writes `source CONTRADICTS target` (evidence→item,
  matches framework.py:887). `contradictions(handle)` = INCOMING edges = records that contradict it.
- **Best-effort, lower bound (review H3):** a decayed-but-unlinked state is NOT "repairable by a
  future resolve" (that decays again). `contradictions()` may under-report; conviction history is
  the complete text record. No repair outbox in v1.
- **Never trust the edge envelope (review H1):** POST /memory/edge returns 200 status:success even
  on `edge_created:false` (falkordb.py:899,906 → smartgraph.py:394). Client checks `edge_created`.
- **Both landed exits link (review H2):** clean path AND `_reconcileResolution` return `{result,link}`.
- **Canonical-handle (review M4):** emit a hit only when the neighbour IS `_resolveOne(record.handle)`
  (earliest, D-FOH-4). `_resolveItems` filters to `fluid_ns===RECORD_NS`, so events never intrude.
- **Failure trichotomy (review M6/M7):** target 404 → FluidRecordNotFound; per-neighbour 404 → skip;
  corrupt/non-fluid → skip; ANY other fetch failure → throw (no silent partial).

## RUNTIME PRECONDITION for live-fire (top risk)
`enforce_declared_relation` (relation_schema.py:203) permits any UNDECLARED relation. A bare fluid
workspace declares record *types*, not a `contradicts` *relation*, so the edge writes freely — UNLESS
an installed ontology pack declares `contradicts` with domain/range constraints, in which case strict
mode (default on) 400s. Live-fire must confirm: a real CONTRADICTS edge lands between two `fluid_<kind>`
nodes, reads back via /neighbors, and a double-write yields ONE edge. Provisioning recipe:
`foh-4-progress.md` top section.

## Remaining — ALL DONE (2026-08-10)
1. ~~Adjudicate post-impl Codex review~~ DONE — 1 Medium fixed.
2. ~~Live-fire~~ PASSED.
3. ~~Commit + journal~~ DONE — feat @7731043, journal session 107 @5a16d9d, pushed (origin/main up to date).
4. ~~File upstream SmartMemory leftovers as smartmem-dev~~ DONE:
   - idempotency-ID on `/resolve` → smart-memory-service#5
   - atomic decay-plus-link → smart-memory-core#5
   - property-carrying link read → smart-memory-core#6
   Epic status unchanged: COMP-FOH stays IN_PROGRESS (CALIBRATION undeclared/blocked — no subject).
