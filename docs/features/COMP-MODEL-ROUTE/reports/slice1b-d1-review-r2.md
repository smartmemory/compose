# COMP-MODEL-ROUTE S1b dispatch 1 — independent review r2

2026-09-11. **CHANGES REQUIRED: 2 HIGH findings in the engine-receipt fix. Dispatch 1 is not REVIEW CLEAN and is not ready to commit.**

Reviewed the uncommitted tree at HEAD `426112353c8481500055d370ac1f3cbb265f84d2`, targeting the four r1 fixes against the blueprint, design Decisions 5–7 and progress rulings. Three r1 findings are FIXED; engine known-spend handling is PARTIAL. The original engine probe passes, but the actual persisted engine receipt shape still loses known spend, and legitimate legacy provenance is newly refused.

Accepted the supplied host verification (122/122 across seven files, new regression file 7/7, frozen fixtures byte-unchanged); did not rerun those suites or regenerate fixtures. Ran independent inline probes with disposable `STRATUM_STATE_ROOT`, including the real sibling Stratum `buildReceipt` function. No provider, GUI, runtime runner or real Stratum-home activity. Only this review file was written in the repository; no production/test edits or commit.

## 1. Execution of the four r1 rulings

| R1 finding | Verdict | Evidence and practical result |
|---|---|---|
| 1. Contradictory seeded lineage | **FIXED** | `lib/routing-ledger.js:847` validates the referenced disposition's unique per-issuance relation and defect evidence, matches the retained proposal's predecessor and proposed digest, and validates completed endpoints. `:897` binds snapshot item bytes to the admission digest. The original conflicting link is refused; A remains accepted and B remains ancestry-unknown. No neighbouring bypass or legitimate S1a admission/snapshot rejection was demonstrated in this class. |
| 2. Lost engine spend | **PARTIAL** | The reference/spool path now retains and reconciles the original probe's `usage` amounts (`lib/consumer-fanout.js:915`, `lib/routing-ledger.js:1330`, `:1366`). But the new extracted-receipt path at `lib/consumer-fanout.js:895` silently loses actual `ReceiptRecord.amount` values and refuses `usdSource:'legacy'`. See R2-1 and R2-2. |
| 3. Retry erased unknown ancestry | **FIXED** | `lib/routing-ledger.js:1090` introduces independent `ancestryUnknown`; `:1099` preserves it while truthfully reporting retry. Completeness (`:1336`), ledger validation (`:1146`) and eligibility (`:1132`) consume that signal. Unknown retries stay written, incomplete and ineligible; known repair retries remain complete/eligible. The restriction to routed issuances at `:1149` is correct: fully costed unsupported children can be complete, while `:1131` still excludes them. |
| 4. Embedded outcome invariant | **FIXED** | Journal and ledger validation both call `validateOutcomeClassification` (`lib/routing-ledger.js:830`, `:833`, `:1139`). Latest selection validates before selecting (`:1249`), and direct eligibility validates first (`:1130`). The original contradictory revision is refused, rather than selected. No new refusal of a valid generated classification was found. |

**Independently rerun r1 outputs.** I extracted and executed command 1 from the r1 report unchanged. It stopped at the first contradictory write, as expected:

```text
RoutingError: Lineage contradicts per-issuance relation/defect evidence
code: 'ROUTING_BINDING_DRIFT'
EXIT_CODE=1
```

I then reran the same command with exception capture only around the conflicting `linkRepair` and malformed-ledger read, so every original case executed. These are my outputs, not the implementer's transcript:

```text
LINEAGE_REFUSAL {"code":"ROUTING_BINDING_DRIFT","message":"Lineage contradicts per-issuance relation/defect evidence"}
CONTRADICTORY_LINEAGE {"gateRelation":"retained","oldOutcome":"accepted","newContext":"unknown"}
UNKNOWN_RETRY {"prior":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"context":{"waveKind":"retry","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"completeness":{"state":"incomplete","reasons":["unknown-repair-context"]},"eligible":false}
ENGINE_SPEND {"knownReceiptUsd":3,"cost":{"tokens":20,"durationMs":50,"usd":3,"provenance":["reported"],"paidReceiptRefs":[{"ownerRunId":"a9625c4a-6896-4065-9c73-64c15a0498bc","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"}]},"reconciled":[{"ref":{"ownerRunId":"a9625c4a-6896-4065-9c73-64c15a0498bc","dispatchId":"legacy:17","payloadDigest":"49cbaa79eb2aa52d932f8d746e8ba4ff366c0d0c59cf0a0beae750f3a5792803"},"tokens":20,"durationMs":50,"usd":3}]}
INVALID_LATEST {"refused":true,"code":"ROUTING_BINDING_DRIFT","message":"Outcome binary differs from label/cause"}
EXIT_CODE=0
```

