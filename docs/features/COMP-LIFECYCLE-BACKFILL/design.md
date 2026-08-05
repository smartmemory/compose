# COMP-LIFECYCLE-BACKFILL: Design

**Status:** DESIGN — **BLOCKED on a Stratum-side capability (idempotent, non-emergency guard migrate). Scope decided: fix Stratum first, then build this with no carve-out.**
**Date:** 2026-08-05
**Review:** Codex design gate round 1 — 4 must-fix, all confirmed and folded in. Round 2 — 5 more, all confirmed; two are **hard blockers** verified in stratum's source. See "Review adjudications".

> **Round 2 outcome: this design is not implementable on today's Stratum guard.** Two constraints, both verified directly in `stratum/ts/src/guard/transition.ts`:
>
> 1. **One edge, one predicate list.** `transition.ts:439` resolves predicates by `from->to` alone, so live completion and backfill completion cannot carry different predicates on `ship → complete`. The predicate DSL also cannot express a request-time condition like "a reason was supplied".
> 2. **`guardMigrate` requires the emergency override token** (`transition.ts:565`) and unconditionally increments `graph_version` (`:592`), so it is neither idempotent nor usable without the token.
>
> Constraint 2 is a design contradiction, not just an inconvenience: adding the backfill edge to already-registered features would make this feature **depend on `STRATUM_GUARD_OVERRIDE_TOKEN`, the very mechanism it exists to replace**.
>
> See "Reshape forced by the guard constraints" for the way out of (1) and the open cross-repo dependency for (2).

## Related Documents

- `docs/features/COMP-MCP-ENFORCE/design.md` — the guard this completes (Slices 1–4, the phase graph, evidence-bound completion)
- `ROADMAP.md` → `COMP-MCP-ENFORCE-XREPO` (PLANNED) — the sibling gap. Same symptom, different axis.
- `server/lifecycle-guard.js` — phase graph, `verifyCompletionEvidence`, `guardedTransition`
- `server/lifecycle-phase-history.js` — `appendPhaseHistory`, the record this feature extends
- `server/stratum-client.js` — `guardRegister`/`guardTransition` adapter; policy immutability
- `contracts/fluid-record.schema.json` — existing `provenance: {origin, recorded_at}` vocabulary

---

## Problem

The lifecycle guard enforces two different claims through one gate:

1. **Did this really ship?** A commit SHA the server verifies by reading git, plus attested tests. A claim about **reality**.
2. **Did this follow the process?** `server_file_exists` on `design.md`, `blueprint.md`, `plan.md`. A claim about **procedure**.

For work done out of band — a hotfix, a small wiring fix, work done in another tool, work predating Compose adoption on a repo — claim 1 is fully checkable and claim 2 is **false by definition**. There was no phase walk, so there is no phase-walk evidence.

Today, failing claim 2 blocks recording claim 1. The system's answer to "this shipped without a design doc" is to record that it did not ship.

**The guard exists to keep the roadmap honest, and in this case it forces the roadmap to lie.**

### Evidence

| Fact | Location |
|---|---|
| `COMPLETE`/`KILLED` are lifecycle-owned; MCP callers cannot set them under the guard | `server/compose-mcp-tools.js:64`, `:102` |
| `capabilities.guard` is **on** in this repo | `.compose/compose.json` |
| `/lifecycle/complete` requires `currentPhase === completablePhase` (`ship`) | `server/vision-routes.js:471` |
| Build-mode edge evidence: `design.md`, `blueprint.md`, `plan.md` | `lib/lifecycle-modes.js:58` |
| …enforced as `server_file_exists('<featureRelDir>/<file>')` | `server/lifecycle-guard.js:104` |
| The only escape is a global env-var bypass that also disables `force` everywhere and records nothing | `server/compose-mcp-tools.js:72` |
| A `COMPLETE` feature with no `design.md` is already a **tolerated state** (warn, not fail) | `lib/feature-validator.js:571` |
| No backfill/retroactive path exists | grepped, 2026-08-05 |

The last two rows are the crux: `COMPLETE`-without-artifacts is an accepted **state**. There is simply no legitimate **transition** into it.

### This has already cost us

`COMP-MCP-ENFORCE-XREPO` (ROADMAP.md, PLANNED) records the precedent verbatim: the STRAT-AGENT-INTERP canon backfill *"had to set status COMPLETE via direct feature.json edit because the guard path was unavailable."*

