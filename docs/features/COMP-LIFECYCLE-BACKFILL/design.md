# COMP-LIFECYCLE-BACKFILL: Design

**Status:** DESIGN — **STILL BLOCKED 2026-08-17. Two stratum features shipped toward it (`91a55ed`, `e01b6d7`), and the second proved the blocker is deeper than assumed: compose's CLI transport cannot carry ANY authorized guard mutation, including the override-token fallback. Owner decision required — see the two 2026-08-17 updates below.**
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

> **2026-08-17 update — constraint 2 is half resolved, and the other half is now a deliberate refusal, not a defect.**
> Stratum shipped `STRAT-GUARD-UPGRADE` (`stratum@91a55ed`,
> `stratum/docs/features/STRAT-GUARD-UPGRADE/design.md`): a new token-free,
> idempotent, additive-only `stratum_guard_upgrade` alongside the unchanged
> emergency `stratum_guard_migrate`.
>
> **What is fixed.** A policy whose checksum already matches returns
> `unchanged` and writes nothing — no ledger entry, no `graph_version` bump, no
> token. The lazy per-resource migration off the `_registered` cache path is
> therefore free in the steady state and safe to re-run after a partial batch
> failure (there is no cross-resource transaction; per-resource `flock` is all
> there is, and idempotency is what makes that acceptable).
>
> **What is NOT fixed, and why it will not be.** `guardUpgrade` freezes
> `terminal` in both directions and refuses any new edge entering or leaving a
> terminal state. Adversarial review proved the alternative is a completion
> bypass: if a token-free caller may add a terminal state, it can declare its
> own success state, reach it over a new edge whose predicates it also chose (an
> empty predicate list evaluates as met), and be COMPLETE without passing any
> gate that existed at registration — while touching no existing edge, so an
> additive classifier waves it through. Granting completability is an
> authorization decision. `complete_backfilled` **is** a completability grant.
>
> **Owner decision required before implement.** Either
> (a) accept one token-gated `guardMigrate` per resource for the one-time
> terminal grant, with the free idempotent `guardUpgrade` check on every path
> thereafter; or
> (b) file stratum work for a **server-owned upgrade descriptor** — the target
> policy must match a checksum the server was configured with rather than one
> the caller supplies, which is the general safe form of a pre-authorized
> policy change.
>
> **2026-08-17, later the same day — option (b) was built, and it exposed a
> deeper problem that blocks BOTH options.** Stratum shipped
> `STRAT-GUARD-DESCRIPTOR` (`stratum@e01b6d7`): server-owned upgrade descriptors,
> where the exact target policy is held in a file a human reviewed and whose
> sha256 is pinned in the server environment, applied by name via
> `stratum_guard_apply_upgrade`. That is the right shape and it does grant
> `complete_backfilled` legitimately.
>
> **But it is MCP-only, and compose does not talk to stratum over MCP.**
> `server/stratum-client.js` is, by its own docstring, "the ONLY module in
> compose that spawns Stratum CLI processes" — every guard call is a CLI
> subprocess. A CLI process inherits the *caller's* environment, so a CLI apply
> action would let any caller write its own descriptor file, pin its own digest,
> and mint its own authorization (with the ledger stamping `resolved_by:
> "human"` over it). Stratum therefore refused to expose one.
>
> **And the fallback was never real either.** Proving that finding turned up a
> defect in the existing system: `_checkOverrideToken` compares the supplied
> token against `process.env` *in whatever process is running*, so over the CLI a
> caller sets both sides and they match. Verified empirically against a guard
> whose only predicate could never be satisfied — the honest transition was
> `refused`, and the same walk with a self-invented token returned `deviation`
> and moved the state. So option (a) from the earlier note, "accept one
> token-gated migrate per resource", **was not an authorized path at any point**.
>
> **The decision is now a different one**, and it is bigger than this feature:
> - **(i) Trusted transport** — compose calls stratum over MCP for privileged
>   guard operations instead of spawning the CLI. Scoped to guard mutations this
>   is small; as a general transport change it is not.
> - **(ii) Signed descriptors** — authorization becomes a signature the calling
>   process cannot produce, verified against a public key checked into stratum's
>   source. Transport-independent, and it retroactively repairs the override
>   token. Stratum's design recommends this one.
>
> Compose-side work that is useful under either: generate and commit the
> descriptor file (compose owns `buildPhaseGraph`, so it can enumerate the
> distinct policies among registered guards and emit `{from_checksum, to_policy}`
> for each), and have a human review it. That is the authorization artifact
> either way.
>
> Also answered, closing open question 4 below: the ledger is append-only and
> fully preserved across a policy change; `current_state` is derived from it and
> `graph_version` entries do not advance it; there is no cross-resource
> transaction.

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

