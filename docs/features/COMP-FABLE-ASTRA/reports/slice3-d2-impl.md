# Slice 3 dispatch 2 implementation

Implemented build/GSD wiring over dispatch 1 @9e1fa25. No Git commit, direct dependency install, production preset edit, or sibling Stratum mutation.
Pre-existing progress.md and COMP-GUARD-CLAIM-1/audit.json changes were left alone.

Insertion points (post-edit):
- lib/build.js:1528: exported preflight retains legacy diagnostics/projection and calls dispatch-1 normalization/preflight; runtime defaults merge without dropping tier_from.
- lib/build.js:812,3857: full recorded input admission, before any ready token is queued; every stage resolves all items, and descriptors bind immutable item/profile evidence.
- lib/build.js:1379: prepareIssuance's authoritative envelope replaces worker success before reporting; findings are receipted; prepared failures replay without another agent call.
- lib/build.js:803: ONE zero-usage metadata receipt helper; :785 replays the journal delivery spool with original IDs and acknowledges only successful/duplicate responses.
- lib/build.js:933,4825: current-audit output decisions and common merge wrapper; D2 is after the byte-identical-to-HEAD review_gate branch and before policy evaluation.
- lib/build.js:904: post-approval checkpoint publication delegates to recoverCheckpoint (witness -> prepared fsync -> CAS -> published), then replicates evidence before cleanup.
- lib/build.js:3299,3377: terminal/cancelled and ordinary resume reconcile after revision verification; cancelled replication remains pending locally and is reported incomplete.
- lib/build.js:3355: explicit --fresh deletes the old flow's recorded ref with expected-old CAS; other flow refs and HEAD/index are preserved.
- lib/build.js:986,5981: prepareWaveShip at ship entry; dispatch-1 squashOntoBase uses a temporary index; captured checkpoint deltas supply authoritative paths, including deletions/rename endpoints.
- lib/gsd.js:147,522,526,695: selected local-or-bundled sidecar, whole-wave admission, descriptor.item task identity, common gate/checkpoint wrapper; ship receives artifact context.
- lib/flow-state.js:39,54: strict persisted snapshot/spend reader, verifying run/revision/gate token and summing attributed receipt USD once.
- lib/build-stream-writer.js:201: pause emits build_paused once and closes without build_end.
- bin/compose.js:2671,2740: --cost-ceiling-usd parsing/value removal and batch rejection; single-build option passed to runBuild.

Pause/resume contract:
- `_costCeiling: {input,default,gates}` enables the receipt acknowledgement barrier and strict persisted-spine accounting. `runBuild({costCeilingUsd})` overrides only the live limit, outside profilesDigest, with a separate metadata receipt for each effective override.
- USD equal to the ceiling is allowed; greater spend, missing/unattributed cost, unreadable state or an unacknowledged paid receipt requires a human, including skip/flag policy.
- Noninteractive holds return `{status:'waiting_gate',flowId,gateToken,reason}`; active-build.json remains resumable with token/reason and its accumulator intact.
- lib/build.js:5130 suspends before promptGate; :2784 and both finally paths skip terminal actuals/build_end while still closing resources. Cancellation remains terminal owner.
- The token's hold is durable receipt intent. Raising the ceiling and resuming does not approve it. Interactive resume accepts an explicit human approve/revise/kill through the same merge wrapper.
- Proposed decision/source/open findings are recorded before resolution; final outcome evidence follows the actual wrapper outcome. Ambiguous gate acknowledgement is audited by ordinal, never resolved twice blindly.

Caller inputs:
- Build: selected YAML plus adjacent `.profiles.json`; agent entries are strings or `{default,tier_from:'item.tier'}`. `_consumer[step]` opts into ownership/independence/checkpoint gates; gate objects use decide_from/validators. No new production preset is shipped.
- Output gate: configured execute entry/provider are passed to decideGateFromOutput; only recorded source/review/gate states are authoritative. reviewOutput is never supplied as an override.
- Admission/direct issuance: pass localSpec, fresh audit, pipelineProfiles, the pinned ConsumerFanoutArtifacts manager, stratum and flowId. Direct runConsumerIssuance obtains admission if none was supplied; only resolved STRING profiles reach runAndNormalize.
- Input references follow the shipped direct syntax `${step.output.tasks}`, `${input.waves[0]}`, `${wave.tasks}`; carry is a bare flow-value name, not a `carry.` namespace. Unsupported/unavailable references fail admission.
- Ship: pass context.artifacts, flowId and stratum. Net-tree computation never stages the real index; existing selective staging/commit stays intact. A recorded ship receipt supports idempotent preparation after its own base-parent commit.
- Receipts: usageReport must be available for replicated evidence. Stable IDs are `compose:<kind>:<flowId>:<token>[:<state>]`; paid-call IDs are retained across lost acknowledgements. No metadata is added to step_done.

