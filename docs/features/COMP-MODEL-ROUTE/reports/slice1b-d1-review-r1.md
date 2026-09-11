COMP-MODEL-ROUTE S1b, Dispatch 1 — independent correctness review r1

2026-09-11. **CHANGES REQUIRED: 3 HIGH, 1 MEDIUM. This dispatch is not REVIEW CLEAN.**

Reviewed the specified working-tree changes and new files against HEAD `426112353c8481500055d370ac1f3cbb265f84d2`, the S1b blueprint, design Decisions 5–7, progress rulings, evidence report, and implementer's account. Findings below concern D1 primitives/contracts, not the deliberately absent D2 runtime callers. All four findings were reproduced through disposable real journal/ledger instances; production code and tests were not edited. The fourth probe deliberately corrupts only its disposable ledger to test the promised reload validation.

Accepted the supplied host verification: targeted 122/122, real-engine goldens 23/23, and byte-unchanged frozen fixtures. Did not rerun those suites. Ran the two inline probe commands reproduced below and `git diff --check` (exit 0). No provider, GUI, or real Stratum-home activity.

1. **HIGH — A seeded lineage relation overrides contradictory gate evidence.** `lib/routing-ledger.js:814` (`validateLineage`), `lib/routing-ledger.js:1020`, `lib/routing-ledger.js:1049`; test blind spot at `test/helpers/routing-s1b-fixture.js:110` and `test/routing-outcome.test.js:32`.

   The lineage validator checks that referenced records exist, the target digest matches its retained snapshot, and scope/epoch are compatible. It never requires the link's relation and predecessor to agree with the referenced disposition's per-issuance relation/defect evidence. Nor does it bind the completed target to a previously retained proposal in that disposition. The derivations subsequently trust the link's `relation:'repaired'` once the gate has any token acknowledgement and valid partition/ownership flags.

   **Reproduced:** complete A, record an acknowledged approve/retained disposition for A (`defective:false`), complete B in epoch 1, then call the existing `linkRepair` helper with A's retained gate. Journal write and reload accept this contradictory link. A becomes `repaired`/negative and B becomes repair-context, although the referenced gate retained A and proposed no repair. Probe output:

   ```text
   CONTRADICTORY_LINEAGE {"gateRelation":"retained","oldOutcome":"repaired","newContext":"repair"}
   ```

   This is also the dominant test-oracle weakness: the six-label table passes its desired scenario directly into both `gateEvidence` and `linkRepair`, then asserts that label. The helper invents the completed predecessor/target link and copies the target digest from the later snapshot; every ordinary fixture uses `routingDigest(null)` as its item digest. These tests establish classification of supplied consistent inputs, not validation that the gate actually authorized that lineage. The contradictory-input probe demonstrates the missing validation, rather than merely objecting to unit fixtures.

   Consequence: an incorrectly associated link can turn retained work into a negative sample and fabricate repair ancestry/depth. Before accepting a completed link, validate its relation, predecessor and retained proposal against the original disposition and immutable proposal chain. Add a rejection case using a retained/non-defective gate and a conflicting repair link; do not construct both sides from the asserted label. This is observation-evidence validation within D1, not the deferred stronger dispatch-time findings-partition enforcement.

