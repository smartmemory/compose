# COMP-MODEL-ROUTE — progress ledger

## 2026-09-10 — filed + design drafted
- Owner asked "what if we want dynamic routing to subagents based on difficulty". Clarified: not
  failure-based escalation; self-learning; scope = EVERY pipeline step; most keys stay static
  (preset/manual), learning mostly on plan + implement; the deliverable is a routing FRAMEWORK
  whose values are static or dynamic per key.
- Row added: COMP-MODEL-ROUTE (position 153, COMP-TEAMS phase, L, high). Links: supersedes
  COMP-FABLE-CALIBRATE (its calibration table = slice 2 here); depends_on COMP-FABLE-ASTRA.
- COMP-FABLE-CALIBRATE could NOT be flipped: PLANNED→SUPERSEDED is not a lifecycle transition,
  force is disabled under capabilities.guard, KILLED is lifecycle-owned and `kill_feature`
  needs the compose server (:4001, not running; not started unasked). TODO when server is up:
  kill_feature COMP-FABLE-CALIBRATE reason "superseded by COMP-MODEL-ROUTE".
- design.md written (Fable). Decisions D1–D7, slices S1–S3, 10 completion-evidence items.
- Owner directive mid-turn: "maximize usage of astra" → design review r1 dispatched to Codex
  gpt-6-astra/high, runId 7882a3be8644, report → reports/design-review-r1.md.

## 2026-09-10 — design review r1 (astra, run 7882a3be8644, 6 min, 1.24M tok) → 6 HIGH / 3 MEDIUM
Verdict: not buildable as written; three slices viable after changes. Report: reports/design-review-r1.md.
Adjudication (Fable) — ALL NINE ACCEPTED, rulings where the reviewer left a fork:
1. Acceptance ≠ final epoch. Derive from gate dispositions + acceptedDispatchToken + task lineage across
   waves; capture per-wave item bindings BEFORE the revise reset; labels accepted / repaired / re-implemented /
   retried-same-epoch / failed-or-cancelled / unknown(censored). Final epoch = freshness only.
2. Receipt attribution: Compose-side durable join routing-issuance → every model-call dispatch id (incl.
   normalization-repair calls). Rows with missing attribution or cost = incomplete evidence, EXCLUDED, never pooled.
3. Statistical key ≠ record identity. Record id = run + scoped step/stage + epoch + item/generation + issuance
   token; key is a field. Route receipt ids use the issuance token. Ledger materialization idempotent by record id.
4. Immutable START RECORD (policy, frozen evidence-table version, seed minted before plan, static resolutions +
   their digest) carried through fresh AND resume input handling; later wave decisions = immutable journal
   entries bound to the root + recorded wave input; unseen waves resolve from the PINNED table; missing/drifted
   routing record fails closed. Do not claim the sidecar guard or an appendable input provides this.
