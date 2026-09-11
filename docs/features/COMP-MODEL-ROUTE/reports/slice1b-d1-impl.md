# COMP-MODEL-ROUTE S1b — Dispatch 1 implementation

2026-09-11. Dispatch 1 only. Final D1 targeted result: **75 passed, 0 failed**; separate compatibility/golden run: **113 passed, 0 failed**. No commit or push. Runtime observation remains disabled. This report does not certify S1b runtime completion, Dispatch 2/3, or live-provider attribution.

## Built

- Extended all four Compose-owned contracts. RoutingStart gains a reusable `ProfileIntent` definition without changing generated start payloads. RoutingRecord retains S1a branches and adds explicit observation opt-in, metadata bundles, receipt owners, expected-evidence checkpoints, failure/cancellation settlement proofs, and versioned ledger rows. RoutingJoin defines call intents/resolutions/heads, unsupported observations and the separately compiled closed `receiptRouting` definition. RoutingOutcome defines snapshots, dispositions, acknowledgement witnesses, lineage and immutable outcome revisions.
- Extended the existing `ConsumerFanoutArtifacts` journal. `routingObservation: true` explicitly enables atomic issuance/index/event-tip/owner/metadata-spool publication; its default is false and no runner supplies it. `recordRoutingIssuance({prepareMetadata:true})` is also explicit. New issuances carry `observationVersion:1`; their bundle is mandatory on reload. `prepareRoutingMetadata(id)` upgrades only an unlaunched S1a issuance without rewriting its immutable bytes. Historical launches lacking evidence remain incomplete.
- Added immutable `bindRoutingCalls` observers, binding-local invocation slots, atomic resolution/head/checkpoint/spool writes, monotone evidence improvements, raw field-presence checks, original-owner reads, exact-payload delivery acknowledgements, and a metadata delivery barrier primitive. No connector, normalizer or runner calls these new observers.
- Added evidence-derived outcome revisions, six-label/binary derivation, repair-stratum recording, reported-execution tier projection against pinned mappings, and one eligibility predicate. No floor is computed, compared or enforced. No routing policy, report, calibration, trial, exploration or learned selection was added.
- Added project-scoped ledger serialization and journal-path process locks. Locks reclaim only a verifiably dead PID (`ESRCH`), never `EPERM`, timeout, age or an unknown owner. Receipt delivery occurs outside journal locks. Ledger materialization reloads original owners while holding the project lock, writes incomplete rows, preserves immutable journal ids, advances ledger versions, fsyncs rows, quarantines incomplete crash tails and rejects malformed complete rows. Reconciliation unions owner-run/paid-receipt identities so child costs included in their parent are counted once.

The pre-existing untracked `docs/features/COMP-GUARD-CLAIM-1/audit.json` was left alone. No sibling Stratum or installed dependency was modified. No `npm install`, GUI, port binding, `ps`, full-suite run, or real-provider call was performed.

## Dispatch 1 checkbox evidence

These are the six checkboxes under the blueprint's **Dispatch 1**, not its later runtime/golden completion checkboxes. New tests use actual `createRoutingStart`, plan/request/run binding, `admitOrdinaryRoute` / `admitConsumerWave`, `prepareRoutingIssuance`, `routingEvent`, and real `ConsumerFanoutArtifacts`. The shared fixture is `test/helpers/routing-s1b-fixture.js`. Since D1 deliberately has no connector or gate hooks, raw call results and gate/failure/cancellation protocol inputs are supplied to the production primitives. They are not claimed as independently observed engine/provider responses.