2. **HIGH — Engine-receipt observations have no usable path into the ledger's known-cost reconciliation.** `contracts/routing-join.schema.json:726`, `lib/routing-ledger.js:1252`, `lib/routing-ledger.js:1262`, `lib/routing-ledger.js:1296`; insufficient test at `test/routing-join.test.js:110`.

   An `engine-receipt` observation retains only an owner/id/sequence/digest reference. Materialization obtains costs exclusively from connector `call-intent`/resolution records, and reconciliation exclusively from their `usageRef`s. Neither consumes the engine observation's evidence reference or retains its available receipt amounts. The ledger validator also requires totals to equal those connector resolutions (`lib/routing-ledger.js:1113`). There is no engine-evidence cost branch that D2 can populate through the published observation API.

   **Reproduced:** persist and acknowledge a receipt with id `legacy:17`, 20 tokens, 50 ms and USD 3 in the original journal, then record an engine observation with its exact owner, sequence and payload digest. Materialization writes the observation but loses all known amounts; reconciliation returns no receipt:

   ```text
   ENGINE_SPEND {"knownReceiptUsd":3,"cost":{"tokens":null,"durationMs":null,"usd":null,"provenance":[],"paidReceiptRefs":[]},"reconciled":[]}
   ```

   The probe supplies the available receipt locally to isolate the D1 storage/materialization boundary; it does not claim to exercise D2's engine-audit extraction. Keeping the row incomplete is correct. Discarding its independently known excluded spend is not. Turning `legacy:17` into a connector call would violate C11, so it cannot repair this through ordinary observer wiring.

   The implementer's report explicitly defers engine extraction and reconciliation at `reports/slice1b-d1-impl.md:107`. Extraction hooks can remain D2, but this contract/writer deficiency is D1: blueprint section 3 requires legacy spend to remain engine-synthesized evidence, section 2 requires unsupported rows to retain known excluded spend, and Dispatch 2 integrates D1 ingestion primitives. The current engine test only inserts an evidence reference and checks identity/replay refusal; it never resolves that reference to independently retained receipt bytes or checks materialized cost.

   Consequence: complete-plus-excluded spend cannot reconcile once engine-owned calls are observed. Provide a retained, validated engine-receipt evidence representation and consume it in materialization/reconciliation without creating connector identity or routed issuance. Exercise known engine amounts and exact reference validation through those primitives.

3. **HIGH — A retry removes censoring from an unknown repair stratum.** `lib/routing-ledger.js:1042`, `lib/routing-ledger.js:1267`, `lib/routing-ledger.js:1078`; missed by `test/routing-outcome.test.js:86` and `test/routing-ledger-materialize.test.js:82`.

   The same-run/same-epoch branch recursively obtains the predecessor context, then unconditionally replaces its `waveKind` with `retry`. If the predecessor was unknown, all lineage/depth fields remain null. Materialization adds `unknown-repair-context` only when `waveKind === 'unknown'`, and eligibility makes the same limited check. Thus the unknown lineage is no longer censored.

   **Reproduced:** complete an unlinked epoch-1 issuance, whose context correctly derives as unknown; complete and retain its same-epoch retry with acknowledged call/metadata receipts. The new row is complete and eligible despite having no known repair depth or lineage:

   ```text
   UNKNOWN_RETRY {"prior":{"waveKind":"unknown","repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"context":{"waveKind":"retry","repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"completeness":{"state":"complete","reasons":[]},"eligible":true}
   ```

   Existing tests retry only work whose fresh/repair ancestry is already known; their separately unknown case is not retried. Consequence: a retry can enter the acceptance population while its underlying repair stratum remains unknowable, violating the context censoring rule. Preserve that censoring across retries, either by retaining unknown context or explicitly making unknown retry depth/lineage incomplete and ineligible. No floor computation is needed.

4. **MEDIUM — Latest-ledger validation omits the label/binary/censor invariant.** `contracts/routing-record.schema.json:2299`, `lib/routing-ledger.js:1084`, `lib/routing-ledger.js:1181`, `lib/routing-ledger.js:1078`; missed by `test/routing-ledger-materialize.test.js:115`.

   The standalone journal outcome validator enforces the relationship between label, cause and binary disposition (`lib/routing-ledger.js:798`). The ledger's embedded outcome schema instead permits independent enum values, and `validateRoutingLedgerRow` never applies the semantic rule. `routingEligible` then trusts the binary field.

   **Reproduced:** materialize a valid complete accepted row, append version 2 with the same issuance and call/cost evidence but `label:'unknown', binary:'positive', censorReason:'missing-lineage'`, and reopen through `readRoutingLedger`. The invalid revision becomes the selected latest row and is eligible:

   ```text
   INVALID_LATEST {"version":2,"outcome":{"label":"unknown","binary":"positive","derivation":"no-evidence","censorReason":"missing-lineage"},"eligible":true}
   ```

   This is an empirical malformed-ledger/reload finding; the normal materializer was not observed generating that contradictory pair. Nevertheless, it breaks the explicit promise of a latest **validated** version and the shared predicate's unknown/cancelled exclusions. Current corruption tests cover version duplication/gaps and cost disagreement only. Apply the same label/cause/binary invariant at the embedded ledger boundary and test malformed censored revisions.