> **Closed 2026-09-05.** Stratum shipped `STRAT-GUARD-UPGRADE` (`91a55ed`), `STRAT-GUARD-DESCRIPTOR` and the signed-descriptor + `STRAT-GUARD-AUTHZ` work (`3647b4c`, 2026-08-17). The override token no longer exists. See **Revision 2026-09-05** below for the transport decision and the redo of adjudications #3, #4, #5.

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

---

# Revision 2026-09-05 — unblocked; transport, descriptors, history, idempotency, readers

Grounding: `explore-compose-2026-09-05.md` and `explore-stratum-2026-09-05.md` in this folder (two
read-only passes over compose and stratum 0.4.1, every citation below verified there this session).
Stale citations in the sections above are corrected in `explore-compose-2026-09-05.md` §13; the
prose is left as written for history.

## What stratum shipped, and what it leaves us

| Stratum capability | What it gives this feature | Where |
|---|---|---|
| `guardRegister` idempotent; **a fresh registration may carry any terminal set** | Every feature that registers after this ships gets `complete_backfilled` for free. No migration for the unregistered majority | `transition.ts:393-455` |
| `guardUpgrade` (token-free, additive, **terminal frozen**) | Not usable here — it cannot add a terminal state, by design | `transition.ts:980`, CHANGELOG `STRAT-GUARD-UPGRADE` |
| `guardApplyUpgrade(resource_id, descriptor_id)` over a **signed descriptor file** | The sanctioned way to add `complete_backfilled` to an already-registered resource. Idempotent (`unchanged` writes nothing), destination-checked before `from_checksum`, refuses with `upgrade_descriptor_mismatch` | `transition.ts:1070-1133`, `descriptors.ts` |
| Signed authorization (`sshsig`, in-source trust root `contracts/guard-signers.allowed`, ships EMPTY) | One operator signature per descriptor file; the path env var only locates the file | `trust.ts`, `sshsig.ts`, `descriptors.ts:193-227` |
| `guardMigrate` with a per-resource signed authorization bound to the ledger head | Break-glass only; one human signature per resource per attempt. Not the routine path | `transition.ts:780` |

**Measured 2026-09-05 (`explore-compose` §12):** 35 registered guard resources, all in this
workspace, all `graph_version 1`, states 31 `explore_design` / 1 `blueprint` / 3 `complete`. **All 35
policy checksums are distinct**, because the edge predicates embed the feature directory
(`server_file_exists('docs/features/<CODE>/design.md')`). So a descriptor's `from_checksum` binds to
exactly one resource: the descriptor file is **one entry per registered non-terminal resource**, not
one shared entry. The 3 resources already at `complete` need nothing.

## Decision 8: Transport — the guard stays behind the CLI; stratum gains a CLI `apply-upgrade`

The 2026-08-17 note (`c7cc848`) framed the choice as (i) compose calls stratum over MCP for
privileged guard mutations, or (ii) signed descriptors. Stratum shipped (ii). With (ii) in place, the
reason `apply-upgrade` is MCP-only is gone: `STRAT-GUARD-DESCRIPTOR` Decision 6 rested on a caller
pointing *two* env vars (path + digest pin) at a file it wrote; the pin was deleted when signing
landed, and stratum's own code says so (`descriptors.ts:20-22`: "Locating an artifact is not
authorizing it"). The residual attacks — `NODE_OPTIONS` injection into a process you already control,
or editing the committed trust root — are **identical on both surfaces**, and compose spawns the
stratum MCP server itself, so an MCP transport would not even buy the "operator-owned environment"
the restriction assumed.

Compose does already own an MCP client to stratum (`lib/stratum-mcp-client.js`, generic `#callTool`
`:517`) — the earlier claim that it does not was wrong. Using it for one guard operation would split
guard traffic across two transports for no security gain, against the module-level invariant that
`server/stratum-client.js` is the only module that spawns the stratum CLI (`:4-6`) and that the
guard is reached exclusively through it.

**Chosen:** a small stratum slice, **`STRAT-GUARD-CLI-APPLY`** (stratum 0.4.2), then compose consumes
it over the existing CLI client:

1. CLI action `guard apply-upgrade` `{resource_id, descriptor_id}` → `guardApplyUpgrade`, same
   envelope as the MCP tool. `STRAT-GUARD-DESCRIPTOR` Decision 6 is amended in place to record why
   the restriction is retired (signing made the env path non-authorizing).
2. CLI action `guard policy` `{resource_id}` → `{checksum, graph, edge_predicates, terminal, stakes,
   initial, graph_version, current_state}`. Read-only, CLI-only. Compose needs the **stored** checksum
   to fill `from_checksum`; recomputing stratum's canonical-JSON fingerprint in compose would
   duplicate `fingerprint.ts` and break silently on ordering (adjacency order is load-bearing,
   `fingerprint.ts:7-20`). `history` cannot be widened without touching the frozen MCP surface.