| Blueprint checkbox | Status and test anchors |
|---|---|
| Immutable same-id refusal; append-only call chains; unresolved → late completion → repeat after reload/continuation; identity/usage/termination/gap/fork refusal | **Satisfied at the D1 primitive boundary.** `test/routing-join.test.js:8` drives two S1a consumer descriptors with the same profile, independent prescribed call ids/amounts and reversed primary/child completion. `:27` covers late completion and byte-stable repeat after reload/ack. `:37`, `:46`, `:101` cover conflicts and missing middle/head/tail, including deletion of both a resolution and head against the retained checkpoint. `:122` rejects receipt amounts inconsistent with raw call evidence atomically. `test/routing-ledger-materialize.test.js:64` creates an actual S1a continuation intent and new binding, then resolves and delivers at the old owner without moving the spool. `test/routing-outcome.test.js:119` covers immutable, derived outcome revisions and one latest chain. |
| Atomic issuance/index/event-tip/owner/pending metadata across publication crashes; missing participating journal/incomplete S1b bundle refuses; exact metadata payload | **Satisfied.** `test/routing-journal.test.js:178` runs both before/after-write fault cases through the S1a issuance producer with explicit D1 opt-in; verifies marker, token index, tip, original owner path, exact `compose:route:<originalRunId>:<token>`, payload key set, `source`, `usage:{}`, null call/intent fields, selected-route reference and canonical digest; corrupts each bundle component and refuses reload. `:211` covers unlaunched S1a upgrade and historical-launch refusal. `test/routing-join.test.js:77` covers missing real journal; `:85` covers metadata acknowledgement barrier, lost delivery, concurrent journal mutation during delivery, cancellation delivery refusal and exact-byte acknowledgement. |
| Six labels, cancellation precedence, three binaries and unknown causes; success equality unchanged; separate failure/cancellation proofs | **Satisfied at the D1 primitive boundary.** The table at `test/routing-outcome.test.js:23` exercises all six labels and all three binaries. `:44` retains cancellation censoring after a linked replacement; `:55` rejects uncertain child teardown; `:62` validates the exact prepared failure request/envelope and rejects absent success token / absent acknowledgement. `:77` separates token-response, token-engine-witness, ordinal and unconfirmed gate evidence; `:82` censors ambiguous partition evidence. `:143` proves later cost evidence does not invalidate an already witnessed cancellation. Existing S1a equality/event tests remain at `test/routing-journal.test.js:63`. Actual engine failure/cancellation capture, lost-RPC replay and GSD exit reachability remain D2. |
| Eligibility excludes unsupported/incomplete/censored populations and null executed tier for tier claims; no report/policy/selection work | **Satisfied.** `test/routing-outcome.test.js:106` tests complete supported rows, declared key/cohort mismatches, local null-executed-tier exclusion from tier claims, and unsupported coverage rows. `test/routing-ledger-materialize.test.js:10`, `:23`, `:104` cover incomplete/unsupported/unknown exclusion and retained excluded costs. `test/routing-join.test.js:57`, `:70` distinguish absent call identity, forbidden substitutes, local effort, and independently witnessed nonexecution. Production scope inspection confirms no floor, report or selection implementation. |
| Crash/concurrent-safe ledger across starts; incomplete rows; late revisions yield one latest sample; unique paid receipt reconciliation | **Satisfied.** `test/routing-ledger-materialize.test.js:10` writes unknown/null-cost rows and then one latest completion revision without duplicate samples. `:23` pins parent-inclusive and child-excluded costs against independent amounts and unique receipt totals. `:32` covers before/after append faults, retained/quarantined partial tail and malformed complete-line refusal. `:57` runs four real child processes over two starts and shared owners. `:115` rejects duplicate/gapped versions and contradictory costs; `:123` writes nonexecution evidence with null cost. `test/routing-ledger.test.js:363` exercises real lock acquisition, live-owner refusal, child-process death reclamation and unverifiable-owner refusal. |
| Repair context recomputed from journal admission/epoch/validated lineage; fresh/repair/retry/depth2/unknown; no task-name inference or floor | **Satisfied under the initial-fresh interpretation documented below.** `test/routing-outcome.test.js:86` checks fresh, first repair, depth-two repair, same-epoch retry and missing-lineage unknown. `:131` censors multiple plausible predecessors. `test/routing-ledger-materialize.test.js:82` materializes these strata after corrupting only the in-memory cache and proves disk records win. `:104` uses S1a consumer producers for identical task ids/text in two different source waves and asserts unknown/null lineage rather than linking by name. No tier ordering enters `deriveRoutingContext`. |

## Actual APIs and reader inventory

| Surface | D1 API / reader |
|---|---|
| Schema loading and validation | Existing `validateRoutingRecord`/`validateRoutingJournal` now dispatch the new branches. Dedicated `validateRoutingJoin`, `validateRoutingOutcome`, `validateReceiptRouting`, `validateRoutingLedgerRow`; `validateRoutingReceiptSpool` checks original joins, exact payloads and raw-versus-paid amounts on writes/reloads. The receipt validator is compiled from `routing-join.schema.json#/$defs/receiptRouting`, not a call-record validator. |
| Journal writes and reload | Existing constructor, `#mutate`, `#reload`, `recordRoutingIssuance`, `recordPendingUsageReceipt`, `acknowledgeUsageReceipt`; new `prepareRoutingMetadata`, `recordRoutingEvidence`, `recordRoutingCallIntent`, `recordRoutingCallResolution`, `recordRoutingObservation`, `recordRoutingCheckpoint`, `recordRoutingOutcome`. Every participating mutation uses the journal-path lock; initial creation/reopen also locks. |
| Call observation | `bindRoutingCalls({artifacts,issuanceId|observationId})` returns frozen binding plus `intent`, `resolve`, `child`. `routingUsageEvidence` accepts raw observed fields and presence, not normalizer defaults. `latestRoutingCall` validates sequence/predecessor/head/checkpoint evidence; `prepareRoutingResolution` only improves unknown facts. A confirmed identity, usage amount, execution result or termination cannot be contradicted. |
| Receipt preparation/delivery | `routingMetadataBundle`, `routingReceiptDetail`, `pendingRoutingReceipts`, `flushRoutingReceipts({artifacts,deliver,requiredDispatchId})`. Delivery callback receives **original physical run id** and the copied canonical pending payload. Only that payload may be acknowledged. Paid-delivery transport failures retain pending evidence; the required metadata id fails closed. |
| Original-owner recovery | `exportRoutingJournal` / `readRoutingRecord` retain their existing return contracts. Continuation copies typed owner/checkpoint records, never the spool. `openRoutingOwner` refuses missing original files before constructing a journal; `readRoutingOwners` validates root/run/revision/path and merges authoritative newer immutable chains rather than preferring retained unresolved copies. |
| Settlement and outcomes | Existing `routingIssuanceState` retains its original success equality. New failure acknowledgement and cancellation audit branches are separate. `deriveRoutingOutcome`, `prepareRoutingOutcome`, `latestRoutingOutcome` provide evidence-derived revisions; arbitrary caller labels cannot be inserted as derived outcomes. |
| Context, eligibility and ledger | `deriveRoutingContext`, `routingExecutedTier`, `routingEligible`, `materializeRoutingLedger`, `readRoutingLedger`, `reconcileRoutingPaidReceipts`, `acquireRoutingLock`. Materialization writes outcome revisions at original owners, then freezes call/outcome/context/cost evidence into ledger rows. Readers validate each complete row and contiguous versions; same journal id is immutable, while a ledger record's next version supersedes its previous version. |