A hand-edit to canon is the exact failure mode the guard was built to prevent. When the sanctioned path cannot express a true fact, the unsanctioned path gets used — and it is strictly worse, because it leaves no record that anything unusual happened.

## Goal

A **backfill edge**: a legitimate, evidence-gated transition for work that completed out of band, which records honestly *how* the work was made rather than only *that* it landed.

**In scope**

- A backfill transition reachable from any non-terminal phase, **inside** the guard rather than around it.
- Reality evidence unchanged in strength.
- Backfill of intermediate phases, so partial walks become representable.
- A second time axis on phase history, so a recorded-late fact never reads as a live one.
- A durable audit record: reason, evidence reference, verification result.

**Not in scope**

- Storing phase history in SmartMemory through the fluid seam (Decision 6).
- Cross-repo evidence (`COMP-MCP-ENFORCE-XREPO` owns that axis).
- Any weakening of the live `/lifecycle/complete` path.

---

## Decision 1: A backfill edge, not a bypass

The alternative is the existing `STRATUM_GUARD_OVERRIDE_TOKEN`. Rejected on every axis that matters:

| | Override token | Backfill edge |
|---|---|---|
| Scope | Global; also disables `force` everywhere | One feature, one call |
| Record of what/why | None | Mandatory reason, persisted |
| Access | Server env var, out-of-band shell | Normal API/MCP call |
| Reality evidence | Bypassed entirely | Unchanged in strength |

The token remains for genuine emergencies. Backfill is for the routine case it was being misused to cover.

**Reality evidence is not weakened.** Backfill calls the same `verifyCompletionEvidence` — server-read git verification of the commit SHA, and tests attested by actually running the configured command (or an explicit `tests_pass: true`, never a silent default). The *only* thing dropped is the phase-artifact requirement, because there was no phase walk to evidence.

## Decision 2: The backfill edge lives in the guard graph, and existing resources are migrated

**This is the constraint that shapes the feature.** `guardRegister` (`server/stratum-client.js:327`) documents it: *"Re-registering an identical policy is a no-op; a different policy is rejected (use migrate)."* The graph from `buildPhaseGraph` (`server/lifecycle-guard.js:79`) is baked into an immutable registration at first use, and today it contains only forward edges, `<completable> → complete`, and `* → killed`.

So adding a backfill edge is not a code change to one function. Three options:

**(a) Backfill skips `guardedTransition`.** Rejected. It would make backfill the one lifecycle path with no ledger entry — precisely the "no record anything unusual happened" property that makes the current hand-edit workaround bad. The feature would reproduce the disease it treats.

**(b) Add the edge to `buildPhaseGraph` and let re-registration handle it.** Rejected: it does not work. Every already-registered feature has the old policy; re-registration with a different graph is *rejected*, not upgraded. Fresh features would get backfill and existing ones would 422 — the worst outcome, because it fails on exactly the historical features backfill exists for.

**(c) Add the edge to `buildPhaseGraph` AND migrate existing registrations.** Chosen. Stratum exposes a guard migration path (`stratum guard migrate`, surfaced as `stratum_guard_migrate`); the registration is versioned and existing resources move to the new policy.

Consequences to settle in blueprint:

- Migration must be **idempotent and lazy** — driven off the same `_registered` cache path (`lifecycle-guard.js:301`) so a cold server does not need a batch job.
- A migration failure must **fail closed** (refuse the backfill), consistent with the existing posture. It must not silently degrade to option (a).
- The new edge is `<any non-terminal> → complete`, guarded by a **backfill-specific edge predicate** (evidence present + reason present), not by the phase-artifact predicates.

**This is the highest-risk part of the feature** and the reason it is worth a full lifecycle rather than a quick patch: it modifies a policy that is immutable by design, for resources that already exist.

## Decision 3: Server-verified existence plus recorded caller attestation — stated honestly

An earlier draft claimed the system "never takes anyone's word for it." **That was an overclaim, and correcting it is load-bearing.**

What the server can actually verify about a piece of evidence:

- **that it exists** — a commit readable from git, or a file it can `stat`
- **when it exists from** — commit author date, or file mtime, which is what bounds valid time

What the server **cannot** verify is the *link*: that `docs/journal/2026-08-05-session-101.md` is evidence of *this feature's* `explore_design` phase. Nothing mechanical distinguishes a genuine design record from an unrelated file. The same commit could be cited for every phase.