3. ~~Test seam via `STRATUM_GUARD_TRUST_ROOT` under `NODE_ENV=test`~~ **Withdrawn at the design gate
   (finding 1):** an env-selected trust root, however gated, lets a CLI caller set `NODE_ENV=test`
   and point at its own key — self-authorization with no code injection, the exact hole signing
   closed. Stratum ships no seam. **Compose's golden flow instead runs the real CLI from an
   isolated package copy:** copy `node_modules/@smartmemory/stratum/dist` to a temp dir, write a
   fixture trust root into that copy's **`dist/contracts/guard-signers.allowed`** — the packaged
   reader resolves `dist/contracts/…` (`prepare-dist.mjs:24` rewrites `trust.ts:23`'s path and copies
   the contracts under `dist`; the published package ships only `dist`, `package.json:19`) — point
   `COMPOSE_STRATUM_TS_CLI_BIN` at the copy's `dist/cli/stratum.js` and `$HOME` at a temp guard
   store. **The copy must be runnable (R2-7):** the CLI eagerly imports third-party packages
   (`yaml` at `cli/stratum.ts:6`), so a bare `dist` copy fails `MODULE_NOT_FOUND`. The test copies
   `package.json` + the complete `dist` tree, then symlinks `<copy>/node_modules` to the directory that
   actually resolves the real stratum's dependencies (found with
   `createRequire(<real dist path>).resolve('yaml')` and walking up to its `node_modules`), which is
   `compose/node_modules` when hoisted and `stratum/ts/node_modules` when the sibling checkout is
   symlinked. Nothing test-shaped ships in either package.

Stratum's `guardApplyUpgrade` is unchanged; the slice adds two read/apply CLI actions and nothing else.

## Decision 9: Descriptor lifecycle in compose

- **Generation:** `compose guard descriptors` (CLI, operator-facing) enumerates this workspace's
  registered resources (`resourceId()` over feature folders + `guard policy` per resource), skips
  terminal ones, and writes `.compose/guard-upgrades.json`:
  `{version:1, descriptors:[{id:"backfill-<mode>-<from_checksum[:12]>", rationale, from_checksum:<stored>, to_policy:<stored policy + node + edges>}]}`
  **deduplicated by `from_checksum`** (finding 8): a checksum binds a *policy*, not a resource —
  `fingerprint.ts:13-19` excludes resource id and workspace root, so every fix-mode bug (no
  feature-specific predicates, `lifecycle-modes.js:99`) shares one entry, and build-mode features
  get one each only because their predicates embed the folder. `to_policy` is derived from the
  **stored** policy (so the from/to pair is exact), never from a fresh `buildPhaseGraph`. Byte-stable
  (sorted ids, stratum's key order), `chmod 0600`. Authorization scope is therefore policy-wide by
  construction; that is accepted and stated, not hidden.
- **Signing is a human act, outside compose.** The operator runs
  `ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors .compose/guard-upgrades.json`
  (passphrase prompt is the point). Both `guard-upgrades.json` and `.sig` are **committed**. The
  operator's PUBLIC key is enrolled in stratum's `contracts/guard-signers.allowed` (a stratum commit
  + release; compose reads the trust root of the *installed* package).
- **Application is lazy, inside the gate.** When a backfill is requested for a registered resource
  whose policy lacks `complete_backfilled`, the gate spawns `guard apply-upgrade` with
  `STRATUM_GUARD_UPGRADE_DESCRIPTORS=<abs path of .compose/guard-upgrades.json>` in the child env.
  `unchanged` and `applied` proceed; `upgrade_descriptor_unavailable` / `_mismatch` / any error
  **refuse the backfill, fail-closed**, naming the fix (`compose guard descriptors` + re-sign). No
  batch job; the 3 `complete` resources are never touched.
- **Staleness is bounded, not chased.** A resource that registers *between* generation and this
  feature shipping gets the old graph and no descriptor; its first backfill refuses with a message
  that says to regenerate and re-sign. After ship, every new registration carries the node.
- **Unregistered features** (the ~315 majority) register fresh at first backfill with the new graph
  — no descriptor involved (`transition.ts:393-455`).

## Decision 5 (rewritten): phase history is ordered by valid time, not by phase rank

Round-2 finding #3 stands: `phaseOrder` has loops (`verification → blueprint` `lifecycle-modes.js:46`,
`test → fix` `:89`), so a phase can recur and rank-based insertion is unimplementable.

**Model.** `lifecycle.phaseHistory` is a list of **occurrences**. An occurrence is
`{phase, enteredAt, exitedAt, recordedAt, origin, confidence, evidence?, step?, from?, to?, outcome?, timestamp?}`
(legacy dual-shape fields kept; `appendPhaseHistory` `lifecycle-phase-history.js:23-44` is the sole
live writer and gains `recordedAt = enteredAt`, `origin:'live'`, `confidence: 1.0` on new writes —
**no migration of stored records**; readers treat a missing `origin` as `'live'`).

**Backfill insertion (`insertBackfilledPhases(item, occurrences)`):**