R1 command 2 was also rerun unchanged:

```text
CONTINUATION_CONTEXT {"physicalEpoch":0,"logicalEpoch":0,"hasPredecessor":true,"context":{"waveKind":"unknown","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null}}
EXIT_CODE=0
```

## 2. Findings in the engine-receipt fix

### R2-1 — HIGH: actual persisted engine amounts are still silently discarded

**Sites:** `lib/routing-ledger.js:766`–`:772` (`prepareEngineReceiptEvidence`), `lib/consumer-fanout.js:895`–`:898` (extracted receipt writer), `lib/routing-ledger.js:1330` and `:1366` (consumers).

The projector reads only `receipt.usage`. That is the Compose submission/spool shape used by the original probe and both new engine tests. Persisted engine receipts instead contain `amount`: the real producer copies `input.usage` to `ReceiptRecord.amount` at `../stratum/ts/src/engine/receipts.ts:52` (executed JS at `../stratum/ts/dist/engine/receipts.js:45`). Blueprint section 3 explicitly requires ingestion of these persisted engine receipts.

**Reproduced with the real producer:** create a `legacy:17` fanout receipt through `buildReceipt`, with 20 tokens, 50 ms and reported USD 3; pass that exact returned object and its sequence into `recordRoutingEngineReceipt`; reopen and materialize. The original `amount` bytes remain retained, but all three projected costs and reconciled amounts are null:

```text
PERSISTED_RECEIPT {"usdSource":"reported","actual":{"tokens":20,"ms":50,"usd":3},"cost":{"tokens":null,"durationMs":null,"usd":null},"paid":[{"tokens":null,"durationMs":null,"usd":null}],"state":"incomplete"}
```

**Consequence:** the r1 known-spend loss remains reachable through the new extraction-boundary API with its intended upstream data. Complete-plus-excluded totals omit a known USD 3. Keeping this row incomplete is correct; losing its independently retained amounts is not.

This is a D1 projection/validation defect, not a request to wire D2 extraction. D1 accepts the original receipt object and binds its digest, but ignores its costs. An undocumented D2 rewrite of `amount` into `usage` would change the bytes whose original receipt digest is supposed to be retained. Project the actual persisted representation while preserving original bytes/reference checks; keep the existing spool representation supported explicitly. Test using producer-returned receipts rather than only submission-shaped literals.

### R2-2 — HIGH: valid engine-synthesized legacy provenance is newly refused

**Sites:** `contracts/routing-join.schema.json:1300` (usage provenance enum reused by `engineReceiptEvidence` at `:1371`), `lib/routing-ledger.js:772` (projection), and `contracts/routing-record.schema.json:2461` (ledger cost provenance enum).

The new engine evidence reuses the connector provenance domain `reported | estimated | null`. The actual engine accepts `legacy` and emits it when an engine-settled amount lacks reported pricing provenance: `../stratum/ts/src/engine/receipts.ts:38`, `../stratum/ts/src/engine/engine.ts:2762`. The blueprint explicitly requires this engine-synthesized spend to remain separately recorded and excluded.

**Reproduced:** change the real receipt producer input above to `usdSource:'legacy'`. `recordRoutingEngineReceipt` throws `ROUTING_SCHEMA_INVALID` atomically; no observation is written. A separate direct validation of the engine-evidence definition isolates the exact cause. The same rejection occurs even with the fix's preferred `receipt.usage` shape, so this defect survives correcting R2-1.

```text
PERSISTED_RECEIPT {"usdSource":"legacy","actual":{"tokens":20,"ms":50,"usd":3},"refused":"ROUTING_SCHEMA_INVALID","journalUnchanged":true}
LEGACY_SCHEMA [{"instancePath":"/usageEvidence/provenance","schemaPath":"#/$defs/usageEvidence/properties/provenance/enum","keyword":"enum","params":{"allowedValues":["reported","estimated",null]},"message":"must be equal to one of the allowed values"}]
```

**Consequence:** a legitimate existing engine receipt cannot enter the D1 journal/ledger at all, preventing recovery/materialization through this API instead of retaining an incomplete excluded row. This is the new over-refusal introduced by evidence validation. Retain legacy provenance in the engine-specific evidence and ledger representation without treating it as accepted connector provenance, fabricating identity, or completing the row.

