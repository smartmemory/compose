# COMP-FOH — Implementation Blueprint (FOH-2)

**Slice:** FOH-2 — `CAP.RECALL` on `SmartMemoryFluidProvider`
**Status:** READY TO IMPLEMENT
**Date:** 2026-08-04
**Revision:** r3. Two review rounds, nine findings, all upheld and resolved. Four were introduced by the round-1 fixes; three corrected claims an earlier draft asserted confidently. See both review sections at the foot.

## Related Documents

- Architecture: [architecture.md](architecture.md) §Sequencing item 2, §Q3.
- Design: [design.md](design.md)
- Prior slice: [blueprint.md](blueprint.md) — FOH-1, shipped @3d97dce. Its D-FOH-1
  and Ruling Q3 name this slice's entry gate; both are answered below.

**Artifact naming.** FOH-1 owns `blueprint.md`, so this slice is
`blueprint-foh-2.md`. Disclosed consequence: compose's tooling hard-codes
`<feature>/blueprint.md` (`lib/gsd.js:78`, `lib/staleness.js:61`,
`lib/lane-gate.js:35`, `lib/triage.js:338`, `lib/feature-validator.js:540`), so
this file is not staleness-tracked. No gate breaks — those checks find FOH-1's
blueprint and pass — but a future multi-slice feature deserves a real answer
rather than this workaround. Filed as a follow-up, not fixed here.

## Entry gate — the two questions FOH-1 said this slice must open by answering

FOH-1 named both explicitly rather than leaving them to be discovered mid-slice.
Both are now answered against directly-read code.

### EG-1: reindexing. **There is no path available to Compose. Accept and bound.**

`PATCH` does not refresh an item's embedding. FOH-1 recorded this as
second-hand; it is now **verified direct**: `_generate_and_store_embedding` is
called from exactly one site, `pipeline/stages/crud.py:125`, inside `add()`. The
update path (`update_properties` → `update_memory_node` → `add_node`) never
reaches it.

**The bound is narrower than FOH-1 assumed, and stating it loosely would
overstate the damage.** Search is **hybrid by default** (`enable_hybrid=True`,
`request_models.py:65`) and runs several named channels alongside the semantic
one, including `contains` and `keyword-bm25` (`search.py:405-416`). The lexical
channels query the graph node directly — `toLower(n.content) CONTAINS ...`
(`search.py:1100-1102`) — and `content` **is** rewritten by `PATCH`. So:

- an edited record **remains findable by its new text**, lexically;
- what goes stale is the **semantic vector**, so associative "have we discussed
  something like this" matching, and the RRF ranking contribution of that
  channel, still reflect the original text.

The honest bound is therefore *degraded associative recall and skewed ranking on
edited records*, not "invisible until re-created". This matters for what we tell
users and for what the test asserts.

Two things look like they solve it and do not:

- **`needs_reembed`** (`activation/compaction_constants.py:25`) is documented as
  the marker for "a downstream enrichment pass". It has **producers only** —
  `compaction.py:346` sets it, a test asserts it is set — and **no consumer**.
  Writing it from here would be cargo-culting a flag nothing acts on. This is the
  same latent-key shape as `embeddings.enable_*` in Ruling Q3, and the same
  mistake round 2 made about `_embed`: a key existing is not a mechanism working.
- **`smartmemory rebuild`** (`cli.py:205`) is a real vector reindex, but it is an
  operator CLI command over the whole index. Not HTTP-reachable, and far too
  coarse for one edited record.

