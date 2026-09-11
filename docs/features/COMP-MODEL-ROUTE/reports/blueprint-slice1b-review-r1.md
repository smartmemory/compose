# S1b blueprint independent correctness review — r1

Reviewed 2026-09-11 against Compose working-tree HEAD `a341b58650e8d61478982c537b176a775b09f231` and sibling Stratum HEAD `813d799228c91e65ee8729d6a362bb17827a6747`. S1a completion at `2100b89` is the governing baseline.

**Verdict: revise the blueprint before implementation. Findings: 5 HIGH, 6 MEDIUM, 1 LOW.** The central pre-RPC placement is sound, but the receipt lifecycle, unsupported population, cancellation proof and call identity/binding contracts are not yet sufficient to deliver attributable shadow outcomes.

Method: read the governing design, evidence report, S1a blueprint and progress rulings; independently inspect the cited code, schemas, adapters, connector paths and golden helpers. `VERIFIED` below means verified by reading, not execution. `CONSEQUENCE` describes the inferred implementation failure. No tests, production imports, model calls, application launches or Stratum state operations were performed. Only this review file was written. Existing untracked files were left untouched.

References to `blueprint-slice1b.md`, `design.md`, `blueprint-slice1a.md` and `progress.md` below are relative to `docs/features/COMP-MODEL-ROUTE/`; source paths are relative to the Compose root.

## Anchor and insertion-point results

The claim at `blueprint-slice1b.md:10` that eight of fourteen design anchors are stale is not supported. Independently checking the fourteen anchors enumerated in the evidence report yields **five plainly stale ranges, one partially stale boundary, and eight accurate/interior ranges**. The repair range is accurately located but needs a behavioral qualification; that does not make its location stale.

| Blueprint claim | Independent result |
|---|---|
| C1 | Correct correction: `lib/build.js:1779–1784`, conditional `flowTag` at `lib/build-cancel.js:62–68`. Old design range is stale. |
| C2 | Correct correction: `lib/build.js:1865–1875`; usage omits item binding, and the comment conflicts with the installed sink at `:4376`. Old design range is stale. |
| C3 | Correct correction: `lib/build.js:2236–2298`, payload at `:2261–2285`. Old design range is stale. Delivery/spooling qualification is important: see H1. |
| C4 | Correct: local primary at `lib/result-normalizer.js:569`, MCP primary at `:591`, and normalization repair at `:777` uses `stratum.agentRun` even behind a local primary. No separate local repair branch was found. |
| C5 | Correct correction and store distinction: Compose payload equality at `lib/consumer-fanout.js:850–863`; Stratum id-only dedup at `../stratum/ts/src/engine/engine.ts:890–892`, after cancellation refusal at `:873–877`. Old design range is stale. This does not mean every current receipt uses the Compose spool. |
| C6 | Correct: `lib/flow-state.js:55–75` has the stated strictness and the no-USD/no-positive-usage skip. It does not establish routing completeness. |
| C7 | Correct current-state anchors: `lib/flow-state.js:41–52`, `../stratum/ts/src/engine/state.ts:51–65,173–194`. No historical reconstruction is supplied by these readers. |
| C8 | Correct correction: repair-tier prompt at `presets/team-fable-astra.stratum.yaml:211–213`; no tier-history enforcement at `lib/output-gate.js:6–42`. Old preset range is stale. |
| C9 | Correct qualification: `lib/pipeline-profiles.js:148–156,157–177`; no prior-tier input. This is the one partially stale boundary. |
| C10 | Correct: `ReceiptInput.detail` is available and not a validated routing contract; `buildReceipt` supplies defaults. |
| C11 | Fallback/default sites exist, but treating the local connector's own dispatch ID as a fabricated substitute is incorrect/inconsistent: H5. The event-usage fallback UUID is specifically at `lib/result-normalizer.js:716`, not `:480–496`. |
| C12 | Correct reset ordering and limitations of artifact/checkpoint acceptance. The GSD RPC named in section 4 is wrong: L1. |
| C13 | Correct description of existing ordinal recovery and token-bearing merge transactions. A token in a prepared transaction is not token-bound acknowledgement proof: M2. |
| C14 | Correct distinctions: current `routing-ledger.js` is not the JSONL outcome ledger; engine settlement is not acceptance; bound plans remain in `pendingRoutingPlans`; credited repair is not all paid repair. |