1. Each backfilled occurrence's `enteredAt` is its `evidence.observedTime` (commit author date, or
   file mtime — Decision 3/4); `recordedAt = now`, `origin:'backfill'`, `confidence` derived
   (`commit` → 0.9, `path` → 0.6; exact values live in the contract, not prose).
2. Merge live + backfilled occurrences and sort by `enteredAt`. **Closure is recomputed from valid
   time**: every occurrence's `exitedAt` = next occurrence's `enteredAt`; the last is `null` unless a
   terminal occurrence follows.
3. **Before any check (R2-4, R3-2):** an incoming occurrence whose key `(phase, evidence.ref)` already
   exists with an identical **claim** is dropped from the batch (it is the retry case); one whose key
   exists with a **different claim** refuses the batch ("occurrence already recorded with other
   evidence"). The claim is exactly `{phase, evidence.kind, evidence.ref, evidence.observedTime}` —
   never `recordedAt`, `exitedAt`, `confidence`, `episode` or any other generated/closure field,
   which a later retry legitimately regenerates. On recovery the persisted `recordedAt` is kept, not
   re-stamped. Only then:
4. Refusals (whole batch, nothing persisted):
   - an **incoming backfilled** occurrence whose `enteredAt` equals any existing or incoming
     `enteredAt` ("two phases cannot start at the same instant — cite distinct evidence"). Existing
     live ties are legal — `appendPhaseHistory` produces zero-length intervals when two transitions
     share a timestamp (`lifecycle-phase-history.js:23-43`) — and keep their **stored sequence** as
     the secondary sort key (finding 7);
   - a backfilled `enteredAt` strictly inside a **closed live** interval (that claims a phase ran while
     a live phase was known to be running);
   - a **closed live** occurrence whose `enteredAt`/`exitedAt` would change (live records are never
     rewritten; only the *open* live occurrence may be closed by a later backfilled one);
   - consecutive occurrences not transitively reachable in the mode's `BASE_TRANSITIONS`, **except
     across the adoption instant** (encodes Decision 7's "ordered by reality" without rank: gaps
     allowed, `explore_design → execute` legal, `execute → explore_design` not). **Adoption (findings 6,
     R2-6, R3-3, R3-4):** the single boundary is the *instant* `lifecycle.startedAt` — not any
     particular occurrence, because the reconciler recreates a missing first live entry with the
     current time (`reconciler.js:97`). Occurrences with `enteredAt < startedAt` are episode 1
     (pre-adoption work); those at or after it are episode 2. Reachability is not checked between the
     last episode-1 occurrence and the first episode-2 one; everywhere else it is, including into a
     reconstructed `outcome:'resumed'` entry and from live→backfill (work claimed after adoption must
     follow the adopted phase). A backfilled occurrence with `enteredAt === startedAt` is refused as
     ambiguous placement. **Out-of-graph genesis:** lifecycle start writes `explore_design` in every
     mode (`vision-routes.js:317`), which is not a node of the fix graph (`lifecycle-modes.js:83`);
     such an occurrence is an adoption marker, never a reachability source or target — the first
     in-graph occurrence after it may be any node of the mode (entering the mode's first work
     episode). The genesis entry itself is preserved as written;
   - `enteredAt <= exitedAt` violated anywhere after the merge (invariant check before persist).
5. Because step 3 runs first, re-running a batch whose occurrences already reached disk is a no-op
   rather than a tie refusal — which is what Decision 10's recovery re-drive relies on.

The pre-adoption case (backfilled occurrences earlier than the first live one) and the common
"live `explore_design` still open, work happened afterwards" case both fall out of step 2.

## Decision 10: One door — backfill is an `intent` of the completion gate

`lib/completion-gate.js` already owns the write-ahead intent (`:353-362`), the dir lock (`:283-284`),
guard-state recovery via `guardHistory` (`:306-351`) and the five writes (`:419-499`), and it already
takes an `intent` parameter (`:232`). Backfill does **not** get a sibling; it is `intent: 'backfill'`
on the same function:

- `from` = the resource's **current** guard state (read via `currentGuardState`, `:155-185`), not
  `completablePhaseOf(mode)`; `to = 'complete_backfilled'`. Both are parameterised (`:367`, `:388-389`).
  **Bootstrap for unregistered resources (R2-2):** `currentGuardState` returns `null` when no guard
  exists (`:178`), so the gate registers **first** and reads state second. The registration
  `initial` is the item's `lifecycle.currentPhase` when that is a node of the mode's graph;
  otherwise the mode's own initial state (`lifecycle-modes.js:83` — `reproduce` for fix mode, whose
  items nonetheless start at the genesis `explore_design`, `vision-routes.js:317`; stratum rejects
  an `initial` absent from the graph, `transition.ts:349`). The mapping is recorded on the batch
  record as `guard_initial: {registered, lifecycle_phase}`; the item's history is **not** relabelled.
