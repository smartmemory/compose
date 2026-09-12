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

## 2026-09-11 — COMP-FABLE-CALIBRATE killed as superseded @a341b58
Owner ruling: CALIBRATE's whole surface is a strict subset of this feature (receipt/planned-tier join = S1b;
planning-prompt calibration table = S2 behind `calibration_feedback`). Killed through the guarded lifecycle path
(`explore_design` → `killed`), not a forced status flip — `set_feature_status` refuses KILLED under
capabilities.guard (STATUS_OWNED_BY_LIFECYCLE) and PLANNED→SUPERSEDED is not a legal transition.
Gotcha for next time: `kill_feature` needs the tracker item's UUID, not the feature code, AND the item had no
lifecycle record until the server's startup feature scan created one — the first attempt failed with "No
lifecycle on this item" against a stale MCP-side view. Rationale + re-file condition: ../COMP-FABLE-CALIBRATE/killed.md.

## 2026-09-11 — S1b evidence pass (astra bcc8e7d4b941, 21 min, 4.84M tok) → reports/slice1b-evidence.md
Read-only anchor verification + seam census before blueprinting. **Of the 14 code anchors design.md Decisions 5/6/7
cite, 5 are outright stale (D5 build.js:1263–1268 / :1352–1357 / :1741–1765, consumer-fanout.js:710–721,
D7 preset :206–208), 1 partially stale (pipeline-profiles.js:151–171), 1 misdescribed.** The misdescription is the
important one: D5 implies result-normalizer.js:777–805 is a second MCP/local fork, but `repairFn` ALWAYS calls
`stratum.agentRun` — normalization repair has exactly ONE transport even behind a local-SDK primary. A brief written
from the design would have specified a local repair hook for a path that does not exist.
Also found: the no-journal artifact-stub population is LARGER than the S1a incident recorded (ts-cutover-e3-round4
and round5 were never in the postmortem list); Stratum's usageReport dedups on id only, without payload comparison
(engine.ts:890–892), so Compose's spool is the authoritative one; `readFlowSpend` is NOT a ready-made completeness
rule (skips no-USD/no-positive-usage rows); and the local connector structurally cannot report effort.

## 2026-09-11 — S1b blueprint r1 (astra 4c9160dadc7e, 7.7 min) → 5 HIGH / 6 MEDIUM / 1 LOW — ALL ACCEPTED
All 14 anchor corrections from the evidence pass were independently confirmed. The findings were against the plan
built on them. Rulings made by Fable, implemented in the fix run (not re-litigated by astra):
- H5 call identity: the connector-minted wrapper id IS the call identity on BOTH transports (minted once at the
  invocation boundary, attached to success and error). My "never use the local wrapper id" rule would have excluded
  every ordinary local-path call from attribution. Forbidden is a FALLBACK id minted later because the real one was
  lost, plus dispatchToken/`legacy:<seq>` substitution. New `callIdSource ∈ {connector-invocation, absent}`;
  identity, launch outcome and usage evidence are separate fields.
- H3 cancellation: settling cancellation on an acknowledged `stepDone` is IMPOSSIBLE — `stepDoneLocked` rejects a
  cancelled run before token handling (engine.ts:746–748). Cancellation settles on durable run-cancellation audit
  (build-cancel.js:98–106) PLUS per-call termination evidence; unconfirmed teardown stays `unknown`. The token-absent
  settlement path stays in S1b for FAILURE only, preserving S1a success-path token equality.
- H1 receipts: participating paid receipts spool independently of `_costCeiling` (the spool is currently only used
  when that flag is set, so "authoritative dedup" held for ceiling runs only). S1a-deferred `compose:route` metadata
  receipts and prelaunch delivery are S1b and were missing from the draft entirely.
- H2: unsupported observations are an S1b deliverable; the draft let implementers waive them "by name". Own record
  branch, null issuance, explicit unsupportedReason, never an invented issuance.
- H4: the call sink had no issuance binding — under concurrent consumers item A's repair could bind to item B.
  Now an immutable per-issuance observer, one intent-owning layer.