**Gate path coverage, VERIFIED:** all five direct Build calls (`lib/build.js:5706,5777,5811,5829,5905`) use the closure at `:5486`; GSD's call at `lib/gsd.js:788` uses `:734`. Configured output and policy-skip decisions share one Build call site. No additional gate-reset RPC bypassing those closures was found in these two runners. The actual RPCs are `lib/build.js:5586` and `lib/gsd.js:764`. Stratum's gate revise calls `resetFrom` at `../stratum/ts/src/engine/engine.ts:1370`; its other references do not reveal an automatic gate-reset path outside gate resolution.

This coverage is bounded: Build explicitly does not handle scoped child gates in this branch (`lib/build.js:5404–5418`), and configured holds return before the closures (`lib/build.js:5790–5796`; `lib/gsd.js:732–733`). A hold does not itself reset anything. Do not expand “one closure” into a claim that every gate reachable in an arbitrary nested spec is supported by these runners.

At the closure entrance the audit and gate token are available. Full task objects/digests and logical identities require joining retained admissions/bindings, not merely reading the local merge transaction. For admitted single-stage waves these records already exist (`lib/build.js:1265–1296,1406–1415`); live statuses/tokens are durable in the audited engine state. Executed tier requires the **new** completed call evidence. Merge acceptance and the final merge-adjusted gate outcome are only determined later. M1 and M2 specify the missing design work; moving capture after `prepareMerge` or after the RPC would not solve it.

## HIGH findings

### H1 — Routing receipt intents and participation-wide recovery are not actually specified

**Blueprint:** `blueprint-slice1b.md:34,57–59,97–116`.

**VERIFIED:** the blueprint specifies per-call intents and an added paid-receipt `detail.routing`, but never specifies the `compose:route:<runId>:<issuanceToken>` metadata receipt, atomic issuance/receipt preparation, or acknowledged prelaunch delivery. These are explicitly deferred to S1b by `blueprint-slice1a.md:154` and `progress.md:109–110`; routing receipt identity and prelaunch intents also appear in `design.md:100–103,200–204,416–419`.

The supposedly authoritative spool is only used for paid receipts when `_costCeiling` is present (`lib/build.js:2288–2291`). Without that flag, receipts go directly to Stratum. Startup flushing is guarded by `waveProfilesEnabled`, not routing participation (`lib/build.js:4403–4410`). Cancellation can exit before spooling (`:2237–2246`). Continuation copies routing records, not pending receipts (`lib/routing-ledger.js:325–340`; `lib/gsd.js:236–239,326–335`). The blueprint acknowledges the latter fact at line 46 without assigning a recovery mechanism.

**CONSEQUENCE:** an implementer can satisfy the listed join tests using a ceiling-enabled run while ordinary-only shadow runs lose durable delivery intents and payload-equality protection. A new GSD physical run can lack access to an old pending receipt. Call intents alone do not deliver the S1b metadata-receipt guarantee.

**Required blueprint correction:** define the metadata payload/ID and an atomic durable operation or equivalent fail-closed invariant binding issuance and pending metadata; name the prelaunch flush point and every participating resume/terminal recovery entry. Route participating paid receipts through the existing spool independently of `_costCeiling`, preserving the legacy off path. Retain the original physical run/journal as receipt owner across continuation and define delivery after cancellation as locally retained/incomplete when upstream refuses. Define a schema for the actual `detail.routing` payload, which differs from both proposed RoutingJoin record shapes.

**Required evidence:** ordinary-only and no-ceiling Build/GSD producers; crash between issuance, pending receipt and launch; lost receipt acknowledgement; replay with changed bytes through `reportUsageReceipts`; old-run late delivery after continuation. Assert exact metadata IDs and zero usage.

