# COMP-MODEL-ROUTE S1a — Dispatch 1 implementation

Implemented inline on 2026-09-10, from source revision `5fbf8e0bd5dae18eb92a08197b5a9a50743722dc` (package 0.5.1). Runtime participation remains disabled. No commit was made.

## Files

Created:

- `lib/model-router.js`: canonical JSON, versioned reachable-contract fingerprint, statistical keys, tuple-hashed issuance ids, pinned empty table, static resolver and typed routing refusals.
- `lib/routing-ledger.js`: closed-schema validation, immutable start/plan/request/run-binding persistence, exclusive start locks, Git storage protection, strict replay and lost-plan recovery, continuation transformations, journal validation and derived execution state. Does not create `ledger.jsonl`.
- `contracts/routing-start.schema.json`, `contracts/routing-record.schema.json`: draft-07 schemas with `_source` and `_roadmap`; closed routing structures and explicit v1 union tags. Domain documents such as exact flow input, contract definitions, source output and stepDone envelopes retain their JSON payload shapes.
- `test/model-router.test.js`, `test/routing-ledger.test.js`, `test/routing-journal.test.js`.
- `test/fixtures/model-route-off-bundled-build-v0.5.1.json`, `test/fixtures/model-route-off-carry-v0.5.1.json`, `test/fixtures/model-route-off-gsd-input-v0.5.1.json`.
- `test/helpers/record-model-route-baselines.mjs`: retained temporary recorder for the completed frozen captures; its loader transforms source in memory. It archives the pinned revision, uses the installed dependencies and existing Stratum test-bin resolution, and skips fixtures already marked captured.
- This report.

Changed:

- `lib/pipeline-profiles.js`: closed route/mode validation, runtime policy override refusal, static projection before hashing, non-enumerable policy/provenance, original prior and explicit-vs-default-role evidence.
- `lib/flow-state.js`: routing-specific snapshot validation, strict run discovery, verified step epoch lookup. Existing cost readers retain their error semantics.
- `lib/consumer-fanout.js`: optional routing binding on first journal creation, validation on reload, atomic immutable admissions/issuance/index/event primitives, linked dispatch records. Existing receipt methods and usageReport behavior are unchanged.
- `test/pipeline-profiles.test.js`: route policy, provenance and digest regressions.