- **Registration compatibility (finding 2).** Once `buildPhaseGraph` carries the node, a cold
  `ensureGuard` (`lifecycle-guard.js:299-323`) would send the new policy for an already-registered
  resource and stratum would refuse it as "a different policy" (`transition.ts:423-437`) — blocking
  *every* transition on legacy resources after a restart, not just backfill. So `ensureGuard`
  changes for all callers: on that refusal it calls `guard policy`; if the stored policy equals the
  new policy **under the legacy projection**, the resource is cached as `legacy` and **ordinary
  transitions proceed on the old policy** (its edges are a subset; nothing they use changed). Any
  other difference fails closed as today. **Comparison contract (R2-3):** compare exactly the four
  checksum fields `{graph, edge_predicates, terminal, stakes}` — never `initial`, `current_state`,
  `checksum` or `graph_version` (`initial` legitimately differs: registration seeds it from the
  phase at first contact, `lifecycle-guard.js:290`). The legacy projection removes
  `complete_backfilled` from `terminal`, deletes its node from `graph`, and removes it from every
  adjacency list; the comparison is object-key-order-insensitive, sorts `terminal`, and preserves
  adjacency-array order (the order stratum hashes, `fingerprint.ts:13-19`). Descriptor generation
  uses the **same four-field projection in reverse** to build `to_policy` from the stored policy;
  descriptor parsing rejects any other field (`descriptors.ts:41`). Backfill on a
  `legacy` resource then runs `apply-upgrade` per Decision 9 before its transition; refusal refuses.
- **Recovery is joined through the ledger, not the local file (finding 3).** The backfill
  transition carries `idempotency_key = operation_id`; stratum's `_maybeReplay`
  (`transition.ts:459-480`) replays an identical retry as `status:"replayed"`, and the ledger entry
  records `idempotency_key` (`store.ts:45,167`), which `guard history` returns. **Recovery re-issues
  the transition, it does not adopt a ledger entry (R2-1):** the intent persists the exact
  transition envelope `{from, to, artifacts, resolved_by, idempotency_key}`, and on recovery the
  gate sends that envelope again. Stratum's replay check compares the **payload** under the key
  (`transition.ts:459-480`): identical → `replayed`, and the gate proceeds to re-drive its writes;
  different payload under the same key → stratum refuses, so a caller who learned a pending
  `operation_id` and spent it on another payload cannot have that transition adopted. `guard
  history` is consulted only to distinguish "terminal reached under **another** key" (refuse,
  `refusedAt:'recovery'`) from "not terminal" (proceed). When neither an intent nor a finalized
  record exists for the request, recovery is **refused**: the ledger holds only a payload hash
  (`store.ts:38`) and cannot reconstruct a request. An idempotency key is correlation, not
  ownership. The intent persists the full request — `reason`, occurrence batch, `commit_sha` — plus
  `request_digest = sha256` over them; `operation_id` is minted once per `request_digest`, so an
  identical retry reuses the key and a changed request cannot resume another request's transition.
  This is why backfill, unlike live completion, does use an idempotency key: its retry is defined
  as "the same request".