5. RULING: manual = "replace the fallback" (today's mergeRuntimeProfiles semantics, off-mode byte-identical).
   No force-override in v1 (filed as follow-up). Provenance kept in the start record, not the merged profile.
   Learned per-item tiers get their own resolved-route map consulted at admission, NOT the default seam.
6. Repair floor becomes an explicit ADMISSION constraint applied after every source (manual, learned, preset).
   Floor = the tier that actually executed for the repaired task (lineage-recorded); absent lineage → refuse.
7. Supported boundary in v1: ordinary agent steps + single-stage consumer fanouts, via build AND gsd admission
   (broaden admitConsumerWave entry). Engine-dispatched fanouts, multi-stage fanouts, normalization subcalls:
   recorded as source:unsupported rows, never routed. Resolved-route map is stage-aware and separate from the
   profile map. S1/S3 + Files list the real touched paths.
8. Cold start: explicit recorded calibration TRIALS in shadow (`route_trials` per-key alternate tiers, bounded
   fraction, source:'trial', excluded on manual-overridden keys, repair waves, ceiling gates, assess). Unobserved
   cells reported as unknown, never projected. Provider-specific tier ladders; `coordinator` (Fable) is not a rung.
9. Planner calibration feedback gated separately (`calibration_feedback`, default OFF in shadow baseline);
   calibration string is an immutable start input; report cohorts labelled static vs calibration-influenced.
Next: astra revises design.md per rulings (fix run), then r2 review targets the fixes.

## 2026-09-10 — design revision r1 (astra fix run 606e18487868, 7.5 min, 568K tok)
design.md rewritten 289 → 448 lines: 11 decisions (start record, record identity vs statistical key,
supported boundary, receipt joins, acceptance labels with lineage, repair floor as admission rail,
cold-start trials, gated calibration feedback), S1 now carries persistence/joins/outcomes, 20 evidence
items, Files table lists build.js + gsd.js + consumer-fanout.js + result-normalizer.js + output-gate.js
+ 4 contracts. Fable read the full revision: consistent with all 9 rulings; no code claim contradicted
what r1 verified. Round 2 (targets the fixes) dispatched: astra run 973c7cb3e898 → reports/design-review-r2.md.

## 2026-09-10 — design review r2 (astra, run 973c7cb3e898) → 1 HIGH / 2 MEDIUM; r1 findings 2,3,5,6,7,9 RESOLVED, 1,4,8 RESOLVED-WITH-NEW-ISSUE
Report: reports/design-review-r2.md. Adjudication (Fable) — ALL ACCEPTED:
1. HIGH GSD resume = new engine run (gsd.js:294–304, filtered graph :1300–1320). RULING: participating GSD
   resume is a RECORDED CONTINUATION sharing the original start root (reviewer option A). Persist old→new
   engine-run link + the filtered-graph transformation; decisions carry by LOGICAL task id (the planner's
   task id, stable across the filtered graph) + logical wave id, never by array index; each actual redispatch
   gets a new issuance record; reconcile uncertain prior calls before continuing; one logical start = one
   breadth vote. Resuming the original engine run (option B) is NOT chosen — different recovery design.
2. MEDIUM ordinary-step routes at repair epochs: accept. Frozen initial candidate ≠ admitted route; at each new
   epoch check recorded repair context before issuing an ordinary call, suppress ineligible trial/explore to
   static baseline + floor, append to the root-bound journal; same-epoch retries reuse; resume reuses.
3. MEDIUM censored rows satisfy durability: accept. ONE acceptance-eligible population (attributed + cohort +
   final binary label) — all durability counts and breadth votes come from it; all-observation cost + censoring
   reported separately. RULING on partial label groups: confirmed cancellation = EXCLUDED (censored, not model
   evidence); retried-same-epoch = NEGATIVE (work did not stick).
S1 split ACCEPTED: S1a recorded routing lifecycle + recovery (incl. GSD continuation); S1b attributable shadow
outcomes (joins, pre-reset capture, acceptance, ledger). S2/S3 depend on S1b. Trials + floor stay in S3.
Next: astra fix run, then r3 targeted at these three fixes (round cap per feedback_review_loop_budget).

## 2026-09-10 — design revision r2 (astra fix run f0d07df96078, 3 min, 259K tok)
design.md 448 → 494 lines: GSD continuation protocol in D3 (shared root, logical task/wave ids, one breadth
vote per logical start), per-epoch ordinary admission separated from frozen candidate, single
acceptance-eligible population in D6/D8, S1 split S1a/S1b, evidence + Files updated. Fable spot-read D3
continuation, D8 population and Slices: matches rulings. r3 (final gate, targets the three fixes + split)
dispatched: astra run 63034084e627 → reports/design-review-r3.md.

## 2026-09-10 — design review r3 (astra, run 63034084e627) → REVIEW CLEAN (4/4 checks PASS)
Design gate closed at round 3 (cap). Total astra spend this gate: 3 reviews + 2 fix runs, ~2.4M tokens.
Feature stays PLANNED. Next step when ordered: blueprint for S1a (recorded routing lifecycle + recovery).

## 2026-09-10 — S1a blueprint (astra run 04600eef258f, 16 min; stream dropped after the file was written)
blueprint-slice1a.md, 208 lines, 15 checked claims (C1–C15), 3 dispatches. Corrections worth carrying:
- C2: Build preflight wrapper is build.js:1588–1664 (the ~1249 anchor in the brief was the consumer call try block).
- C8: GSD preflights the profile sidecar (gsd.js:156–158) but its ordinary agentRun passes cwd/telemetry only
  (gsd.js:606–619) — the sidecar is NOT applied on GSD ordinary steps today. Latent gap, pre-existing.
- C13: converting the preset's `plan` string entry to an object (to add `route`) changes the profile digest;
  off mode must restore the legacy string representation before hashing to stay byte-identical.
RULING Q1 (Fable): S1a REFUSES a participating GSD configuration whose preflighted profile differs from the bare
ordinary call (`ROUTING_STATIC_DISPATCH_MISMATCH`); bundled bare GSD proceeds unchanged. The GSD sidecar gap
(C8) is a separate follow-up bug, NOT fixed inside this slice — fixing it would break zero-call-change shadow.
Follow-up to file: COMP-GSD-SIDECAR-APPLY (GSD ordinary steps ignore the preflighted profile sidecar).
Next: astra blueprint review (1 round), then dispatch 1.

## 2026-09-10 — S1a blueprint review r1 (astra run b3ed1edd8893) → 2 HIGH / 2 MEDIUM / 1 LOW — ALL ACCEPTED
Report: reports/blueprint-slice1a-review-r1.md.
1. HIGH source-epoch equality (build.js:845–849) rejects bundled GSD merge-revise (gsd.yaml revises execute, not
   decompose; decompose stays epoch 0). Fix: bind source identity/token/output digest independently of consumer
   epoch; keep item epoch/index/generation fences; add GSD merge-revise case.
2. HIGH graph-membership rule rejects a 2nd+ continuation (completed ids cumulative, graph already filtered).
   Fix: cumulative completed ids vs ids removed on THIS transition; validate earlier completions against the
   continuation chain; three-run continuation test.
3. MEDIUM baseline capture used the test fixture, not the bundled preset. Fix: dispatch 1 also freezes the
   bundled preset's digest/envelope/call projections via the production golden BEFORE edits; named baselines.
4. MEDIUM receipt spooling pulled forward from S1b. Fix: move routing metadata spool + prelaunch delivery to S1b;
   S1a keeps immutable local admission/issuance/events + shadow record assertions.
5. LOW C3 anchor: 3312–3326 is unconditional refresh; conditional pins are 3361–3363, 3433–3439, 3812–3823.
Off identity probe (reviewer): projected legacy digest 310f9698… equals current; wrapped plan would give 29c060da….
Next: astra blueprint fix run, then r2 targeted at findings 1–2, then dispatch 1.

## 2026-09-10 — S1a blueprint fix run (astra da2bea96dce5, 6 min, 774K tok) → 212 lines, all 5 findings in
Source binding independent of consumer epoch; cumulative vs removed completed ids; three named frozen baselines
(bundled Build, carry fixture, GSD input identity); routing receipts deferred to S1b; C3 anchors corrected.
r2 targeted check (findings 1, 2, 4) dispatched: astra ab6b12781070 → reports/blueprint-slice1a-review-r2.md.

## 2026-09-10 — S1a blueprint review r2 (astra ab6b12781070) → REVIEW CLEAN (3/3 PASS). Blueprint gate closed.
Next: dispatch 1 (contracts + pure/durable primitives + frozen baselines) → astra implementation.

## 2026-09-10 — S1a dispatch 1 impl (astra f25be110f2a1, 29 min, 4.66M tok)
New: lib/model-router.js, lib/routing-ledger.js, contracts/routing-{start,record}.schema.json, 3 test files,
3 baseline fixtures, test/helpers/record-model-route-baselines.mjs. Changed: pipeline-profiles.js, flow-state.js,
consumer-fanout.js, test/pipeline-profiles.test.js. Off-mode bundled digest 310f9698… pinned.
Host targeted run: 90/90 pass (test/{model-router,routing-ledger,routing-journal,pipeline-profiles,
build-team-fable-astra,build-wave-routing,gsd-wave-routing}.test.js). GSD baseline could not capture in the
sandbox (EPERM on ~/.stratum flow lock) — captured on the HOST from frozen revision 5fbf8e0 via the recorder:
gsd-input captured=true. Impl review r1 dispatched: astra 55023bb8d260 → reports/slice1a-d1-review-r1.md.

## 2026-09-10 — S1a d1 impl review r1 (astra 55023bb8d260) → 5 HIGH — ALL ACCEPTED
Report: reports/slice1a-d1-review-r1.md. Every finding probe-reproduced with production APIs + actual presets.
1. Fingerprint treats `a|b` enum literals as contract refs → both bundled presets refused
   (`Missing referenced contract critical` / `complete`). Test used `string|number` (both primitives) — the
   fake-producer pattern again. Fix: parse the real contract grammar (validate.ts:63–92), share traversal
   with reachableContracts, test closures from BOTH actual presets.
2. No public API can initialize a continuation journal with ancestry; constructor writes an invalid journal.
   Test mutated plain objects, bypassing the journal API. Fix: validated atomic first-journal initializer.
3. Continuation validation checks only the immediate graph and caller-supplied ids: drops A from cumulative
   completions, accepts an unexplained description change. Fix: enforce graph == predecessor filteredGraph
   and monotonic cumulative history through reachable ancestors.
4. Losing the LAST launch event resets an issuance to `prepared` → re-launchable. Test deleted a middle event.
   Fix: per-issuance event tip/count validated on reload; test loss of the final event.
5. routingProfileProjection iterates `_underscore` metadata as policy: off mode rewrites `_comment` and can
   throw on inert metadata → off NOT byte-identical for custom sidecars. Fix: skip underscore ids except `_routing`.
Also: report's GSD-blocked text is stale (host captured); `createContinuationIntent` needs
`resumeDetails.verifiedCompletedTaskIds` — dispatch 2 must supply validated bookkeeping.
Next: astra fix run → r2 targets the fixes → host targeted run → commit d1.

## 2026-09-10 — S1a d1 fix run r1 (astra aac14adccdfa, 8 min, 1.73M tok) → host targeted run 97/97
All five fixed within d1 ownership; diff +338/-11 over the r1 state. r2 review (targets the fixes, re-probes
each) dispatched: astra 5da3396efa14 → reports/slice1a-d1-review-r2.md.

## 2026-09-10 — S1a d1 review r2 (astra 5da3396efa14) → 5/5 FIXED, 1 new MEDIUM (omitted `out` rejected by
shared walker) → fixed by astra 3eada73e344d (`stage.out ?? null` once + Stratum-validated regression).
Host targeted run: 98/98. Full suite running on host before the d1 commit.
Full suite on host: node 6849/6849, UI 624/624, tracker 100/100. Committing d1.