The initial-fresh interpretation is conservative at its direct boundary, with the qualifications in findings 1 and 3. By reading, S1a ordinary admissions advance logical epoch across prior admissions (`lib/build.js:1082`); consumer continuation reuses retained admissions and binds a predecessor issuance (`lib/build.js:1266`, `lib/build.js:1109`). A second probe drove `createContinuationIntent`, `bindRoutingRun`, the real new-run journal, and `admitConsumerWave`/`prepareRoutingIssuance` with reset physical epoch zero. It obtained:

```text
CONTINUATION_CONTEXT {"physicalEpoch":0,"logicalEpoch":0,"hasPredecessor":true,"context":{"waveKind":"unknown","repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null}}
EXIT_CODE=0
```

No path was found that turns this recorded continuation redo into `fresh`. With valid S1a ancestry, the dual-zero/no-predecessor guard is a reasonable initial-fresh interpretation of the otherwise unevaluated admission marker. It does not establish freshness outside recorded ancestry. Multiple distinct repair predecessors remain censored by the explicit unique-predecessor check. Q3 remains open and was not assessed.

The other requested finding classes are clean within this review's scope:

- **Journal versus ledger idempotency: CLEAN, no rule conflation found.** Journal changed-byte refusal remains at `lib/consumer-fanout.js:733` and receipt payload refusal at `lib/consumer-fanout.js:990`; call resolutions append sequence/head records. Ledger equality excludes timestamp/version and appends the next version at `lib/routing-ledger.js:1279`; reload enforces contiguous versions. Finding 4 concerns semantic validation, not immutable-id rules leaking into the ledger.
- **Off-mode byte identity: CLEAN.** The start schema change adds only an unused-by-start `ProfileIntent` definition (`contracts/routing-start.schema.json:466`), referenced by call-intent. AJV is not configured to insert defaults. Start digests hash payloads, not schema bytes (`lib/routing-ledger.js:37`), and `createRoutingStart` returns before storage for off mode (`lib/routing-ledger.js:199`). Observation defaults false; no runner opts in. The supplied unchanged-fixture and real-engine results support this source inspection. No routing storage, ledger or routing journal fields are newly allocated by an off-mode path.
- **Identity/defaults: no new fabricated connector identity or zero-filled missing cost found in the D1 production producers.** Missing call ids remain null; tracked issuance tokens and reserved legacy/metadata prefixes are refused; costs begin null and absent fields are retained as missing. No `readFlowSpend` shortcut exists. Actual fallback/default filtering at connector boundaries remains D2 and is not certified by `beginCall`'s supplied ids or `finishCall`'s supplied raw usage. Engine known-spend loss is finding 2.
- **Runtime wiring and scope: CLEAN apart from the unusable engine-cost primitive in finding 2.** Missing callers for the new exports are intentional. No Build/GSD/connector/normalizer runtime changes, report, calibration, learned selection, trials, exploration or repair-floor computation/comparison were included. Success settlement still requires exact original identity and accepted-token equality; failure/cancellation use their separately constrained proof branches. The filed legacy follow-ups remain unfixed.

Every new/extended test was inspected. `fixture`, `consumerWave` and continuation helpers use real S1a start/plan/binding/admission/issuance APIs and real `ConsumerFanoutArtifacts`; they do not seed ledger rows for the positive materialization assertions. Raw connector returns, gate/failure/cancellation evidence and delivery responses are supplied at D1's declared primitive boundary. That is not runtime producer evidence, and the implementation report appropriately says so. Direct disk mutations in corruption tests test reload refusal rather than stand in for successful production writes. The substantive exception is the overclaimed lineage validation in finding 1; engine cost and unknown-retry cases are also absent from the tests credited to those guarantees.

Dispatch 1 checkbox audit:

| Checkbox | Review result | What the cited evidence actually establishes |
|---|---|---|
| 1. Immutable journal ids; append-only call chains; late/repeated evidence across reload/continuation | PASS at D1 boundary | `test/routing-join.test.js:27`, `:37`, `:46`, `:101` drive durable production mutations/refusals; `test/routing-ledger-materialize.test.js:64` uses an actual S1a continuation and original-owner late resolution/delivery. This does not certify future connector adapters. |
| 2. Atomic issuance/index/tip/owner/metadata and exact payload | PASS at stated publication-fault boundary | `test/routing-journal.test.js:178` injects before/after publication faults through the S1a producer, checks persisted bundle fields and corrupts each component; `:211` covers explicit unlaunched upgrade. `test/routing-join.test.js:85` exercises the production delivery barrier and exact payload acknowledgement. |
| 3. Six evidence-derived labels, cancellation precedence, separate settlement proofs | PARTIAL | Label branches and cancellation/failure guards are exercised, and success equality stays exact. Supplied replacement relations are not independently checked against gate disposition/proposal evidence: finding 1. |
| 4. Shared eligibility excludes incomplete/censored/unsupported and null tier claims | FAIL | Basic exclusions/local-tier checks pass, but unknown retry ancestry becomes eligible (finding 3), and malformed unknown-positive latest rows pass (finding 4). |
| 5. Crash/concurrent ledger, incomplete rows, one latest sample and unique paid reconciliation | PARTIAL | Publication faults, partial-tail quarantine, concurrent child processes across starts, connector-child cost union and ordinary late revisions have meaningful coverage. Engine known spend is absent (finding 2); latest-row semantic validation is incomplete (finding 4). |
| 6. Persisted fresh/repair/retry/depth2/ambiguous context, no name inference or floor | FAIL | Disk reload, simple depth progression and multiple-predecessor censoring are covered. A contradictory gate/link is accepted (finding 1); retrying unknown ancestry loses censoring (finding 3). The separate continuation probe confirms no false initial freshness in that path. |

The implementer's blanket “Satisfied” assessments for checkboxes 3–6 should therefore not be accepted as completion evidence. Checkboxes remain unticked in the blueprint. During this review, external edits appeared in `blueprint-slice1b.md` and `progress.md`, reconciling the five-versus-three follow-up inventory. I inspected those diffs, did not write them, and did not count them as this implementation's scope changes; they do not alter the governing D1 requirements or these findings.