D2 integration requirements: explicitly opt participating artifact managers into `routingObservation`; flush the required metadata id before the existing launch boundary; install observers only in the named connector paths; supply raw presence/provenance and real transport witnesses; call owner recovery/materialization from the specified runtime exits. Unsupported connector observations take a durable invocation-slot key in `callSite`; a reused observation cannot own a second launch. Recovery binds its retained observation/intent ids instead of allocating a new launch. Engine receipt observations use original run/receipt id with sequence/digest checks; coverage identities also include scope/stage/epoch.

## Specification corrections and underspecified boundaries

1. **Post-r2 `context`: initial freshness is not fully specified.** The blueprint names admission `repairContext` and epoch, but S1a's producer writes only `{state:'not-evaluated-s1a'}` (`lib/build.js:1060`). No approved truth table maps that state to fresh/repair/retry/unknown. This implementation treats physical **and logical epoch zero**, no predecessor issuance and no explicit repair/unknown marker as the initial fresh boundary. Every later unlinked epoch is unknown; explicit repaired lineage requires one executed predecessor, validated gate proof and recursively known depth. This is an implementation interpretation for review, not an owner ruling or a resolution of Q3. The schema additionally permits explicit recording states `fresh|repair|unknown` with evidence references; no runner currently produces them. The singular `repairOfRecordId` cannot represent multiple distinct predecessors; those cases are censored, not arbitrarily reduced to one predecessor or tier.
2. **Nested wire shapes need concrete choices.** The blueprint specifies the roles, but not the exact inner shapes, of raw usage, receipt refs, termination witnesses, gate witnesses, proof envelopes and ordinary snapshot entries. Their implemented shapes are the closed published schemas. In particular usage retains nullable aggregate tokens/duration/USD/model/effort, raw JSON, explicit presence and reported/estimated provenance; receipt refs bind original run/id/payload digest. Token-response witnesses retain the exact prepared request plus a response acknowledgement wrapper; token-engine witnesses must contain the consumed token and matching run/revision/scope/round/decision. D2 must adapt actual responses to these boundaries and independently test its adapters. D1 protocol-input tests do not establish that adaptation.
3. **The blueprint requires expected heads but does not name the retained checkpoint branch or atomic metadata marker.** Added typed `evidence-checkpoint` and `issuance-metadata` records, plus optional `issuance.observationVersion:1`. These stay inside `routing.records`, preserving the closed S1a routing subtree and allowing whole-tail and bundle-loss detection. Existing S1a issuances remain immutable.
4. **Existing provenance source values are `manual|preset|default`, not a new `spec` spelling.** Ledger source preserves the actual S1a vocabulary. Existing RoutingRecord now references the new closed schema unions, so the old schema-inventory test was extended to inspect those published contracts instead of assuming every branch is inline.
5. **Follow-up inventory differs between documents.** The blueprint tail lists three entries, while current `progress.md` has the five filed follow-ups named by the dispatch brief. No follow-up was repaired or refiled here. Build/GSD, cancellation loops, finding validation, sidecar behavior and the stale usage-sink comment are unchanged.

The skill's source/spec comparison is recorded here rather than rewriting the authoritative blueprint or reviewed documents. No contradiction was resolved by changing the approved scope.

## Commands and real results

Every test run was executed directly by Node. Runs were redirected to the listed `/tmp` log, followed by `result=$?; echo "EXIT_CODE=$result"` and an `rg` summary of TAP counts/errors. No test run was piped to `tail`. These are sandbox targeted results, not a trustworthy full-suite result.

Exact test command prefixes (the log redirection used for each invocation is in the table):

```sh
# A
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-ledger.test.js test/routing-journal.test.js
# B
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-join.test.js
# C
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-outcome.test.js test/routing-join.test.js
# D
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-ledger-materialize.test.js
# E
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-join.test.js test/routing-outcome.test.js test/routing-ledger-materialize.test.js test/routing-ledger.test.js test/routing-journal.test.js
# F
STRATUM_STATE_ROOT=$(mktemp -d /tmp/route-d1-compat-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/usage-receipts.test.js test/build-model-route.test.js test/gsd-model-route.test.js test/integration/build-wave-golden.test.js test/integration/gsd-route-continuation-golden.test.js test/build-team-fable-astra.test.js
```