- M1: wave selection comes from the gate's RESET DEPENDENCY CLOSURE, not the adjacent merge fanout — the bundled
  adjudication gate follows `assess`, not `execute`, so the adjacent reading captures nothing there.
Also corrected in the draft by Fable before the gate: the pre-reset capture point. The first draft put it at
build.js:5821/5906 and gsd.js:784, which are all POST-RPC — it would have captured state the engine had already
destroyed. Correct point is closure entry at `resolveGateWithConsumerMerge` (build.js:5486, gsd.js:734); the RPC is
inside at build.js:5586 / gsd.js:764 (NOT gsd.js:775, which is recovery resume).

## 2026-09-11 — S1b blueprint fix run (astra 9ade03c35a9d, 12.7 min, 2.86M tok) → r2 (astra 33ea8d485b26, 5.5 min) REVIEW CLEAN
All 12 findings fixed, no new findings, no scope drift into S2/S3, off-mode gating intact, `ROUTING_STATIC_DISPATCH_MISMATCH`
untouched. Blueprint 156 → 243 lines. The journal-dereference hardening list grew from the 4 sites Fable found to
5 sites / 7 dereferences (adds publishConsumerCheckpoint build.js:1424 and replicateCheckpoints :1437,:1444 with a
guard needed before capturedWavePaths :1429–1432). Two owner questions remain open (Q1 executed-tier evidence on
the local SDK path, Q2 failure-settlement scope). Live-fire shadow build stays explicitly OUTSTANDING and cannot be
ticked by deterministic real-engine tests.

## S1b follow-ups — FILED, not fixed (do not repair inside S1b)
CORRECTED 2026-09-11 after the blueprint fix run: this list was first written with FIVE entries; the revised
blueprint reduced it to THREE because two of them turn out to be HANDLED by S1b's own lifecycle hooks rather than
deferred. Authoritative list is the blueprint tail; kept in sync here.
1. Legacy GSD direct conversion drops sibling `usdSource`/`split` (gsd.js:673–683 vs result-normalizer.js:788–794),
   and error usage lacks that adaptation (gsd.js:663–668). S1b's raw connector evidence bypasses this loss for
   PARTICIPATING attribution; changing the legacy conversion stays a follow-up.
2. `validateDecision` does not compare original `review.findings` multiplicities (output-gate.js:12–39) despite the
   prompt demanding an exhaustive partition (team-fable-astra.stratum.yaml:203–204). S1b records observation-only
   partition/ownership checks and censors ambiguity; stronger gate-dispatch enforcement stays a follow-up.
3. GSD preflights the sidecar (gsd.js:161–166) while ordinary calls stay bare (:651–660). Preserve
   ROUTING_STATIC_DISPATCH_MISMATCH; do NOT fix sidecar dispatch in S1b.
NO LONGER deferred (handled by S1b lifecycle hooks, previously listed here in error): GSD post-call parsing outside
the call catch (gsd.js:689–693) and participating cancellation-loop reachability (gsd.js:348–355). The stale
"Build mode passes no onUsage sink" comment (build.js:1865–1866, contradicted by :4376) is a d2 cleanup, not a
standalone follow-up.

## 2026-09-11 — S1b owner questions Q1 + Q2 BOTH RULED; no owner action outstanding
Q2: CLOSED as already ruled (failure-only token-absent settlement stays in S1b; cancellation settles on run-cancellation
audit + bound per-call termination, never a stepDone acknowledgement; lost failure ack → ROUTING_ISSUANCE_UNCERTAIN).
The r1 fix run settled it and r2 reviewed the execution clean.

