# COMP-FLUID-SEAM-GUARANTEES — lift the fluid store's safety guarantees into the seam

**Status:** PLANNED
**Date:** 2026-08-05
**Epic:** COMP-PLAN-RIGOR (Front-of-Funnel Rigor + Parity)
**Origin:** COMP-PLAN-IDEA-UNIFY S3b-1, review round 2

## Related Documents

- Origin slice: [COMP-PLAN-IDEA-UNIFY blueprint-s3b-1.md](../COMP-PLAN-IDEA-UNIFY/blueprint-s3b-1.md) — findings F3-1, F6-1, F7-1
- Seam: `lib/fluid/provider.js` · Floor: `lib/fluid/local-provider.js` · SmartMemory: `lib/fluid/smartmemory-provider.js`
- Substrate ruling: [`PROVIDER-SEAM`, what-to-build §8k](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)

---

## Problem

S3b-1 gave the fluid store two safety guarantees and put both in the **floor
implementation** rather than in the seam. The SmartMemory provider has neither, and nothing
failed to warn us — it satisfies the seam's interface completely.

**1. Handle allocation is unserialized on SmartMemory.** `lib/dir-lock.js` is wired into
`local-provider.js` only. `grep -n "withDirLock" lib/fluid/smartmemory-provider.js` returns
nothing, while that provider allocates through `_nextHandle` (`:445`) → `_issuedHandles`
(`:433`) — both remote reads — and appends its event log remotely too (`:815-820`).

The floor's measured failure transfers unmitigated: N concurrent creates all allocate
`IDEA-1`, and last-writer-wins destroys N-1 ideas. Two independent reasons the S3b-1 fix
does not carry over:

- `dir-lock` is a **local filesystem mutex**, so it could never serialize two machines
  sharing one SmartMemory workspace — and being shared is the entire reason to use it.
- That provider does not take it **even on one machine**, so two local processes race too.

**2. The one-time import cannot restart on SmartMemory.** Same tombstone-before-record
ordering as the floor (`appendEvent:552`, then `createItem:559`) but no `reclaimAborted` —
the issued-handle guard at `:508` throws unconditionally. The window is far wider than the
floor's because it spans a **network call** rather than a local file write. A blip
mid-import burns that handle permanently, and `ensureIdeaboxMigrated`'s resume path then
fails forever: it calls `importIdeabox`, which passes `reclaimAborted`, which this provider
ignores.

**Blast radius today: none.** `.compose/compose.json` has no `fluid` block, so
`fluidProviderFor` returns the floor. This is latent, not live — and latent is exactly the
shape of defect S3b-1 spent a whole slice proving stays invisible until data reaches it.

## Goal

A guarantee implemented in one provider is not a guarantee of the store. Both of these
belong to **what a fluid provider IS**, alongside the handle invariants already lifted into
`record-shape.js` for precisely this reason (COMP-FOH C12/C16). The seam states them
nowhere today, so a third implementation would miss them just as silently.

**In scope:** serialized mutation and `reclaimAborted` as seam obligations; a conformance
suite every provider must pass; the two P2s from the same review (F6-1, F7-1); an
interim guard on configuring SmartMemory.

**Not in scope:** the SmartMemory **service** limitations — no per-item reindex
(smart-memory-core#4), PATCH cannot clear a property (smart-memory-core#3), no per-request
`_embed` (smart-memory-service#3), and the supersession back-reference. All filed and owned
upstream; **do not plan Compose work for any of them.** Also out: migrating the other five
ad-hoc `mkdir` locks in `lib/` onto `lib/dir-lock.js` — real, but independent of the seam
question.

---

## Decision 1: fix the seam, not the second implementation

Patching `smartmemory-provider.js` to match the floor would close today's instance and
leave the cause — that neither guarantee is written down anywhere a new provider must
satisfy. The conformance suite is the acceptance criterion that actually prevents a
recurrence; the rest only repair the current one.

## Acceptance criteria

- [ ] Serialized mutation is a **seam obligation**, stated on `FluidProvider` and satisfied
      by every implementation. The floor keeps `dir-lock`; SmartMemory needs a mechanism
      valid across machines, since a local mutex cannot serialize the shared case.
- [ ] `reclaimAborted` is part of the seam contract, with the floor's narrow semantics: a
      handle with no record and no `deleted` event, reclaimable only by an explicit opt-in
      caller (the import).
- [ ] A shared **conformance suite** runs against every provider, so a new implementation
      cannot satisfy the interface while missing the guarantees.
- [ ] Concurrent creates against the SmartMemory provider yield distinct handles, asserted
      by a test that fails when the mechanism is removed.
- [ ] An interrupted import against SmartMemory can be re-run to completion.
- [ ] **F6-1** — `add --cluster "X"` cannot create duplicate clusters. Lookup and create are
      separate operations (`ideabox-cli.js:101`, `:153`) and the lock covers only each
      individual mutation. Needs find-or-create in one critical section, which needs a
      non-locking inner create because `withDirLock` is not reentrant.
- [ ] **F7-1** — a discussion author containing a space survives the projection. The
      contract accepts any string, the parser's grammar is `\w+` (`lib/ideabox.js:53`), and
      the renderer emits verbatim, so `author: "Jane Doe"` round-trips to zero discussion
      entries. Unreachable from the CLI (always writes `human`), reachable from the provider
      and from COMP-PLAN-IDEA-UNIFY S3b-2's API.
- [ ] Until the above land, `fluid.provider: "smartmemory"` warns rather than silently
      running the ideabox on a provider with unserialized allocation.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/fluid/provider.js` | edit | State both obligations on the seam. |
| `lib/fluid/smartmemory-provider.js` | edit | Cross-machine allocation; honour `reclaimAborted`. |
| `lib/fluid/local-provider.js` | edit | Non-locking inner create so find-or-create can compose (F6-1). |
| `lib/ideabox-cli.js` | edit | Atomic cluster find-or-create (F6-1). |
| `lib/fluid/render-ideabox.js` or `contracts/fluid-record.schema.json` | edit | Reconcile the author grammar (F7-1). |
| `lib/fluid/factory.js` | edit | Interim warning on `provider: "smartmemory"`. |
| `test/fluid-provider-conformance.test.js` | new | The suite every provider must pass. |

## Open Questions

- **What is the cross-machine mechanism?** A local mutex is definitionally wrong for a
  shared store. Whether SmartMemory can offer a conditional create or a reservation
  primitive decides whether this is a Compose-side change or an upstream ask. **Answer
  before designing the fix.**
- **Should allocation move off max-plus-one entirely?** A server-assigned monotonic counter
  would make the race unrepresentable rather than merely guarded, but it changes how
  `IDEA-N` handles are minted — and the whole epic treats those as external citations, so it
  is a larger ruling than it looks.