| Command | Exact redirection | Tests | Pass | Fail | Exit | Interpretation |
|---|---|---:|---:|---:|---:|---|
| A | `> /tmp/route-d1-baseline.log 2>&1` | 31 | 30 | 1 | 1 | Old inline-only schema inventory assertion failed; corrected for referenced closed branches. |
| B | `> /tmp/route-d1-join.log 2>&1` | 8 | 8 | 0 | 0 | Initial join primitive coverage. |
| C | `> /tmp/route-d1-outcome.log 2>&1` | 24 | 24 | 0 | 0 | Join plus initial outcome matrix. |
| D | `> /tmp/route-d1-materialize.log 2>&1` | 7 | 6 | 1 | 1 | Consumer test descriptor omitted required `policy`, so S1a did not recognize its consumer stage; fixture corrected. |
| E | `> /tmp/route-d1-all-1.log 2>&1` | 65 | 65 | 0 | 0 | First combined D1 pass. |
| E | `> /tmp/route-d1-all-2.log 2>&1` | 68 | 67 | 1 | 1 | New lock test passed a `/var` symlink path on macOS; corrected to the canonical path, preserving production refusal. |
| E | `> /tmp/route-d1-all-3.log 2>&1` | 73 | 73 | 0 | 0 | Expanded chain, outcome, context and ledger checks. |
| F | `> /tmp/route-d1-compat.log 2>&1` | 113 | 113 | 0 | 0 | Existing receipt, Build/GSD routing and frozen real-engine golden regressions. Ran before the final S1b-only validation refinements; no runtime/off wiring changed afterward. |
| E | `> /tmp/route-d1-final.log 2>&1` | 75 | 75 | 0 | 0 | Added engine-reference and raw-versus-paid amount checks. |
| E | `> /tmp/route-d1-final-2.log 2>&1` | 75 | 75 | 0 | 0 | Final run after aligning immutable call-record conflicts with `ROUTING_CALL_EVIDENCE_CONFLICT`. |

All completed TAP runs above had **0 cancelled and 0 skipped**. One premature command, `node --test --test-timeout=300000 test/routing-join.test.js`, ran before that file existed: exit 1, `Could not find 'test/routing-join.test.js'`, **no tests executed**. It is not counted as a passing or failing test suite.

`git diff --check` passed. Schema imports passed. The frozen fixture comparison command passed with exit 0:

```sh
git diff --exit-code -- test/fixtures/model-route-off-bundled-build-v0.5.1.json test/fixtures/model-route-off-carry-v0.5.1.json test/fixtures/model-route-off-gsd-input-v0.5.1.json
shasum -a 256 test/fixtures/model-route-off-{bundled-build,carry,gsd-input}-v0.5.1.json
```

| Frozen file | Unchanged SHA-256 |
|---|---|
| bundled-build | `dcb7be4001879664d347a12abec6106a458329f7e61ca320ba211e9c7e77bf3a` |
| carry | `f806519cb4d86317e4565e0eb9e8280c21e1129ff0c569ae033006f70e9d679c` |
| gsd-input | `1fa3aae48bb0d0d928e8b6554d6e499f40dfcf32566737f2e5630a3f194b8ae2` |

## Verification limits

- **Full suite: NOT RUN.** Host execution is the arbiter, as requested. The two final targeted populations are reported separately; repeated intermediate passes are not summed into a larger test claim.
- **D2 runtime observation and producer guarantees: NOT VERIFIED / intentionally unwired.** No actual connector observation hook, pre-reset capture, gate acknowledgement adapter, engine-receipt ingestion hook, cancellation exit or terminal recovery hook was added. Unit protocol inputs are not real engine acknowledgement evidence. The existing S1a goldens prove regression behavior, not new S1b runtime calls or outcomes.
- **Live-fire complete shadow samples: OUTSTANDING.** No provider call was made and no real-provider ledger reconciliation is claimed.
- **Crash testing boundary:** real concurrent processes and dead-owner reclamation were tested; publication exceptions and a partial serialized row exercise the durability protocol. An actual machine power failure/filesystem failure was not reproduced. A lock with no verifiable PID intentionally refuses rather than guessing it is stale.
- **Engine-only spend:** the D1 observation contract preserves engine receipt identity/provenance and coverage gaps. Actual extraction and cost reconciliation of the engine-owned runtime population remain D2; connector-backed unsupported children are covered here.
- **Repair-context freshness:** the post-r2 interpretation above needs review. Q3's floor-policy decision remains open for S3 and was not answered by this implementation.

## Review r1 fixes

2026-09-11. All four accepted findings are fixed at the D1 contract/writer/reader boundary. This section supersedes the original report's blanket validation claims for checkboxes 3–6 and its deferral of engine-cost reconciliation. Runtime observation remains **DISABLED**; no Build/GSD, connector or normalizer wiring was added. No commit or push.

### Finding 1 — validate lineage against retained disposition/proposal evidence

- `lib/routing-ledger.js:847` validates the link's predecessor against exactly one per-issuance disposition and requires matching relation and defect evidence. Every standalone link must match a proposal retained inside that same disposition, including predecessor snapshot/admission/issuance and proposed digest. Embedded replacement proposals retain null future targets; later immutable links supply the completed target. A proposal cannot point at another disposition. Endpoint snapshot, admission and proposed-target digest checks remain enforced; `lib/routing-ledger.js:897` also binds ordinary snapshots to their actual admitted input digest.
- `test/helpers/routing-s1b-fixture.js:46` captures full ordinary admission inputs and uses different work bytes across epochs; `:89` accepts explicit proposals retained before replacement issuance. The six-label table remains classification coverage, with its positive replacement setups corrected to supply those earlier proposals. It is **not** treated as an independent evidence-validation oracle. Existing label assertions were retained, and exact context assertions were extended with the new ancestry field.
- New independent rejection tests: `test/routing-evidence-validation.test.js:13` constructs an approve/retained, non-defective gate with no proposal, then submits the conflicting repair link and checks atomic refusal plus the unchanged accepted predecessor. `:26` pins earlier proposal publication, distinct item digests, wrong target/predecessor/relation rejection, lost-proposal and false/null-defect reload refusal, admission-digest binding, and rejection of a completed target inserted into the proposal itself. `:64` proves a defect label without any retained proposal is insufficient and rejects a proposal associated with another gate.
- This validates recorded observation evidence only. The filed stronger gate-dispatch findings-partition enforcement remains unfixed.