### H2 — The S1b unsupported-observation population has no producer or usable record contract

**Blueprint:** `blueprint-slice1b.md:33–46,50–55,104`.

**VERIFIED:** the proposed call records require `issuanceId`, and outcomes are per issuance. No unsupported observational identity/record branch or engine-receipt ingestion path is specified. Current ordinary admission excludes fanouts/non-agent steps (`lib/build.js:1068`); consumer routing participation is single-stage only (`:1308–1309`). Deferred multi-stage bindings are deliberately not supported issuance bindings (`lib/consumer-fanout.js:481–482,835–840`). Engine-owned calls occur in Stratum, outside Compose's normalizer/client hooks (`../stratum/ts/src/engine/engine.ts:2399,2531–2580,2743–2767`).

The named auxiliary launches also include calls without an engine issuance: gate Q&A at `lib/build.js:3001`, review fixer at `:5736`, and the startup probe invoked at `:4172` with its actual call at `lib/codex-preflight.js:138`. `design.md:217–231,416–419,445` explicitly assigns unsupported observations to S1b, including receipt-based identities when no issuance token exists.

**CONSEQUENCE:** these calls must either disappear, be attached to an invented/arbitrary issuance, or fail the proposed schemas. Merely permitting each launch to be “asserted out of scope by name” at line 104 lets implementation tests waive a governing deliverable.

**Required blueprint correction:** specify unsupported identities, parent links when available, null/incomplete physical fields, source and exclusion rules, and ingestion from available engine receipts. Distinguish a normalization child observation from its parent's inclusive cost. Assign producers and tests for engine fanout, multi-stage consumer stages, normalization repairs and the named auxiliary calls. Explicit lack of engine evidence must remain visible; do not invent a routable issuance.

### H3 — Confirmed cancellation cannot supply the required acknowledged `stepDone`

**Blueprint:** `blueprint-slice1b.md:75,107,122,133,153`.

**VERIFIED:** `stepDoneLocked` rejects a cancelled run before token/result handling (`../stratum/ts/src/engine/engine.ts:746–748`). Compose's cancellation catch throws before preparing/reporting a consumer failure envelope (`lib/build.js:1799–1806`), and other control abort paths also send no `stepDone` (`:1820–1831`). Cancellation confirmation uses engine audit (`lib/build-cancel.js:98–106`), not successful result submission. GSD direct agent errors similarly throw without `reportRoutingStep` (`lib/gsd.js:661–670`). GSD also does not terminate its status loop on `cancelled` (`:348–355,791`), which the blueprint defers despite requiring cancellation outcomes.

**CONSEQUENCE:** the proposed acknowledged-envelope-only path cannot settle actual confirmed cancellations and does not cover GSD connector failures. A test that fabricates a successful cancellation `stepDone` acknowledgement proves an impossible production path. Broadening token equality alone would risk converting uncertain execution into safe-to-redispatch state.

**Required blueprint correction:** separate acknowledged engine rejection of a specific submitted token from cancellation proof. Specify durable run cancellation plus per-call termination/uncertainty evidence and original issuance binding; leave unconfirmed teardown uncertain. Name Build/GSD catch, teardown, resume and terminal hooks, including a reachable GSD cancellation exit. Preserve success equality and the rule that cancellation stays censored even if replacement work follows (`design.md:299–303`). Lost failure acknowledgements need an explicit recovery/refusal rule because current result events do not automatically provide the removed token.

A token-absent **failure** settlement extension is reasonable in S1b: `failAttempt` deletes tokens (`../stratum/ts/src/engine/engine.ts:2478–2503`), and retries require a settled predecessor (`lib/consumer-fanout.js:768`). The defect is the proposed evidence mechanism, not touching S1a-owned validation.

### H4 — The shared call sink has no issuance-binding input or per-issuance installation contract

**Blueprint:** `blueprint-slice1b.md:34,52–55,115`.

