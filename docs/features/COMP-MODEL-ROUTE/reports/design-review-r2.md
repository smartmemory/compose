# COMP-MODEL-ROUTE — independent design review, round 2

Reviewed 2026-09-10 against the revised design, round-1 report and adjudication.
Scope: fixes and implementation forks only; adjudicated rulings remain accepted.
Paths are Compose-relative; design references below mean `design.md` in this feature.
Rechecked cited code surfaces, including the normalizer call/error branches and receipt
detail enrichment. No tests run; design.md and progress.md were not edited.

## Round-1 disposition

| Finding # | Status | Evidence |
|---|---|---|
| 1 | RESOLVED-WITH-NEW-ISSUE | D6 (:239–270) captures pre-reset lineage and accepted tokens correctly; its censoring now needs a matching durability population in D8 (new finding 3). |
| 2 | RESOLVED | D5 (:210–235) requires original issuance-to-call joins, all repair usage, incomplete exclusions and unique paid-id accounting; `../stratum/ts/src/engine/engine.ts:2738` preserves nested `detail.routing`. |
| 3 | RESOLVED | D1 (:94–103) separates statistical keys from issuance identities and makes receipts/materialization idempotent by issuance. |
| 4 | RESOLVED-WITH-NEW-ISSUE | D3 (:139–177) pins retained table contents, pre-plan seed and later journal entries; GSD continuation and ordinary repair admissions remain unspecified forks (new findings 1–2). |
| 5 | RESOLVED | D2 (:107–135) preserves fallback replacement, manual provenance and a separate item route map, matching `lib/pipeline-profiles.js:128–149`. |
| 6 | RESOLVED | D7 (:278–291) applies the executed-tier floor after every source and refuses ambiguous lineage; S1 capture versus S3 enforcement is explicit. |
| 7 | RESOLVED | D4 (:184–206), S1/S3 (:373–387) and Files (:420–436) agree on ordinary/single-stage consumer support and unsupported engine/multi-stage/subcall observations. |
| 8 | RESOLVED-WITH-NEW-ISSUE | D8 (:307–324) supplies authorized shadow trials and explicit provider ladders; repair-time eligibility and censored-cell durability need decisions (new findings 2–3). |
| 9 | RESOLVED | D3 (:147) and D10 (:353–358) pin exact feedback bytes and cohort independently; feedback-off and enabled cohorts stay separate in D8–D10. |

## New findings

### 1. HIGH — GSD resume is a new engine run, not replay of the bound run

**Design section:** D1, D3, D8; S1 and the GSD Files row (:94–103,156–177,295–299,373–378,424).

**Evidence:** D3 requires resume to validate the recorded run/revision binding and reuse
existing decisions byte-for-byte. GSD instead always calls `stratum.plan`
(`lib/gsd.js:294–304`), including after its resume branch (:112–115).
`loadResumeTaskGraph` removes completed tasks and completed dependencies (:1300–1320),
then supplies that filtered graph as the new decompose output (:599–603).
Stratum generates a fresh run id inside every plan (`../stratum/ts/src/engine/engine.ts:578`).
Thus unfinished B can move from index 1 in the original run to index 0 in a new run,
with a changed wave digest and new issuance token. A pinned table/seed alone does not
identify B's existing decision across that transformation. Treating it as an unseen
wave can change its trial allocation; treating the old binding as mandatory rejects
normal GSD resume. Counting each continuation run independently also manufactures breadth.

**Recommended change:** Specify participating GSD resume as a recorded continuation
sharing the original start root. Persist old/new engine-run links and the filtered task
transformation; carry decisions through stable logical task/wave identities, while giving
actual redispatches new issuance records. Reconcile prior uncertain calls before continuing
and count the logical start once for breadth. Alternatively, explicitly redesign participating
GSD to resume the original engine run; that is a different recovery implementation.
The design must choose before S1 can implement its promised replay guarantee.

### 2. MEDIUM — Frozen ordinary-step routes lack repair-time eligibility handling

**Design section:** D2–D4 and D8 (:131–164,188–198,319–324).

**Evidence:** D3 puts ordinary-step choices into effective profiles before preflight,
draws using seed + scoped step, and retains the frozen choice for retries. D8 excludes
trials/exploration on repair waves, but only consumer items have a described wave-admission
resolution path. Ordinary steps also recur inside those waves: the bundled topology places
`verify` after execute and revises back to execute
(`presets/team-fable-astra.stratum.yaml:146–148,221–227`); reset increments descendant
epochs (`../stratum/ts/src/engine/engine.ts:2805–2837`). A participating custom profile may
opt such an ordinary step into learning; only the bundled preset is restricted to plan/execute.
If verify drew a trial initially, reusing its profile during repair violates D8. Replacing
it requires an ordinary per-epoch decision path that D3 has not specified. This is not
a problem for the bundled static verify entry, but it is inside the promised v1 boundary.

**Recommended change:** Separate the frozen ordinary initial candidate from its admitted
route. At each new epoch, check recorded repair context before issuing an ordinary call;
suppress ineligible trials/exploration using the static baseline and applicable floor.
Append that decision to the root-bound route journal without changing the start/profile
digest. Same-epoch retries reuse the admitted choice; resume reuses its entry. Extend the
ordinary route-consumption path accordingly, and state the allocation identity explicitly.

### 3. MEDIUM — Censored observations can satisfy durability without acceptance breadth

**Design section:** D6 acceptance denominator and D8 eligibility (:267–269,295–305).

**Evidence:** D6 excludes unknown and non-defect re-implementation from the binary
acceptance denominator. D8 requires three runs, five dispatches and two workspaces for
a key/tier/cohort cell, but does not say those counts must come from that denominator.
Five fully cost-attributed dispatches across three runs/two workspaces can contain four
censored outcomes and one acceptance. Counting all five satisfies the written breadth
thresholds while the reported acceptance fraction is based on one outcome from one run.
Counting only binary-eligible rows instead refuses the same cell. These produce different
active routes and promotion decisions; merely reporting censoring counts does not choose.

**Recommended change:** Define one explicit acceptance-eligible population after attribution,
cohort and final-label filtering. Apply all durability counts to that population, with
run/workspace breadth contributed only by included outcomes. Compute the policy's paired
acceptance/cost comparison on the declared comparable population; retain all-observation
cost and censoring totals separately in the report. Specify the binary disposition of
confirmed cancellations and non-failure retries rather than leaving their label groups partial.

## Consistency and S1 split

D3 and D10 are compatible: build the pinned table, derive feedback bytes once, then seal
the start record before plan; neither admission nor resume regenerates the string.
D4's supported/unsupported boundary is reflected in Slices and Files. No additional
dispatch boundary expansion or Stratum API change is required by those tables.

**Split S1 into two dependent slices:**

1. **S1a — Recorded routing lifecycle and recovery:** start/schema/root, immutable decision
   and issuance journal, ordinary/consumer identity, Build replay and the explicit GSD
   continuation protocol from finding 1. Reserve feedback fields with disabled/empty values.
2. **S1b — Attributable shadow outcomes:** call hooks/joins and receipt intents, pre-reset
   gate/task capture, acceptance derivation, unsupported observations and idempotent ledger.

S1 currently bundles a GSD recovery redesign with the shadow evidence product. S1a must
establish which executions are continuations before S1b can certify attribution or breadth;
S1b is the first slice that may claim complete shadow samples. S2/S3 depend on S1b.
This split does not move trials or repair-floor enforcement out of S3.

**Verdict: 1 HIGH / 2 MEDIUM / 0 LOW.**