Probe output (same review setup, with the expected write refusal caught so the remaining probes can execute):

```text
CONTRADICTORY_LINEAGE {"refusal":{"code":"ROUTING_BINDING_DRIFT","message":"Lineage contradicts per-issuance relation/defect evidence"},"gateRelation":"retained","oldOutcome":"accepted","newContext":"unknown"}
```

### Finding 2 — retain and reconcile known engine spend as excluded

- `contracts/routing-join.schema.json:1333` defines retained `engineReceiptEvidence` containing original owner, sequence, receipt bytes and projected usage presence/provenance. Unsupported observations carry that evidence or explicit null (`:553`, `:787`).
- `lib/consumer-fanout.js:895` adds `recordRoutingEngineReceipt({receipt, sequence, unsupportedReason, context})` for D2 to call with extracted engine evidence. `recordRoutingObservation` at `:901` also resolves the existing engine-reference API against independently retained, acknowledged original-journal receipt bytes, which preserves the review probe's API. Neither path creates an issuance or connector invocation.
- `lib/routing-ledger.js:766` projects only present engine amounts and receipt provenance; missing values stay null. `:774` verifies exact owner/id/sequence/payload digest and projected amounts/provenance against the retained bytes. Original-spool cross-checking also runs on journal writes/reloads. Connector/metadata receipts cannot become engine evidence, and engine observations cannot own connector calls. `:1157`, `:1330` and `:1365` validate the embedded ledger evidence, materialize known engine cost and reconcile it once per owner/receipt. Engine rows remain written, incomplete and EXCLUDED, with null issuance and no calls.
- `test/routing-evidence-validation.test.js:93` pins the exact 20-token/50-ms/USD-3 receipt, rejects independently wrong reference fields before a valid observation exists, reopens the journal/ledger and checks exact reconciliation. `:117` exercises the new extraction-boundary writer with known partial amounts and estimated provenance, null missing duration, byte-identical repeat, changed-byte refusal, corrupt journal and embedded-ledger evidence, mixed supported/excluded spend, deduplication and connector-identity refusal.
- The existing test at `test/routing-join.test.js:110` was wrong to credit provenance validation to a reference with no retained receipt bytes. Its fixture now stores and acknowledges the actual receipt first; all its previous replay/identity/sequence/coverage assertions remain.

Probe output:

```text
ENGINE_SPEND {"knownReceiptUsd":3,"cost":{"tokens":20,"durationMs":50,"usd":3,"provenance":["reported"],"paidReceiptRefs":[{"ownerRunId":"911802df-df82-4ae3-b399-07f83d07d573","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"}]},"reconciled":[{"ref":{"ownerRunId":"911802df-df82-4ae3-b399-07f83d07d573","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"},"tokens":20,"durationMs":50,"usd":3}]}
```

### Finding 3 — preserve retry truth and propagate unknown ancestry

- `contracts/routing-record.schema.json:2231` / `:2278` adds required `context.ancestryUnknown`. `lib/routing-ledger.js:1090` derives this independently of `waveKind`; the same-epoch branch still records `waveKind:'retry'` and carries the predecessor's ancestry fact through repeated retries.
- `lib/routing-ledger.js:1132`, `:1146` and `:1336` make eligibility, ledger consistency and supported-row completeness depend on ancestry knowledge. Unknown ancestry adds `unknown-repair-context`, keeps depth/lineage null and prevents a complete eligible routed row. Known retry ancestry must retain internally consistent depth and references. Unsupported child attribution can remain complete while its unsupported source excludes it; engine rows separately remain incomplete.
- `test/routing-evidence-validation.test.js:76` completes and acknowledges two successive retries of unlinked epoch-1 work, proves that their accepted outcome and retry wave kind survive while ancestry stays unknown, and checks persisted incomplete/ineligible rows. It also rejects forged complete status and an ancestry-known flag contradicting null lineage. Existing fresh/repair/depth-two/known-retry tests continue to pass.
- No repair-floor computation, comparison or enforcement is involved. Q3 remains OPEN for S3.

Probe output:

```text
UNKNOWN_RETRY {"prior":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"context":{"waveKind":"retry","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"completeness":{"state":"incomplete","reasons":["unknown-repair-context"]},"eligible":false}
```

### Finding 4 — enforce the same outcome invariant at the ledger boundary

- `lib/routing-ledger.js:833` extracts the existing journal label/cause/binary rule into `validateOutcomeClassification`; the standalone outcome validator still calls it. `validateRoutingLedgerRow` calls the same function at `:1139`, before a reader can select a revision or eligibility can trust its binary. Journal immutability and ledger versioning retain their different contracts.
- `test/routing-evidence-validation.test.js:151` appends malformed version-2 rows covering unknown-positive, unknown-negative, cancellation-negative and re-implemented-positive outcomes. Both `readRoutingLedger` and direct `routingEligible` reject them; restoring the original ledger still returns the valid version-1 row. No assertion was removed or weakened.

Probe output:

```text
INVALID_LATEST {"refused":true,"code":"ROUTING_BINDING_DRIFT","message":"Outcome binary differs from label/cause"}
```

### Probe execution and verification

