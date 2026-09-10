# COMP-MODEL-ROUTE S1a Dispatch 3 — independent review r1

Reviewed the uncommitted scoped changes against `36dcf5dd9234b415b7e18a24989c5e16e8e43f8c`.
Verdict: **2 findings: 0 HIGH, 1 MEDIUM, 1 LOW.**

1. **MEDIUM — GSD's off oracle hides missing plan options.**
   `test/integration/gsd-route-continuation-golden.test.js:227` constructs
   `opts: { ...p.opts, workspaceRoot: '<workspace>' }` on both sides.
   This inserts the only frozen option even when the producer omits `opts`
   entirely. A disposable mutation probe deleted `workspaceRoot`, deleted
   `opts`, and replaced the root with `/wrong/workspace`; all three comparisons
   still passed. Substituting a known fixture path is legitimate; inventing a
   missing key weakens the claimed complete plan-option comparison and the
   GSD receipt cited at `docs/features/COMP-MODEL-ROUTE/design.md:436`.
   Fix: first assert each actual plan's `opts.workspaceRoot === f.cwd`, then
   compare its complete options against the frozen options with only the
   expected workspace value substituted. Add a missing-options negative control.

2. **LOW — the release note still describes the pre-fix result.**
   `CHANGELOG.md:5` says “Two production defects remain as failing goldens.”
   Both production fixes are in this diff, both defect goldens now pass, and
   `docs/features/COMP-MODEL-ROUTE/reports/slice1a-d3-impl.md:111` explicitly
   records their resolution. The linked report's opening also remains historical,
   so readers must reach the appended fix section to find the current outcome.
   Fix: describe D3-1/D3-2 as fixed in the CHANGELOG and link directly to the
   report's `#defect-fixes-d3-1-d3-2` section; label the report opening historical.

Review conclusions and evidence:

- **D3-1 scope and fences:** `lib/build.js:4507` selects consumer descriptors;
  `:4528` requires recorded routing context and a single-stage fanout before
  filtering. Off/legacy and deferred multi-stage paths still receive the full
  descriptor batch. The seven legacy inconsistent-evidence cases at
  `test/build-wave-routing.test.js:23` pass with zero worker calls, including
  descriptor-epoch and generation refusals. The real pending-sixth-item refusal
  at `test/integration/build-wave-golden.test.js:166` also passes.
- The admitted descriptor's checks are unchanged: full recorded wave length,
  item index/epoch, descriptor generation/item/epoch at `lib/build.js:1360`,
  retained input/provenance/baseline at `:1277`, and live issuance token/item
  generation at `:1099`. Unseen siblings still traverse these checks. A repeated
  seen descriptor is ignored, not substituted into its queued work; it cannot
  authorize another dispatch. Queued work retains its original binding and is
  fenced again against live token/epoch/generation at `:1173` before inference
  (`:1764`); settlement checks accepted-token/generation at `:1160`. No new
  route for a genuinely drifted sibling to launch was found. The concurrency-3
  shadow carry golden completes both waves and all 12 expected calls.
- **D3-2 precedence:** `lib/gsd.js:1291` compares persisted run IDs and consults
  `pendingRoutingPlans`; `lib/routing-ledger.js:576` reads durable feature pins,
  starts and plan bindings. Current invocation flags and timestamps are absent
  from this decision. Same-owner pauses retain precedence.
- Disposable `/tmp/d3-review-probes/probe.mjs` used the real golden child driver
  to produce halt→crash histories, without seeding pause/state/blackboard files.
  It evaluated the exact HEAD resume-loader function and the working-tree loader
  on the same artifacts with `claim:false`. Off: routing index empty, both
  returned the identical graph `[B,C]` and run-1 pause owner despite state naming
  run 2. Shadow, resumed with `route_mode:'off'`: HEAD chose run 1; the fix chose
  indexed run 2, and detailed completion filtering left `[C]`. Both off and
  participating halt-only controls selected the pause, identically to HEAD.
- **Frozen oracles:** `test/helpers/build-wave-golden-fixture.js:223` only reads
  fixtures; Build comparisons use them as EXPECTED at
  `test/integration/build-wave-golden.test.js:274` and
  `test/build-team-fable-astra.test.js:144`. All three frozen files match HEAD
  byte-for-byte and match the SHA-256 values in the implementation report.
  No recorder was invoked and no fixture was regenerated.
- **Order and sensitivity:** `test/helpers/build-wave-golden-fixture.js:239`
  sorts only contiguous `execute/N` calls, bounded by ordinary steps. For this
  carry trace those are the concurrent waves. Independently applying every
  control at `test/integration/build-wave-golden.test.js:320` caused the actual
  equality assertion to throw: prompt, sandbox, added option, ordinary-step
  order, and cross-wave worker swap. An `execute/1`↔`execute/2` swap passed.
  Other concurrent worker/receipt assertions sort or match by identity.
  Bundled worker/review order is sequential; GSD chooses and awaits one ready
  consumer at a time (`lib/gsd.js:533`). No connector-arrival-order flake found.
- **Producer authenticity:** no new fake-engine producer oracle was found.
  Build uses real plan/stepDone/connector calls with substituted Claude inference
  and a fake Codex executable (`test/helpers/build-wave-golden-fixture.js:153`).
  The GSD harness substitutes inference (`test/integration/gsd-route-continuation-golden.test.js:67`),
  but executes real engine RPCs and worktree merges. SIGKILL follows real plan
  or gate RPCs (`:121`, `:131`); the injected budget response (`:136`) reaches
  production halt writers. Its file writes create inputs, TaskResults, traces
  and the deliberate Git conflict, not pause/state/blackboard control evidence.
  The direct fake-executable self-test and static oracle controls are explicitly
  harness tests, not substitutes for the real producer goldens.
- **Design receipt:** `design.md:436` has valid Build digest/input/full-call and
  no-routing-write evidence from both cited Build tests. The GSD receipt proves
  fresh/resume input and flow identity plus absence of routing storage/journal
  fields, subject to finding 1 for options. Its frozen fixture is input-only,
  not a GSD model-call or profile-digest oracle. The substitution caveat is
  discoverable in `CHANGELOG.md:5`, the cited helper's `:230` comment, and
  `slice1a-d3-impl.md:45` / `:79`: cwd/workspace, UUID and TAP duration changes;
  functions and signals are outside the JSON boundary.
- **Documentation scope:** `README.md:93` matches bundled defaults and opt-ins;
  `:95` describes programmatic mode selection, `:103` recorded resume mode,
  and `:105` sidecar projection/custom-input restrictions. `:114` explicitly
  limits S1a to static choices. Neither the new README section nor Dispatch 3
  release note claims shipped attributable receipts/ledger, learned or active
  selection, or routing reports. Existing wave receipts are not S1b attribution.

Validation: eight individual test-file invocations, each with disposable
`STRATUM_STATE_ROOT` and empty service keys; **112/112 passed**, no skips.
Counts: Build golden 10; GSD continuation golden 10; bundled preset 3;
Build model-route 41; GSD model-route 19; GSD stuck/resume 6;
Build wave-routing 19; GSD wave-routing 4.
Logs: `/tmp/d3-review-build.log`, `/tmp/d3-review-gsd.log`, and
`/tmp/d3-review-<test-basename>.log`; precedence/control probe logs are
`/tmp/d3-review-probe.log` and `/tmp/d3-review-controls.log`.
No full suite, GUI, fixture regeneration, production/test edits, commit or push.
Only this requested review report was added; pre-existing unrelated changes were left intact.