Both findings are reproduced by this command, run from the repository root. It imports the existing compiled receipt producer, whose relevant implementation was checked against its TypeScript source; it does not run a flow or contact a model:

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/routing-r2-engine-proof.XXXXXX) node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {readFileSync} from 'node:fs';
import {buildReceipt} from '../stratum/ts/dist/engine/receipts.js';
import {fixture} from './test/helpers/routing-s1b-fixture.js';
import {materializeRoutingLedger,reconcileRoutingPaidReceipts,prepareEngineReceiptEvidence} from './lib/routing-ledger.js';
const cleanup=[];const t={after:f=>cleanup.push(f)};
try {
 for(const usdSource of ['reported','legacy']) {
  const f=fixture(t);const receipt=buildReceipt({receiptCounter:16},{dispatchId:'legacy:17',source:'fanout',usage:{tokens:20,ms:50,usd:3},usdSource});const before=f.bytes();
  try {
   f.artifacts.recordRoutingEngineReceipt({receipt,sequence:receipt.seq,unsupportedReason:'engine-fanout'});
   const row=materializeRoutingLedger({cwd:f.cwd,artifacts:f.reopen()})[0];
   assert.deepEqual(row.observation.engineReceiptEvidence.receipt,receipt);
   const paid=reconcileRoutingPaidReceipts([row]).map(({ref,...amounts})=>amounts);
   console.log('PERSISTED_RECEIPT',JSON.stringify({usdSource,actual:receipt.amount,cost:{tokens:row.cost.tokens,durationMs:row.cost.durationMs,usd:row.cost.usd},paid,state:row.completeness.state}));
  } catch(e) {console.log('PERSISTED_RECEIPT',JSON.stringify({usdSource,actual:receipt.amount,refused:e.code,journalUnchanged:f.bytes()===before}));}
 }
 const schema=JSON.parse(readFileSync('contracts/routing-join.schema.json','utf8'));
 const check=new Ajv({strict:false}).compile({$defs:schema.$defs,$ref:'#/$defs/engineReceiptEvidence'});
 const evidence=prepareEngineReceiptEvidence({ownerRunId:'original-run',sequence:17,receipt:{dispatchId:'legacy:17',usage:{tokens:20,ms:50,usd:3},usdSource:'legacy'}});
 check(evidence);console.log('LEGACY_SCHEMA',JSON.stringify(check.errors));
} finally {for(const f of cleanup.reverse())f();}
JS
probe_status=$?
echo "EXIT_CODE=$probe_status"
```

Output is the three lines reproduced above, followed by `EXIT_CODE=0`. The command reports observed defects; exit zero does not mean those behaviors satisfy the contract.

## 3. Test quality and legitimate-shape checks

All seven new tests were inspected. Their substantive rejection/derivation assertions do not simply echo a supplied expected outcome:

- `test/routing-review-r1.test.js:13`: independently contradicts a retained/non-defective disposition with a repair link; checks refusal, atomicity and unchanged derived classifications. The assertion of the helper's supplied disposition is a setup check, not the proof of correctness.
- `:26`: retains proposal bytes before B exists; varies target, predecessor, relation, proposal ownership/completion and defect evidence; checks reload and admission-digest refusal. Its positive repaired-label assertion is still classification coverage, but the independent contradictory cases provide the missing validation coverage.
- `:64`: proves a defect relation without a proposal is insufficient and a proposal cannot borrow another disposition.
- `:76`: constructs repeated real retries and asserts derived ancestry, completeness and eligibility; it does not inject `ancestryUnknown` into the successful producer path.
- `:93` and `:117`: meaningfully test exact references, retained amounts, changed-byte refusal, reload corruption and reconciliation. However, both build `usage`-shaped receipt literals with only `reported`/`estimated` provenance (`:95`, `:120`). They never exercise actual persisted `amount` or valid `legacy` provenance. This is an upstream-shape coverage gap, not a reason to reject ordinary input/output assertions in persistence tests; it explains R2-1/R2-2.
- `:151`: deliberately supplies contradictory ledger revisions and expects rejection. No positive eligibility result is asserted from a supplied contradictory binary.

The `routingDigest(null)` weakness is fixed across the shared ordinary fixtures, not only the new tests. `test/helpers/routing-s1b-fixture.js:46`–`:54` captures the same full input projection used by the real admission producer; `:95`–`:96` retains those bytes and their digest. Every caller of `gateEvidence` uses that path. Searches of `test/routing*.test.js` and the helper found no remaining `routingDigest(null)` snapshot fixtures. Different epochs now have different `stepInputs.revision`; same-epoch retries legitimately retain identical inputs. The original six-label table at `test/routing-outcome.test.js:33` still passes a scenario into gate/link creation and should be credited only as classification coverage, as the revised account now says.

Additional probes exercised existing S1a ordinary issuance without observation fields, full consumer task snapshots from real admissions, and recorded continuation. No new S1a routing-record validation failure was found. Existing engine-produced receipts are the exception documented above. Initial consumer-snapshot probe setup omitted sealing, then attempted sealing unsettled work; those harness attempts exited 1. After completing the real issuances and sealing through the producer, the snapshot probe passed. Those setup failures are not production findings.

## 4. Unchanged guarantees and narrowing checks

**Journal/ledger idempotency: CLEAN.** Changed same-id journal bytes still refuse at `lib/consumer-fanout.js:733`; ledger equality excludes version/time at `lib/routing-ledger.js:1234`, with monotone append at `:1348` and validated reload at `:1249`. A new independent probe materialized unresolved work, confirmed repeat byte identity, completed the same call, observed version 2 with one latest row, and separately refused a changed journal intent.

**Ancestry narrowing: CLEAN.** An independent unknown-epoch retry with USD 1 primary plus USD 2 unsupported child produced an incomplete/ineligible USD 3 parent and a complete/ineligible USD 2 child. The exception at `:1149` does not make the parent eligible, and the source/owner check at `:1140` prevents merely relabelling a routed row as unsupported. A known repair-depth-1 retry remained complete and eligible. Probe outputs:

```text
UNKNOWN_RETRY_WITH_CHILD {"parent":{"state":"incomplete","context":{"waveKind":"retry","ancestryUnknown":true,"repairOfRecordId":null,"repairDepth":null,"repairLineageRefs":null},"usd":3,"eligible":false},"child":{"state":"complete","usd":2,"eligible":false}}
KNOWN_REPAIR_RETRY {"waveKind":"retry","depth":1,"state":"complete","eligible":true}
S1A_CONSUMER_SNAPSHOT {"accepted":true,"distinctDigests":true}
SUCCESS_EQUALITY {"independentFieldRefusals":8,"correctSettlement":"settled"}
DISTINCT_IDEMPOTENCY {"repeatBytesEqual":true,"initialState":"incomplete","latestVersion":2,"latestCount":1,"changedJournalIdRefused":true}
```

The first two lines completed before the initial snapshot-harness error described above; the final three are from the corrected boundary probe, `EXIT_CODE=0`.

**Off-mode identity: CLEAN within D1.** Trusted frozen-byte host evidence remains applicable. `createRoutingStart` returns before storage at `lib/routing-ledger.js:199`; observation defaults false at `lib/consumer-fanout.js:356`; no runner enables it. The start-schema diff adds only the independently referenced `ProfileIntent` definition, not start payload fields/defaults. An independent off fixture allocated no `.compose/routing`. Existing S1a issuance without observation fields reopened and settled with no pending routing metadata; explicit materialization wrote an incomplete row rather than silently upgrading it.

**Success settlement equality: CLEAN.** The exact run/revision/step/epoch/item/generation/issuance-token equality remains at `lib/routing-ledger.js:494`, with accepted-token equality at `:496`. Independently changing each of those eight fields was refused; the exact valid settlement succeeded. Separate failure/cancellation proof branches did not relax successful settlement.

**Identity, missing cost and incomplete-row persistence: CLEAN apart from the two engine-spend findings.** Connector identity exclusions remain at `lib/routing-ledger.js:617`; engine observations cannot own connector intents (`:967`) or acquire connector parents (`:787`). Missing values remain null. Unknown retry rows and old S1a rows with missing call/metadata evidence were actually written incomplete. The engine failures are known-amount loss and over-refusal, not fabricated identity or zero-filled completeness.

**Scope: CLEAN.** Production changes remain the D1 schemas and two owning libraries. No Build/GSD/connector/normalizer runtime wiring, S2/S3 report/calibration/selection/trial/exploration work, or repair-floor computation/comparison/enforcement was found. The filed legacy GSD receipt conversion, stronger findings-partition enforcement and GSD sidecar-dispatch follow-ups remain unfixed; their source files are unchanged. Q3 remains OPEN and was not adjudicated. Pre-existing authority edits and the unrelated untracked audit were left untouched. `git diff --check` passed.

The dispatch's engine-cost primitive must handle actual retained engine amounts and legacy provenance before the fix account can claim all four r1 findings resolved.
