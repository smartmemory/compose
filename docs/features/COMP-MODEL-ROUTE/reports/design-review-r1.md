# COMP-MODEL-ROUTE — independent design review, round 1

Reviewed 2026-09-10. Design review only; no implementation edits or test suite.
Paths are Compose-relative; `../stratum/` is the sibling engine source.
Read-only probes exercised profile resolution and enumerated all four presets.

## Findings

### 1. HIGH — Final epochs do not establish downstream acceptance per item

**Section:** Decision 4, “Acceptance” (design.md:169–174); Completion evidence (:259).

**Evidence:** `lib/flow-state.js:40–51` returns the persisted snapshot, without
deriving history. Stratum initializes steps without epochs
(`../stratum/ts/src/engine/engine.ts:575–579`), so the proposed `epoch ?? 0` is
correct. But revise increments every reset descendant's epoch and deletes its
attempts, accepted token, output and entire fanout (:2805–2837). The preset
explicitly tells assess to dispatch only affected work and retain unaffected
accepted tasks (`presets/team-fable-astra.stratum.yaml:201–209`), then revises
to execute (:221–227). Thus wave 0 `[A, B]`, followed by repair wave 1 `[B]`,
leaves only B at index 0 in final fanout state. A was retained, yet comparing its
epoch to execute's final epoch rejects it. An `implement` wave has the same
reset behavior without necessarily rejecting any prior work. Conversely, a
failed dispatch can share the final epoch. Current success is separately named
by status and `acceptedDispatchToken` (`../stratum/ts/src/engine/state.ts:51–65,173–189`).

**Change:** Define acceptance from recorded gate dispositions, successful
issuance tokens, and task lineage across waves; retain per-wave item bindings
before reset. Distinguish repair, additional implementation, same-epoch retry,
and failed/cancelled or unadjudicated work. Use an unknown/censored label when
lineage or downstream disposition is unavailable. Final epoch is a freshness
check, not the acceptance classifier. Update S1's evidence capture accordingly.

### 2. HIGH — Cancellation attribution is not receipt attribution

**Section:** Decision 4, “Row” (:164–167); Open question 2 (:288–290).

**Evidence:** Consumer calls do pass `flow.itemIndex` (`lib/build.js:1263–1268`),
but usage is forwarded with `stepId: descriptor.step ?? descriptor.id`, i.e.
the parent fanout ID (:1306–1311,1352–1357). `reportUsageReceipts` sends that
step ID and the model-call dispatch ID; it does not copy the flow tag or item
binding (:1741–1765). Stratum stores the flow tag in the foreground cancellation
registry (`../stratum/ts/src/mcp/server.ts:200–223`). Its receipt schema has no
`flow` field (`../stratum/ts/src/engine/receipts.ts:4–14`); item detail is added
only when receipt lookup locates an item
(`../stratum/ts/src/engine/engine.ts:2711–2738,3066–3078`). A receipt for
`execute` therefore does not acquire an item index from the earlier agent call.

**Change:** Add an explicit durable join from routing issuance to every actual
model-call dispatch ID, including failure and normalization-repair calls.
Preserve step, item index, stage, generation, epoch and issuance token in that
mapping/receipt detail. Item-qualified receipt lookup alone is insufficient for
late delivery after a reset; retain the original binding. Treat receipts with
missing attribution/cost as incomplete evidence, not pooled or zero-cost rows.
This is Compose wiring within the existing receipt surface, not a required
Stratum API change. `readFlowSpend` already refuses missing cost evidence
(`lib/flow-state.js:57–73`).

### 3. HIGH — The learning key cannot identify individual routing records

**Section:** Decision 1 (:86–99); Decision 3, sidecar and receipt identity (:144–159).

**Evidence:** Multiple tasks can have the same preset, stage, provider, template,
prior and output contract. Admission enumerates them separately by item index
and binds each descriptor's `dispatchToken` (`lib/build.js:901–909`). The design's
`key[:epoch]` cannot distinguish two such items, or retries within one epoch.
`reportWaveEvidence` really constructs `compose:<kind>:<flowId>:<token>[:<state>]`
(:803–807); existing item-model receipts use the descriptor token (:1242–1246).
Reusing a receipt ID with changed detail throws; identical detail deduplicates
away the additional dispatch (`lib/consumer-fanout.js:710–721`).

**Change:** Separate the statistical key from the dispatch-instance identity.
Store decisions by run + scoped step/stage + epoch + item/generation + issuance
token, with the statistical key inside each record. Define any shared per-key
choice separately from per-dispatch evidence. Use the issuance token for route
receipt IDs and bind model-call IDs as in finding 2. Make terminal ledger
materialization idempotent by this identity so restart cannot duplicate samples.

### 4. HIGH — The recorded-input/digest lifecycle is not defined by the existing seam