Q1 (executed-tier evidence on the local SDK path): **no later slice scheduled; conditional trigger instead.**
Measured, not assumed: `localExecution` has exactly ONE setter (build.js:1797, `policy.isolation === 'none'`) and
pairs with `cfg.provider === 'claude'` (result-normalizer.js:425). The other five runAndNormalize call sites
(build.js:1766,4782,4879,4971,5736) never pass it → ORDINARY steps can NEVER take the local path; it is
consumer-fanout-only. Bundled census of `isolation: none` + `agent: claude`: only the `review_lenses` fanouts
(pipelines/build.stratum.yaml:260, build-quick:238, presets/team-review:88, team-research:89).
**team-fable-astra does not reach it** — its fanout is `isolation: worktree` (:127) over `agent: codex` (:131), and
its two learn-opted keys are `plan` (ordinary) and `execute` (that worktree fanout). So the null-executed-tier gap
affects ZERO rows in every configuration S1b and S2 ship.
It bites only if a `review_lenses`-shaped key is opted into learning (a plausible S3 candidate: high-volume,
uniform-contract, repeated across runs — where learned routing pays most). Then every such row is
executed-tier-unknown and cannot certify a repair floor.
**Trigger to revisit:** any spec adding `route.learn` to a key whose fanout is `isolation: none` with a `claude` agent.
**Work required then:** check whether the Claude Agent SDK response surfaces applied thinking/effort; if it does,
plumb it through local-claude-connector.js:287–300 as execution evidence. Relabelling configured `appliedEffort`
(:68–90,151) stays forbidden — that is intent, and substituting intent for evidence is what Decision 6 prevents.
Deliberately NOT filed as a scheduled follow-up: a follow-up against an inert gap is exactly the perishable
forward-looking claim that rots.

## 2026-09-11 — Q3 raised by owner: the repair floor may be measuring the wrong thing (OPEN, S3)
Owner objection: Decision 7's floor is a TIER comparison ("never redo below the rung that executed"), which treats
ladder position as a proxy for "likely to succeed here". The proxy inverts — a stronger model can follow a tightly
specified task WORSE. Second example (Codex vs Claude on reviews) is ALREADY handled: cross-provider evidence refuses
admission and provider ladders are explicit policy, not a global ordering (design.md:318,350–353); `coordinator` is
not a rung. Within-provider monotonicity is NOT handled.
Structural tension: the floor applies after EVERY source and rejects anything below it (design.md:320–322), so it
overrides the learned value. The feature's premise is "stop assuming which model is right, measure it" — and the one
hardcoded prior outranks the measurement.
Candidate shape (NOT ruled): evidence-based floor where durable evidence exists (never redo with a candidate whose
measured accepted-rate is worse than the executed one's), evaluated on the REPAIR STRATUM not the key overall (work
that reached a repair is not a random sample of the key); ladder demoted to cold-start prior; cross-provider refusal
unchanged; floor derived from the same evidence as the learned source so they cannot contradict.
Deliberately NOT decided now — the shadow corpus should settle it before S3 builds enforcement.

## 2026-09-11 — S1b ledger row gains `context` (repair stratum) @b5382d3
Found while answering Q3: the blueprinted ledger row had `key`, `source` and `outcome` but NOTHING marking a row as
repair-context, so once a row reached the ledger a repair-wave sample was indistinguishable from a fresh-wave one and
the journal that could re-derive it is per-run/per-artifact-root (consumer-fanout.js:282–296) and not retained for the
ledger's lifetime. Design already scopes the eligible population by "key/tier/cohort and source stratum"
(design.md:296–298) — the field is what makes that stratum expressible.
Added `context:{waveKind, repairOfRecordId, repairDepth, repairLineageRefs}`, `waveKind ∈ {fresh,repair,retry,unknown}`.
RECOMPUTED at materialization from persisted admission repairContext/epoch (build.js:1060) + validated `lineage-link`
records, then frozen into the row (the row IS the durable sample); never from task names or in-memory state. Ambiguous
lineage → `unknown`, censored, never defaulted to `fresh`. `repairDepth` stops a third-round repair being pooled with a
first attempt. S1b RECORDS only — no floor computed, compared or enforced (that stays S3).
One-line schema change now vs re-materializing the ledger after S1b ships. Dispatch-1 checkbox + a Tests-table row added.
NOTE: this edit post-dates the r2 CLEAN review; it is additive recording with no floor logic, but it has NOT itself been
through a review round.