Exact probe command 1, run from the repository root (no probe/test file created):

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-review-state.XXXXXX) node --input-type=module <<'JS'
import { fixture, beginCall, finishCall, acknowledgeAll, gateEvidence, linkRepair } from './test/helpers/routing-s1b-fixture.js';
import { materializeRoutingLedger, routingEligible, deriveRoutingContext, deriveRoutingOutcome, reconcileRoutingPaidReceipts, readRoutingLedger } from './lib/routing-ledger.js';
import { routingDigest } from './lib/model-router.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const cleanups=[]; const t={after: f=>cleanups.push(f)};
const complete=(f,epoch)=>{const i=f.issue({epoch}); f.launch(i);finishCall(f,beginCall(f,i));f.settle(i);return i;};
try {
 const f=fixture(t); const a=complete(f,0); const ga=gateEvidence(f,[a]); const b=complete(f,1); const gb=gateEvidence(f,[b],{gateOrdinal:1,priorSnapshotIds:[ga.snapshot.id]}); linkRepair(f,a,b,ga,gb); acknowledgeAll(f);
 const r=f.reopen().exportRoutingJournal();console.log('CONTRADICTORY_LINEAGE',JSON.stringify({gateRelation:ga.disposition.dispositions[0].relation,oldOutcome:deriveRoutingOutcome(r,a.id).label,newContext:deriveRoutingContext(r,b.id).waveKind}));
 const g=fixture(t); const c=complete(g,1);gateEvidence(g,[c]);const d=complete(g,1);gateEvidence(g,[d],{gateOrdinal:1});acknowledgeAll(g);const rows=materializeRoutingLedger({cwd:g.cwd,artifacts:g.reopen()});const row=rows.find(r=>r.recordId===d.id);console.log('UNKNOWN_RETRY',JSON.stringify({prior:deriveRoutingContext(g.reopen().exportRoutingJournal(),c.id),context:row.context,completeness:row.completeness,eligible:routingEligible(row)}));
 const h=fixture(t);const receipt={dispatchId:'legacy:17',source:'agent',usage:{tokens:20,ms:50,usd:3},usdSource:'reported'};h.artifacts.recordPendingUsageReceipt({dispatchId:receipt.dispatchId,receipt});h.artifacts.acknowledgeUsageReceipt({dispatchId:receipt.dispatchId,seq:17});const obs=h.artifacts.recordRoutingObservation({unsupportedReason:'engine-fanout',evidenceSource:'engine-receipt',evidenceRef:{ownerRunId:h.binding.runId,dispatchId:receipt.dispatchId,sequence:17,payloadDigest:routingDigest(receipt)}});const engineRows=materializeRoutingLedger({cwd:h.cwd,artifacts:h.reopen()});console.log('ENGINE_SPEND',JSON.stringify({knownReceiptUsd:receipt.usage.usd,cost:engineRows[0].cost,reconciled:reconcileRoutingPaidReceipts(engineRows)}));
 const v=fixture(t);const vi=complete(v,0);gateEvidence(v,[vi]);acknowledgeAll(v);const vr=materializeRoutingLedger({cwd:v.cwd,artifacts:v.reopen()})[0];const invalid={...vr,version:2,outcome:{label:'unknown',binary:'positive',derivation:'no-evidence',censorReason:'missing-lineage'}};appendFileSync(join(v.cwd,'.compose/routing/ledger.jsonl'),JSON.stringify(invalid)+'\n');const latest=readRoutingLedger({cwd:v.cwd})[0];console.log('INVALID_LATEST',JSON.stringify({version:latest.version,outcome:latest.outcome,eligible:routingEligible(latest)}));
} finally {for (const f of cleanups.reverse())f();}
JS
probe_status=$?
echo "EXIT_CODE=$probe_status"
```

Full output:

```text
CONTRADICTORY_LINEAGE {"gateRelation":"retained","oldOutcome":"repaired","newContext":"repair"}
UNKNOWN_RETRY {"prior":{"waveKind":"unknown","repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"context":{"waveKind":"retry","repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"completeness":{"state":"complete","reasons":[]},"eligible":true}
ENGINE_SPEND {"knownReceiptUsd":3,"cost":{"tokens":null,"durationMs":null,"usd":null,"provenance":[],"paidReceiptRefs":[]},"reconciled":[]}
INVALID_LATEST {"version":2,"outcome":{"label":"unknown","binary":"positive","derivation":"no-evidence","censorReason":"missing-lineage"},"eligible":true}
EXIT_CODE=0
```

Exact probe command 2:

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-review-continuation.XXXXXX) node --input-type=module <<'JS'
import { fixture, consumerWave, continueRoutingFixture, beginCall, finishCall } from './test/helpers/routing-s1b-fixture.js';
import { pendingRoutingPlans, deriveRoutingContext } from './lib/routing-ledger.js';
import { ConsumerFanoutArtifacts } from './lib/consumer-fanout.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cleanup=[];const t={after:f=>cleanup.push(f)};
try {
 const f=fixture(t,{consumer:true});const tasks=[{id:'A',description:'continued work',depends_on:[]}];const wave=await consumerWave(f,tasks);const a=wave.issuances[0];f.launch(a);finishCall(f,beginCall(f,a));f.settle(a);
 const next=await continueRoutingFixture(f,wave);const plan=pendingRoutingPlans({cwd:f.cwd,featureCode:'S1B'}).find(p=>p.binding?.runId===next.binding.runId);
 const g={...f,...next};g.context={routing:{...f.context.routing,binding:next.binding,artifacts:next.artifacts,resolvedRoutes:new Map()},artifacts:next.artifacts};g.snapshot={...f.snapshot,id:next.binding.runId,input:plan.intent.input};g.saveSnapshot=()=>writeFileSync(join(process.env.STRATUM_STATE_ROOT,`${g.snapshot.id}.json`),JSON.stringify(g.snapshot));g.saveSnapshot();
 const continued=await consumerWave(g,tasks,0);const b=continued.issuances[0];const r=g.artifacts.exportRoutingJournal();console.log('CONTINUATION_CONTEXT',JSON.stringify({physicalEpoch:b.epoch,logicalEpoch:b.logicalEpoch,hasPredecessor:b.priorRecordId===a.id,context:deriveRoutingContext(r,b.id)}));
} finally {for(const f of cleanup.reverse())f();}
JS
probe_status=$?
echo "EXIT_CODE=$probe_status"
```

Full output is the `CONTINUATION_CONTEXT` line and `EXIT_CODE=0` reproduced above. Both commands exited successfully because they print the observed behavior; that does not mean the first command's four contract violations passed a correctness assertion.
