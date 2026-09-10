# COMP-FABLE-ASTRA — progress ledger

Order (owner directive 2026-09-10): slice 1 (routing) → slice 3 (compose seams) → slice 4 (contracts + preset) → slice 6 (live-fire).
Slices 2 (STRAT-LOOP-CARRY) and 5 (cancel: STRAT-FLOW-CANCEL-FG + COMP-BUILD-CANCEL) shipped before this ledger opened.

Loop per slice: Fable brief → Codex gpt-6-astra/high implements (workspace-write, no commit) → Codex astra adversarial review (probe production paths) → Fable adjudicates, runs targeted tests on the host → commit direct to main with CHANGELOG.

## Slice 1 — routing (started 2026-09-10)

Verified before start: `lib/agent-string.js` KNOWN_TIERS = critical|standard|fast; `server/model-tiers.js` MODEL_TIERS = Opus 4.7 / Sonnet 4.6 / Haiku 4.5; `lib/build.js:1227` loadPipelineProfiles fail-open; no preflight resolves step models before dispatch.

| When | What | Evidence |
|---|---|---|
| 2026-09-10 | brief written | briefs/slice1-routing.md |
| 2026-09-10 | slice 1 impl dispatched to Codex astra | stratum run 43818b0621c1 |
| 2026-09-10 | slice 3 BLUEPRINT dispatched to Codex astra (read-only, writes blueprint-slice3.md) | stratum run 7e0e31d7c4e6; brief briefs/slice3-blueprint.md |
| 2026-09-10 | slice 3 blueprint DONE (206 lines, 20 corrections, astra 16 min / 4.3M tok) | blueprint-slice3.md |

### Slice 3 blueprint adjudication (Fable, 2026-09-10)

Accepted as the implementation contract with these rulings:
- **Q1 (WaveDecision.tasks shape):** `Task[]` — the same element type as `TaskGraph.tasks`, matching the design's carry expression `${assess.output.tasks}`. Slice 4 writes the contract that way.
- **Q2 (terminal ship):** D3's ship squash is an opt-in seam that fires only when the flow contains `ship`. The preset (slice 4) routes `assess_gate` approve → `ship` so a completed team run ends in one base-parent commit; no implicit ship is added to D2.
- **Corrections that change the work (kept):** C9 gate token not durable engine-side → compose journals token-linked gate/checkpoint evidence itself; C13 validate the WHOLE recorded wave input before the first dispatch (ready[] is concurrency-truncated); C15/C16 resume needs prepared/published watermarks on the checkpoint; C20 noninteractive auto-approve means the cost-ceiling pause is a real suspension path, not `policy.mode=gate`; C12 the consumer dispatch seam is `runConsumerIssuance` → `result-normalizer.js`, not the build.js step audit block.
- **Pruned (feedback_minimal_first / no_indirections):** six new modules collapse to three — `lib/pipeline-profiles.js` (sidecar schema, D6 admission), `lib/output-gate.js` (D2 + validators + ceiling pause), `lib/wave-checkpoint.js` (D3). D4 ownership lives in `consumer-fanout.js` beside `prepareMerge` (it is a merge rule, not a module). Evidence writes go through ONE helper in `lib/build.js`, not a new `build-wave-evidence.js`. `flow-state.js` strict reader only if dispatch 1 actually needs it — justify in the report or skip.
- **Kept:** zero-usage metadata receipts via the shipped `usageReport` surface for run-record evidence (the design says "written to the run record"; this is the existing mechanism, no engine change). `profilesDigest` beside revisionDigest (a sidecar change under a resumed run is a real hazard).
- Dispatch order 1 → 2 → 3 as blueprinted; each leaves the suite green; sibling stratum read-only.
| 2026-09-10 | slice 1 impl DONE by astra (24 min, 7.3M tok); host targeted gate 243/243 (sandbox's 16 stream-bridge + ps/port failures were sandbox artefacts) | reports/slice1-routing-impl.md |
| 2026-09-10 | slice 1 review r1 (astra): 3×P1 + 1×P2 confirmed with a probe harness — all pre-existing routing holes the new preflight *certified* | reports/slice1-review-r1.md |
| 2026-09-10 | r1 #1/#2/#3 FIXED inline (Fable): multi-stage fanout with a fanout-keyed profile over differing stage agents fails closed; implicit-agent stages checked; tier/template on `dispatch: engine` refused. Reviewer's probes re-run: all three now fail before `stratum.plan` with zero calls. | lib/build.js preflightPipelineProfiles; test/profile-preflight.test.js (3 new tests) |
| 2026-09-10 | r1 #4 (resume re-derives runtime profiles from an EDITED local spec for non-consumer flows) NOT fixed here — pre-existing spec-drift-on-resume gap; filed as follow-up COMP-RESUME-SPEC-PIN (pin effective spec+profiles digest on the active record; refuse drift on resume). Falsifier: `grep -n "specDigest" lib/build.js` shows a comparison on the non-consumer resume path. | — |