**VERIFIED:** `intent({purpose, transport, profileIntent})` has no issuance/run/item parameter or specified bound-sink factory, although it must persist `issuanceId` and `recordId`. Build passes the same run `context` and `stratum` into consumer calls (`lib/build.js:4452–4470`), schedules overlapping consumers (`:4510–4536`), and discovers the actual issuance within each invocation (`:1570–1575`). The normalizer and connectors do not currently receive that shared Build context as an argument (`:1766–1797`; `lib/result-normalizer.js:569–599`).

**CONSEQUENCE:** a mutable “current issuance” on `context.routingCalls` or the shared client can bind A's completion/repair to B. Identical provider/profile information cannot distinguish same-key items. Sorting call arrivals in the golden helper does not test receipt ownership.

**Required blueprint correction:** specify an immutable per-issuance observer binding, passed through internal options to the primary and every child call, plus a separate binding for unsupported auxiliary calls. Choose one intent-owning layer so installing hooks at client, normalizer and `runAgentText` does not triple-count one dispatch. Define stable per-call identity within an issuance and await durable intent completion before launch.

**Required evidence:** force A/B launch, return and repair order to differ; use same profiles but distinct returned IDs and usage amounts. Assert each persisted call/receipt/ledger link against the originating descriptor, after restart and late delivery. Do not derive expected ownership from arrival order or the generated ledger.

### H5 — The call-ID rule rejects the real local connector's identity while MCP uses the same mechanism

**Blueprint:** `blueprint-slice1b.md:24,35,54,57,105`.

**VERIFIED:** local `runLocalClaudeAgent` creates one wrapper `dispatchId` at `lib/local-claude-connector.js:213`, invokes the SDK at `:217`, and attaches that same ID to success/error at `:309,336`. MCP likewise creates its ID before invocation (`lib/stratum-mcp-client.js:269,275`) and attaches it after success/error (`:285,297`). MCP can also fail before dispatch (`:312–330`). The evidence report itself distinguishes these actual-call wrapper identities from normalizer fallback IDs (`reports/slice1b-evidence.md:36,54–55`).

**CONSEQUENCE:** the explicit instruction that the local wrapper ID is “never” a resolution `callId` excludes every ordinary local connector result regardless of real reported cost. Applying the same logic consistently excludes MCP wrapper IDs too. Conversely, accepting MCP IDs merely because they exist incorrectly treats preflight rejection as execution. This is separate from missing effort: the blueprint makes otherwise attributable local spend incomplete before tier certification is considered.

**Required blueprint correction:** distinguish an identity assigned once at the actual connector invocation boundary from a fallback fabricated later because an identity was lost. Retain the real wrapper ID for attribution, with separate execution/usage evidence and launch outcome; ID existence alone proves neither payment nor successful execution. If a provider-native ID is instead mandatory, name its actual producer, extraction and receipt crosswalk for both transports. It is not the current returned `dispatchId` contract.

The narrow effort conclusion is sound: current local returned telemetry omits effort, and `appliedEffort` is configuration (`lib/local-claude-connector.js:151,287–307`). Returning that configured value under a new name would not prove reported execution. Recording null executed-tier evidence is appropriate; it does not require rejecting a valid dispatch identity.

## MEDIUM findings

### M1 — “The full wave at the top” lacks a wave-selection and history-binding specification

**Blueprint:** `blueprint-slice1b.md:38–39,65–69,103,106`.

**VERIFIED:** the closure's merge fanout is only an immediate predecessor (`lib/build.js:5452–5454`; `lib/gsd.js:728–729`). The bundled adjudication gate follows `assess`, not `execute` (`presets/team-fable-astra.stratum.yaml:226–230`), so there is no `consumerFanoutStep` at precisely the gate that classifies repair work. Its revise resets the dependency closure, potentially including several ordinary/fanout steps (`../stratum/ts/src/engine/engine.ts:2784–2838`). The proposed snapshot has one `logicalWaveId` and no explicit run/scoped-step/epoch identity for unissued/skipped items. Admission is whole-wave but issuance preparation only covers returned descriptors (`lib/build.js:1265–1296`); some items can be skipped without any token (`../stratum/ts/src/engine/engine.ts:1960–1967`). Ordinary epoch records do not themselves contain downstream dispositions (`lib/build.js:1117–1122`).