Validation:
- Requested targeted gate: exit 0; 122/122 passed, 0 failed/cancelled/skipped, 102.895s (after final production edits). Existing file names all existed; none substituted. Log: /tmp/d2.log.
- Additional unchanged review/GSD fanout goldens: 30/30 passed (/tmp/d2-review-gsd-goldens.log).
- Output-gate + existing section-emission checks: 28/28 passed (/tmp/d2-sections.log); final reserved-review/sections supplement: 17/17 passed (/tmp/d2-final-review-sections.log).
- Legacy injected-artifact compatibility: 63 passed, 1 sandbox `spawnSync ps EPERM` failure (/tmp/d2-compat.log).
- UI 624/624 and tracker 100/100 passed (/tmp/d2-ui.log, /tmp/d2-tracker.log).
- Full suite run ONCE: exit 1; 6,761 tests: 5,830 passed, 470 failed, 453 cancelled, 8 skipped; 933.849s (/tmp/d2-full.log); exact failure inventory: /tmp/d2-full-failures.json.
- New tests use disposable real Git and shared fakeBuildStratum/makeBuildWorkspace plus dispatch-1 consumer-wave fixtures. YAML/sidecars live in test helpers, never presets/.
- Coverage includes sixth-item zero-dispatch rejection, per-item models/effort, direct-caller admission, ownership/prepared replay, carry/input resolution, profile drift, human budget resume, lost receipt/gate acknowledgements, two checkpoint waves, single ship commit, fresh ref isolation and post-approval cancellation.

Full-suite failure separation:
- Confirmed sandbox: listener EPERM across HTTP/API route suites (all names/errors in the inventory); `settings-e2e` waited on its listener and hit 900s.
- Process inspection: `review-fixes-runtime.test.js:213` reports `spawnSync ps EPERM`; 10 lifecycle-backfill assertions follow unverifiable guard registration.
- Filesystem/resource: GSD budget/stuck goldens cannot write ~/.stratum; hook-read-cache cannot write ~/.claude/read-cache; compose-mcp pack cannot write ~/.npm. ideabox-projection-watch/pipeline-specwatch report EMFILE.
- Package-start hit 900s during its own permitted temporary install. Its install-cache log `compose-package-start-EWRbMR/install-cache/_logs/2026-09-10T06_01_13_849Z-debug-0.log` records registry.npmjs.org EPERM; no install was invoked directly.
- Other host-dependent checks: build-quick/hooks-status init subprocess failures; 16 build-stream-bridge delivery assertions. The final agent-lanes integration rerun reaches its unchanged watcher assertion (0 callbacks/lanes), no longer the prepared-envelope error (/tmp/d2-agent-lanes.log).
- Remaining assertion, not claimed green/environmental: `test/build.test.js:156` expects flow_not_found but receives transport for an unknown flow. It is outside this wiring seam and was also recorded in dispatch 1.
- Failures introduced during wiring were corrected: runtime preflight diagnostic lost its step/path; legacy injected artifact doubles lacked returned envelopes; the extra mapped section call was consolidated into the existing auto branch. Final affected code checks pass; the separate watcher/ps assertions above remain blocked.
- The full run started before these corrections; it was not rerun. Final targeted/supplemental tests cover the corrected code. The concurrent-model fixture now matches calls by step identity rather than scheduling order.

Blueprint corrections/deviations:
- Dispatch 1 supplied no persisted spend reader, so the brief's conditional flow-state.js seam was necessary; primitives still own validation and checkpoint transactions.
- Initial publication and recovery share recoverCheckpoint, called only after confirmed approval; no second Git transaction implementation was added to build.js.
- Captured baseline/witness tree deltas supply ship paths even when checkpointing is enabled without ownership. This excludes pre-existing dirt without requiring an ownership policy.
- Legacy injected artifact adapters may omit return values when no wave policy is enabled; real/configured artifact paths require the prepared result. Existing usage-receipt doubles now return the real envelope shape.
- GSD retains its existing restart-as-new-flow/resume-task-graph semantics; same-flow human ceiling resume is the runBuild contract. Its headless configured holds return waiting_gate.
- Intended profile and normalized reported model are separate evidence; connector identity is explicitly unverified, not inferred from the requested model.
- Skill source corrections are recorded here, within dispatch-2 ownership; blueprint/README edits remain dispatch 3.

Dispatch 3: real-engine carry/repair/crash boundary and installed-CLI connector goldens, remaining checkpoint crash matrix, README/blueprint documentation. Production contracts/prompts/presets remain slice 4; live model/cost and cancellation evidence remain later slices.

## Fixes r1
- Ship receipts now persist the successful result and completion evidence. If the recorded commit is HEAD, ship replays that result and the same receipt before tests/staging/commit; missing replay evidence refuses safely.
- Runner preflight rejects `_costCeiling.gates` containing `review_gate` with `WAVE_COST_CEILING_RESERVED_GATE`. The reserved review branch is byte-identical to the pre-fix working tree (7,132 bytes).
- Admission/gate helpers check applicable configuration before fetching audits; GSD retains its existing issuance audit and skips unconfigured admission.
- Added one regression per defect in build-wave-ship, build-output-gate, and build-wave-routing: all three failed before the fixes and pass afterward.
- Ship probes `ship-replay`, `ship-replay-dirty`, and `ship-replay-sections`: identical successful envelopes on resume, unchanged HEAD, exactly one base-parent commit. Regression also asserts unchanged index and receipt.
- `review-ceiling`: exit 1 with the named preflight error, as expected; no gate resolution.
- `legacy-audits`: working tree and `9e1fa25` baseline loader both yield `{"error":null,"waitingAudits":1,"resolves":1}`. Exact fake-client totals: legacy consumer build 5 audits; plan-gate build 2, matching baseline.
- Requested eight-file command: exit 0; 83 tests passed, 0 failed/cancelled/skipped, 6 suites, 22.432s. Log: `/tmp/d2-fix.log`.
- Probe logs: `/tmp/d2-fix-{ship-replay,ship-replay-dirty,ship-replay-sections,review-ceiling,legacy-audits,legacy-baseline}.log`. Full suite not run; no Git commit.
