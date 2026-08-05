# COMP-FLUID-SEAM-GUARANTEES — lift the fluid store's safety guarantees into the seam

**Status:** PARTIAL — six of seven criteria met; the seventh needs a change in SmartMemory (Q1)
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
`_embed` (smart-memory-service#3), and the supersession back-reference. **Do not plan
Compose work for any of them** — they are fixed in SmartMemory or not at all. Note the
earlier wording, "filed and owned upstream", overstated it: those issues are self-filed and
unanswered, so they are a backlog we own, not a handoff someone else has accepted. Also out: migrating the other five
ad-hoc `mkdir` locks in `lib/` onto `lib/dir-lock.js` — real, but independent of the seam
question.

---

## Decision 1: fix the seam, not the second implementation

Patching `smartmemory-provider.js` to match the floor would close today's instance and
leave the cause — that neither guarantee is written down anywhere a new provider must
satisfy. The conformance suite is the acceptance criterion that actually prevents a
recurrence; the rest only repair the current one.

## Acceptance criteria

- [x] Serialized mutation is a **seam obligation**, stated on `FluidProvider` and satisfied
      by every implementation — *or DECLARED absent*. `mutationScope()` (`none|process|machine|cluster`)
      plus `isShared()` are how a provider says how far its serialization reaches; both
      default to the pessimistic answer, so a provider that never considered concurrency
      inherits "unsafe" rather than "fine". The floor declares `machine` and keeps
      `dir-lock`. SmartMemory declares `none`, honestly — see Q1.
- [x] `reclaimAborted` is part of the seam contract, with the floor's narrow semantics: a
      handle with no record and no `deleted` event, reclaimable only by an explicit opt-in
      caller (the import). Now implemented on the SmartMemory provider too — it needed no
      server primitive, so it did not wait on Q1. **The import is restartable there today.**
- [x] A shared **conformance suite** runs against every provider, so a new implementation
      cannot satisfy the interface while missing the guarantees.
      `test/fluid-provider-conformance.test.js`, 19 cases x 2 providers. Adding a provider
      means adding one row. The SmartMemory row runs against the shared wire stub rather
      than a hand-rolled double, because a double would pass by construction — which is how
      the real provider passed review while missing both guarantees.
- [ ] **Needs a SmartMemory-side change first — ours to make, not another team's
      (tracked as `SVC-LEASE-1` in `smart-memory-docs/docs/ROADMAP.md`).**
      Concurrent creates against the SmartMemory provider yield distinct handles. The
      conformance case is written and gated on `mutationScope()`, so it starts applying to
      that provider the moment it can honestly declare `cluster` — and the suite fails today
      if it declares `cluster` without a mechanism.
- [x] An interrupted import against SmartMemory can be re-run to completion.
- [x] **F6-1** — `add --cluster "X"` cannot create duplicate clusters. Lookup and create were
      separate operations and the lock covered only each individual mutation. Now
      `FluidProvider.findOrCreateRecord()`, one operation on the seam: the floor runs both
      halves inside a single hold of the mutation lock (composing on the existing
      non-locking `_createRecordLocked`, since `withDirLock` is not reentrant). *Line refs in
      the original finding are stale — the cluster resolution moved to
      `lib/fluid/ideabox-ops.js` in COMP-PLAN-IDEA-UNIFY S3b-2.*
- [x] **F7-1** — a discussion author containing a space survives the projection. **This went
      live before it was fixed:** S3b-2 shipped `POST /api/ideabox/ideas/:id/discuss`, which
      takes the author from a request body, so the defect stopped being unreachable. Probed
      and confirmed — `Jane Doe` rendered correctly and parsed back to ZERO entries, taking
      the comment and the `serialize(parse(projection))` fixed point with it. The parser's
      author grammar is now "everything up to the FIRST colon" (lazy, so a colon in the
      comment TEXT still works), and the contract forbids a colon or line break in an author:
      a value the surface cannot represent is a value the store should refuse to hold.
- [x] Until the above land, `fluid.provider: "smartmemory"` warns rather than silently
      running the ideabox on a provider with unserialized allocation. **Derived from the
      provider's own declarations, not hardcoded to its name:** the factory warns when
      `isShared()` and the scope is below `cluster`. A hardcoded warning has to be remembered
      by whoever adds the third provider — the same failure this feature exists to close —
      and remembered again, in the other direction, on the day the gap is fixed.

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

## Answered Questions

### Q1 — What is the cross-machine mechanism? **ANSWERED 2026-08-05: none exists yet. Upstream ask filed.**

Checked the SmartMemory service directly rather than reasoning about it:

| Candidate | Verdict | Evidence |
|---|---|---|
| Caller-supplied item id on create | **Absent** — the server assigns it, so there is no key two writers can collide on | `crud.py:373` takes `content`, `memory_type`, `metadata`, `use_pipeline`, `profile_name`, `conversation_context` |
| Conditional create / if-not-exists | **Absent** | same route |
| Compare-and-swap on update (ETag/If-Match/version) | **Absent** | `crud.py:1003` |
| Counter / sequence / allocate endpoint | **Absent** | no such route |
| Content-hash idempotency | **Exists but unusable** — an explicitly NON-ATOMIC read-then-write that proceeds on error, on a different route, keyed by content. It cannot express "claim IDEA-7": two records claiming the same handle hash differently | `ingest.py:178-205` |

So there is no primitive to build a correct cross-machine reservation on. This half cannot
be fixed from the Compose side — but it is **not "blocked upstream" in the sense that phrase
usually carries**, and saying so would park it forever.

**THERE IS NO OTHER TEAM, AND GITHUB IS NOT THE TRACKER.** Two corrections to how this was
first written up:

1. Every issue this document and its predecessors cite as "owned upstream" —
   `smart-memory-service#3`, `smart-memory-core#3`, `smart-memory-core#4` — was filed by our
   own `smartmem-dev` account with zero comments, no assignee and no label. We own
   SmartMemory. Treating one as a dependency with a queue behind it parks the work forever.
2. **SmartMemory tracks work in its own roadmap, not GitHub issues.** The live tracker is
   `smart-memory-docs/docs/ROADMAP.md` (884KB, hand-authored prose, 555 feature folders).
   The top-level `SmartMemory/ROADMAP.md` is an unused May scaffold, and the GitHub trackers
   hold only Dependabot noise and our own unanswered notes.

So this is filed where SmartMemory actually works: **`SVC-LEASE-1`**, with a roadmap entry
and `smart-memory-docs/docs/features/SVC-LEASE-1/design.md`. The GitHub issue is closed and
points there, so there is one tracker rather than two.

The honest statement: **this is the next task, in a repo we own, and it is small.**

**The ask is small, because the machinery already exists there.**
`snapshot_sweep.py:94` runs `with_snapshot_lock` — a Redis lease with a TTL, released via
Lua compare-and-delete — already consumed by `routes/summary.py:87`. It is internal,
single-purpose and workspace-scoped rather than key-scoped. One behavioural change is
required if it is generalized: it currently yields `True` when Redis is unreachable
(`snapshot_sweep.py:88-91`), which is a sensible default for a sweep and **wrong** for
allocation — a lease that grants itself when the coordinator is down is worse than no lease,
because the caller believes it is serialized.

**A hack was considered and rejected.** The content-hash path can be abused into a
last-writer-wins arbiter (both racers write a claim under the same derived id, read back,
and whoever's token survives wins). It would make a correctness primitive out of a
convenience that documents itself as best-effort and falls back on error. Not worth it.

**What this does NOT block.** Only one acceptance criterion depends on it. `reclaimAborted`
needed no server primitive — it is a question about the provider's own event log — so it is
fixed here rather than deferred, and the import is restartable on SmartMemory today.

### Q2 — Should allocation move off max-plus-one? **Deferred, and now cheaper to defer.**

A server-assigned monotonic counter would make the race unrepresentable rather than guarded.
But there is no counter endpoint either, so it is the same upstream conversation with a
larger blast radius: it changes how `IDEA-N` is minted, and the epic treats those as
external citations. The lease in Q1 is the smaller ask and leaves this open rather than
foreclosing it.

---

## Implementation record — 2026-08-05

Six of seven acceptance criteria met. The seventh is blocked upstream and is the
only one, which is why Q1 was answered before any design work rather than after.

### What shipped

| Concern | Where |
|---|---|
| Both obligations stated on the seam | `lib/fluid/provider.js` — a long comment block above the record methods, plus `MUTATION_SCOPE`, `mutationScopeAtLeast`, `mutationScope()`, `isShared()` |
| Honest declarations | `local-provider.js` → `machine`/not shared. `smartmemory-provider.js` → `none`/shared |
| `reclaimAborted` on SmartMemory | `smartmemory-provider.js` — `_isAbortedAllocation()` mirroring the floor's narrow semantics |
| Atomic find-or-create (F6-1) | `FluidProvider.findOrCreateRecord()` + the floor's single-lock override; `ideabox-ops.js` consumes it |
| Author grammar (F7-1) | `lib/ideabox.js` `DISCUSSION_ENTRY_RE`, plus an author `pattern` in the contract |
| Declaration-derived warning | `factory.js` `warnIfUnsafelyShared()` |
| Conformance suite | `test/fluid-provider-conformance.test.js` — 19 cases x 2 providers |

### Decisions taken during implementation

- **D1 — a provider may DECLARE the absence rather than implement it.** The original
  criterion read "satisfied by every implementation", which SmartMemory cannot do while Q1
  is open. The alternative to a declaration is silence, and silence is what shipped in
  S3b-1. Both accessors default to the pessimistic answer, so a provider that never
  considered concurrency inherits "unsafe" rather than "fine" — the direction of the default
  is the whole point.
- **D2 — the scope is a reach, not a boolean.** "Is it locked" has no single true answer: a
  filesystem mutex genuinely serializes every process on one machine and cannot serialize
  two. `machine` is the complete answer for the floor and a shortfall for a shared store,
  and only the pair (`mutationScope` + `isShared`) decides which.
- **D3 — the conformance suite asserts the NEGATIVE case too.** A provider declaring `none`
  is expected to fail the concurrency cases, and the suite says so. That keeps the
  declaration honest in both directions: a provider that later gains serialization cannot
  leave a stale `none` behind, and one that claims `machine` or better without a mechanism
  fails immediately (verified — that mutation fails four cases).
- **D4 — the warning is derived, never hardcoded.** A per-provider warning has to be
  remembered by whoever adds the third provider, which is this feature's own failure mode,
  and remembered again in the other direction on the day the gap closes.
- **D5 — F7-1's fix constrains the contract rather than escaping in the renderer.** An
  author containing a colon cannot be represented in `- [date] author: text`. A value the
  surface cannot express is a value the store should refuse to hold; escaping it would make
  the projection unreadable to preserve something nobody wants.

### Verification

- 310 tests across the fluid and ideabox suites; full suite **5413 node + 581 ui + 100
  tracker, zero failures** (node baseline 5372 after S3b-2; +41 is exactly the new tests).
- Mutation-tested, each failing its case when removed: SmartMemory ignoring `reclaimAborted`
  (the S3b-1 state), reclaiming a `deleted` handle (too broad), the floor's find-or-create
  dropping its lock, and a provider overstating its `mutationScope`.
- F7-1 was probed against the real renderer and parser before the fix — `Jane Doe` produced
  zero parsed discussion entries and broke the fixed point — and after.

### Open

- The remaining criterion. **It is work we have not done yet, not work we are waiting on.**
  Two steps, in this order: (1) `SVC-LEASE-1` — expose a scoped, fail-closed lease in
  `smart-memory-service`; the Redis + Lua CAD machinery already exists at
  `snapshot_sweep.py:94`, internal and workspace-scoped; (2) here, implement it in
  `smartmemory-provider.js` and flip `mutationScope()` to `cluster`. The conformance suite's
  concurrency cases then begin applying to that provider automatically, with no test
  changes — that is what the gating buys.
- Still explicitly out of scope: the other five ad-hoc `mkdir` locks in `lib/` (IDEA-22), and
  the SmartMemory service limitations owned upstream.