Further, `prepareMerge` may change approve to revise/kill after the proposed capture (`lib/build.js:5504–5559`; `lib/gsd.js:754–757`). Gate validation does not prove exhaustive disposition of original review findings (`lib/output-gate.js:24–39`). Deferring stricter dispatch validation does not authorize using an incomplete partition as acceptance evidence.

**CONSEQUENCE:** choosing the local merge predecessor captures nothing at `assess_gate`; requiring an issuance for every wave item fabricates identities or rejects skipped/unissued items. Task-ID-only lineage cannot identify the right historical B after repeated repairs or retained A absent from the current wave. Capturing only the requested action can mislabel a merge failure as approval.

**Required blueprint correction:** define how gate configuration/reset dependencies select all relevant retained admissions/epochs and ordinary issuances, including non-adjacent fanouts. Specify nullable issuance fields and retained full-item/source references. Bind lineage to prior snapshot/admission/issuance IDs, not task strings alone. Persist the final proposed RPC decision after merge adjustment but before RPC, then append acknowledgement separately. Define observation-only partition/ownership checks and unknown/censoring for ambiguity. Add real `assess_gate`, merge-induced revise, skipped item, ordinary-step and multi-wave retention cases.

### M2 — A prepared merge token is not evidence that its gate transition was acknowledged

**Blueprint:** `blueprint-slice1b.md:26,67,109,133`.

**VERIFIED:** `prepareMerge` persists the token before any gate RPC (`lib/consumer-fanout.js:1401–1415,1470–1488`). Engine `gate_resolved` events omit that token (`../stratum/ts/src/engine/engine.ts:1338,1350`); existing recovery correlates by ordinal (`lib/consumer-fanout.js:1931–1937`). Therefore both “crashed before sending” and “sent, committed, lost response” can leave the same prepared token locally. Some carry-revise provenance does retain a token (`../stratum/ts/src/engine/engine.ts:1293,1365–1367`), but it is conditional and is not the universal merge-transaction proof proposed here.

**CONSEQUENCE:** calling a recovered transition token-confirmed merely because the transaction contains a token upgrades intent to acknowledgement and may falsely certify acceptance. Gates without merge transactions have no such proposed path at all.

**Required blueprint correction:** enumerate sufficient witnesses: for example, durably record the successful response to the token-bearing request; after response loss, use only an explicitly validated engine witness where available. Otherwise preserve ordinal/unconfirmed classification. Test crash before RPC, committed RPC with lost response, restart before local acknowledgement, and a later round of the same gate. Do not let existing ordinal-based `markGateResolved` become token proof retroactively.

### M3 — Exactly-once immutable resolution conflicts with later completion evidence

**Blueprint:** `blueprint-slice1b.md:35,44,57,83,131–132`.

**VERIFIED:** the proposed resolution permits `outcome: unresolved` and null `callId`/`usageRef`, but is written exactly once. The journal rejects changed bytes for the same record ID (`lib/consumer-fanout.js:717–724`). Only the materialized ledger is revisioned by the proposed section 5.

**CONSEQUENCE:** once recovery writes an unresolved resolution, later genuine completion/usage cannot update the authoritative call evidence. Incrementing a ledger version does not repair the immutable record; either the row remains incomplete forever or the writer quietly bypasses the declared source-of-truth rule.

**Required blueprint correction:** distinguish pending derived state from terminal immutable resolution, or define append-only resolution-evidence revisions with a validated chain and deterministic latest selection. Specify which late events may improve completeness and which conflicts refuse. Test unresolved → genuine late completion → repeated delivery, including reload and continuation, rather than only “lost resolution stays unresolved.”