No Build/GSD runner, preset, YAML, package/dependency, persistent golden harness, progress ledger or other feature file was edited. The pre-existing untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` was left alone.

## Dispatch 1 checkbox → evidence

| Blueprint §8 Dispatch 1 checkbox | Status and pinning test |
| --- | --- |
| Freeze actual bundled Build digest, feature input and both-provider call projections before production edits | **Captured.** Original production golden `test/build-team-fable-astra.test.js:43`; recorder runs this test from the pinned source archive. Fixture contains the exact input envelope and ordered provider/prompt/options calls. Digest is `310f9698e97212f695ce2ca752d724f90c1f233ab5855dcb33a26bd3ad786205`. Ongoing off hash pin: `test/pipeline-profiles.test.js:90`. |
| Freeze carry and GSD input identity separately, with source revision | **Carry and GSD captured.** Carry: `test/integration/build-wave-golden.test.js:103`, digest `247791ff900ad8b6e0bbcba7408591d1a74adbdce1ab9c8833ab6621589cc1cd`. GSD: `test/gsd-stuck-resume-golden.test.js:161` and `:261`; GSD was captured on the host from revision `5fbf8e0`; both legacy plan envelopes are retained. All three fixtures have `captured:true`. |
| Profile route shape/override refusal, legacy representation/hash, manual fallback vs item tier, metadata/gates | `test/pipeline-profiles.test.js:82`, `:90`, `:102`, `:115`; existing metadata/gate/provider/ownership tests remain. `test/model-router.test.js:36` verifies item-tier source and static decisions despite a manual fallback. |
| Stable fingerprints, distinct issuance identities, static would, null identities, no active/trial/explore output | `test/model-router.test.js:6`, `:13`, `:21`, `:29`, `:36`, `:45`. Reachable nested references, optionality, reordered unions/options/paths, unrelated definitions/task text, scope/stage/retry differences, malformed JSON and static provenance are pinned. |
| Schema/root/table corruption, immutable create/replay, pre-plan seed, continuation transform and lost-plan uniqueness/refusal | `test/routing-ledger.test.js:32`, `:71`, `:85`, `:92`, `:106`, `:180`, `:190`, `:208`, `:218`, `:232`. Three-run continuation preserves C allocation/admission through 2→1→0, retains cumulative A/B completion history, removes only current-source completions, records dependency removal and refuses source-token/graph/identity drift. |
| Atomic local issuance/token index, immutable record/event replay and changed-payload refusal, missing index/entry detection, ordinary recovery, off journal bytes unchanged | `test/routing-journal.test.js:37`, `:45`, `:55`, `:63`, `:78`, `:88`, `:94`, `:106`, `:124`, `:136`. Tests include exact prepared-result envelopes, refusal of unsupported settlement/duplicate launches, missing event sequence/link detection, retry predecessor enforcement and no receipt allocation. |

## Referenced primitive guarantees

- **Storage protection:** `test/routing-ledger.test.js:51` exercises real disposable Git repositories: dirty status, `git add -A`, staged diff, `git clean -fd`, a ship-like commit tree and linked-worktree `info/exclude`. Routing control files survive cleanup and stay out of commits. This is a primitive Git behavior test, not a claim that Dispatch 2 runner guards have shipped. Tracked reserved files, live writer locks, nested symlinks and verified-dead-owner reclaim are pinned at `:62` and `:169`.
- **Off identity:** `test/routing-ledger.test.js:100` proves no start/storage/ignore-rule writes; `test/routing-journal.test.js:88` proves absent routing keys and byte-identical legacy reopen. The bundled digest test preserves string vs default-only-object representation. Runtime off/shadow call equality remains Dispatch 2/3 work; the existing production golden still passes unchanged.
- **Fault boundaries:** `test/routing-ledger.test.js:92`, `:180`, `:218` inject faults before/after prepared-plan/request/binding publication. `test/routing-journal.test.js:94` and `:106` inject before/after admission, issuance/index, launch, result and settlement journal writes. Reopen sees either the preceding durable state or the complete new record and replays identical bytes. These are synchronous publication fault injections, not host power-loss tests. A real terminated child pid is used for dead-writer recovery.
- **Mapping pins:** `test/routing-ledger.test.js:190` covers original/effective spec and recorded-role evidence; `:208` covers same-named scoped defaults and reserved unseen tier mappings. `routingModelMappings(preflight)` includes ordinary resolutions, provider ladders and per-item tier/template capabilities; Dispatch 2 should pass a freshly constructed map of this shape to `validateRoutingRun`.
- **No acceptance claims:** schema v1 does not admit acceptance/cost/paid-call extension fields. `repairContext` remains `not-evaluated-s1a`; execution settlement is only token-bound bookkeeping. Receipts, supported-call joins, ledger materialization, learned choices and repair floors remain deferred.

## Resolved implementation choices and API details

1. Kept the blueprint's public function names and synchronous I/O convention. Added named helpers `recordRoutingPlanRequested`, `routingModelMappings`, `validateRoutingStart`, `validateRoutingRecord`, `validateRoutingJournal`, `routingIssuanceState`, `routingStaticInput`, `validateRoutingSnapshot` and `routingStepEpoch` for the stated persistence/recovery contracts.
2. A prepared plan and its requested marker are separate immutable `plan-intent` records. The prepared id is already present in `input.routing_plan_intent`; the marker id appends `-requested`. An immutable per-plan run pointer prevents binding one plan to two engine runs. The feature index uses a SHA-256 directory name, so feature text cannot become a path traversal. Recovery never calls plan.
3. Starts store authored and effective parsed spec identities separately. Effective literal fields use the existing `resolvePlanSpecValues` implementation (`$.input.role` authoring syntax). Routing transport is excluded only from static-input hashing, and full outgoing input remains pinned in the plan/binding digest. Calibration is empty and never interpolated.
4. Local records use the schema's explicit `{resolution, provenance}` route shape. `resolveRoute` also accepts a flat resolved baseline for pure callers. The root retains original prior, winner/source/via and fallback `{supplied, origin, profile, recordedRole}`. Only explicit overrides get manual provenance; default role substitution remains a spec/preset source.
5. Custom `{default,route}` wrappers project to strings; `{default,tier_from,route}` project to `{default,tier_from}`; existing objects without route retain object representation. The same projection is used for static shadow preflight, preserving its baseline dispatch identity. Non-enumerable `routingPolicy` and `staticProvenance` do not alter existing enumeration.
6. Event records carry a contiguous per-issuance `sequence` so JSON object-key order cannot change recovery state. The required per-issuance event tip/count is updated atomically with each event; missing final or intermediate events refuse. Identical id replay does not update journal timestamps. Retried issuances require their retained, settled predecessor and may not fork the chain.
7. Continuation epoch bindings retain source run/step/token/output independently of the consumer epoch. `resumeDetails.verifiedCompletedTaskIds` is the explicit adapter boundary for completion bookkeeping already validated by the runner; it is not inferred from an engine epoch. Earlier completions require retained continuation ancestry. Previous admissions stay byte-for-byte unchanged; new bindings carry physical indices/epochs. S1a conservatively refuses a continuation if prior recorded issuances are not settled.
8. Settlement currently requires matching accepted-token evidence along with the issuance's full physical identity. Missing tokens, advanced epochs or ready-state observations alone cannot settle a call. Broader failed/cancelled-call recovery evidence remains conservative until an adapter can provide verified token-bound evidence.
9. Storage uses fsynced temporary files, exclusive hard-link publication (atomic create without replacing a record), directory fsync, and per-start exclusive lock directories. Lock reclaim requires a valid recorded pid and ESRCH proof; an unreadable/unknown owner holds. Routing paths reject symlink components. Workspace comparison resolves macOS `/var` and `/private/var` aliases.
10. The root-bound constructor is a first-journal creation primitive. Dispatch 2 must apply §5's recorded-run initialization/missing-journal guard before constructing it; these primitives do not infer authorization to recreate an entirely lost artifact directory. They refuse adding a root to an existing legacy journal and detect holes on every participating reload.
11. Q1 was already ruled in `progress.md`: customized participating GSD ordinary dispatch must refuse with `ROUTING_STATIC_DISPATCH_MISMATCH`. No GSD execution path was altered in Dispatch 1.

## Reader inventory / handoff

| Reader boundary | Dispatch 1 disposition |
| --- | --- |
| Sidecar normalization, runtime merge and core preflight | Updated; route and `_routing` are validated then projected from dispatch/hash material. |
| Build wrapper, wave predicate, fresh/resume calls; GSD setup/context | Preserved, runtime participation disabled; Dispatch 2 owns wiring. |
| Recorded routing flow input / strict snapshots | Validators and exact intent/binding digest checks implemented; no YAML declarations added. |
| `context.routing` and separate stage-aware resolved-route map | Dispatch 2 adapter work; no new model prompt/options inputs. |
| Optional journal routing pin/records/tokenIndex/eventTips | Implemented, checked on read and atomic mutation. |
| Optional dispatch binding routing reference | Implemented, including linked identity and static profile comparison. Legacy fields retained. |
| Detailed GSD graph reader / paused state / blackboard | Preserved; pure continuation consumes detailed validated evidence without changing these files or shapes. |
| Existing receipts and artifact envelope readers | Existing receipt storage/delivery methods unchanged; consumer prepared-artifact envelopes remain authoritative. |

## Baseline capture status

All three fixtures have `captured:true` and source revision `5fbf8e0bd5dae18eb92a08197b5a9a50743722dc` (0.5.1). Bundled Build and carry were captured in the original sandbox run. GSD was subsequently captured on the host from that frozen revision after the sandbox refused its Stratum flow lock. Its fixture contains both legacy plan inputs. These are real-engine/connector fixtures with recorded inference, not live paid-model evidence. No fixture was regenerated during fix run r1.

## Validation

Each new test file was first run red against the requested absent API; pipeline profile extensions also ran red before production implementation. The initial pure/profile red run had 35 passes and 4 failures; the initial ledger import failed; the initial journal run had 7 failures. Each reached green after implementation. Subsequent focused regressions exposed and pinned scope, provenance, path, reload-link and retry-chain fixes.

Final required targeted command:

```sh
RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/model-router.test.js test/routing-ledger.test.js test/routing-journal.test.js test/pipeline-profiles.test.js test/build-team-fable-astra.test.js test/build-wave-routing.test.js test/gsd-wave-routing.test.js
```

Result: **90 tests passed, 0 failed, 0 cancelled, 0 skipped, 0 todo; exit 0**. Duration: 24.860 seconds. Raw local output: `/tmp/model-route-targeted-final.log`.

`git diff --check` passed. The full suite and `test/package-start.test.js` were not run. Baseline capture was the only additional real-engine golden invocation, as required before production edits. No commit, push or external message was sent.

## Six-line summary

Dispatch 1 contracts and pure/durable routing primitives are implemented; runtime participation is disabled.  
Bundled Build and carry baselines were captured from the pinned 0.5.1 source before production edits.  
GSD baseline was captured on the host from revision `5fbf8e0`; all three fixtures are `captured:true`.  
The exact bundled off-mode digest is pinned and preserved.  
The requested targeted run passed all 90 tests; `git diff --check` passed.  
No full suite, package-start test, runner/preset/YAML edit, dependency change or commit was made.

## Fix run r1

All five accepted HIGH findings are addressed within Dispatch 1 ownership. Runtime wiring remains Dispatch 2 work.

1. **Fingerprint:** Parse Stratum enum literals, parenthesized enum arrays, optionality and nested arrays into canonical nodes; share reference traversal with reachableContracts. Both actual bundled YAMLs enter resolvePlanSpecValues → preflight → createRoutingStart. Pin: `test/routing-ledger.test.js:296`.
2. **Continuation journal:** The constructor accepts routingAncestry from exportRoutingJournal(). initializeRoutingJournal validates the predecessor snapshot and complete new journal before the first atomic write, including retained records, token index and event tips. Missing ancestry or retained allocation evidence publishes no journal. Continuation bindings validate their admission/issuance references and completion-chain links. The three-run test uses only public journal APIs and exercises both first-publication fault boundaries. Pin: `test/routing-ledger.test.js:109`.
3. **Continuation validation:** Check immediate graphs against predecessor filteredGraph and require cumulative completion history to retain every reachable ancestor completion. Pin dropped A as ROUTING_CONTINUATION_HISTORY_DRIFT and unexplained C description edits as ROUTING_CONTINUATION_GRAPH_DRIFT, including refusal to publish matching altered epoch/source evidence. Pin: `test/routing-ledger.test.js:184`.
4. **Issuance events:** Maintain required eventTips[issuanceId] = {count,eventId} atomically with issuance/event publication; validate both index directions and sequence on reload. Final launch and trailing prepared-result loss refuse with ROUTING_BINDING_MISSING; the middle-event loss test remains. Pin: `test/routing-journal.test.js:146`.
5. **Inert metadata:** Skip underscore-prefixed ids in route-entry projection while validating reserved _routing separately. Preserve both reported metadata objects exactly and compare the full enumerable off preflight output and digest against the real HEAD implementation loaded read-only. Pin: `test/pipeline-profiles.test.js:124`.

Grammar edge cases: `test/model-router.test.js:51`. Event-index corruption: `test/routing-journal.test.js:161`.

Validation: the exact requested seven-file command passed **97 tests, 0 failed, 0 cancelled, 0 skipped, 0 todo; exit 0**, in 23.231 seconds. Log: `/tmp/model-route-fix-r1-tests.log`. The same command was run twice, passing 97/97 both times; the second run includes retained-reference validation and the third-run epoch binding. No full suite, baseline regeneration, runner/preset/YAML edits, receipts or commit.

Fix run r2: Normalize `stage.out` once to `root = stage.out ?? null` for both closure construction and traversal; added a Stratum-validated two-step omitted-`out` regression through resolvePlanSpecValues → preflight → createRoutingStart and persisted readback.
Validation: `RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-ledger.test.js test/model-router.test.js` passed **24 tests, 0 failed, 0 cancelled, 0 skipped, 0 todo; exit 0**. Only the three requested files edited; no commit.