So the honest classification: **the artifact and its date are server-verified; the claim that it evidences this phase is a caller attestation, and is recorded as one.** That is why the reason is mandatory and why the evidence reference is persisted (Decision 4) — a reader must be able to follow the citation and judge it themselves.

This is still decisively better than the override token, which records neither a citation nor a reason. But it is attestation *with verified provenance*, not proof, and the design says so rather than overselling.

**Evidence must be inside the repository.** Repo-relative regular files only; the resolved realpath must remain inside the repo root, and symlink escape is rejected. The hardened pattern already exists at `lib/feature-writer.js:555`.

> **Landmine:** on macOS, `realpath` does **not** collapse firmlinks (`/System/Volumes/Data`), so a naive containment check compares mismatched prefixes. Strip the firmlink prefix by hand, and never `resolve()` before `realpath` — resolving first can normalise away the very traversal being checked for.

## Decision 4: What is persisted

The reason and evidence must survive the request or the audit trail is a promise the record does not keep. Two levels:

**Per backfill call — a durable batch record** (`lifecycle.backfills[]`):

| Field | Purpose |
|---|---|
| `reason` | Mandatory prose. Why this skipped the process. |
| `recordedAt` | Transaction time of the backfill call. |
| `completionEvidence` | The commit SHA + test attestation result from `verifyCompletionEvidence`. |
| `guardRef` | The guard ledger entry for the transition, so the two records join. |
| `actor` | Who ran it. |

**Per backfilled phase entry** — the evidence citation:

| Field | Purpose |
|---|---|
| `evidence.kind` | `'commit'` \| `'path'` |
| `evidence.ref` | The SHA or repo-relative path, as given |
| `evidence.verifiedAt` | When the server confirmed it exists |
| `evidence.observedTime` | Commit author date or file mtime — what bounds valid time |

`confidence` is **derived from `evidence.kind`, never caller-supplied** (settles open question 2 from round 1): a caller-supplied confidence is an assertion, and the premise of this feature is verified provenance over assertion.

## Decision 5: Bitemporal phase history — insertion, closure, and readers

**`appendPhaseHistory` already records valid time.** `server/lifecycle-phase-history.js:32-43` writes `enteredAt` / `exitedAt`, with `exitedAt: null` meaning "still in this phase" — a valid-time interval with an open end, under different names.

What is missing is the second axis. Today `timestamp` is overloaded: for a live walk *when it happened* and *when it was recorded* are the same instant, so one field serves both. **Backfill is exactly the case where they diverge.**

Added per entry:

| Field | Meaning | Live walk | Backfill |
|---|---|---|---|
| `enteredAt` / `exitedAt` | Valid time (**existing**) | phase entered/left | bounded by `evidence.observedTime` |
| `recordedAt` | Transaction time (**new**) | equals `enteredAt` | when the backfill ran |
| `origin` | Provenance (**new**) | `'live'` | `'backfill'` |
| `confidence` | How tightly valid time is bounded (**new**) | `1.0` | derived from evidence kind |

**Why `confidence` rather than a `backfilled: true` boolean.** A commit SHA gives an exact author date; a file mtime gives only "no later than this". A boolean flattens that gradient; `confidence` preserves what a reader needs to judge the record, using vocabulary the sibling system already has. `origin` also aligns with `contracts/fluid-record.schema.json:70`, where Compose already carries `provenance: { origin, recorded_at }`.

### Insertion and closure

`appendPhaseHistory` appends in insertion order and closes the prior open entry at the incoming timestamp (`lifecycle-phase-history.js:27-31`). **Appending historical entries through that path can produce `exitedAt < enteredAt`** — a corrupt interval.

So backfill does not append. It **inserts by `phaseOrder` position**, and:

- closure is computed from **valid time**, not arrival order: an entry's `exitedAt` is the `enteredAt` of the next entry in phase order, or `null` if it is the last
- the result must satisfy `enteredAt <= exitedAt` for every entry, checked before persist, refused as a whole if violated
- a backfilled entry whose valid time precedes the item's existing lifecycle start is legal — that is the pre-adoption case — and must not retro-close a later live entry
- **idempotency:** re-running the same backfill must not duplicate entries. Keyed on `(phase, evidence.ref)`.

### Readers must actually show it

An earlier draft claimed back-compat was total *and* that a backfill never reads as live. **Those were in tension**: if no reader changes, no reader can show the difference.

Corrected: **stored records are back-compatible — nothing migrates, and live walks are byte-identical.** But surfacing origin is part of this feature, not a follow-up:

- `server/decision-events-snapshot.js:48` currently drops `origin`/`recordedAt` — it must carry them
- any surface rendering phase history must visibly mark a backfilled entry

A backfill that is invisible in the UI is a backfill that reads as a live walk, which is the failure this feature exists to prevent.

## Decision 6: Adopt the vocabulary, not the storage

Phase history stays in `vision-state.json`. Routing it through the fluid seam into SmartMemory would buy real bitemporal queries ("what did the roadmap claim on June 1st?"), and that is the natural direction — but it is a separate, much larger feature.

SmartMemory's `MemoryItem` (`smart-memory-core/smartmemory/models/memory_item.py:61-63`) is the reference model — `valid_start_time` / `valid_end_time` / `transaction_time`, plus `origin` and `confidence` — and it is a real surface, exposed on both the service write path (`request_models.py:206-207`) and reads (`crud.py:282-283`). Naming things its way now makes that later move a **provider swap rather than a migration**.

## Decision 7: Ordered, gap-tolerant, never fabricated

- **The forward-transition graph does not constrain what may be recorded.** `explore_design → execute` is a legal *history*, though illegal as a live transition. The live graph encodes what may happen next; history states what did happen. (The *guard* edge that authorises the backfill is Decision 2's `<any non-terminal> → complete`.)
- **Still ordered by `phaseOrder`.** `execute` cannot be recorded before `explore_design`. Ordering is a property of reality, not of process.
- **Gaps are permitted and are information.** A backfill recording `explore_design`, `execute`, `ship` and *no* `blueprint` states plainly that no blueprint phase happened. Filling that gap to make the walk look continuous is the fabrication this feature exists to prevent.

---

## Reshape forced by the guard constraints

Constraint 1 (one edge, one predicate list) kills Decision 2's "same edge, backfill-specific predicate". The way out is not a Stratum change — it is a better model that the constraint surfaced:

**Give backfilled completion its own terminal state: `complete_backfilled`.**

- It is a **different node**, so `<any non-terminal> → complete_backfilled` is a **different edge key** and carries its own predicate list. Constraint 1 dissolves.
- It is **more honest than the original design**, not a workaround. Under the field-based approach a reader had to inspect `origin` on a history entry to learn the completion came in out of band; here the terminal state itself says so, permanently and unmissably, in the one place every reader already looks.
- It removes the reader problem behind round-2 P2 almost entirely: no closed DecisionEvent metadata schema needs widening for the *primary* signal, because the signal is the state.
- Status projection (`phaseToStatus`) maps it to `COMPLETE` — the roadmap still reads COMPLETE, which is the true statement. The distinction lives in the lifecycle, which is where provenance belongs.

**Constraint 2 remains and is a genuine cross-repo dependency.** Existing features already carry an immutable registration without the new node, and `guardMigrate` is token-gated and non-idempotent. Nothing on the Compose side can work around that.

### How wide is constraint 2, actually?

Measured 2026-08-05, not assumed: **31 registered guard resources against 350 feature folders.** Registration is *lazy* — `ensureRegistered` (`lifecycle-guard.js:301`) fires on the first guarded transition, so a feature that has never transitioned has no immutable policy and would register **fresh, with whatever graph is current at that moment**. No migration.

The 31 registered are 30 at `explore_design` and 1 at `blueprint`, all `graph_version: 1`. Spot-checked by recomputing `resourceId()`: `COMP-PLAN-IDEA-UNIFY`, `COMP-FLUID-SEAM-GUARANTEES` and `COMP-LIFECYCLE-BACKFILL` are all **unregistered**.

So constraint 2 blocks roughly 9% of features, and none of the ones this feature was motivated by.

### Scope decision (owner, 2026-08-05): fix Stratum first

A Compose-only v1 covering the ~319 unregistered features was available and was **declined**. The reasoning stands on its own: shipping a completion path that silently does not work for 31 features — with no way for a caller to know which — reintroduces the class of defect this feature exists to remove. A backfill that fails on exactly the oldest features is the worst possible distribution of the gap.

So the order is:

1. **Stratum:** an idempotent, purpose-scoped guard migration. Must no-op when the target policy checksum already matches, and must not require `STRATUM_GUARD_OVERRIDE_TOKEN` — a routine policy upgrade is not an emergency deviation, and coupling them is what created the contradiction here. Owned by stratum; filed in stratum's tracker.
2. **Compose:** this feature, consuming it, with no carve-out.

Note in Stratum's favour: `guardTransition` **already supports idempotency keys** (`_maybeReplay`, `transition.ts:434`), which covers the guard half of round-2 P1d. Only the `vision-state.json` half needs a reconciliation protocol.

## Review adjudications (Codex design gate, round 2)

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | Guard cannot represent a backfill-specific predicate on `ship → complete` | **CONFIRMED** at `transition.ts:439` | Reshaped to a distinct `complete_backfilled` terminal state — see above |
| 2 | `guardMigrate` is token-gated and non-idempotent; lazy migration impossible | **CONFIRMED** at `transition.ts:565,592` | **Unresolved — hard cross-repo blocker.** Escalated |
| 3 | `phaseOrder` is not a temporal order (backward loops `verification → blueprint`, `test → fix` mean a phase can recur) | **CONFIRMED** at `lifecycle-modes.js:45,88` | Decision 5's insertion algorithm is **wrong as written**. Needs occurrence identity + a valid-time/sequence merge, not phase rank. To redo |
| 4 | No whole-call idempotency across the guard mutation and the vision-state mutation | **CONFIRMED** | Guard half is covered by `_maybeReplay`; the vision-state half needs a pending/finalized protocol joined on `guardRef`. To redo |
| 5 | Reader fix cannot carry the fields — `decision-event-emit.js:52` rejects them, `comp-obs-contract.schema.json:266` is closed to `from_phase`/`to_phase`; and "byte-identical live records" still contradicts adding fields to live entries | **CONFIRMED** | Largely dissolved by the `complete_backfilled` reshape. The residual contradiction is mine: live entries **do** gain `recordedAt`/`origin`, so the correct claim is "no migration of existing records and no reader breakage", not "byte-identical". To correct |

## Review adjudications (Codex design gate, round 1)

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | Guard policy is immutable; the backfill edge cannot be added to registered resources by re-registration | **CONFIRMED** — verified at `stratum-client.js:327` | New Decision 2: edge goes in the graph, existing registrations migrate, fail-closed |
| 2 | Reason and evidence are promised but not persisted | **CONFIRMED** — the round-1 field table held only timestamps/origin/confidence | New Decision 4: batch record + per-entry evidence citation |
| 3 | Bitemporal contract defines no insertion/closure/idempotency; readers drop `origin` | **CONFIRMED** — `lifecycle-phase-history.js:27` closes on arrival order; `decision-events-snapshot.js:48` drops the fields | Decision 5 rewritten; reader changes moved in-scope; the "back-compat is total" overclaim corrected |
| 4 | Existence is not phase attestation; the "never takes anyone's word" claim is false; path containment unspecified | **CONFIRMED** — an overclaim on my part | Decision 3 rewritten to classify honestly; containment + symlink rejection specified |

## Files

| File | Action | Purpose |
|------|--------|---------|
| `server/lifecycle-guard.js` | modify | Backfill edge in `buildPhaseGraph`; migration of existing registrations; evidence resolver (path-or-SHA, containment-checked); valid-time + confidence derivation |
| `server/lifecycle-phase-history.js` | modify | `recordedAt`/`origin`/`confidence`/`evidence`; phase-order insertion with valid-time closure |
| `server/vision-routes.js` | modify | `POST /api/vision/items/:id/lifecycle/backfill` |
| `server/decision-events-snapshot.js` | modify | Carry `origin`/`recordedAt` so backfills are visible downstream |
| `server/compose-mcp-tools.js` | modify | Expose backfill as an MCP tool — it is the sanctioned path, so agents need it |
| `contracts/*` | modify | Backfill request + batch-record contract |
| `test/lifecycle-backfill.test.js` | new | Golden flow, refusal harness, interval-invariant and idempotency tests |
| `CHANGELOG.md` | modify | Same commit as the code |

## Open Questions

1. **Does backfill require the item to already exist as a vision item with a lifecycle?** Leaning yes — creating the item is a separate concern, and conflating them makes backfill a create-or-update. Settle in blueprint.
2. ~~Should `confidence` be caller-supplied or derived?~~ **Settled:** derived from evidence kind (Decision 4).
3. ~~Does a backfilled completion still require `guardedTransition`?~~ **Settled:** yes (Decision 2, option (a) rejected).
4. **What does `stratum guard migrate` actually guarantee** — does it preserve the existing ledger, and can it fail partway across many resources? Blueprint must read the stratum implementation, not assume.