## 2026-09-11 — S1b DISPATCH 1 implemented and committed
astra impl fef0c0b97e9d (42 min, 9.68M tok) → review r1 ba57b097b2bc (7.9 min) → fix cc6777e0e8b6 (13 min) →
review r2 fec8fb4e7d06 (9.7 min) → fix e182a5c110c0 (8.6 min). Host: node 6983/6983, UI 624/624, tracker 100/100;
targeted 132/132; goldens 23/23; three frozen off fixtures byte-unchanged. Runtime observation still DISABLED.

**r1 — 3 HIGH / 1 MEDIUM, all reproduced with probes, all accepted:**
1. A seeded lineage `relation` overrode contradictory gate evidence: `validateLineage` checked existence/digest/scope
   but never that the link agreed with the referenced disposition's per-issuance relation and defect evidence. Probe
   built an APPROVED/retained gate for A, attached a repair link anyway, and got A→`repaired`/negative plus fabricated
   repair ancestry for B. Fixed at routing-ledger.js:847 (validate relation+predecessor against the disposition and
   bind the completed target to a retained proposal).
   The test oracle was the same defect: it passed the desired scenario into BOTH `gateEvidence` and `linkRepair` then
   asserted the label it had supplied, and every ordinary fixture used `routingDigest(null)` as its item digest, making
   digest binding vacuous. Fixed with rejection cases built independently of the assertion.
2. Engine-receipt observations retained only a reference, so independently known spend vanished from reconciliation.
3. A retry erased unknown-ancestry censoring: the same-epoch branch overwrote `waveKind` with `retry`, and censoring
   keyed only on `waveKind === 'unknown'`, so unknown-ancestry work became complete and ELIGIBLE. RULING: keep `retry`
   (it is true) and make ancestry-unknown explicit and independent — `ancestryUnknown` at routing-ledger.js:1090,
   consumed by completeness/eligibility/ledger validation. This one attacked the `context` field added @b5382d3.
4. MEDIUM: the embedded ledger outcome skipped the label/cause/binary invariant the journal validator enforces, so a
   malformed censored revision could be selected as "latest validated" and trusted by eligibility.

**r2 — 3 of 4 FIXED clean; finding 2 PARTIAL with 2 new HIGH, both reproduced through the REAL producer:**
R2-1 the engine fix read `receipt.usage` (the Compose SUBMISSION shape) but persisted engine receipts store costs in
`ReceiptRecord.amount` (../stratum/ts/src/engine/receipts.ts:52) → real receipts materialized with null costs.
R2-2 engine evidence reused the connector provenance domain `reported|estimated|null` and refused `legacy`, which the
engine actually emits (receipts.ts:38, engine.ts:2762) → a legitimate receipt could not enter the journal at all.
**Root cause of both: the r1 PROBE was itself a synthetic producer, and the fix was fitted to the probe.** Fixed by
projecting both shapes explicitly and keeping engine provenance a separate domain from connector provenance. Driving
the real `buildReceipt` in the tests then exposed a THIRD instance neither review round found — partial estimated
receipts losing their known amounts the same way.
r2 also CONFIRMED: the initial-fresh interpretation holds (a real continuation probe at physical AND logical epoch 0
with a predecessor stays `unknown`, never `fresh`); journal-vs-ledger idempotency unconflated; off-mode identity
intact; S1a success-token equality exact; the ancestry check's narrowing to routed issuances is correct, not a
relocated hole.

Controller rename post-r2: `test/routing-review-r1.test.js` → `test/routing-evidence-validation.test.js` (a test file
named after a review round records process history, not subject). review-r2.md still cites the original name as history.

**LESSON — a review probe is a producer, and fitting a fix to a probe is fitting to a fake producer.** This is the
THIRD distinct appearance of the fake-producer class in this feature and the first one level up the stack. Fix briefs
must say "drive the real producer, and do not fit the new probe either".