**Section:** Decision 3 (:138–155); Decision 4, exploration seed (:197);
Decision 7 (:228–233).

**Evidence:** Preflight hashes `{normalized, resolved, overrides}`, not arbitrary
flow inputs (`lib/pipeline-profiles.js:179–199`). Its runtime parameter is a map
of step IDs to agent strings/default entries (:128–149), not dispatch keys to
`{tier, source, reason}`. A direct read-only probe rejects the proposed value
shape; adding a routing input declaration leaves the profile digest unchanged.
Build does merge overrides before its effective preflight
(`lib/build.js:3312–3326`), but `startFresh` sends a fixed input envelope
(:6439–6444). The engine's flow ID is minted only inside plan
(`../stratum/ts/src/engine/engine.ts:578–579`), after the proposed preflight-time
exploration draw would need it. Profile pins are local journal identity, and
their comparison is conditional on wave profiles (`lib/build.js:3361–3363,3812–3823`).
`PROFILE_SIDECAR_REQUIRED` checks a missing adjacent execution sidecar for known
bundled basenames; it is not a general resume drift fence (:1530–1549).

Appending future wave decisions cannot change an already-pinned profile digest:
bindings require the original digest and changed admissions are refused
(`lib/consumer-fanout.js:678–704`). Re-reading the live ledger when an as-yet
unseen wave is admitted also contradicts “resume never re-resolves” if that
ledger changed during suspension.

**Change:** Specify an immutable start record containing routing policy, frozen
evidence/table version, a seed available before plan, static resolutions and
their digest. Explicitly adapt validated tiers into effective profiles before
preflight and carry the start record through fresh/resume input handling.
Record later wave resolutions as separately identified, immutable journal
entries/receipts, bound to that root and the recorded wave input; define the
persist-before-dispatch/recovery boundary. Resolve unseen waves from the pinned
evidence, and reuse existing entries. Require missing/drifted routing records
to fail closed for every participating run. Do not claim the current sidecar
guard or an appendable flow input already provides these guarantees. This
preserves COMP-FABLE-ASTRA's recorded-state ruling (design.md:30–36,160–171;
progress.md:24–26,31,58).

### 5. HIGH — “Manual wins” changes the existing runtime override semantics

**Section:** Decision 2, manual and preset sources (:109–120), policy protection (:133–134).

**Evidence:** `mergeRuntimeProfiles` replaces `default` while preserving
`tier_from` (`lib/pipeline-profiles.js:127–149`). `resolveConsumerProfile` then
uses `item.tier` ahead of that default. Probe: override execute with
`codex:implementer:fast`, then resolve an item whose tier is critical; the
result is `codex:implementer:critical`. That is the reverse of the proposed
unconditional manual-tier precedence. Merging also discards the provenance
needed to distinguish a preset value from a manual winner.

**Change:** Decide explicitly whether manual means “replace the fallback” or
“force this item's tier.” Preserve the former for off-mode compatibility; if
the latter is wanted, define a distinct recorded force override and its scope.
Keep source provenance separate from the merged profile. Learned per-item
tiers likewise need a per-item resolution path: replacing `default` through
the current runtime seam will still be overridden by `item.tier`.

### 6. HIGH — The repair-tier floor is a prompt instruction, not an existing rail

**Section:** Decision 4, policy and exploration refusals (:184–197).

**Evidence:** The preset asks for repair tiers never lower than the repaired task
(`presets/team-fable-astra.stratum.yaml:206–208`), but wave validation checks
allowed tiers, ownership and independence only (`lib/pipeline-profiles.js:151–171`).
The repair gate validates task shape and ownership of an open-finding file;
it never compares against a prior task's tier (`lib/output-gate.js:12–39`).
The proposed learned policy may lower a critical-prior task at parity; refusing
only exploration on repair waves still allows that normal learned downgrade.

**Change:** Make the repair minimum an explicit admission constraint applied
after every routing source, including learned and manual choices. Define how
a repair maps to earlier tasks and whether the floor is their planned or
actually executed tier. Record that lineage and refuse ambiguous/absent floor
evidence rather than assuming an existing validator enforces it.

### 7. MEDIUM — Two build call sites do not cover the promised dispatch scope

**Section:** Goal (:47–59); Decision 7 (:228–233); S1 (:239–241).

**Evidence:** `admitConsumerWave` returns immediately without `tier_from` or
`_consumer` (`lib/build.js:815`); its callers use the same gate
(:1057–1062; `lib/gsd.js:524–526`). Adding only `route.learn` does not enter
that seam. Stage-specific keys cannot be passed through the current profile
map: normalization requires a real parent step ID
(`lib/pipeline-profiles.js:73–76,92–95`), and build deliberately refuses differing
stage agents under one profile (`lib/build.js:1634–1654`). A probe of a runtime
`execute/0` key fails “Step execute/0 not found in spec.” Engine-dispatched
fanouts expressly cannot consume Compose tiers (:1613–1617).

