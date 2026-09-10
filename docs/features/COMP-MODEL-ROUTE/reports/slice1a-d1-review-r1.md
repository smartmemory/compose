# COMP-MODEL-ROUTE S1a — Dispatch 1 independent review r1

Reviewed 2026-09-10 against `blueprint-slice1a.md` §§2–7/§8 Dispatch 1 and the progress rulings.
Base: `5fbf8e0bd5dae18eb92a08197b5a9a50743722dc`; inspected the working diff and new files.

**Verdict: 5 HIGH, 0 MEDIUM, 0 LOW.**

1. **HIGH — Fingerprinting rejects the actual bundled output contracts.**
   Evidence: `lib/model-router.js:40–47` treats every word in a type string as a primitive or named
   contract; `lib/routing-ledger.js:190–191` applies this to every start's output closure.
   Stratum interprets `a|b` as literal enum values, including parenthesized enum arrays
   (`../stratum/ts/src/ir/validate.ts:63–92`), not references to contracts named `a` and `b`.
   Probe: load each actual bundled YAML, add only the required optional transport declarations,
   resolve inputs with `resolvePlanSpecValues`, preflight, and call `createRoutingStart`.
   Team Fable/Astra refuses with `ROUTING_SCHEMA_INVALID: Missing referenced contract critical`;
   GSD refuses with `Missing referenced contract complete`. Dispatch 2 cannot enable these presets.
   The test “fingerprint follows reachable contracts, optionality, unions and unordered option/path sets”
   (`test/model-router.test.js:13–19`) uses `string|number`; both happen to be in the primitive allowlist.
   It bypasses the production contract producer and therefore passes without exercising literal enums.
   Fix: parse the supported contract grammar, preserving optionality/array nesting and canonicalizing
   enum values independently of named references. Share that traversal with `reachableContracts`
   (`lib/routing-ledger.js:224–232`) and test closures from both actual presets.

2. **HIGH — The public journal API cannot initialize a continuation journal.**
   Evidence: `lib/consumer-fanout.js:511–537` publishes a new journal with the continuation run binding
   but empty `records`/`tokenIndex`. Every routing mutation reloads first (`:414–416`, `:456–457`).
   `lib/routing-ledger.js:305–315` then requires the previous run binding and continuation intent
   to already be present. There is no atomic initialization/import API that can install that ancestry.
   Probe: obtain the real `binding2` produced by `bindRoutingRun` in the three-run scenario, construct
   `ConsumerFanoutArtifacts` for run2, then call `recordRoutingRecord(oldBinding)`.
   It refuses `ROUTING_BINDING_MISSING: Missing continuation ancestry`; reopening also refuses.
   The constructor has already durably written this invalid journal.
   “three-run continuation preserves C allocation through 2→1→0…” bypasses this production producer:
   its `put` directly mutates a plain records object (`test/routing-ledger.test.js:112–114`), and
   `:144–161` changes the run binding and inserts ancestry/issuances without the journal API.
   Fix: provide a validated atomic first-journal initializer carrying the retained ancestry, admissions,
   issuances, events and token index, and exercise it through the public API before Dispatch 2 wiring.

3. **HIGH — Continuation validation does not enforce the retained transformation/history.**
   Evidence: `lib/routing-ledger.js:407–414` checks the immediate graph against its current epoch/source;
   `:419–435` walks ancestry but only validates completion IDs supplied by the caller. It never requires
   the immediate graph to equal the preceding continuation's `filteredGraph`, or earlier completed IDs
   to remain in the cumulative set. Journal validation at `:310–315` checks only run/revision linkage.
   Probes using the three-run fixture and the real `createContinuationIntent`:
   - In run2, supply cumulative completions `[B]` instead of `[A,B]`, with otherwise unchanged valid
     records/snapshot. It accepts and emits `completedTaskIds:[B], completionChain:[]`, dropping A.
   - Change C's description in run2's graph and matching epoch/source evidence, retaining the unchanged
     first continuation and original admission. It accepts the replacement description under the old
     allocation/admission even though no retained transformation explains it.
   The existing test (`test/routing-ledger.test.js:139–143,160–165`) checks locally inconsistent edits
   and the successful cumulative case, not either break across the retained chain.
   Fix: validate each run's graph against its binding's continuation intent and enforce monotonic
   cumulative completion history from reachable ancestors; reject unexplained graph/history changes.

4. **HIGH — Losing the last execution event silently makes a launched issuance launchable again.**
   Evidence: `lib/routing-ledger.js:357–369` defaults to `prepared` and checks sequence continuity only
   among surviving events. Neither the issuance nor a separate index records the expected event tip.
   Probe: persist admission, issuance and launch-intent through `ConsumerFanoutArtifacts`; remove only
   that launch event from the journal, retaining the issuance and token index; reopen normally.
   Validation succeeds, `routingIssuanceState` returns `prepared`, and recording the launch again succeeds.
   An already-started execution can thus lose its uncertainty hold and be launched again on recovery.
   The same issue loses a trailing prepared-result envelope. This is individual-record loss, not a claim
   that the implementation must detect rollback of an entire internally consistent journal snapshot.
   “journal reopening detects … missing prepared-result event” (`test/routing-journal.test.js:124–128`)
   deletes a middle event while retaining sequence 2, so it passes solely because a sequence gap remains.
   “all admission/launch/result/settlement publication boundaries replay without a second launch”
   (`:106–120`) only replays record writes; it does not execute/recover a model-launch producer.
   Fix: atomically maintain a required per-issuance event tip/count or equivalent retained linkage;
   validate it on reload and test loss of the final launch/result event as well as middle-event loss.