### M4 — Routing refusal propagation is required at more than `reportUsageReceipts`

**Blueprint:** `blueprint-slice1b.md:50–59,104–105,132`.

**VERIFIED:** the blueprint explicitly protects routing-join refusal only from the warning catch in `reportUsageReceipts`. Normalization repair catches all errors (`lib/result-normalizer.js:797–816`), the review normalizer swallows the rethrow (`lib/review-normalize.js:153–158`), and post-repair escape currently recognizes cancellation/control failures, not routing failures (`lib/result-normalizer.js:830–844`). `runAgentText` catches usage-sink exceptions (`lib/stratum-mcp-client.js:885–890`), and several Build usage callers also catch and warn, including the gate fixer (`lib/build.js:5755–5772`).

**CONSEQUENCE:** failed intent persistence or changed-join refusal can be swallowed as ordinary repair failure; the run can settle successfully without the required durable call evidence. Passing a raw connector-hook test will not detect this.

**Required blueprint correction:** specify participation-gated propagation of routing integrity/persistence errors through every owning catch layer, distinct from fail-open receipt delivery errors. Inject an intent-write failure before repair, a resolution-write failure after a billable repair, and a changed receipt through the full production normalizer/runner path. Assert no launch before durable intent, no false successful settlement, and no silent rerun.

### M5 — “No journal, routing on, green” contradicts fail-closed participation

**Blueprint:** `blueprint-slice1b.md:89–91,103,108,134`.

**VERIFIED:** the ten listed adapters really lack a journal. But a participating call requires a bound admission and issuance, accessed through the artifact manager (`lib/build.js:1564–1575`); the journal validator deliberately refuses a missing participating journal (`lib/routing-ledger.js:369–374`). This is required by `design.md:200–205`, not optional compatibility behavior. The optional-access repair inventory is also incomplete: `publishConsumerCheckpoint` has the same `artifacts?.journal.wave` dereference at `lib/build.js:1424`, immediately on the GSD checkpoint path (`lib/gsd.js:773,779`).

**CONSEQUENCE:** making all bare adapters successfully execute with routing on either bypasses the durability contract or forces tests to assert an impossible configuration. Merely replacing the four named accesses leaves another identical checkpoint failure. Section 6 lists four fixes while dispatch 2 assigns only “two.”

**Required blueprint correction:** split tests into off/nonparticipating adapters (successful legacy behavior), real participating journal contexts (successful durable behavior), and participating missing-journal contexts (named refusal before any call). If a legacy artifact adapter is supported alongside a separate routing journal, define that arrangement explicitly. Audit the entire newly reached checkpoint chain, including `publishConsumerCheckpoint`, and assign all hardening sites consistently.

### M6 — The completion tests can pass without establishing the design's final evidence

**Blueprint:** `blueprint-slice1b.md:111–116,126–136`.

**VERIFIED:** the test table requires a real-engine carry run but not the live-fire shadow build required by `design.md:459`. The carry helper runs a controlled project through `runBuild` (`test/helpers/build-wave-golden-fixture.js:182–187`); that is useful production-path evidence, not live model telemetry evidence. `normalizedGoldenCalls` only sorts and compares call arguments (`:234–263`), not routing joins. The frozen GSD artifact covers inputs/options, not a full connector trace (`test/fixtures/model-route-off-gsd-input-v0.5.1.json:2–40`).

The table also lacks an explicit terminal materialization matrix for Build's already-terminal resume/exception/cancellation paths (`lib/build.js:3919–3952,6352–6420`) and GSD pause/exception paths (`lib/gsd.js:358–394,460–473`). A generic “one final outcome” helper test can pass while these producers never call it.

**CONSEQUENCE:** all checkboxes can be green with no real-provider attributable sample, no verified GSD off call identity, and missing ledger rows on early exits. The additional defects above can also hide behind fixture-built joins or impossible acknowledgements.

