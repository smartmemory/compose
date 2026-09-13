---
name: Dynamic Model Routing
priority: high
track: orchestration
desc: One resolver for supported agent dispatches, fed by static sources and opt-in learning from receipts joined with downstream acceptance; unsupported calls remain observable.
---

# COMP-MODEL-ROUTE — Dynamic Model Routing for Agent Dispatches

Status: PLANNED — design; not implemented or approved for implementation.
Created: 2026-09-10 (Fable design, owner-directed).
Parent phase: COMP-TEAMS (Agent Team Presets).

## Related Documents

- Roadmap row: `../../../ROADMAP.md` → COMP-MODEL-ROUTE (position 153)
- Depends on: [COMP-FABLE-ASTRA design](../COMP-FABLE-ASTRA/design.md) — profile sidecar,
  per-item tier seam and runtime fallback override; existing live-fire evidence needs
  attribution checks before it can supply eligible routing samples.
- Supersedes: [COMP-FABLE-CALIBRATE](../COMP-FABLE-CALIBRATE/) — receipt-vs-tier calibration
  becomes slice 2 here; lifecycle closure remains tracked in `progress.md`.
- Signal provider: STRAT-LEARN-COST (stratum) — model-call receipts.
- Evidence rules: STRAT-TS-LEARN (stratum) — fingerprint keys, breadth-not-volume durability,
  apply default-off. This feature reuses the rules, not the code.
- Provider axis follow-up: STRAT-AGENT-INTERP-TS (stratum) — per-item `agent` in the TS IR.
- Prior art in the ideabox: E3 complexity-aware execution (`reference_e3_complexity_aware`).
- [Round-1 review](reports/design-review-r1.md) and [controller rulings](progress.md).

---

## Problem

Agent models come from preset profiles, runtime fallback overrides and planner item tiers.
No component records the answer to “which tier should this dispatch use” together with
its eventual acceptance and attributable cost. Current snapshots are not a historical
outcome ledger: revise deletes attempts, accepted tokens, output and fanout state
(`../stratum/ts/src/engine/engine.ts:2805–2837`). Receipts alone do not restore item identity.

The consequence is two-sided waste: expensive tiers on work a cheaper tier handles, and
cheap tiers on work that then needs repair. Learning requires durable dispatch bindings,
receipt joins and downstream dispositions before either claim can be measured.

## Goal

**One routing framework, many value sources.** Ordinary agent steps and single-stage
consumer fanouts use one resolver. Most keys stay static; learning is opt-in per key.
The selected tier, source and reason are recorded before each supported issuance runs.
Engine fanouts, multi-stage fanouts and normalization subcalls are observed as unsupported.

```
static baseline = item.tier where configured, else manual fallback → preset → spec default
eligible learned / trial / exploration choice → repair admission constraint → recorded route
```

**Self-learning, not failure-based.** Learned choices use frozen cross-run evidence before
admission. A failure is evidence, not a retry escalation trigger. The repair minimum is an
explicit admission constraint on lineage, separate from that learning policy.

**In scope (v1)**
- Statistical keys, dispatch identities, resolver, immutable start record and issuance journal.
- Append-only routing ledger with receipt attribution and downstream outcome capture.
- Shadow observation throughout participating Build and GSD runs, with unsupported rows.
- Hindsight report, separately gated planner feedback, and recorded cold-start trials.
- Active learning on `plan` and `execute` in `team-fable-astra`, after evidence-based promotion.

**Not in scope**
- Provider switching, engine/multi-stage fanout routing, or normalization-subcall routing.
- Claude Code's own `Agent` tool and hand-made `stratum_agent_run` calls outside the pipeline.
- Cross-project learning or SmartMemory egress; the ledger is per project.
- Force overrides. Manual continues to replace the fallback; a force mode is a follow-up.
- Stratum API changes. Compose must build the joins and persistence on its existing surfaces.

---

## Decision 1: Statistical key and dispatch-instance identity

The **statistical key** groups comparable observations; it does not identify a dispatch.