5. **HIGH — Routing projection changes legacy inert metadata even in off mode.**
   Evidence: normalization preserves arbitrary underscore metadata (`lib/pipeline-profiles.js:77–78`),
   but `routingProfileProjection` iterates it as agent policy (`:252–257`) without skipping underscore IDs.
   Probe against the HEAD implementation: `{_comment:{default:'label',route:{learn:true}}}` is retained
   unchanged before this patch but becomes `{_comment:'label'}` now, with a different profiles digest.
   `{_unknown:{route:'some metadata',inert:true}}` was valid and now throws `PIPELINE_PROFILE_INVALID`.
   The unchanged Build wrapper reaches this projection (`lib/build.js:1659`) and exhibits the rewrite.
   This can reject a non-participating custom sidecar or invalidate an existing run's digest pin.
   The metadata test at `test/pipeline-profiles.test.js:24–30` only calls normalization and does not enter
   the new preflight projection. Fix: skip inert underscore metadata in the route-entry loop, handling
   only reserved `_routing` separately; compare full off preflight output/digest with legacy behavior.

Dispatch scope and handoff:

- All Dispatch 1 checkbox areas have files/tests, but fingerprint and durable continuation delivery are
  incomplete as above. The original public function names/argument lists are retained with additive
  options/helpers; the unusable continuation initialization seam is the material Dispatch 2 API blocker.
- `createContinuationIntent` additionally requires `resumeDetails.verifiedCompletedTaskIds` for current
  removals (`lib/routing-ledger.js:435`). Dispatch 2's detailed graph adapter must provide genuinely
  validated bookkeeping; the blueprint's listed detailed-return shape alone will not satisfy it.
- No Build/GSD wiring, preset/YAML opt-in, new routing receipt spool, paid-call joins or runtime routing
  participation was pulled forward. Their absence is correctly Dispatch 2/3 or S1b work.
- Policy/provenance remain non-enumerable preflight properties, outside `normalized` and the profile hash
  (`lib/pipeline-profiles.js:226–230`). Missing-root/table/input checks and zero/ambiguous/unreadable-plan
  holds pass the targeted primitive tests. Runtime enforcement remains unclaimed until Dispatch 2.
- `planned()` fabricates engine snapshots (`test/routing-ledger.test.js:25–30`), including for lost-plan
  recovery and strict-snapshot tests at `:71,85`. Journal fixtures fabricate bindings, issuance evidence
  and result envelopes (`test/routing-journal.test.js:11–26`). These prove local validation/storage,
  not actual plan/stepDone recovery; Dispatch 3 must enter the real producers.

Existing behavior and baselines:

- Off behavior is **not universally byte-identical**, because of finding 5. All four bundled sidecars'
  enumerable serialized preflight results do match HEAD exactly. With only the clock fixed, initial
  off journals and legacy `recordDispatchBinding` writes also match HEAD byte-for-byte. Existing cost
  snapshot readers are unchanged; no other non-participating regression was found in the inspected paths.
- All three fixtures now have `captured:true` and pin `5fbf8e0…` (`test/fixtures/model-route-off-*.json:2–6`).
  That revision is HEAD and its `package.json` is 0.5.1. Bundled/carry digests are `310f9698…`/`247791ff…`;
  they contain distinct feature/bug input envelopes and ordered Claude/Codex call records. GSD has two
  legacy plan envelopes with `featureCode`, `gateCommands`, `pre_merge_gate`, and no routing keys.
  These are plausible frozen baselines. The implementation report's GSD-blocked statements are stale.
- Capture chronology cannot be proved from untracked JSON. The documented host GSD capture occurred
  after edits, but the recorder archives the pinned Compose revision (`test/helpers/record-model-route-baselines.mjs:11,34–37`)
  and never recaptures a fixture already marked captured (`:45–47`). No evidence of regeneration from
  edited production code was found; this review did not regenerate any fixture.
- The recorder is safe to retain for these frozen fixtures: all three are skipped. It remains temporary
  tooling, not a Dispatch 3 expectation updater. Recreating a missing fixture uses current dependencies
  and resolved Stratum bins (`:36,38,54`), so Compose's source revision alone does not pin that environment.

Validation: 69/69 across `model-router`, `routing-ledger`, `routing-journal`, `pipeline-profiles`; 21/21
across `build-team-fable-astra`, `build-wave-routing`, `gsd-wave-routing`; `git diff --check` passed.
Additional disposable probes reproduced findings 1–5 using production APIs/actual preset inputs where
available; continuation perturbations are explicitly synthetic extensions of the existing fixture.
No full suite, baseline regeneration, production/test edits, commit or push. Only this report was added.