**Required blueprint correction:** distinguish deterministic real-engine evidence from live-fire completion evidence; explicitly retain the latter as outstanding until obtained. Require independent expected call ownership/amounts, a GSD off/shadow connector trace comparison, and producer-driven materialization on normal completion, failure, cancellation, already-terminal resume, pause/continuation and thrown post-call errors. Assert no blanket acceptance, one record per issuance, and no rerun during recovery. Tests may use controlled inference, but should not seed the very join, gate acknowledgement or outcome being proved.

## LOW finding

### L1 — Several claimed verified anchors and inventory statements are themselves wrong

**Blueprint:** `blueprint-slice1b.md:10,65,79,91,103,151–156`.

**VERIFIED corrections:**

- Section 1's eight-stale count should be five stale plus one partially stale, as inventoried above.
- Section 4 points to `lib/gsd.js:775` as the gate RPC; that line is recovery `resume`. The reset-capable call is `:764`. Build has five closure invocations, with configured output sharing the skip branch, not six distinct invocation sites.
- The GSD missing-journal merge-transaction access is `lib/gsd.js:758`, not `:760` (a closing brace).
- The sidecar follow-up's `lib/gsd.js:156,606` anchors are stale: preflight is `:161–166`, ordinary bare dispatch is `:651–660`; `:156` is a budget comment and `:606` is a stuck-task field.
- The ledger is not the first project-scoped routing artifact. S1a already persists starts and records under `.compose/routing` (`lib/routing-ledger.js:78–98,115–130,270–277`). It is the first project-wide **outcome ledger**.
- “Recorded in progress.md” at line 151 is false for the new follow-up list in the current tree: `progress.md` ends at line 234 with S1a completion. The older GSD sidecar follow-up is present at `:93–96`.

**CONSEQUENCE:** implementers following these claimed verified anchors land in recovery/comment/unrelated code, miss a guard, or assume follow-ups and storage ownership already exist. Correct the blueprint's references and inventory rather than propagating them into dispatch briefs. These are documentation defects, not reasons to change the corresponding production behavior.

## Scope and completion assessment

| Governing S1b obligation | Assessment |
|---|---|
| Every primary/failure/repair call joined to its original issuance | Intended, but H2–H5 and M4 leave identity, ownership and failure reachability unresolved. |
| Receipt intents, exact metadata identity and restart/continuation recovery | Incomplete specification: H1. |
| Pre-reset full task evidence, gate disposition and retained/repaired lineage | Correct timing; insufficient population/witness specification: M1–M2. |
| Acceptance labels, cancellation censoring, unmatched tokens and missing lineage | Labels copied correctly; production evidence and cancellation precedence need explicit tests: H3, M1, M6. |
| Unsupported engine/multi-stage/subcall observations | Missing implementable record/producer plan: H2. |
| Missing-cost exclusion and parent/child unique-paid-ID reconciliation | Correct stated policy. Must include uncredited successful/failed repairs and unknown calls in the production oracle; wrapper-ID rule currently undermines it. |
| Idempotent ledger, one latest sample, late completion | Correct journal-versus-ledger distinction and project-lock requirement; unresolved-resolution lifecycle still conflicts: M3. |
| Live-fire nonempty ledger and reconciled complete/excluded cost | Absent from implementation completion tests: M6. |

No concrete report, calibration prompt, learned-selection, trial/exploration or repair-floor **enforcement** implementation is pulled into S1b. Defining the reusable eligibility predicate and recording tier history are appropriate. References to denominators/breadth in S1b tests should establish retained evidence and exclusion semantics; S2/S3 still own report/policy recomputation. Do not fix the GSD sidecar dispatch behavior inside this slice: the existing refusal ruling remains controlling.

Where the blueprint corrects the design/evidence interpretation, retain those corrections: normalization repair uses MCP behind a local primary; `readFlowSpend` is not routing completeness; Compose payload dedup and Stratum id-only dedup differ; artifact acceptance is not downstream acceptance; ledger revisions must not inherit immutable journal-ID rules. The new findings concern how those facts are translated into an implementable S1b plan.