## 2026-09-12 — S1b dispatch 3: deterministic goldens and documentation

Implementation extends `test/integration/build-wave-golden.test.js`,
`test/integration/gsd-route-continuation-golden.test.js`,
`test/build-team-fable-astra.test.js` and `test/helpers/build-wave-golden-fixture.js`.
`realCodexTool` gains an optional `sdkEvents` input generator; its existing default
behavior is unchanged. `goldenProviderTool` drives real Codex/Claude connectors,
and `paidWaveGolden` drives real Build/carry/normalization/receipt/gate producers.
No routing joins, acknowledgements, outcomes or ledger rows are seeded.

Actual APIs used: `resumeRouting`, `recoverRoutingEvidence`, `readRoutingLedger`,
`reconcileRoutingPaidReceipts`, `routingEligible`, `latestRoutingCall`,
`latestRoutingOutcome`, and `routingIssuanceState`. The connector entropy wrapper
preserves non-enumerable routing options. Off assertions check full input/options
and both ignore files. A/B same-profile receipt ownership is asserted independently
of the frozen helper's contiguous execute-call sorting. GSD continuation checks
original-owner spools and latest call/outcome evidence, with one logical start and
no rerun of decomposition or completed A.

No production defect was found; d1/d2 production files remain unchanged. Test
fixture corrections and all gate evidence are detailed in
`reports/slice1b-d3-impl.md`. The canonical ReviewResult contract and no-ceiling
late-delivery configuration are explicit; frozen expectations were not refreshed.

Blueprint Dispatch-3 checkboxes 1–4 are now closed. Final golden run:
**37 tests / 37 pass / 0 fail / 0 cancelled**, exit 0. Forwarding/local-effort
regressions: **23 / 23 / 0 / 0**. Multiple-owner baseline: **1 / 1 / 0 / 0**.
Each reversion of `lib/build.js`, `lib/stratum-mcp-client.js`,
`lib/result-normalizer.js`, or `lib/gsd.js` gives **1 / 0 / 1 / 0**, after a
**1 / 1 / 0 / 0** baseline. Removing additional forwarding checks gives
**21 / 4 / 17 / 0**; removing the multiple-owner refusal gives **1 / 0 / 1 / 0**.
All reversion scripts exit 0 (successful controls); the reverted/mutated Node
runs exit 1 with nonzero TAP fail counts and zero cancellations.

Exact final golden command (main checkout):

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 test/integration/build-wave-golden.test.js test/integration/gsd-route-continuation-golden.test.js test/build-team-fable-astra.test.js > /tmp/d3-evidence/golden-verified.log 2>&1
```

Exact reversion commands (cwd `/tmp/d3-evidence/negative-workspace/compose`, a
local shared clone with all five final test/helper files byte-identical to this
checkout, separate from concurrently running positive tests):

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 paid carry primary' --prod lib/build.js lib/stratum-mcp-client.js -- --test test/integration/build-wave-golden.test.js > /tmp/d3-evidence/revert-build-connector.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 paid carry success' --prod lib/result-normalizer.js -- --test test/integration/build-wave-golden.test.js > /tmp/d3-evidence/revert-normalizer.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 GSD production off/shadow' --prod lib/gsd.js -- --test test/integration/gsd-route-continuation-golden.test.js > /tmp/d3-evidence/revert-gsd.log 2>&1
```