The review's exact combined command 1 was rerun unchanged from the repository root (`/tmp/routing-r1-original-1.sh`, log `/tmp/routing-r1-original-1.log`). It now stops at the first invalid lineage write with:

```text
RoutingError: Lineage contradicts per-issuance relation/defect evidence
code: 'ROUTING_BINDING_DRIFT'
EXIT_CODE=1
```

That expected refusal prevents the original combined script from reaching its other cases. `/tmp/routing-r1-probes.mjs` retains its imports, setup and all four operations, adding exception capture only at the invalid lineage write and invalid ledger read. The four exact outputs above are from that rerun, **EXIT_CODE=0**. The unrelated continuation command 2 was also rerun unchanged, **EXIT_CODE=0**:

```text
CONTINUATION_CONTEXT {"physicalEpoch":0,"logicalEpoch":0,"hasPredecessor":true,"context":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null}}
EXIT_CODE=0
```

Final targeted commands (each output redirected, with the real test exit captured and echoed; no test output pipe):

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-r1-final-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-evidence-validation.test.js test/routing-outcome.test.js test/routing-ledger-materialize.test.js test/routing-join.test.js test/routing-journal.test.js test/routing-ledger.test.js > /tmp/routing-r1-final.log 2>&1
test_status=$?
echo "EXIT_CODE=$test_status"

STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-r1-compat-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/usage-receipts.test.js test/build-model-route.test.js test/gsd-model-route.test.js test/integration/build-wave-golden.test.js test/integration/gsd-route-continuation-golden.test.js test/build-team-fable-astra.test.js > /tmp/routing-r1-compat.log 2>&1
test_status=$?
echo "EXIT_CODE=$test_status"
```

- Final D1 targeted run: **82 tests, 82 passed, 0 failed, 0 cancelled, 0 skipped; EXIT_CODE=0.** Seven new r1 tests supplement the existing 75-test population.
- Final compatibility run: **113 tests, 113 passed, 0 failed, 0 cancelled, 0 skipped; EXIT_CODE=0.** This includes the S1a receipt/routing regressions and existing Build/GSD real-engine goldens; it does not certify D2 observation hooks.
- Regression baseline `/tmp/routing-r1-red.log`: all four initial new tests failed as intended (4 tests, 0 passed, 4 failed). That one shell wrapper mistakenly assigned zsh's read-only `status` variable and failed before echoing Node's captured exit; no captured Node exit is claimed for that invocation. Subsequent commands use `test_status` and print their real exit codes.
- First broader fix run `/tmp/routing-r1-first.log`: 44 tests, 42 passed, 2 failed, EXIT_CODE=1. Failures exposed the old reference-only engine fixture and an overly broad ancestry/completeness check on unsupported child attribution. Both were corrected as described above, preserving the existing assertions. The next six-file run and final run each passed 82/82; repeated passes are not summed.

### Limits and remaining work

All four accepted findings are addressed. No new unresolved failure is known in the verified targeted population. The full sandbox suite was **NOT RUN**; host execution remains the full-suite arbiter. These are D1 primitive tests with supplied protocol evidence, not claims of live engine/provider observation. D2 extraction hooks, connector/normalizer/runtime callers, runtime cancellation/recovery capture and live-fire shadow reconciliation remain unverified and intentionally unwired.

The tightened D1 shapes require explicit ancestry and retained engine-evidence fields. Unmigrated pre-fix D1 journals/ledger rows missing those fields are refused; no migration of such experimental artifacts was implemented or verified. Runtime observation has not been enabled. Invalid complete ledger revisions cause reload refusal rather than silently falling back to an earlier row.

S1a success-path settlement equality is unchanged. Frozen off-mode fixture files were not regenerated or edited; their SHA-256 values remain exactly the three values recorded earlier in this report. `git diff --check` and the frozen-file `git diff --exit-code` check passed. No Build/GSD/connector/normalizer source, filed follow-up, S2/S3 selection/report/calibration/trial/exploration work, floor policy, authority/progress file or unrelated audit was changed by this fix run. No npm install, GUI launch, real provider call, commit or push.

## Review r2 fixes

2026-09-11. R2-1 and R2-2 are fixed at the D1 projection/validation boundary. Their shared root cause was projecting the **submission** contract as though it were the **persisted** contract, including its narrower pricing-provenance domain. The r1 engine literals concealed that mismatch. This section supersedes the r1 claim that the extraction path already retained real engine amounts and all valid engine provenance.

### Root-cause fix and representation boundaries

- `lib/routing-ledger.js:766`: `prepareEngineReceiptEvidence` explicitly distinguishes Stratum's persisted `ReceiptRecord.amount` from Compose's submission/spool `ReceiptInput.usage`. Presence of `amount` selects the persisted representation; absent fields remain null and are never filled from submission fields or producer-defaulted telemetry. Only the separate usage projection changes. The original receipt is copied intact; no `amount` → `usage` rewrite occurs.
- Verified the actual producer at `../stratum/ts/src/engine/receipts.ts:26` and its executed compiled counterpart `../stratum/ts/dist/engine/receipts.js:10`: `buildReceipt` returns `amount` copied from `input.usage` (`:52` / compiled `:45`), accepts `reported|estimated|legacy`, and defaults telemetry independently. Engine settlement supplies legacy pricing at `../stratum/ts/src/engine/engine.ts:2762`. No sibling file was edited.
- `contracts/routing-join.schema.json:1375`: new **engine-specific** `engineUsageEvidence` admits `reported|estimated|legacy|null`; `engineReceiptEvidence` references it at `:1371`. Common numeric/presence fields reference existing definitions, but the connector `usageEvidence` provenance enum at `:1300` stays `reported|estimated|null`.
- `contracts/routing-record.schema.json:2458`: ledger cost can retain `legacy`. `lib/routing-ledger.js:1168` refuses it on every non-engine cost row. The existing engine branch at `:1163` still requires exact retained engine cost, no connector calls, an **incomplete** row and an **EXCLUDED** outcome. Missing issuance/call identity is never manufactured.
- The existing owner/id/sequence/digest and retained-projection checks remain at `lib/routing-ledger.js:780`; spool cross-checks and the two ingestion APIs in `lib/consumer-fanout.js:895` / `:901` are unchanged. Both shapes flow into the existing engine cost and reconciliation readers. No D2 normalization or extraction hook is needed to change the original receipt bytes.

### Producer-driven regression coverage

- `test/routing-evidence-validation.test.js:164` runs two cases, `reported` and `legacy`, using the actual object returned by the sibling compiled `buildReceipt`. Each passes that object and its returned `seq` directly into `recordRoutingEngineReceipt`, then reopens the journal, materializes, and reads the ledger. Assertions cover the full returned receipt (including producer fields, split and detail), equality of its canonical serialized bytes captured **before ingestion**, the unchanged original object and digest, idempotent journal replay, 20 tokens / 50 ms / USD 3, retained provenance, unique reconciliation, null issuance identity, empty calls, incomplete/excluded status, and refusal to make the row complete.
- `test/routing-evidence-validation.test.js:122` corrects the existing extracted-receipt test: its synthetic submission literal was the wrong upstream representation. It now uses `buildReceipt` with partial estimated amounts. All former amount, missing-duration, mixed-spend, deduplication, changed-byte, reference, reload-corruption and connector-identity refusal assertions remain. Receipt corruption now targets the producer's actual `amount.tokens`; the producer's default telemetry duration zero must **not** replace missing `amount.ms`.
- `test/routing-evidence-validation.test.js:94` is explicitly named and documented as **submission/spool compatibility**, preserving that real API population and every existing refusal/amount assertion. It also asserts the retained submission object and canonical bytes unchanged. This supplied submission is not credited as persisted-producer coverage.
- `test/routing-evidence-validation.test.js:200` proves `legacy` is still atomically rejected in connector resolution evidence, and cannot be inserted into the cost of an otherwise eligible connector-backed ledger row.
- No existing assertion was deleted or weakened. Three new test cases were added; the existing extraction case was corrected rather than replaced with a weaker expectation. Before the production fix, the real reported and partial estimated producer cases lost their amounts, and the legacy producer case was refused. The first red run also caught a new test setup error: `finishCall` ignores an unsupported `provenance` option. The test now directly submits that evidence through the bound observer. The corrected red run had 10 tests / 6 passed / 4 failed; three failures reproduced the engine defects, and the fourth was the new ledger rejection assertion expecting the engine-domain guard's conflict code while the old schema still rejected all legacy cost. Initial green regression run: 10/10, exit 0. These runs are not added to final population counts below.

### Verbatim r2 acceptance probe

Extracted section 2's fenced shell command without edits, verified the extracted script equals the review text, and executed it from the repository root as `zsh /tmp/routing-r2-fix-zuv2f0yk/r2-1.sh`. It imports the real compiled producer, uses its own disposable `STRATUM_STATE_ROOT`, and performs no flow/model execution. Full post-fix output (`/tmp/routing-r2-fix-zuv2f0yk/r2-after.log`):

```text
PERSISTED_RECEIPT {"usdSource":"reported","actual":{"tokens":20,"ms":50,"usd":3},"cost":{"tokens":20,"durationMs":50,"usd":3},"paid":[{"tokens":20,"durationMs":50,"usd":3}],"state":"incomplete"}
PERSISTED_RECEIPT {"usdSource":"legacy","actual":{"tokens":20,"ms":50,"usd":3},"cost":{"tokens":20,"durationMs":50,"usd":3},"paid":[{"tokens":20,"durationMs":50,"usd":3}],"state":"incomplete"}
LEGACY_SCHEMA null
EXIT_CODE=0
```

Both persisted-receipt lines meet the acceptance amounts in both projection and reconciliation, neither is refused, both remain incomplete, and `LEGACY_SCHEMA null` means no validation errors. The same verbatim command was run before the fix (`r2-before.log`) and reproduced both reported findings.

### Re-run r1 probes

Both original fenced commands were extracted without edits and verified equal to the review text. Command 1 (`r1-1.sh`) correctly stops at its first contradictory lineage write. Full output from `r1-original.log`:

```text
file:///Users/ruze/reg/my/forge/compose/lib/model-router.js:7
export function routingRefuse(code, message) { throw new RoutingError(code, message); }
                                                     ^