## 2026-09-11 — S1a dispatch 2 impl (astra 19c5ba43734a, 36 min, 9.77M tok)
build.js/gsd.js wiring, both bundled specs declare optional routing inputs, fable-astra preset ships
`_routing:{mode:"shadow"}` + plan/execute `route.learn`. Astra: 164/165 — the 1 failure was
test/pipeline-profiles.test.js wrapping the (now already wrapped) preset a second time; Fable rewrote that test
to derive the legacy shape FROM the shipped preset (intent unchanged: off mode == 0.5.1 digest). Host: 165/165.
Impl review r1 dispatched: astra d6c99518d67f → reports/slice1a-d2-review-r1.md.

## 2026-09-11 — S1a d2 impl review r1 (astra d6c99518d67f) → 4 HIGH / 1 MEDIUM — ALL ACCEPTED
Report: reports/slice1a-d2-review-r1.md. Independent off-identity: bundled Build + carry traces match frozen
0.5.1 fixtures on the ENTIRE serialized call objects after substituting only cwd/UUID/TAP-duration values;
GSD fixture holds inputs only (no calls/digest) — cannot certify calls. Shadow = same 5 calls, identical args.
1. HIGH fresh-after-terminal-old-flow inherits the OLD routing mode (build.js:3773–4055): active mode dispatched
   instead of ROUTING_SLICE_UNAVAILABLE; no journal for a valid shadow request. Fix: re-resolve mode/roles/
   overrides once the verdict is fresh; public-runner test.