**OWNER DECISION 2026-08-04 — ship recall against the index as it stands,
disclose the bound.** `getRecord`/`listRecords` stay exact, because the blob is
canonical and read directly. Only `recall()` is affected, and only in its
semantic channel: an edited idea is still findable by its new text lexically,
but its associative match and its ranking reflect the original wording. Filed
upstream as [smart-memory-core#4](https://github.com/smart-memory/smart-memory-core/issues/4).

Rejected: **re-add on update** (delete the item and recreate it under the same
handle to force a fresh embedding). FOH-1's stated reason — "it burns a handle" —
was **too strong and is corrected here**: re-adding under the *same* handle does
not reissue that handle to a different record, so the tombstone invariant is not
what forbids it. The real cost is sharper and was not visible until FOH-1
shipped: re-adding resets the server-stamped `metadata.created_at`, which is
exactly the field **D-FOH-4's duplicate tie-break depends on**
(`secure_smart_memory.py:343`). An edited record would become the "newest" and
lose a tie-break against its own duplicate. It is also non-atomic — a failure
between the delete and the create leaves either zero or two live items on one
handle — and pays an embedding call per edit.

### EG-2: per-kind recallability. **The half that matters is enforceable here; the other half stays a deployment dependency.**

Ruling Q3 assigned enforcement to this slice and assumed the only lever was
`embeddings.enable_<memory_type>` — global SmartMemory deployment config that
defaults to on and that Compose cannot verify.

**The two halves of "recallability" have different answers, and conflating them
is what made Ruling Q3 look like a single unsolved problem.**

**The negative half — never recall an INDEXED kind — is fully enforceable here,
by output exclusion.** Every hit is filtered to
`metadata.fluid_ns === 'compose.fluid.v1'` and to the recallable-kind allowlist
before it reaches a caller. If a deployment leaves `enable_fluid_cluster` at its
default and clusters get embedded anyway, **they are still never recalled**. This
holds with the config dial unset, which is exactly the fail-open case Ruling Q3
could not defend against, and it is asserted in the tests.

**The positive half — a FULL kind is actually associatively recallable —
remains a deployment dependency and is NOT enforceable from Compose.**
`enable_fluid_idea=false` would leave ideas unembedded
(`pipeline/stages/crud.py:177-188`), degrading them to lexical matching only
(EG-1's channel analysis) while architecture.md §Q3 calls them FULL. Compose
cannot verify this over the API: there is no endpoint that reports whether an
item was embedded.

So the deployment keys are **downgraded, not eliminated**: they no longer control
whether INDEXED kinds leak into recall, but they still control whether FULL kinds
get the semantic channel at all. Documented as a required deployment step with
its failure mode named, alongside EG-1's bound. An earlier draft of this section
claimed the dial "stops being load-bearing" — that was an overclaim in the
positive direction and is corrected here.

**Note on the query itself:** `SearchRequest.memory_type` exists
(`request_models.py:63`, passed through at `crud.py:1384`) but this slice
deliberately does **not** use it — see "Query strategy", where a single
unfiltered query beats one-query-per-kind. Enforcement is by output exclusion,
not by request scoping. Those are equivalent for the negative half, and only the
output side is testable in one round trip.

**RECALLABLE_KINDS = `idea`, `thread`, `question`** — architecture.md §Q3's FULL
set. `cluster` and `decision` are INDEXED: stored and readable by handle, never
returned from `recall()`.

## Corrections table

| # | Assumed | Reality | Consequence |
|---|---|---|---|
| **R1** | Architecture: "implemented over the already-shipped `client.search()`" | The shipped `search()` sends `Authorization` but **not `X-Workspace-Id`** — the workspace header is applied only by `crudHeaders()`, which FOH-1 added for the CRUD family (`smartmemory-client.js`, `search` at `:101-136` vs `crudHeaders` in the S01 block) | A recall built on `search()` would query the **key's default scope, not the configured fluid workspace**. Needs a workspace-scoped search method. Purely additive: `search()` is untouched, because COMP-SMARTMEMORY-RECALL ships on it. |
| **R2** | — | `memory_type` on search is a **single optional value**, not a list (`request_models.py:63`) | Three recallable kinds cannot be expressed in one filtered query. See "Query strategy". |
| **R3** | — | Search results already carry `item_id`, `content`, `memory_type`, **`metadata`** and `score` (`_format_memory_item`, `crud.py:215-290`) | The canonical blob rides back on the hit itself. Recall reconstructs full records with **no second fetch** — no N+1. |
| **R4** | — | The route over-fetches internally (`_fetch_k = top_k * 2`, `crud.py:1350`) then re-ranks and truncates to the requested `top_k` | The caller's `top_k` is a post-truncation budget. Compose's own over-fetch (below) is on top of this, not instead of it. |
| **R5** | FOH-1 C8: scopes are method-derived | `POST /memory/search` is a **POST**, so a read-only recall needs `write:memories` | Already satisfied — FOH-1 requires all three scopes and documents it. No new config. |
| **R6** | — | `recall()` in the seam calls `this.require(CAP.RECALL)` before doing any work (`provider.js`) | Declaring the capability and implementing the method must land in the same commit. A provider that declares RECALL without a working `recall()` is the exact failure `PROVIDER-SEAM` forbids. |

## The `recall()` contract

The seam declares `recall(query, opts)` and defines nothing else, so this slice
defines it. Left implicit it would be re-invented differently by the next
provider — the C12/C16 failure again.

```
recall(query: string, opts?: { limit?: number }) -> Promise<RecallHit[]>

RecallHit = {
  handle: string,        // the citation, and the authority
  score:  number | null, // the server's score, passed through, never recomputed
  record: FluidRecord,   // hit-time snapshot — current, not "as indexed"
}
```

**A hit is a wrapper, not an enriched record.** `contracts/fluid-record.schema.json`
declares `record` with `additionalProperties: false` (`:75`), so attaching
`score` to the record object would produce something the contract rejects. The
wrapper keeps the record valid against the published schema and keeps score
semantics out of the record vocabulary.

**`limit`:** defaults to **10**, clamped to `1..100`. A non-integer, zero,
negative or absent value takes the default rather than throwing — `recall` is a
discovery call, often driven by a UI or an agent, and a hard failure on a sloppy
limit is worse than a sane one. The clamp is not decoration: `top_k` is
unconstrained on the wire and the route immediately doubles it
(`crud.py:1350`), so an unclamped caller value becomes an unbounded fetch and a
proportional embedding-comparison cost on the server.

**`record` is current, not stale — the staleness is in the MATCH, not the
payload.** These are easy to conflate and an earlier draft did, labelling the
payload "as indexed". Search hydrates each hit from the live graph node
(`search.py:173`), and FOH-1's `updateRecord` rewrites `metadata.fluid_record_json`
on that same node (`smartmemory-provider.js` `updateRecord`). So the blob that
comes back on a hit is the current record.

What EG-1 bounds is therefore **why a record surfaced and where it ranked**, not
what you receive when it does. An edited idea can match on its old wording and
still hand back its new text. That is a strictly better position than the earlier
draft described, and the distinction has to survive into the JSDoc or an
implementer will "fix" a non-problem.

**The one case where the payload really can differ from canon is duplicates.**
Search returns items, and a racing duplicate (D-FOH-4) can be returned instead of
the canonical earliest one.

**Rule: `handle` is the authority; `getRecord(handle)` is canon.** A caller that
displays results can use `record` directly. A caller about to *act* on one must
re-read it by handle. Stated in the JSDoc, not just here.

Within one result set, hits are **deduplicated by handle**, using D-FOH-4's
order in full: earliest `metadata.created_at`, ties broken lexicographically by
`item_id`. Both keys are already on the hit, so this costs no extra request — and
dropping the second key would leave equal-timestamp duplicates resolving
nondeterministically, and inconsistently with `getRecord`. That closes the
duplicate case whenever both copies are returned. It cannot close the case where
only the later copy is returned, which is why the authority rule exists rather
than a claim of full canonical resolution. Resolving every hit's handle
canonically was rejected: it turns one round trip into N+1 to fix a race the
authority rule already makes safe.

## Query strategy

R2 forces a choice, and both options degrade differently.

**Chosen: one unfiltered query, over-fetched, filtered client-side.**

`recall(query, {limit})` issues a single search with `top_k = limit * OVERFETCH`
and no `memory_type`, then drops every hit that is not a fluid record of a
recallable kind, then truncates to `limit`.

Rejected: **one filtered query per recallable kind, merged.** Three round trips
per recall, and the merge is unsound — scores from separate searches are not
comparable, so ranking across the merged set would be fabricated.

Concretely:

```
top_k = min(max(limit * OVERFETCH, MIN_FETCH), TOP_K_CAP)
        OVERFETCH = 4    MIN_FETCH = 20    TOP_K_CAP = 200
```

The floor is inside the formula, not beside it: `limit: 1` must fetch 20, not 4,
or a single-result recall has almost no room to survive filtering. With `limit`
clamped to `1..100` the widest request is 200 — bounded, and bounded before the
route doubles it.

**Every request pins `channel_weights: {}`.** This is not a default-ish no-op, it
is the difference between EG-1's bound holding and not. Omitting the field makes
the route fall back to the **API key's agent recall-profile weights**
(`crud.py:1369-1375`), and a zero weight disables that channel outright
(`search.py:270`). A profile that zeroes the lexical channels would silently
falsify EG-1's "still findable by new text"; one that zeroes the semantic channel
would falsify EG-2's FULL kinds. The route's own comment names `{}` as the way to
say "use channel defaults, ignore profile" (`crud.py:1370`). Compose's recall
behaviour must not depend on a per-key profile it does not manage, so the empty
dict is sent explicitly and asserted in the tests.

**The disclosed cost:** recall can return fewer than `limit` results even when
more matching records exist, if the workspace holds enough higher-scoring
non-recallable items to fill the over-fetch. This is a **quality bound, not a
correctness bug** — the alternative is unbounded fetching — and it is asserted in
the tests so a future change is a deliberate one. If a real workspace shows
starvation, the answer is the per-kind merge with a documented scoring caveat, or
a metadata filter on search (upstream ask, not filed — no evidence it is needed
yet).

## File Plan

| File | Action | Change |
|---|---|---|
| lib/fluid/provider.js | edit | Define the `RecallHit` typedef and move the `recall()` contract — hit shape, `limit` default and clamp, the `handle`-is-authority rule — onto the shared seam method, which today documents only the exception it throws. |
| lib/smartmemory-client.js | add | `searchItems()` — workspace-scoped search via `crudHeaders`. Additive; `search()` untouched. |
| lib/fluid/smartmemory-provider.js | edit | Declare `CAP.RECALL`; implement `recall()`; add `RECALLABLE_KINDS`. |
| test/smartmemory-client.test.js | edit | Extend the CRUD stub for `searchItems`. |
| test/fluid-smartmemory-provider.test.js | edit | Recall suite against the existing stub, extended to serve `/memory/search`. |

## Boundary Map

### R00: the recall contract on the seam
Produces:
  lib/fluid/provider.js → RecallHit (type)

Consumes: nothing (leaf node)

### R01: workspace-scoped search on the HTTP client
Produces:
  lib/smartmemory-client.js → searchItems (function)

Consumes: nothing (leaf node)

### R02: recall on the fluid provider
Produces:
  lib/fluid/smartmemory-provider.js → RECALLABLE_KINDS (const)

Consumes:
  from R00: lib/fluid/provider.js → RecallHit
  from R01: lib/smartmemory-client.js → searchItems

## Test strategy

Extends the existing provider stub with a `/memory/search` route. The stub
returns hits in a caller-controlled order so ranking and filtering are testable
without a real embedding model.

- `recall()` **throws `FluidCapabilityUnavailable` on the local floor** and
  succeeds here — the capability difference is the seam's whole point, and one
  test asserts both halves.
- Every recall request carries `X-Workspace-Id` (R1 — the bug this slice exists
  to avoid shipping).
- A recallable-kind hit is returned; a `cluster` and a `decision` hit are
  **dropped** even when the server returns them ranked above it (EG-2 — this is
  the enforcement assertion, and it must hold with the config dial unset).
- A non-fluid item in the same workspace is dropped (namespace filter).
- Results reconstruct records from the hit's own metadata, with no follow-up
  `getItem` call — asserted by counting stub requests (R3).
- A hit is the `{handle, score, record}` wrapper, and `record` **validates
  against `#/definitions/record`** — the assertion that would catch someone
  gluing `score` onto the record and silently breaking the contract.
- Ranking follows the server's order for the hits that survive filtering; scores
  are passed through, never recomputed, and a missing score surfaces as `null`
  rather than `0` (which would sort as a real, terrible score).
- `limit` defaults to 10, clamps to `1..100`, and tolerates garbage (`0`, `-5`,
  `"x"`, absent) by falling back to the default rather than throwing.
- Requested `top_k` is **20 at `limit: 1`** (the floor, not `4`) and never exceeds
  `TOP_K_CAP` at `limit: 100` — both ends of the formula pinned.
- **Every request carries `channel_weights: {}`** — the assertion that stops a
  per-key recall profile silently disabling the channels EG-1 and EG-2 depend on.
  Without it both bounds are unenforced and every other test here still passes.
- **Two hits sharing one handle collapse to the earliest**, by `created_at` and
  then by `item_id` — including an **equal-timestamp** case, which is the half
  that would otherwise resolve nondeterministically and disagree with `getRecord`.
- An unreadable blob in a hit is skipped, not fatal — one corrupt row must not
  break recall, matching `_fromItem`'s existing behaviour.
- **The EG-1 bound is asserted at the level it actually holds**, not the level a
  loose reading suggests: edit a record's body, and assert (a) `getRecord`
  returns the new text, (b) the stub saw `content` rewritten, (c) **no reindex
  call was made**. The test pins "we never reindex", which is the true invariant.
  It deliberately does **not** assert "the edited record is unfindable" — that
  would be false, because the lexical channels see the new text, and encoding a
  wrong bound in a test is how a wrong bound survives.

## Deferred / flagged

- **Per-item reindex** — filed upstream ([smart-memory-core#4](https://github.com/smart-memory/smart-memory-core/issues/4)). When it lands, revisit EG-1.
- **Metadata filter on search** — would remove the starvation bound. Not filed: no evidence it is needed.
- **`CHALLENGE`/`CONVICTION`/`CALIBRATION`/`CONTRADICTION`** — unchanged, still deferred past this slice.
- **Multi-slice blueprint naming** — the tooling gap disclosed at the top.
- **`decision` INDEXED vs FULL** — architecture.md's own open item. This slice implements INDEXED as ruled; flipping it later is a one-line change to `RECALLABLE_KINDS` plus a test.

## Verification Table (Phase 5)

| Ref | Claim | Result |
|---|---|---|
| `request_models.py:63` | `SearchRequest.memory_type`, single optional value | ✅ **direct** — EG-2, R2 |
| `crud.py:1384` | `memory_type` passed through to core search | ✅ **direct** — EG-2 |
| `crud.py:1350` | route over-fetches `top_k * 2` then truncates | ✅ **direct** — R4 |
| `crud.py:215-290` (`_format_memory_item`) | hits carry item_id, content, memory_type, metadata, score | ✅ **direct** — R3 |
| `pipeline/stages/crud.py:125` | sole call site of `_generate_and_store_embedding`, inside `add()` | ✅ **direct** — EG-1, upgrades FOH-1's second-hand row |
| `stages/crud.py:443-541` | update path reaches `add_node` with no embedding step | ✅ **direct** — EG-1 |
| `activation/compaction_constants.py:25`, `compaction.py:346` | `needs_reembed` has producers and no consumer | ✅ **direct** — EG-1 |
| `cli.py:205` | `rebuild` is a whole-index operator CLI command | ✅ **direct** — EG-1 |
| `secure_smart_memory.py:343` | server stamps `metadata.created_at` on add | ✅ **direct** — EG-1's rejection of re-add |
| `lib/smartmemory-client.js` `search` vs `crudHeaders` | `search()` does not send `X-Workspace-Id` | ✅ **direct** — R1 |
| `lib/fluid/provider.js:223` | `recall` calls `this.require(CAP.RECALL)` first | ✅ **direct** — R6 |
| `request_models.py:65` | `enable_hybrid` defaults True | ✅ **direct** — EG-1 correction |
| `search.py:405-416` | named channels include `contains` and `keyword-bm25` | ✅ **direct** — EG-1 correction |
| `search.py:1100-1102` | lexical channel matches `toLower(n.content) CONTAINS`, i.e. current graph content | ✅ **direct** — EG-1 correction |
| `pipeline/stages/crud.py:177-188` | `enable_<memory_type>` gates embedding for non-default types | ✅ **direct** — EG-2 positive half |
| `contracts/fluid-record.schema.json:75` | `record` is `additionalProperties: false` | ✅ **direct** — forces the hit wrapper |
| `crud.py:1369-1375` | omitted `channel_weights` falls back to the key's agent recall profile; `{}` means "use defaults, ignore profile" | ✅ **direct** — G1 |
| `search.py:270` | a zero channel weight disables that channel | ✅ **direct** — G1 |
| `search.py:173` | search hydrates hits from the live graph node | ✅ **direct** — G2 |
| `lib/fluid/smartmemory-provider.js` `updateRecord` | rewrites `metadata.fluid_record_json` on that same node | ✅ **direct** — G2 |
| `docs/features/COMP-FOH/blueprint.md` D-FOH-4 | tie-break is `created_at` then `item_id` | ✅ **direct** — G3 |
| `lib/gsd.js:78`, `staleness.js:61`, `lane-gate.js:35`, `triage.js:338`, `feature-validator.js:540` | tooling hard-codes `blueprint.md` | ✅ **direct** — naming disclosure |

**Boundary Map validation:** `ok: true, violations: 0, warnings: 0`.

**Stale references found and fixed:** 1 — FOH-1's "re-add burns a handle"
reasoning, corrected in EG-1. The conclusion (do not re-add) survives; the reason
changed, and the real reason is stronger.

## Review round 1

Codex (sol/xhigh) against r1. **Four findings, all upheld**, though two needed
reframing rather than the fix proposed. Recorded because two of them corrected
claims this document asserted confidently.

| # | Finding | Resolution in r2 |
|---|---|---|
| F1 | EG-2's "the config dial stops being load-bearing" ignores the **positive** half: `enable_fluid_idea=false` leaves ideas unembedded, so FULL is not honoured. Also, EG-2 said the query is kind-scoped while Query Strategy said unfiltered — the document contradicted itself | **UPHELD.** EG-2 split into negative (enforceable by output exclusion, holds with the dial unset) and positive (deployment dependency, not verifiable over the API). Overclaim removed, contradiction resolved by stating the query is unfiltered and enforcement is output-side |
| F2 | No-fetch reconstruction can surface a racing duplicate, so `recall()` shows one record while `getRecord(handle)` resolves another — violating D-FOH-4 | **UPHELD.** Resolved with the authority rule (`handle` is canon, `getRecord` re-reads) plus dedupe-by-handle earliest-wins within the hit set. Codex's proposed fix — resolve every hit canonically — was **not** taken: it makes recall N+1 to fix a race the authority rule already makes safe, and the same rule was needed for EG-1 regardless |
| F3 | `recall()` under-specified: no `limit` default or bounds, undefined "floor", and "full records + scores" would violate the record schema's `additionalProperties: false` | **UPHELD, and the schema point is the sharpest finding of the round.** Added the contract section: `{handle, score, record}` wrapper, `limit` default 10 clamped 1..100, explicit `OVERFETCH`/`TOP_K_CAP`/`MIN_FETCH` |
| F4 (P2) | EG-1 modelled search as embedding-only. It is **hybrid by default**, and the lexical channels read current graph `content`, which PATCH updates | **UPHELD — and it corrects us in the optimistic direction.** The bound is a stale semantic vector and skewed ranking, not "findable only by original text". The test assertion changed accordingly: it pins "we never reindex" rather than a falsifiable "the edited record is unfindable" |

**On F4.** This is the third time in this feature that a confident claim about
SmartMemory came from reading one code path and not its neighbours — after r2's
`_embed` blocker and r1's `PATCH` deep-merge. The pattern is specific enough to
name: *a mechanism's reach is not established by the function that implements it,
only by the callers that configure it.*

## Review round 2

Codex (sol/xhigh) against r2, pointed at the round-1 fixes. **Five findings, all
upheld — four of them defects the round-1 fixes introduced**, which is the
expected shape (`feedback_review_round2_targets_fixes`).

| # | Finding | Resolution in r3 |
|---|---|---|
| G1 (P1) | **EG-1's lexical guarantee was never pinned.** Omitting `channel_weights` makes the route substitute the API key's **agent recall-profile** weights (`crud.py:1369-1375`), and a zero weight disables that channel (`search.py:270`). A profile could disable the lexical channels EG-1 relies on, or the semantic channel EG-2 relies on — and every other test would still pass | **UPHELD, and the most consequential finding of either round.** Every request now pins `channel_weights: {}`, which the route's own comment names as "use channel defaults, ignore profile" (`crud.py:1370`). Asserted in the tests. Compose's recall must not depend on a per-key profile it does not manage |
| G2 (P1) | **"record AS INDEXED" describes the wrong payload.** Search hydrates hits from the live graph node (`search.py:173`), and `updateRecord` rewrites the blob on that node — so the returned record is **current**. Only the retrieval signal is stale | **UPHELD, and it corrects r2 optimistically.** The staleness is in *why a record matched and where it ranked*, never in what you receive. Rewritten, with the distinction flagged as JSDoc-bound so an implementer does not "fix" a non-problem |
| G3 (P2) | Recall's dedupe used only `created_at`, dropping D-FOH-4's `item_id` tie-break — equal timestamps would resolve nondeterministically and could disagree with `getRecord` | **UPHELD.** Both keys, plus an equal-timestamp test case |
| G4 (P2) | `top_k = min(limit * OVERFETCH, TOP_K_CAP)` yields 4 at `limit: 1`, contradicting the floor of 20 stated one sentence later | **UPHELD — the formula was simply wrong.** Now `min(max(limit * OVERFETCH, MIN_FETCH), TOP_K_CAP)`, with both ends pinned by tests |
| G5 (P2) | The section claims to define the seam contract so the next provider cannot reinvent it, then assigns the work only to `SmartMemoryFluidProvider` — leaving the shared `FluidProvider.recall` documenting just its exception | **UPHELD, and pointed.** That section invokes C12/C16 by name and then repeated their mistake. `lib/fluid/provider.js` added to the File Plan and Boundary Map as R00; the contract lands on the shared method |

**Gate call.** Two rounds, nine findings, all resolved. G3/G4/G5 are mechanical
and G1/G2 are precisely specified, so this stops here rather than spending a
third round — `REVIEW CLEAN` is a cap, not a target
(`feedback_review_loop_budget`). What earned the stop is that both P1s were
falsifiable claims about SmartMemory's behaviour that are now pinned by an
assertion, not by prose.