RoutingError: Lineage contradicts per-issuance relation/defect evidence
    at routingRefuse (file:///Users/ruze/reg/my/forge/compose/lib/model-router.js:7:54)
    at validateLineage (file:///Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:860:68)
    at validateRoutingEvidence (file:///Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:998:36)
    at validateRoutingJournal (file:///Users/ruze/reg/my/forge/compose/lib/routing-ledger.js:464:3)
    at #mutate (file:///Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:431:9)
    at ConsumerFanoutArtifacts.recordRoutingRecord (file:///Users/ruze/reg/my/forge/compose/lib/consumer-fanout.js:744:24)
    at linkRepair (file:///Users/ruze/reg/my/forge/compose/test/helpers/routing-s1b-fixture.js:123:22)
    at file:///Users/ruze/reg/my/forge/compose/[eval1]:9:178
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5) {
  code: 'ROUTING_BINDING_DRIFT'
}

Node.js v22.23.1
EXIT_CODE=1
```

To reach every original case, `r1-captured.sh` makes only two changes to command 1: exception capture around the contradictory `linkRepair` write and around the malformed-ledger read. All imports, fixtures, inputs and operations are retained. Full output from `r1-captured.log`:

```text
LINEAGE_REFUSAL {"code":"ROUTING_BINDING_DRIFT","message":"Lineage contradicts per-issuance relation/defect evidence"}
CONTRADICTORY_LINEAGE {"gateRelation":"retained","oldOutcome":"accepted","newContext":"unknown"}
UNKNOWN_RETRY {"prior":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"context":{"waveKind":"retry","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"completeness":{"state":"incomplete","reasons":["unknown-repair-context"]},"eligible":false}
ENGINE_SPEND {"knownReceiptUsd":3,"cost":{"tokens":20,"durationMs":50,"usd":3,"provenance":["reported"],"paidReceiptRefs":[{"ownerRunId":"514dccd6-2ea7-43b0-b533-6f738e349f92","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"}]},"reconciled":[{"ref":{"ownerRunId":"514dccd6-2ea7-43b0-b533-6f738e349f92","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"},"tokens":20,"durationMs":50,"usd":3}]}
INVALID_LATEST {"refused":true,"code":"ROUTING_BINDING_DRIFT","message":"Outcome binary differs from label/cause"}
EXIT_CODE=0
```

Original command 2 was rerun unchanged (`r1-2.sh`). Full output from `r1-continuation.log`:

```text
CONTINUATION_CONTEXT {"physicalEpoch":0,"logicalEpoch":0,"hasPredecessor":true,"context":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null}}
EXIT_CODE=0
```

### Final verification and remaining limits

Commands run from the repository root, each with disposable engine state and output redirected to a file; the actual Node exit was captured and echoed. No test run was piped to `tail`.

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-r2-targeted-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/routing-evidence-validation.test.js test/routing-outcome.test.js test/routing-ledger-materialize.test.js test/routing-join.test.js test/routing-journal.test.js test/routing-ledger.test.js > /tmp/routing-r2-fix-zuv2f0yk/targeted.log 2>&1
test_status=$?
echo "EXIT_CODE=$test_status"

STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-r2-compat-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=300000 test/usage-receipts.test.js test/build-model-route.test.js test/gsd-model-route.test.js test/integration/build-wave-golden.test.js test/integration/gsd-route-continuation-golden.test.js test/build-team-fable-astra.test.js > /tmp/routing-r2-fix-zuv2f0yk/compat.log 2>&1
test_status=$?
echo "EXIT_CODE=$test_status"
```

| Run | Tests | Passed | Failed | Cancelled | Skipped | Exit |
|---|---:|---:|---:|---:|---:|---:|
| Final D1 targeted, six files | 85 | 85 | 0 | 0 | 0 | 0 |
| Compatibility / existing real-engine goldens, six files | 113 | 113 | 0 | 0 | 0 | 0 |

The 10-test review regression file is included in the 85-test population; its separate green run is not counted again. These are sandbox targeted results, not a host full-suite result. **Full suite NOT RUN; host verification remains outstanding.** No live provider was invoked and no D2 extraction, connector/normalizer hooks, runtime cancellation/recovery capture or live-fire shadow reconciliation was verified.

`git diff --check` passed. All three `test/fixtures/model-route-off-*.json` files match their pre-fix SHA-256 values, and `git diff --exit-code -- test/fixtures/model-route-off-*.json` returned 0. No fixture was edited or regenerated. S1a success-path settlement equality was not changed; its existing journal and runner/real-engine compatibility tests passed. The reviewed routed-issuance-only ancestry/completeness restriction (formerly `lib/routing-ledger.js:1149`, now `:1155`) is byte-unchanged, as are lineage/gate validation, ancestry derivation, and outcome classification.

This run edited only `lib/routing-ledger.js`, `contracts/routing-join.schema.json`, `contracts/routing-record.schema.json`, `test/routing-evidence-validation.test.js`, and this appended report section. Pre-existing changes elsewhere were retained. Runtime observation stays **DISABLED**. No Build/GSD, connector or normalizer source was changed; no S2/S3 work or filed follow-up was implemented. Q3 remains **OPEN and unanswered**. No migration of experimental pre-fix D1 artifacts is implemented or verified. No `npm install`, GUI launch, real Stratum-home write, commit or push.

## File rename (controller, 2026-09-11, post-r2)

`test/routing-review-r1.test.js` → `test/routing-evidence-validation.test.js`. A test file named after a review
round records process history, not subject matter: "r1" is meaningless to anyone reading this in six months, and
the file's actual subject is evidence validation at the D1 boundary (lineage against gate disposition, unknown
ancestry censoring, engine receipt spend, ledger outcome invariant). Content unchanged; renamed only.
`reports/slice1b-d1-review-r2.md` is a dated review artifact and still cites the ORIGINAL name — that reference is
left intact as history; this note is the crosswalk.
