# COMP-MODEL-ROUTE S1a — Dispatch 1 correctness review r2

Reviewed 2026-09-10 against the five accepted r1 findings, progress adjudication and implementation “Fix run r1”.
HEAD: `5fbf8e0bd5dae18eb92a08197b5a9a50743722dc`; implementation remains uncommitted.

| R1 finding | Status | Re-run probe evidence |
| --- | --- | --- |
| 1. Bundled contract fingerprints refuse enum literals | FIXED-WITH-NEW-ISSUE | Both actual YAMLs pass `resolvePlanSpecValues` → preflight → `createRoutingStart` → persisted-start readback (`test/routing-ledger.test.js:296`); absent-`out` custom flow fails as detailed below. |
| 2. Public API cannot initialize continuation journals | FIXED | Three runs use `recordRoutingRecord`, `exportRoutingJournal` and constructor ancestry import exclusively; reopen preserves C's admission/allocation through indices 2→1→0, token index and event tips; both initial-publication fault boundaries pass (`test/routing-ledger.test.js:109`). |
| 3. Continuation loses cumulative history or changes description | FIXED | Dropping A refuses `ROUTING_CONTINUATION_HISTORY_DRIFT`; changing C's description refuses `ROUTING_CONTINUATION_GRAPH_DRIFT`, including publication of matching altered epoch/source evidence (`test/routing-ledger.test.js:184`). |
| 4. Losing the final execution event permits relaunch | FIXED | Delete only the FINAL launch event, then separately the trailing prepared-result event: constructor reopen and event replay both refuse `ROUTING_BINDING_MISSING`; restored journals recover their original states (`test/routing-journal.test.js:146`). |
| 5. Off projection rewrites/rejects inert underscore metadata | FIXED | Real HEAD module versus current full serialized off preflight matches with both `_comment:{default:'label',route:{learn:true}}` and `_unknown:{route:'some metadata',inert:true}`; digest matches at `6904380f…b617c`. |

**New finding: MEDIUM — Shared closure traversal rejects a valid omitted output contract.**

Location: `lib/routing-ledger.js:190`, `lib/model-router.js:75–83`.
The start producer normalizes `closure.root` to `null`, but passes unnormalized `stage.out` to
the newly shared `reachableContracts` traversal. Its walker accepts `null` and rejects `undefined`.
An agent step without `out` therefore aborts an otherwise valid custom participating flow before plan.
Stratum permits omitted `out` (`../stratum/ts/src/ir/schema.ts:66`); Compose's existing output-contract
adapter also handles this case (`lib/build.js:498–513`).

Probe: a two-step custom flow has a Codex `work` step without `out`, followed by a Codex `finish`
step returning `Result`, a valid flow output and all five optional routing transport declarations.
The installed Stratum production `validateSpec` returns `ok:true`; `resolvePlanSpecValues` and shadow
preflight succeed; `createRoutingStart` throws `ROUTING_SCHEMA_INVALID: Invalid contract definition`
at the shared walker. Disposable reproducer: `/private/tmp/model-route-r2-extra-probes.mjs`.
Fix: compute `const root = stage.out ?? null` once and pass it to both closure construction and
`reachableContracts`; add a production-start regression with a Stratum-validated omitted-`out` step.

Test-path assessment: no new fake-producer test found in the five fixes. Bundled tests load real YAML
and sidecars, modifying only required transport declarations. Continuation storage now enters public
journal APIs, including issuance/event indexing; corruption tests alter durable bytes only after public
publication. The metadata test loads actual HEAD code. Snapshots, admissions and settlement envelopes
remain synthetic primitive inputs, so these tests do not establish real engine launch/stepDone recovery
or Dispatch 2/3 runtime behavior. The new absent-`out` issue is a coverage gap, not a producer bypass.

Surrounding regression review: inspected the complete tracked diff and new routing modules, schemas,
tests and recorder. No additional regression found outside the five fix areas. There is no separate r1
source commit available; the reported +338/-11 was not independently reconstructed as an exact patch.
All four bundled sidecars' full enumerable off preflight outputs match HEAD. With only the clock fixed,
initial off journals and legacy `recordDispatchBinding` writes match HEAD byte-for-byte. No runner/preset
wiring, receipt behavior or existing cost-reader change was pulled into these fixes.

Validation: **97/97 passed**, zero failures/skips/cancellations, across individual files `model-router`,
`routing-ledger`, `routing-journal`, `pipeline-profiles`, `build-team-fable-astra`, `build-wave-routing`
and `gsd-wave-routing`; log `/tmp/model-route-review-r2-tests.log`. Additional disposable probes verified
the new refusal and HEAD parity (`/private/tmp/model-route-r2-off-check.mjs`). `git diff --check` passed.
No full suite, production/test edits, fixture regeneration, commit or push; only this report added.

**Verdict: 0 HIGH, 1 MEDIUM, 0 LOW.**