Exact preserved-check controls and positives (main checkout; process-local load
hook substitutes the retained mutation source without working-tree changes):

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 --test-name-pattern='real normalizer forwarding|real Claude .* forwarding|local SDK raw presence' test/usage-receipts.test.js test/routing-calls.test.js > /tmp/d3-evidence/forwarding-positive.log 2>&1
D3_MODULE=lib/routing-runtime.js D3_SOURCE=/tmp/d3-evidence/no-evidence-checks.js STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --import /tmp/d3-evidence/substitute.mjs --test --test-timeout=900000 --test-name-pattern='real normalizer forwarding|real Claude .* forwarding' test/usage-receipts.test.js > /tmp/d3-evidence/no-evidence-checks.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 --test-name-pattern='residual B0 ownership for a.txt' test/build-model-route-outcomes.test.js > /tmp/d3-evidence/owner-positive.log 2>&1
D3_MODULE=lib/output-gate.js D3_SOURCE=/tmp/d3-evidence/no-owner-check.js STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --import /tmp/d3-evidence/substitute.mjs --test --test-timeout=900000 --test-name-pattern='residual B0 ownership for a.txt' test/build-model-route-outcomes.test.js > /tmp/d3-evidence/no-owner-check.log 2>&1
```

The report inventories every development test invocation and TAP tally, including
two early fixture-barrier timeouts; cancelled runs are not evidence. The first
full golden run (36 / 35 / 1 / 0) and strengthened subset (17 / 16 / 1 / 0) exposed
an incorrect test expectation for completed GSD's no-pause resume refusal; the
final 37/37 run supersedes them. All five changed JS files pass `node --check`;
`git diff --check` passes. All three frozen fixtures equal HEAD byte-for-byte.
The 259-test dispatch-2 production set was not rerun because production did not
change. No source change was needed to weaken an evidence check.
**LIVE-FIRE gate 5 remains OUTSTANDING.** No provider authorization was granted or
provider run performed. The parent feature remains incomplete pending S2/S3, with
no status change. Host full-suite verification remains outstanding; no full
`npm test` is claimed. README and team-presets describe only shipped recording,
unsupported/incomplete evidence and ledger behavior, without report/calibration/
feedback/learned-selection claims.

## Host adjudication — d3, 2026-09-12

Astra d3 run `512bf65e3708` (28m, 13.5M tok) reported 37/37. Verified independently: no production
file touched, three frozen fixtures byte-identical to HEAD, negative controls red in both
directions (four production reverts 1/0/1/0; removing the added duration/model/effort/provenance/
split comparisons 21/4/17/0; removing the multiple-owner refusal 1/0/1/0).

**The first HOST run was 36 / 31 / fail 0 / cancelled 5 at duration_ms 900008** — the whole-file
timeout cap, i.e. a HANG wearing the mask of four failures. Two test defects, neither in
production code:

1. **Hermeticity.** The goldens reach a real `execute_merge` gate; `lib/build.js:5915` delegates
   to the web UI whenever `probeServer()` answers. Only `npm test` escapes it, via the
   `--import ./test/suppress-expected-drift.js` preload (`package.json:23`) that sets
   `COMPOSE_PORT=19997`. The targeted golden command in `blueprint-slice1b.md` omits the preload,
   so with the dev server up on 4001 the DOCUMENTED command is the one that hangs. Astra could not
   see it: its sandbox cannot bind ports. Fixed as a control in
   `test/helpers/build-wave-golden-fixture.js` (sets `COMPOSE_PORT=19997` when unset; all three
   golden files import it; explicit values never overridden).
2. **Ordering assertion over a schedule the harness leaves free.** RESOLVED 2026-09-12 @66cee92.
   `build-wave-golden.test.js:344` pinned LAUNCH order of A0/B0, which the harness latch at
   `build-wave-golden-fixture.js:413` deliberately leaves free (it waits for both, then forces
   only RETURN order). Contradicted this gate's own adversarial-ordering requirement. Measured on
   the host 2026-09-12, selector `d3 paid carry` with `COMPOSE_PORT=19997`: pre-fix **2 of 6
   failed** (the `success` and `failed` variants, `fail 2 / cancelled 0`, 169s); post-fix **6/6**
   (185s) and **37/37** across the three files (271s). The same pre-fix code passed 37/37 in the
   astra sandbox, so this is not a measured flake RATE — it is an order-dependent assertion whose
   outcome tracks the scheduler, and the two environments disagreed. Now compared as a multiset;
   forced `returned` sequence stays exact. Negative control on wrong membership: 1/0/1/0.

**Final host tally: 37 / 37 / 0 / 0 in 271s, server UP on 4001, `env -u COMPOSE_PORT -u PORT`** —
the hang is gone and the count matches the dispatch. Gates 1-4 CLOSED. Gate 5 (live-fire)
OUTSTANDING: needs owner authorization and a real-provider shadow build; no deterministic result
closes it.

**LESSON — a sandbox that cannot bind ports cannot observe a live-server code path.** The
dispatch's 37/37 was true for its environment and false for the owner's. Astra sandbox results are
never the arbiter; the host is. Related: the documented targeted command was itself the trap, so
the fix belongs in the helper every golden imports, not in a note someone must remember.

## Pre-live-fire finding 2026-09-12 — Codex is unpriced, so no Codex call can be a complete sample

**CORRECTION 2026-09-12, same session:** the first version of this note (below) claimed an
unpriced model produces a COMPLETE attributable sample worth $0.00 and that gate 5 would pass
vacuously. **That was wrong at the last step, and the error was mine, not the code's.** Verified
empirically with a direct probe of `routingUsageEvidence`: a zero total makes
`result-normalizer.js:733-735` OMIT `cost_usd` from the usage record entirely, so
`routing-runtime.js:55` (`u.usd ?? u.cost_usd ?? null`) yields `null`, `presence.usd` is `false`,
and `routing-ledger.js:1286` marks the sample INCOMPLETE with `missing-usd`. Probe output:
`usd = null, presence.usd = false` for an omitted cost; `usd = 0.0021, missing-usd fires: false`
for a priced one.

So the real state is the opposite of a false pass: the ledger is honest, and it currently BLOCKS
gate 5 on the Codex side because no Codex call can ever be complete. The fix below is therefore an
ENABLING fix, not a safety fix. The `calculateCost` return value was left at 0 deliberately:
returning null would change nothing at its single caller (`total += null` coerces to 0) while
breaking a documented contract pinned by `test/model-pricing.test.js:100`.

### Original note (retained; its final inference was wrong)


Found while selecting models for the gate-5 live-fire run. NOT yet observed in a live ledger;
this is a source-verified hazard, and confirming or refuting it is now an explicit objective of
the live-fire run itself.

Two independent pricing tables both return **0** for a model they do not know, rather than null:

- `stratum/ts/src/judge/pricing.ts:26` — `usdFromTokens` returns `0` when `MODEL_PRICING` has no
  entry. Table holds exactly four models: `gpt-5.3-codex-spark`, `gpt-5.6-terra`, `gpt-5.6-sol`,
  `gpt-6-astra`.
- `compose/lib/model-pricing.js:57` — `calculateCost` returns `0` when `lookupPricing` misses.
  **This table contains ZERO `gpt-` entries; it is Claude-only** (verified: `grep -c 'gpt-'` = 0).
  This is the table that feeds routing usage evidence, via `lib/result-normalizer.js:492`.

Why that corrupts gate 5 rather than merely annoying: `result-normalizer.js:494-496` stamps the
computed value `usd_source: 'estimated'` whenever the provider did not report `cost_usd`. The
routing completeness check accepts it — `lib/routing-ledger.js:1286` flags `missing-usd` only when
the value is `=== null`, and `:1288` accepts `estimated` as valid provenance. A $0.00 estimate is
therefore a COMPLETE attributable sample, and "complete plus excluded reconciles to unique receipt
totals" holds vacuously at zero.

Consequence for the gate: a live-fire run whose Codex costs are estimated rather than reported
would tick gate 5 while proving nothing about spend attribution. **The run must verify, per row,
that Codex usage carries `provenance: 'reported'` with a non-zero `usd` — and a `provenance:
'estimated'` Codex row with `usd: 0` is a FAILED live-fire, not a passed one.**

Falsifier: resolved when either table refuses an unknown model (null/throw) instead of returning 0,
or when the routing completeness check treats an estimated-zero cost as incomplete. Check
`lib/model-pricing.js::calculateCost` and `lib/routing-ledger.js:1286`.

Also relevant to model selection: `server/model-tiers.js:14,22` maps tier `fast` to
`claude-haiku-4-5-20251001` and `gpt-5.3-codex-spark`, so a fast-tier preset yields the
Haiku + Spark pairing natively. No model named `luna` exists anywhere in compose or stratum
(searched `lib`, `presets`, `contracts`, `pipelines`, `stratum/ts/src`), and it is absent from both
pricing tables — so running it today would land exactly in the $0.00-estimated hazard above.
Owner ruling 2026-09-12: run Spark first, then add Luna to the pricing table and run it properly.

### Pricing verified against external sources 2026-09-12 (prompted by owner: "did you search?")

I had NOT searched before hardcoding prices. The owner asked. Searching changed two things.

**1. The diagnosis is confirmed externally, and the workaround is standard.** Codex CLI has no
built-in cost tracking and the feature request was closed without shipping; token counts land in
`~/.codex/` rollout files "with nothing pricing them"; `/status` shows requests but no tokens or
cost. OpenAI's own billing views aggregate by day and model, hours later, with no per-session or
per-agent attribution — which is the attribution this feature exists to produce. Third-party tools
(`ccusage`, `whoburnedmore`, agenticcontrolplane) all do exactly what we do: read local token
counts, multiply by a table. There is no mechanism we missed.

**2. Our prices were STALE, and so is the owner's routing rules doc.** Verified against the
LiteLLM community registry (3,889 keys, downloaded and grepped directly — a WebFetch of it
returns a truncated fragment and wrongly reports these models absent) and OpenAI's published
rate card:

| Model | Repo tables held | Actual | Note |
|---|---|---|---|
| `gpt-6-astra` | 10 / 50 | 10 / 50 | correct |
| `gpt-5.6-terra` | 2.5 / 15 | **2 / 12** | cut 2026-07-30 |
| `gpt-5.6-sol` | 5 / 30 | **4 / 20** | promotional from 2026-08-21, stated through >= 2026-11-21 |
| `gpt-5.3-codex-spark` | 1.75 / 14 | unpriced upstream | registry entry is subscription-billed (`chatgpt/…`, no cost fields); our figure is inherited and UNCONFIRMED |
| `gpt-5.6-luna` | absent everywhere | **0.2 / 1.2** | real model, budget tier of the 5.6 family; now priced, NOT yet routable |

`lib/model-pricing.js` now carries the corrected figures, pinned by
`test/model-pricing.test.js` (30/30; the four codex-coverage assertions go RED 4/0/4/0 when the
entries are removed, 23 pre-existing stay green).

**Follow-ups, NOT fixed here:**
1. **Two other tables remain stale.** `lib/experiment-pricing.js` and
   `stratum/ts/src/judge/pricing.ts` still hold terra 2.5/15 and sol 5/30, overstating by
   ~20-33%. Neither carries `gpt-6-astra` (experiment-pricing) — the flagship dispatch model.
2. **Three hand-maintained tables is the class defect.** compose has two, stratum a third, all
   drifting independently, and this incident is what drift looks like. The LiteLLM registry
   covers every model we dispatch except spark; a sync script plus a drift test would replace
   three hand-kept lists with one checked source. Not built — needs a decision on taking the
   dependency.
3. **Sol's rate is promotional and WILL move.** Re-check `gpt-5.6-sol` against the registry on or
   after 2026-11-21. Falsifier: `node -e` compare `lib/model-pricing.js` against
   `model_prices_and_context_window.json`.
4. **Luna is priced but not routable.** `server/model-tiers.js` has no luna entry, so nothing
   dispatches to it. Wiring it is a separate decision.

**Test-timeout correction:** `test/build-model-route-outcomes.test.js` needs **428s**; the 300s
cap in the operational kit and in a batch run reports it as `fail 0 / cancelled 1`, which reads as
a failure and is not one. Isolated at 900s it is **34 / 34 / 0 / 0**.