2. HIGH routing transport can be interpolated into prompts by a custom spec (`${input.routing_start}` in `do`).
   Fix: validate model-facing interpolation/forwarding before a participating plan; refuse; real-engine negative.
3. HIGH existing multi-stage consumer waves BREAK in shadow (ROUTING_BINDING_MISSING / ROUTING_SCHEMA_INVALID
   on execute/0 provenance). Fix: deferred multi-stage steps keep legacy bindings; start construction and journal
   validation distinguish supported vs deferred; test mixed ordinary/single/multi-stage runs through both runners.
4. HIGH `fresh:true` old-wave inspection constructs ConsumerFanoutArtifacts, silently recreating a lost
   participating journal as legacy. Fix: read-only inspection; witness check before any constructor.
5. MEDIUM frozen-oracle tests replay expected prompts instead of running producers; overstated names. Fix: drive
   real producers with controlled nondeterminism or rename to what they compare; goldens remain dispatch 3.
Next: astra fix run → r2 targets fixes → host run → full suite → commit d2.

## 2026-09-11 — S1a d2 fix run r1 (astra 1b0061ff66f5, 17 min, 6.93M tok) → host 184/184
All 5 fixed; persisted deferred-step identity validated on reload; explicit bare-provider overrides aligned into
shared-plan preflight; fresh-only overrides kept out of historical resumes. Full frozen-producer oracle
comparisons stay dispatch 3; test names corrected. r2 (targets fixes + off-identity re-check) dispatched:
astra ece0e97a6020 → reports/slice1a-d2-review-r2.md.