- **Whole-call finalization (finding 4, R3-1).** `lifecycle.backfills[]` is keyed by `operation_id`
  and each record carries `state: 'pending' | 'finalized'`. The record is written `pending` together
  with the occurrences; it flips to `finalized` **only after** status, ROADMAP, projection and the
  audit event have all reached disk, and the intent is cleared only after that flip. The lookup
  order is therefore: `finalized` record → return it; `pending` record or intent → **resume** the
  remaining writes (never "return early"); neither → new operation or refusal per the recovery
  rule. On a resumed attempt the audit event is emitted whether or not `statusChanged` is set on
  that attempt (today's gate emits it only when the status flipped, `completion-gate.js:485`). An
  identical retry after a
  clear finds the finalized record by `request_digest` and returns it (`status:'finalized'`,
  idempotent), instead of refusing for a missing intent. **Ordering (R2-5):** for `intent:'backfill'`
  the gate canonicalises the request and computes `request_digest` first, takes the dir lock, and
  checks finalized → pending → new **before** any evidence verification; a finalized match returns
  immediately and a pending match resumes. Fresh `verifyCompletionEvidence` (`lifecycle-guard.js:199-224`,
  which runs the configured tests against the *current* workspace, `:209`) runs only for a new
  operation. This deliberately differs from live completion, which verifies evidence before the
  lock (`completion-gate.js:246`, header note 3) — a retry of a finished backfill must not be
  refused because the suite regressed later. `vision-store.js` `_save()` returns a
  boolean rather than throwing (`:131-143`); the gate treats `false` as a collected failure and
  keeps the intent.
- **Projection (finding 5).** `server/completion-projection.js:152-155` accepts only `complete`;
  it must accept `complete_backfilled` as a guarded terminal (stamping `guardState` with the actual
  state), including its reconstruction path. Added to Files/S2.
- Artifacts: `operation_id`, `request_digest`, `resolver_tags` (`late-registration+backfill`),
  `commit_sha`. The guard edge carries **no predicate**, exactly like today's
  `ship → complete` (`explore-compose` §1: only three predicates exist, all on early edges);
  stratum predicates are static statements and cannot reference per-call artifacts
  (`evidence.ts:437-441`), so reality evidence is verified by the gate's `verifyCompletionEvidence`
  (`:199-224`) and the guard's contribution is legality + the tamper-evident ledger. Stated plainly
  so nobody reads the ledger entry as a stratum-verified commit.
- Writes added to the sequence: `lifecycle.backfills[]` batch record (Decision 4) and the phase
  occurrences, both on the vision item **through the same in-process store the server uses** — the
  gate is invoked inside the compose server (MCP tool) so `vision-store.js`'s no-lock, whole-file
  save (`:131-143`) is not raced by a second process. The CLI path calls the server's route, not
  the store, for the same reason.
- `phaseToStatus` (`lifecycle-guard.js:143`) maps `complete_backfilled → COMPLETE`; `terminalOf`
  includes it for both modes; `buildPhaseGraph` adds `<every non-terminal> → complete_backfilled`.
- `set_feature_status`/`_overrideOk` (`compose-mcp-tools.js:71-75`) are **not** authorization for
  backfill and are untouched.

## Decision 11 (replaces round-2 #5): readers

The primary signal is the terminal state. Secondary: `origin`/`recordedAt` on occurrences.
- `server/decision-events-snapshot.js:48-57` and `decision-event-emit.js:64-67` carry
  `origin`, `recorded_at`, `confidence` for `phase_transition`; `contracts/comp-obs-contract.schema.json:267-268`
  opens those three optional fields (contract version bump; `additionalProperties:false` kept).
- `server/session-routes.js:248` projection and the two UI readers (`ItemDetailPanel.jsx`,
  `ContextPipelineDots.jsx`) render `origin:'backfill'` visibly (badge + muted dot); the item's phase
  label shows `complete_backfilled` as "Complete (backfilled)".
- `lib/checkpoint/reconciler.js` → `session-routes.js:156-159` (the second live writer) is
  unchanged: it appends live occurrences.

## Open questions — settled

1. **Must the vision item exist with a lifecycle?** Yes. Backfill refuses `ITEM_NOT_FOUND` naming
   `scaffold_feature`; creation stays a separate concern.
4. **What does the upgrade guarantee?** Answered by reading `guardApplyUpgrade`: ledger preserved
   (append-only, hash-chained), idempotent `unchanged`, destination-before-source check, refuses on
   mismatch, `graph_version+1`, `resolved_by:"human"` with the signer's principal + fingerprint in
   the rationale. Per-resource, so a partial fleet is safe to re-run.

## Slices

| Slice | Repo | Scope |
|---|---|---|
| S0 `STRAT-GUARD-CLI-APPLY` | stratum → 0.4.2 | `guard apply-upgrade`, `guard policy`, Decision-6 amendment, CHANGELOG |
| S1 graph + descriptors | compose | `buildPhaseGraph`/`terminalOf`/`phaseToStatus`; `compose guard descriptors`; `stratum-client.js` `guardApplyUpgrade`/`guardPolicy`; lazy apply in the gate |
| S2 gate intent + history | compose | `completionGate({intent:'backfill'})`, `insertBackfilledPhases`, evidence resolver (containment via `lib/canon-guard.js:46-95` firmlink strip + `feature-writer.js:610-641`), `backfills[]`, contracts |
| S3 surfaces + readers | compose | `POST /api/vision/items/:id/lifecycle/backfill`, MCP `backfill_completion`, snapshot/emit/schema, UI badges, CHANGELOG/README |

Tests (`~/.claude/rules/testing.md`): one golden flow that spawns the **real** stratum CLI from an
isolated package copy (fixture trust root written into the copy) against an isolated `$HOME` (this is the seam a
fake guard client hid on 2026-09-05 — `feedback_test_the_real_producer_path` instance 4); a
table-driven refusal harness (no reason, no evidence, bad SHA, path escape, tie, closed-interval
violation, unreachable pair, unsigned descriptor, mismatched descriptor, unregistered vs registered);
contract tests for the obs schema bump; unit tests for the valid-time merge only.

## Operator steps at ship (cannot be automated; called out for the owner)

1. `ssh-keygen -t ed25519 -f ~/.stratum/guard-signing -C "<who>"` (passphrase, never in ssh-agent).
2. Enrol the public key in stratum `ts/contracts/guard-signers.allowed`, commit, release, `npm install` in compose.
3. `compose guard descriptors` → sign the file → commit `.compose/guard-upgrades.json{,.sig}`.

Until step 2 lands the trust root is empty and every backfill on a **registered** resource refuses
with `upgrade_descriptor_unavailable`; backfill on unregistered features works immediately.

## Files (revised)

| File | Action | Purpose |
|---|---|---|
| stratum `ts/src/cli/guard.ts`, `ts/docs/features/STRAT-GUARD-DESCRIPTOR/design.md`, `CHANGELOG.md` | modify | S0 (no trust.ts change) |
| `server/lifecycle-guard.js` | modify | node + edges, `phaseToStatus`, `terminalOf`, lazy apply, evidence resolver |
| `server/stratum-client.js` | modify | `guardApplyUpgrade`, `guardPolicy` (CLI, stdin JSON) |
| `lib/completion-gate.js` | modify | `intent:'backfill'`, parameterised from/to, idempotency key, finalized-record lookup, added writes |
| `server/completion-projection.js` | modify | accept `complete_backfilled` as a guarded terminal (finding 5) |
| `server/lifecycle-phase-history.js` | modify | `recordedAt/origin/confidence`, `insertBackfilledPhases` |
| `server/vision-routes.js`, `server/compose-mcp-tools.js`, `bin/compose.js` | modify | route, MCP tool, `compose guard descriptors` |
| `server/decision-events-snapshot.js`, `server/decision-event-emit.js`, `contracts/comp-obs-contract.schema.json` | modify | carry origin/recorded_at/confidence |
| `contracts/lifecycle-backfill.schema.json` | new | request + batch record + occurrence |
| `src/components/ItemDetailPanel.jsx`, `ContextPipelineDots.jsx` | modify | visible backfill marking |
| `test/lifecycle-backfill.test.js` (golden + harness), `test/phase-history-merge.test.js` | new | see Tests |
| `CHANGELOG.md`, `README.md` | modify | same commit |

## Review adjudications (Codex design gate, round 3 — 2026-09-05, gpt-6-astra/high)

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| 1 | Env-selected trust root under `NODE_ENV=test` reopens self-authorization from the CLI | **CONFIRMED** (`trust.ts:26-37` draws exactly this line) | Seam withdrawn; golden flow runs the real CLI from an isolated package copy with a fixture trust root (Decision 8 §3) |
| 2 | `ensureGuard` sends the new policy first; stratum refuses existing registrations, blocking ordinary transitions after restart | **CONFIRMED** (`lifecycle-guard.js:299-313`, `transition.ts:423-437`) | Registration compatibility rule for every caller; `legacy` cache state; upgrade only on backfill (Decision 10) |
| 3 | Recovery join via `operation_id` did not exist — recovery compared only the local commit | **CONFIRMED** (`completion-gate.js:155-184`, `:322-347`) | `idempotency_key = operation_id` on the transition; recovery matches the ledger entry by key + `to_state`; request persisted with `request_digest` (Decision 10) |
| 4 | Occurrence dedup is not whole-call finalization; double-append and refuse-after-clear | **CONFIRMED** (`:501`, `:322-330`, `vision-store.js:127`) | `backfills[]` keyed by `operation_id`, skip-if-present; intent cleared last; identical retry returns the finalized record (Decision 10) |
| 5 | `completion-projection.js:152-155` accepts only `complete` | **CONFIRMED** | Module added to Files/S2; predicate widened to the guarded terminal set |
| 6 | Reachability rule refuses the pre-adoption history it promises (execute Aug → live explore_design Sep) | **CONFIRMED** (`vision-routes.js:318-330`, `lifecycle-modes.js:47-51`) | Episodes: backfill→live boundary is an adoption boundary, not checked; `episode` counter on occurrences (Decision 5) |
| 7 | Global tie refusal rejects live histories the writer already produces | **CONFIRMED** (reproduced `blueprint`→`verification` same timestamp) | Ties refused only when an incoming backfilled occurrence is involved; stored sequence is the secondary key (Decision 5) |
| 8 | `from_checksum` binds a policy, not a resource; fix-mode bugs share one checksum | **CONFIRMED** (`fingerprint.ts:13-19`) | Descriptors deduplicated by `from_checksum`; policy-wide authorization scope stated and accepted (Decision 9) |

## Review adjudications (Codex design gate, round 4 — 2026-09-05, gpt-6-astra/high, on the round-3 fixes)

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| R2-1 | Recovery by `idempotency_key` + `to_state` could adopt a different payload spent under a leaked key; ledger stores only a hash | **CONFIRMED** (`transition.ts:459`, `store.ts:38`) | Recovery re-issues the persisted envelope so stratum's replay check verifies the payload; history only detects "terminal under another key"; refuse when neither intent nor finalized record exists (Decision 10) |
| R2-2 | Fresh-registration bootstrap undefined; fix-mode items start at `explore_design`, absent from the fix graph | **CONFIRMED** (`completion-gate.js:178`, `vision-routes.js:317`, `lifecycle-modes.js:83`, `transition.ts:349`) | Register-then-read; `initial` = lifecycle phase if a graph node else the mode initial, recorded as `guard_initial` on the batch record, history not relabelled (Decision 10) |
| R2-3 | "New minus backfill node" comparison unspecified; `initial` differs legitimately | **CONFIRMED** (`lifecycle-guard.js:290`, `fingerprint.ts:13`, `descriptors.ts:41`) | Exact four-field contract + legacy projection; same projection reversed for `to_policy` (Decision 10, 9) |
| R2-4 | Dedup ran after the tie check, so a retry after partial persistence refused itself | **CONFIRMED** | Dedup/conflict check moved to step 3, before ties/intervals/reachability (Decision 5) |
| R2-5 | Finalized-record retry ran after evidence verification, so a later suite regression refused a finished request | **CONFIRMED** (`completion-gate.js:246`, `lifecycle-guard.js:209`) | Backfill ordering: digest → lock → finalized/pending → evidence only for new ops (Decision 10) |
| R2-6 | Every backfill→live boundary counted as adoption; a reconstructed `resumed` entry let `ship → execute` through | **CONFIRMED** (`reconciler.js:93`, `lifecycle-modes.js:51`) | Exactly one adoption boundary: the lifecycle-start occurrence (`from: null`, `enteredAt === startedAt`); all other boundaries checked (Decision 5) |
| R2-7 | A `dist`-only copy cannot run: CLI imports `yaml` eagerly | **CONFIRMED** (`cli/stratum.ts:6`, reproduced `MODULE_NOT_FOUND`) | Runnable copy: `package.json` + `dist` + `contracts` + `node_modules` symlink to the resolving directory (Decision 8 §3) |

## Review adjudications (Codex design gate, round 5 — 2026-09-05, gpt-6-astra/high, on the round-4 fixes)

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| R3-1 | Skip-if-present batch record + finalized-before-pending lookup returns a partially written batch as finalized; audit only on `statusChanged` | **CONFIRMED** (`completion-gate.js:485`) | `state: pending|finalized` on the batch record; finalized only after every write; pending/intent → resume; audit emitted on resume regardless (Decision 10) |
| R3-2 | Dedup equality over regenerated fields (`recordedAt`, closure) is not retry-stable | **CONFIRMED** | Equality over the immutable claim `{phase, evidence.kind, evidence.ref, observedTime}`; persisted `recordedAt` kept (Decision 5 step 3) |
| R3-3 | Fix-mode items keep an `explore_design` genesis absent from the fix graph; live→backfill reachability then refuses all fix backfills | **CONFIRMED** (`vision-routes.js:318`, `lifecycle-modes.js:83`) | Out-of-graph genesis is an adoption marker, never a reachability endpoint (Decision 5) |
| R3-4 | Anchoring adoption to an occurrence with `enteredAt === startedAt` fails when the reconciler recreated it later; blanket backfill→live exemption text still present | **CONFIRMED** (`reconciler.js:97`) | Boundary anchored to the `startedAt` instant; equal-instant backfill refused as ambiguous; blanket text replaced (Decision 5) |
| R3-5 | Fixture trust root placed at `<copy>/contracts`; the packaged reader reads `<copy>/dist/contracts` | **CONFIRMED** (`prepare-dist.mjs:24`, `package.json:19`) | Copy the complete `dist` tree and replace the trust root inside `dist/contracts` (Decision 8 §3) |

Gate closed after three rounds (8 → 7 → 5 findings, all confirmed, all folded). Per the review-budget
rule the remaining findings were spec-precision fixes whose correctness is checkable at the blueprint
gate, which re-reads this document against the code.

## Addendum 2026-09-05 (blueprint gate round 1) — recovery after a policy change

The blueprint found that stratum's replay check binds the **policy checksum** into the payload digest
(`transition.ts:131,559`), so a descriptor applied between a crash and its retry turns "replay" into
`idempotency_conflict`. Adopting the ledger entry under the key alone was already rejected (R2-1),
and the blueprint's narrower version of that was rejected again at its own gate (BP-1). Decision:

- The intent persists the resource's **policy checksum** (from `guard policy`) before the transition.
- Stratum gains a read-only CLI action **`guard digest`** `{from_state, to_state, artifacts,
  modified_files, resolved_by, policy_checksum}` → `{payload_digest, payload_digest_version}` that
  runs stratum's own `payloadDigestForVersion` (0.4.3, `STRAT-GUARD-DIGEST`). It grants nothing and
  reads no state; it exists so compose never reimplements `fingerprint.ts`/`canonical.ts`.
- On `idempotency_conflict`, recovery resumes **only if** a ledger entry under the operation's key has
  `kind:'transition'`, `outcome:'applied'`, `to_state:'complete_backfilled'`, and a `payload_digest`
  equal to `guard digest` of the persisted envelope + persisted checksum, **and** the resource's
  `current_state` is still `complete_backfilled` with no later transition entry. Anything else refuses.