**Change:** State the supported dispatch boundary explicitly (including GSD,
engine fanouts and normalization subcalls). For the promised all-step shadow
coverage, broaden admission to participating fanouts and add per-issuance
recording for ordinary steps/retries. Either design a separate stage-aware
resolved-route map or restrict active routing to supported single-stage
consumer fanouts. Reflect the actual affected paths in S1/S3 and Files instead
of promising that nothing else changes shape.

### 8. MEDIUM — The promotion ladder has no defined cold-start evidence path

**Section:** Decision 4, durability/policy/exploration (:180–197);
Decision 5, promotion (:203–213).

**Evidence:** The bundled plan profile is always coordinator
(`presets/team-fable-astra.profiles.json:2`); execute resolves exactly the
planner's tier (`lib/pipeline-profiles.js:142–149`). Therefore static shadow
runs supply one chosen tier per prior cell, absent outside interventions.
Ten such builds cannot establish the unobserved cheaper tier's acceptance
or its projected savings. Exploration is deferred to active S3, while the
promotion gate demands that evidence before active; “eligible” does not say
whether exploration can run before durability/policy has a choice.

**Change:** Define how comparable alternate-tier observations enter the same
prior cell before promotion, such as explicitly authorized recorded calibration
trials. Keep unobserved counterfactual acceptance/savings unknown in the report.
Specify cold-start exploration eligibility, manual-override exclusion, and a
provider-specific tier ordering: Claude's coordinator is a separate Fable model,
not a defined rung in an existing ladder (`server/model-tiers.js:13–24`).

### 9. MEDIUM — S2 changes shadow behavior despite its stated guarantee

**Section:** Decision 5, shadow mode (:205–206); Decision 6 (:221–224); S2 (:243–244).

**Evidence:** The design calls shadow a static-dispatch mode with “zero
behavioural risk,” but S2 feeds learned calibration into plan before active.
Plan creates the task list and tier estimates, which become the carried execute
input (`presets/team-fable-astra.stratum.yaml:85–107`); those tiers directly
select execution models (`lib/pipeline-profiles.js:142–149`). Prompt feedback
can therefore change tasks and spend even while route selection remains shadow.

**Change:** Gate planner feedback separately (default off for baseline shadow),
or redefine shadow and the promotion evidence to distinguish static routing
from calibration-influenced planning. Record the exact calibration string as
an immutable start input, and label report cohorts accordingly.

## Answers to the two open questions

1. **No bundled preset reuses an agent step ID with different templates.** All
   four YAML/sidecar pairs were enumerated. Across presets, the repeated agent
   IDs are `plan` → orchestrator (team-research and team-fable-astra), `execute`
   → implementer (team-feature and team-fable-astra), and `verify` → orchestrator
   (the same two feature presets). Evidence: `presets/team-research.profiles.json:3–5`,
   `presets/team-feature.profiles.json:3–5`, `presets/team-fable-astra.profiles.json:2–6`,
   `presets/team-review.profiles.json:5–7`; corresponding declarations at
   `presets/team-research.stratum.yaml:63,83,103`,
   `presets/team-feature.stratum.yaml:60,84,116`,
   `presets/team-fable-astra.stratum.yaml:91,116,146,166,187`, and
   `presets/team-review.stratum.yaml:63,82,106`. No within-preset duplicate agent
   step IDs were found. Keeping template in the key is harmless redundancy for
   these presets and protects against future/custom profile changes.

2. **Yes for consumer `stratum_agent_run` requests under normal tagging; no for
   the claimed receipt consequence.** Build and GSD both delegate to
   `runConsumerIssuance` (`lib/build.js:3880–3897`; `lib/gsd.js:534–559`), which
   passes descriptor.itemIndex through `flowTag` (`lib/build.js:1263–1268`).
   Both primary and normalization-repair MCP calls forward it
   (`lib/result-normalizer.js:591–599,777–781`). `COMPOSE_FLOW_TAGGING=0` disables
   the tag (`lib/build-cancel.js:62–67`). Local Claude uses the SDK instead of
   `stratum_agent_run` (`lib/result-normalizer.js:570–591`); ordinary non-fanout
   calls need no item index. No missing-index consumer MCP call site was found.
   Paid receipt item attribution still needs finding 2's design change.

## Verdict

**Not buildable as the three slices are currently described.** The resolver,
whole-wave admission journal and zero-usage receipt transport are usable, but
S1 needs explicit routing persistence, issuance identity, receipt joins and
downstream outcome capture before its ledger can support S2/S3. Resolve manual
precedence and the repair floor, then define cold-start evidence and separate
planner feedback from shadow routing. With those design changes, the same three
slice headings remain practical and the existing Compose journal/receipt
surfaces can support them without a new Stratum API; final epochs alone cannot.