## 2026-09-11 — S1a d2 review r2 (astra ece0e97a6020) → 5/5 FIXED (1 with new issue); 1 new HIGH — ACCEPTED
Off-identity re-check: bundled Build (5 calls) + carry (12 calls) complete serialized call objects match frozen
fixtures after cwd/UUID/TAP substitution; digests unchanged. Deferred identity refuses ROOT_DRIFT 4/4.
NEW HIGH: fresh config records BARE provider role flags as runtime overrides in every mode (build.js:3846–3870);
HEAD kept the sidecar tier (`claude::critical` → opus/xhigh), current dispatches bare `{provider:'claude'}`
with modelID/effort absent under route_mode:off. Fix: bare role strings must not replace sidecar defaults
(historical merge semantics, stratum-mcp-client.js:94); provenance separate from effective overrides;
public fresh-off test with tiered sidecar + same-provider bare flag.
Next: astra fix → r3 targeted at this fix (round cap) → full suite → commit d2.

## 2026-09-11 — S1a d2 fix run r2 (astra 7fa71915977a, 6 min) → host 186/186; r3 (astra 565bb53a3e6e) → REVIEW CLEAN
r3 caveat: one carry producer run swapped concurrent execute/1 vs execute/2 connector arrival order (matched on
rerun) — cross-run scheduling is not deterministic; dispatch-3 oracle must tolerate concurrent-arrival order.
FULL SUITE on host: 19 FAILURES the targeted set + three astra reviews all missed — build.js:734
`artifacts.journal.routing` dereferenced unconditionally in reportConsumerStepDone; non-participating callers
(build-emission, gsd-dispatch-instrumentation, review-fixes-runtime, ts-cutover-e3-round3, usage-receipts,
integration/agent-lanes-pipeline) pass artifact stubs without `journal` → TypeError, and the agent-lanes
integration test hung to its 900s timeout. Fable fix: `artifacts?.journal?.routing`. The 6 files → 77/77.
Lesson: the review probes "non-participating callers" only through the bundled goldens; stub-artifact callers
are a distinct population. Second full suite running before commit.
Full suite after guard: node 6914/6914, UI 624/624, tracker 100/100. Committing d2.

## 2026-09-11 — S1a dispatch 3 (astra 3745abcfbade, 19 min, 4.92M tok) → real-engine goldens: 61/63, 2 PRODUCTION DEFECTS
Host reproduces both (63 tests, 61 pass, 2 fail). Report: reports/slice1a-d3-impl.md.
- D3-1 build.js:4524/1290/1099 — shadow admission re-validates EVERY descriptor in a returned ready batch,
  including concurrently settled siblings whose token moved to acceptedDispatchToken → ROUTING_BINDING_DRIFT
  aborts wave 0 at concurrency 3. Off is unaffected (matches frozen 12-call carry trace).
- D3-2 gsd.js:343/405/411/1277/1291 — stale pause.json outranks the newer crashed continuation's state.json;
  run 3 binds previousRunId = run 1, C issuance chain [2,0] instead of [2,1,0]. Pre-existing GSD precedence
  gap surfaced by routing lineage.
Only design box ticked: off-mode golden (3 receipts). Both fixes routed to astra (dispatch-2 ownership).

## 2026-09-11 — D3-1 + D3-2 fixed (astra 1b3e6831c4b6, 6.5 min) → host 112/112 over 8 files
D3-1: unseen-token admission filter, gated to participating single-stage routing waves (a first attempt filtered
legacy batches too and regressed whole-batch refusal — caught by the fix run's own test pass). D3-2: GSD resume
precedence by recorded run lineage, gated on durable routing participation; non-participating off-mode GSD
resume unchanged (pause-first). d3 review r1 dispatched: astra fc20c54f5a7c → reports/slice1a-d3-review-r1.md.

## 2026-09-11 — d3 review r1 (astra fc20c54f5a7c) → 0 HIGH / 1 MEDIUM / 1 LOW — both fixed inline by Fable
MEDIUM: GSD off oracle inserted the only frozen option key (workspaceRoot) on both sides → could not fail on a
missing `opts`. Fix: assert each actual plan's opts.workspaceRoot === cwd and the option key-set equals the
frozen key-set before substituting. LOW: CHANGELOG/report opening still said the two defects were open → updated.
No re-review (trivial). GSD golden 10/10 after fix. Full suite running before the d3 commit.
Full suite: node 6929/6929, UI 624/624, tracker 100/100. Committing d3 — S1a COMPLETE (all three dispatches).