| Part | Source | Why it is in the key |
|---|---|---|
| `preset` | selected sidecar identity | Presets assign different work to the same step |
| `step` | scoped step id plus stage | Preserve scope and stage even for unsupported observations |
| `provider` | resolved stage agent | Tiers and candidate sets are provider-specific |
| `template` | resolved template or empty | Reviewer and implementer work must not pool |
| `prior` | original planner item tier, else original preset/spec tier | Condition on the prior, before manual or learned selection |
| `fingerprint` | canonical output-contract options/paths | Contract changes split evidence; unrelated spec edits do not |

Pin the fingerprint algorithm/schema version in the start record. Workspace root, run id,
spec digest and task text are not statistical key parts. Workspace is a breadth dimension;
run/spec identity remains in the record. Keep `template`: the four bundled profile maps
currently do not reuse a step id with different templates; future/custom profiles may.
Rejected: task-text embeddings without labelled volume; revisit after ≥50 real builds.

The **record id** is run + scoped step/stage + epoch + item/generation + issuance token.
Ordinary steps use explicit null item/generation fields. The statistical key is a field
inside each record. Retries in the same epoch receive separate issuance identities;
two same-key items do not collide. Existing consumer bindings use `dispatchToken`
(`lib/build.js:901–909`); this feature extends recording to every participating issuance.

Route metadata receipts use `compose:route:<runId>:<issuanceToken>`; unsupported subcall
observations include a distinct call suffix and parent record id. Per-key recommendations
may be shared; records and receipts never are. Materialize ledger samples idempotently by
record id, not by key or epoch. Restart must not create another statistical observation.

## Decision 2: Value sources and manual fallback semantics

First construct the static baseline with today's profile semantics. `mergeRuntimeProfiles`
replaces `default` while preserving `tier_from`; `resolveConsumerProfile` then chooses
`item.tier` ahead of that fallback (`lib/pipeline-profiles.js:128–149`). For example, manual
`execute=codex:implementer:fast` plus a critical item still resolves critical. V1 keeps this.

1. **manual** wins when the overridden fallback is used. On a `tier_from` item with a tier,
   record `source:'preset'`, `via:'item.tier'`, plus the manual fallback provenance.
2. **learned** can replace an eligible static baseline only in active mode with durable
   evidence and `route.learn`. Manual-overridden keys are excluded from learning selection,
   trials and exploration; this exclusion does not force the manual tier onto an item.
3. **preset** supplies the item tier or sidecar fallback when neither eligible choice wins.
4. **default** supplies the stage's literal spec agent when there is no profile entry.

Keep original profiles, explicit runtime overrides and winner provenance in the start
record; the merged map loses the distinction. Runtime overrides cannot change routing
policy. `route` will be validated alongside `tier_from`; unknown fields remain errors.

```json
"execute": { "default": "codex:implementer:critical", "tier_from": "item.tier",
             "route": { "learn": true } },
"plan":    { "default": "claude:orchestrator:coordinator", "route": { "learn": true } },
"verify":  "claude:orchestrator:standard"
```

String entries are static. The bundled preset opts in only `plan` and `execute`.
Learned per-item choices go into a **separate stage-aware resolved-route map**, consulted
at admission after baseline resolution. They do not replace `default`, where `item.tier`
would override them. The profile map continues to use real parent step ids; `execute/0`
is not a valid runtime profile key (`lib/pipeline-profiles.js:73–95`).

## Decision 3: Immutable start record and recorded-input lifecycle

Before calling Stratum plan, mint a Compose routing start id and deterministic random seed.
Persist immutable `.compose/routing/starts/<startId>/routing-start.json`, containing:

- Routing schema/policy versions, mode, tolerance, candidate ladders, exploration and trials.
- Frozen evidence table contents, its version/content digest and ledger cutoff; a version
  pointer without retained contents is insufficient. Never consult the live ledger on resume.
- Original static resolutions, manual provenance, frozen ordinary initial candidates and profile
  digest; provider/model mappings and contract fingerprints used to validate those resolutions.
- Exact calibration feedback flag/string and cohort label, even when the string is empty.
- Spec/input identity and a root digest over this record's canonical payload.

Adapt validated ordinary initial candidates into effective agent profiles before preflight;
these are not admitted routes. Preserve provider/template and static provenance. Consumer
item decisions wait for wave admission. Current preflight hashes `{normalized, resolved,
overrides}` only (`lib/pipeline-profiles.js:179–199`); a new flow input is not automatically
covered by that hash. The immutable routing root digest binds the additional policy/evidence.

Fresh Build and GSD input handling must carry the start record and root digest into the
recorded flow input, with declared input contracts; custom specs must declare these to participate.
Build currently sends a fixed envelope (`lib/build.js:6439–6444`). Stratum mints its run id inside plan
(`../stratum/ts/src/engine/engine.ts:578–579`), so the routing seed cannot depend on that id.
After plan, durably bind the returned run/revision to the start id before Compose dispatch.
Build resume validates that binding and input, not current flags or freshly merged roles.
Ordinary initial allocation identity is start id + scoped step/stage; draws use the pinned
seed. Ordinary admission identity is start id + scoped step/stage + logical wave id + logical
epoch (null task id). Before each new epoch's call, check recorded repair context; suppress
ineligible trial/exploration candidates to the static baseline, then apply any repair floor
under Decision 7 (refuse a below-floor proposal, never clamp). Append candidate, context,
proposal and admitted route/refusal to the root-bound journal; change neither start nor
profile digest. Ordinary dispatch consumes this entry through the separate route map.
Same-epoch retries and resume reuse it byte-for-byte; real redispatches get new issuance records.
Consumer allocation identity is start id + scoped step/stage + logical wave id + logical
task id (the planner's stable task id), never array index or engine-run id. Draw at admission
from that identity and seed, once the planner prior and item binding are known.

**GSD resume is a recorded continuation sharing the original start root. Resuming the
original engine run is NOT the chosen design.** Today its resume branch loads a filtered
graph (`lib/gsd.js:112–115,1300–1320`), still calls plan (:294–304), and supplies that graph
as decompose output (:599–603). Each plan mints a new run id
(`../stratum/ts/src/engine/engine.ts:578`). Participating continuation must:

- Validate the original root and reconcile uncertain prior calls before continuing; unresolved
  settlement blocks redispatch, never implies permission to rerun or evidence of acceptance.
- Persist a continuation intent before plan: original/filtered graphs and digests, completed
  task ids, removed dependencies, and original/filtered index mappings to logical task/wave
  identities and prior logical epochs. Filtering preserves wave identity; a genuine new wave gets a recorded
  new id. Engine epochs map to logical epochs; restarting engine counters does not reset them.
- Bind the returned new engine run/revision to the old run, continuation intent and original
  start/root before dispatch. Recover a missing/uncertain plan binding before another plan.
- Carry decisions by logical task id + logical wave id through the persisted transformation,
  including B moving from index 1 to 0. Real redispatches use new engine tokens and issuance
  records linked to prior records; completed tasks retain their earlier outcomes. Ambiguous
  logical identity or transformation refuses continuation.

All continuation runs share one logical start: at most one breadth vote per eligible cell.

Later waves and ordinary epochs append immutable journal entries bound to this root,
recorded wave input digest/provenance, epoch and issuance identity. They do **not** mutate start input or
the pinned profile digest. Resolve unseen waves from the pinned table and seed; reuse
existing decisions byte-for-byte. “Replay” means route/input identity, not identical model output.

Persist admission and issuance records before any supported model call; S1b adds pending
metadata receipt intents before launch. Persist gate disposition and prior-wave bindings
before a revise can reset them. Recovery flushes existing receipt intents and reconciles the
engine issuance token before dispatch; a call with uncertain completion is never silently
rerun under its old identity. Missing/drifted start records, bindings or expected entries
fail closed for every participating run, including ordinary-step-only runs and GSD.
An unseen issuance may create an entry only from validated recorded state and the pinned root.

These are new guarantees. `PROFILE_SIDECAR_REQUIRED` checks missing adjacent configuration
for known bundled basenames (`lib/build.js:1530–1549`), not general resume drift. Current
profile pins are conditional on wave profiles (`lib/build.js:3812–3823`), and consumer
bindings reject changed digests (`lib/consumer-fanout.js:691–704`). Neither is a routing root.

## Decision 4: Supported dispatch boundary

| Dispatch | V1 behavior |
|---|---|
| Ordinary agent step, including retries | Resolve and record each issuance; active only if opted in |
| Single-stage consumer fanout, including GSD | Whole-wave admission plus per-issuance stage-aware route binding |
| Engine-dispatched fanout | `source:'unsupported'`; observe available engine evidence, never route |
| Multi-stage fanout | `source:'unsupported'` per observable stage/issuance; preserve existing validation |
| Normalization primary call | Joined to its owning ordinary/consumer issuance |
| Normalization repair subcall | Separate `source:'unsupported'` observation joined to its parent; never independently route |
| Non-agent gates / intercepted operations | Disposition events where relevant, no invented model dispatch |

Broaden `admitConsumerWave` and its Build/GSD entry conditions for routing participation,
including fanouts with neither `tier_from` nor `_consumer`. Today they return/skip admission
(`lib/build.js:815,1057–1062`; `lib/gsd.js:524–526`). Add ordinary-step issuance hooks too.
Unsupported observations are excluded from learned cells. Where engine evidence lacks an
issuance token, use a namespaced receipt-based observational identity, mark it incomplete,
and never invent a routable issuance. All-step coverage means explicit supported/unsupported
accounting, not a guarantee that every engine call exposes complete attribution.

Engine fanouts cannot apply Compose tiers (`lib/build.js:1613–1617`). Different stage agents
under one parent profile can fail current preflight (`lib/build.js:1634–1654`); this feature
keeps those refusals. A stage-aware route map does not authorize multi-stage routing in v1.

## Decision 5: Receipt joins and complete cost evidence

Compose will durably join each routing issuance to **every actual model-call dispatch id**:
primary, failure/cancellation usage, and successful or failed normalization-repair calls.
The mapping retains run, scoped step, item index, stage, generation, epoch, issuance token,
root digest and original item binding. Persist call intent before launch, then bind the
returned/error dispatch id before settlement or receipt delivery. An unresolved call intent
is incomplete evidence after recovery; a fabricated id must not stand in for a missing id.

Consumer `flow.itemIndex` tags support cancellation (`lib/build.js:1263–1268`). Usage is
forwarded with the parent step id (`lib/build.js:1352–1357`); `reportUsageReceipts` does not
copy the item binding (`lib/build.js:1741–1765`). Stratum's receipt input has `detail`, not
`flow` (`../stratum/ts/src/engine/receipts.ts:4–14`). Store the original join under a distinct
`detail.routing` namespace so current-state receipt enrichment cannot overwrite it.
Item-qualified lookup alone cannot recover a binding deleted by reset.

Extend `result-normalizer.js` with per-call intent/completion/error hooks for MCP and local
SDK paths; retain every repair call id even when its output is not credited. Those paths
currently branch at `lib/result-normalizer.js:570–599,777–805`. Persist the join and pending
receipt payload through the Compose journal; identical redelivery deduplicates and changed
payloads refuse (`lib/consumer-fanout.js:710–721`). Late receipts use the original binding.

Ledger rows contain attributed tokens, duration, USD and provenance, plus completeness.
Missing attribution or cost means **incomplete, excluded** — never pooled or zero-filled.
This follows the strict cost-evidence stance of `readFlowSpend` (`lib/flow-state.js:57–73`).
A parent's learning cost includes its normalization repairs; child observations remain
unsupported and are not counted again in ledger-wide receipt totals. Count each paid id
once; zero-usage routing metadata is separate. Cost reconciliation reports excluded spend.

## Decision 6: Downstream acceptance and wave lineage

Capture the full per-wave item list, task ids, item digests, index/generation/stage, chosen
and actually executed tiers, issuance/accepted tokens and statuses before reset. At each
gate, persist its token, validated action, findings/dispositions and task lineage together
with the pre-reset snapshot, then reconcile the acknowledged gate transition on recovery.
`readFlowSnapshot` only returns current state (`lib/flow-state.js:40–51`); history capture is new.
Derive executed tier from joined primary-call model/effort and the pinned provider mapping;
missing or conflicting execution evidence cannot certify a repair floor.

Lineage references earlier task/issuance records, not re-used array indices. Record affected,
retained and added tasks from validated gate evidence; if identifiers/ownership cannot
establish an unambiguous mapping, use unknown/censored rather than infer acceptance.
The ledger retains these dispositions, with one final classification per issuance:

| Label | Derivation | Binary disposition |
|---|---|---|
| `accepted` | Successful status and matching `acceptedDispatchToken`, plus downstream acceptance/retention with no later superseding disposition | Positive |
| `repaired` | Gate identifies defective work and links replacement repair work | Negative |
| `re-implemented` | Non-defect additional implementation supersedes this work | Excluded/censored |
| `retried-same-epoch` | Another issuance retries the same work without an epoch change; retain failure details if any | Negative, even without failure: work did not stick |
| `failed-or-cancelled` | Confirmed cancellation, or failure without an adjudicated replacement classification; retain cause | Failure negative; confirmed cancellation excluded/censored |
| `unknown` (censored) | Missing lineage, unadjudicated outcome, uncertain settlement or unresolved failure/cancellation cause | Excluded/censored |

Keep local contract success separately. Engine state names successful issuances using
status and `acceptedDispatchToken` (`../stratum/ts/src/engine/state.ts:51–65,173–189`).
An omitted epoch means 0; final epoch checks freshness only. In wave 0 `[A,B]` then repair
wave 1 `[B]`, A can remain accepted and B's old issuance is repaired; new B at index 0 is
not A. An `implement` action adding C does not automatically reject retained A/B.

Define ONE **acceptance-eligible population**: supported issuances with complete attribution
and cost (Decision 5), in the declared key/tier/cohort and source stratum, with a final binary
label above. Confirmed cancellation retains `failed-or-cancelled` and is always censored,
even if later work replaces it; other labels classify non-cancelled issuances.
Every acceptance denominator, paired policy cost comparison, durability count and breadth
vote uses this population. Report all-observation cost, incomplete and censoring totals
separately. Terminal flow success never grants blanket acceptance; ordinary steps need
downstream evidence too.

Append `.compose/routing/ledger.jsonl` at terminal/reconciled outcome, keyed by record id. A late
receipt may append an idempotent completion revision under the same id; table recomputation
selects one latest validated version, never another sample. Preserve raw journal evidence.

## Decision 7: Repair floor is an admission constraint

The existing preset requests non-lowering repair tiers (`presets/team-fable-astra.stratum.yaml:206–208`),
but validation checks shape/ownership, not prior tier (`lib/output-gate.js:12–39`;
`lib/pipeline-profiles.js:151–171`). S1b records the required history; S3 adds enforcement.

For participating runs, resolve each repair task to earlier executed task records. The
floor is the **tier that actually executed**, not the planner's estimate or static fallback.
For an explicitly linked many-task repair, use the highest comparable executed tier;
missing, ambiguous, cross-provider or unordered floor evidence refuses admission.
Validate lineage in `output-gate.js` before revise, and recheck the bound floor at admission.

Apply the floor after **every** source, including manual fallback, learned, trial, preset
and spec default. Reject a proposed route below the floor; do not silently clamp its source
or rely only on exploration exclusion. Record floor, lineage, proposal and refusal reason.
Off mode retains its legacy path; shadow/active participation gains this new admission rail.

## Decision 8: Evidence policy, cold-start trials and exploration

Recompute the table when creating a start record; freeze it for that logical start.
Use ONLY Decision 6's acceptance-eligible population per key/tier/cohort and source stratum
for distinct logical starts, start/step pairs, workspaces, dispatches, accepted fraction and
mean attributed cost/tokens. Durable cells require ≥3 logical starts, ≥5 eligible dispatches
and ≥2 workspaces represented by eligible outcomes. One logical start contributes one breadth
vote, including all GSD continuations; volume cannot substitute for breadth. Keep static/
calibration-influenced cohorts separate. All-observation cost and censoring totals cannot qualify cells.

Active policy chooses the cheapest observed tier within `tolerance` (default 0.05) of the
best observed acceptance, with durable comparable cells for both alternatives and baseline;
both acceptance and cost use the same eligible rows within each compared cell.
Ties/insufficient evidence retain the static baseline. Never compare across planner priors;
a critical-prior downgrade needs cheaper-tier observations in that same critical-prior cell.
The repair constraint still applies after selection. Report observational comparisons as such.

**Cold start:** static shadow alone cannot establish cheaper-tier acceptance. Add explicit,
authorized, recorded `route_trials`: per-key alternate tiers and a bounded fraction (default
0, hard cap 0.2). In shadow, eligible opted-in keys can run `source:'trial'` before durability,
while retaining their original prior and static recommendation. Trials require this input;
a request for shadow alone does not authorize alternate-tier calls. Pin allocation in the
start record and each issuance. Unobserved acceptance and savings remain **unknown**.

Provider ladders are explicit policy, not an ordering of all tier names: Codex and Claude
each use `fast < standard < critical`; Claude `coordinator` is a separate Fable candidate,
not a rung (`server/model-tiers.js:13–24`). A coordinator-prior plan requires an explicitly
listed same-provider alternate trial; no automatic “one below coordinator” exists.

In active mode, `route_explore` (default 0.05, hard cap 0.2) may sample one valid lower rung
from a durable policy choice, `source:'explore'`. Insufficient durability falls back to
static without automatic exploration; cold start uses trials. Trials/exploration exclude
manual-overridden keys, repair waves, `_costCeiling.gates` and `assess` (ship input), plus
unsupported or non-opted-in dispatches. Draws use Decision 3's allocation identities and seed,
never issuance tokens. Each new ordinary epoch checks recorded eligibility and admits its
candidate separately; retries/continuations reuse the entry, including any suppression.

## Decision 9: Modes and the promotion ladder

| Mode | Dispatch and records |
|---|---|
| `off` | Legacy profiles, inputs and dispatch behavior; no routing ledger writes |
| `shadow` | Record static winner and `would:` recommendation; explicit trials may change tier |
| `active` | Durable learned choices on opted-in supported keys; bounded exploration |

The bundled preset ships shadow. Baseline shadow has trials and planner feedback off;
routing observation adds no prompt/model change. Admission failures remain possible under
the new persistence requirements and, from S3, the repair rail. Trial and feedback runs
are labelled interventions, not baseline shadow. Off bypasses new routing fields/digests.

Promotion of `team-fable-astra` plan/execute needs ≥10 real baseline shadow builds plus
comparable alternate-tier trial evidence clearing durability for every changed key, acceptance
within tolerance and observed-comparison savings ≥15% of those keys' spend. Unobserved
counterfactuals cannot satisfy the gate. Record report, cohorts and authorization in this
feature's `progress.md`; promotion is a separate preset change with a CHANGELOG entry.

## Decision 10: Hindsight report and separately gated calibration feedback

`compose route report [--preset <team>]` prints static/learned choices, observed per-tier
acceptance/cost, completeness, censoring and trial allocation. Label cohorts **static** or
**calibration-influenced**, with baseline/trial/exploration source breakdowns; do not pool
feedback interventions into the baseline promotion comparison. Unsupported rows stay visible.
Planner tier-miss reporting requires supported comparable observations; unknown is not a miss.

S2 also offers `calibration_feedback`, default **off** for shadow baseline and independently
recorded from `route_mode`. When enabled, derive `calibration` from the pinned table, capped
at top 10 keys by spend, one line each and 4 KiB UTF-8 total with deterministic truncation.
Store its exact bytes in the start input, including an empty string when disabled. Resume
never regenerates it. The planner output contract stays unchanged; input/prompt wiring changes.
Feedback can change task lists, priors and spend even in shadow, so it requires its own opt-in.

## Decision 11: Ownership and boundaries

Compose owns resolution, durable joins and acceptance derivation; Stratum transports receipts
and flow state. `lib/model-router.js` remains pure (`dispatchKey`, `resolveRoute`, `routingTable`);
`lib/routing-ledger.js` owns start/ledger persistence. Extend the existing consumer journal in
`lib/consumer-fanout.js` for immutable admissions, call joins and receipt intents. Build/GSD
coordinate issuance, gate capture and recovery; `flow-state.js` supplies strict snapshot reads
and outcome derivation helpers. This spans more than two call sites and changes internal shapes.

---

## Slices

**S1a — Recorded routing lifecycle and recovery.** Validate policy; implement start/schema/root,
statistical and logical identities, immutable decision/issuance journal, per-epoch ordinary
admission and broadened consumer admission. Implement Build replay and GSD continuation links,
filtered-graph persistence and uncertain-issuance reconciliation. Pin off-mode byte identity;
reserve feedback fields as disabled/empty. No complete shadow-sample claim in this slice.

**Configuration (added 2026-09-13).** Mode precedence is `--route-mode` flag >
`.compose/compose.json#routing.mode` > preset `_routing.mode` > `off`, resolved once in
`routingOptionsFor`, which both Build and GSD call. The project-config term exists because
without it no ordinary run could record: the default is `off`, there was no CLI flag, and the
only shipped `_routing` setting was the `team-fable-astra` preset — so the shadow corpus that
S2's report and Decision 7's Q3 ruling both consume was never written outside tests. Only `off`
and `shadow` are accepted; anything else is refused by name at the resolver. Refusal semantics are
unchanged by this: a `ROUTING_*` integrity error still refuses the run per the S1a criteria, and
the CLI surfaces the code plus both ways to switch the observation off.

**S1b — Attributable shadow outcomes (depends on S1a).** Add primary/failure/normalization
call hooks, joins and receipt intents; capture pre-reset gate/task bindings and accepted
tokens. Derive acceptance and unsupported observations; implement idempotent ledger and
receipt recovery. First slice allowed to claim complete attributable shadow samples.

**S2 — Hindsight report + separately gated calibration feedback (depends on S1b).** Implement the report and
unknown/censored/cohort accounting. Add default-off feedback with exact immutable prompt input
and deterministic cap. Absorbs COMP-FABLE-CALIBRATE; feedback is a distinct intervention.

**S3 — Active routing, cold-start trials, exploration, repair floor (depends on S1b).** Implement durable policy,
explicit shadow trials, provider ladders, source exclusions and deterministic allocation.
Validate lineage-based executed-tier floors after all sources at Build/GSD admission, with
output-gate pre-reset validation. Preset stays shadow; evidence and authorization precede promotion.

**Follow-ups (not built):** distinct recorded force override; provider axis after
STRAT-AGENT-INTERP-TS; engine/multi-stage fanout and normalization-subcall routing;
SmartMemory egress/cross-project learning; hand dispatches outside a pipeline.

## Completion evidence

- [x] Off-mode golden pins 0.5.1 profile digest and legacy input/dispatch bytes; no routing writes. Receipts: `test/build-team-fable-astra.test.js:47`, `test/integration/build-wave-golden.test.js:268`, `test/integration/gsd-route-continuation-golden.test.js:204`.
- [ ] Manual fast fallback + critical item still dispatches critical; provenance identifies both.
- [ ] Same-key items, same-epoch retries and different stages produce distinct record/receipt ids.
- [ ] Fresh/resume Build and GSD pin identical start bytes; ledger edits cannot affect unseen waves.
- [ ] GSD B index 1→0 preserves logical task/wave allocation; old→new run/graph links persist, redispatch ids differ, uncertain calls block.
- [ ] Ordinary repair epochs suppress trial/explore to baseline + floor; retry/resume reuses the entry without start/profile digest changes.
- [ ] Missing/drifted roots or issuance bindings refuse even ordinary-only runs; crash recovery reuses intents.
- [ ] Route-only fanout with no `tier_from`/`_consumer` enters admission in both Build and GSD.
- [ ] Stage-aware learned item route beats static item tier without changing the profile-map default.
- [ ] Engine/multi-stage/subcall fixtures emit unsupported observations and never receive routed tiers.
- [ ] Primary, failed and normalization-repair receipt ids join correctly after reset and late delivery.
- [ ] Missing id/cost rows are excluded; parent/child cost reconciliation counts each paid receipt once.
- [ ] `[A,B]` then repair `[B]` keeps A accepted; added implement work does not reject retained tasks.
- [ ] Retry, cancellation, unmatched token and missing lineage fixtures produce the specified outcome labels.
- [ ] Repeated terminal materialization and late-receipt completion retain one sample per record id.
- [ ] Executed-tier repair floors reject lower manual/learned/preset routes and absent/ambiguous lineage.
- [ ] Durability refuses 5 eligible calls in 1 logical start; accepts 5 across 3 starts/2 workspaces; parity stays within prior/cohort.
- [ ] Four censored + one accepted cannot qualify; cancellations add no breadth, same-epoch retries are negative, GSD continuations vote once.
- [ ] Acceptance and policy cost use identical eligible rows; all-observation spend/censoring totals stay separate from durability.
- [ ] Authorized shadow trials populate an alternate same-prior cell before durability; unobserved report cells stay unknown.
- [ ] Trials/exploration honor exclusions and caps; coordinator has no implicit lower rung; draws replay identically.
- [ ] Feedback-off shadow preserves plan prompt; enabled feedback is capped, byte-pinned and cohort-labelled on resume.
- [ ] Seeded report matches hand calculations; only plan/execute learn in the bundled preset; promotion rejects missing evidence.
- [ ] Live-fire shadow build yields a nonempty ledger with complete plus excluded cost reconciled to unique receipt totals.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/model-router.js` | new | Pure keys, resolution, evidence policy, provider ladders and deterministic allocation |
| `lib/routing-ledger.js` | new | Start roots, continuation links/graph transformations, logical identity, ledger revisions and idempotent materialization |
| `lib/pipeline-profiles.js` | existing | Policy/provenance, frozen candidates, ordinary/consumer admitted route map and floor checks |
| `lib/build.js` | existing | Fresh/resume inputs, per-epoch ordinary decisions/issuance, broader admission, joins and pre-reset capture |
| `lib/gsd.js` | existing | Shared-root continuation, filtered-graph/identity mapping, prior-call reconciliation, ordinary/consumer admission and gate capture |
| `lib/consumer-fanout.js` | existing | Immutable route/binding journal, model-call join, receipt ids/intents and recovery |
| `lib/result-normalizer.js` | existing | Primary/local/MCP/repair call hooks, including failure ids and uncredited repair usage |
| `lib/flow-state.js` | existing | Strict snapshot access and disposition/token/lineage outcome derivation |
| `lib/output-gate.js` | existing | Validate repair lineage and executed-tier floor before revise |
| `presets/team-fable-astra.profiles.json` | existing | Opt plan/execute into learning |
| `presets/team-fable-astra.stratum.yaml` | existing | Routing/start/trial/feedback input declarations and optional calibration prompt |
| `pipelines/gsd.stratum.yaml` | existing | Declare participating GSD routing/start inputs |
| `bin/compose.js` / `lib/route-report.js` | existing / new | CLI and eligible-population comparisons/breadth, separate all-observation cost/censoring |
| `contracts/routing-start.schema.json` | new | Immutable start/input schema and provenance |
| `contracts/routing-record.schema.json` | new | Continuation/graph links, logical allocation/epoch admission, issuance and versioned ledger rows |
| `contracts/routing-join.schema.json` | new | Call intent, receipt join and original binding schema |
| `contracts/routing-outcome.schema.json` | new | Gate disposition, accepted token and task lineage schema |
| `test/build-model-route.test.js` / `test/gsd-model-route.test.js` | new | Continuation identity/recovery, epoch admission, joins, labels, route-map and floor probes |
| `test/route-report.test.js` | new | Eligible-population durability, continuation breadth, cost/censoring and feedback byte/cap probes |
| `test/integration/build-wave-golden.test.js` | existing | Off identity and shadow/reset/recovery evidence |

## Open Questions

None blocking this revision. Template stays in the key; receipt attribution uses the explicit
join in Decision 5; calibration is capped and separately gated in Decision 10.

## Review log

Round 1, Codex gpt-6-astra/high, 2026-09-10. Nine findings, all accepted; rulings in progress.md.
Round 2, Codex gpt-6-astra/high, 2026-09-10. One HIGH (GSD continuation), two MEDIUM; all accepted; S1 split into S1a/S1b; rulings in progress.md.
