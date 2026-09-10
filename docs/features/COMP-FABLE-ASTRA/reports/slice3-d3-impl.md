# Slice 3 dispatch 3 implementation

Base: b41811b. Added tests/helpers and documentation only; NO production function edits, sibling writes, commits, installs or full-suite run.
Preserved existing/concurrent progress.md, slice4-preset.md and COMP-GUARD-CLAIM-1/audit.json changes.
Outcome: fixture and independent real connector pass; all four integrated wave goldens STOP before worker dispatch on real contract defects. These are not sandbox failures.

Implementation:
- `test/helpers/fake-codex-project.js`: opt-in argv/model logging (`-m` and `--model`), exact prerequisites before any writes, strict multi-file writes (including deliberately unowned edits), executable wiring review and deterministic fake cost. Legacy lane defaults preserved.
- `test/helpers/build-wave-golden-fixture.js:30`: TEST YAML/sidecar, carried Task[] waves, verify after merge, critical default + item tiers, ownership/independence/checkpoints, output gate validator, ceiling and ship.
- `test/helpers/build-wave-golden-fixture.js:118`: real StratumMcpClient; proxy routes only Claude inference to d2 fakeBuildStratum/agentResult. Codex uses the untouched real client.agentRun. Reopens the real client after runBuild closes it, to audit durable terminal state. No engine, audit or receipt acknowledgements are fabricated.
- `test/helpers/build-wave-golden-fixture.js:156`: child-only SIGKILL at markCheckpointPublished entry, after verifying prepared journal + published ref; resume opens another real server. No production hook added.

Validation (logs retained under /tmp):
- Requested golden command: `node --test --test-timeout=900000 test/integration/build-wave-golden.test.js > /tmp/d3.log 2>&1; echo $?` → 1; initial run 5 tests, 1 pass / 4 fail, 0 cancelled/skipped, 6.17s. Stopped each defective golden; no production workaround or rerun of those cases.
- Subsequently added independent connector case and corrected assertions to use the real receipt spine / public audit event shapes. Selected final-file check: `node --test --test-timeout=900000 --test-name-pattern='^(fixture:|real connector:)' test/integration/build-wave-golden.test.js > /tmp/d3-independent.log 2>&1; echo $?` → 0; 2/2 pass, 3.10s.
- The final file contains six tests: two verified independently, four blocked; assertions beyond those four failures remain unexecuted.
- Required d2 gate: `node --test --test-timeout=180000 test/profile-preflight.test.js test/build-output-gate.test.js test/build-wave-routing.test.js test/build-wave-ship.test.js test/gsd-wave-routing.test.js test/ts-cutover-build-golden.test.js test/ts-cutover-consumer-fanout-golden.test.js test/gate-round-reentry.test.js test/build-ship-gate.test.js > /tmp/d3-d2.log 2>&1; echo $?` → 0; 125/125 pass, 0 failed/cancelled/skipped, 101.58s.
- Three helper/test `node --check` commands and `git diff --check` passed. Real server resolved to sibling `stratum/ts/src/mcp/bin.mjs` through the existing test-bin resolver.

Defects retained for owning dispatches:
1. **D2 integration / Stratum MCP contract handoff:** every proposed metadata receipt fails `MCP error -32603: stratum_usage_report.request.receipt.detail is undeclared`; runner throws `WAVE_EVIDENCE_INCOMPLETE` at `lib/build.js:798`. Engine ReceiptInput supports detail, but `../stratum/ts/contracts/mcp-surface.json:360` omits it from the wire request. Sibling remains read-only.
2. **D2 admission:** `lib/build.js:820` requires audit.steps.execute.epoch to be an integer. A fresh real run omits that top-level epoch, while descriptor/item epochs are 0 and carry has all four items. This produces `WAVE_INPUT_INVALID: item 0 Recorded wave length/epoch differs from fanout` before tier validation; defect 1 then masks its reporting. Confirmed from the actual audit and retained pending receipt, `/tmp/d3-epoch-probe.log`; raw wire/persisted comparison in `/tmp/d3-surface-probe.log`.
3. **D1 ownership envelope:** `lib/consumer-fanout.js:164,1155` returns `OWNERSHIP_VIOLATION`, not the required `FILES_OWNED_VIOLATION`. A disposable Git + existing d2 runner probe produced `{failure:"OWNERSHIP_VIOLATION: Task T1 changed unowned paths: outside.txt"}` and failed flow; `/tmp/d3-ownership-probe.log`. The golden deliberately keeps the brief's exact code assertion.
- Source-inspected follow-on limitation, not a reached golden assertion: `../stratum/ts/src/engine/engine.ts:2725` constructs usage_debit detail without caller metadata; `:1053` / `../stratum/ts/src/mcp/server.ts:617` expose no receipt spine in audit. Intended metadata is required in the golden's public audit assertion but its delivery is blocked first by defect 1. D2/Stratum handoff must settle this; no invented audit.receipts field or test shim.

Reproduce defects 1/2 from this checkout (no worker model calls):
```bash
node --input-type=module <<'JS'
import {makeWaveGoldenProject,runWaveGolden,readGoldenJournal} from './test/helpers/build-wave-golden-fixture.js';
const f=await makeWaveGoldenProject('repair');
try { await runWaveGolden(f); }
catch(e) { console.log(e.message); console.log(JSON.stringify((await readGoldenJournal(f)).pendingUsageReceipts,null,2)); }
finally { await f.cleanup(); }
JS
```
Reproduce defect 3 through the existing d2 fake-client path (independent of the blocked MCP golden):
```bash
node --input-type=module <<'JS'
import {buildWaveFixture} from './test/helpers/build-wave-fixture.js';
import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
const cleanup=[]; const f=buildWaveFixture({after:fn=>cleanup.push(fn)},{mutate:cwd=>writeFileSync(join(cwd,'outside.txt'),'forbidden\n')});
try { await f.run(); console.log(f.stratum.calls.filter(c=>c.type==='stepDone').map(c=>c.envelope)); }
finally { for(const fn of cleanup) await fn(); }
JS
```

Design Completion evidence, in checklist order (PASS applies only to the stated test scope):
1. Live Fable plan/assess + Astra review and installed CLI: LIVE-FIRE ONLY. Claude is stubbed; independent real connector verifies fake Astra argv/telemetry at `test/integration/build-wave-golden.test.js:69`.
2. Mixed worker tiers + sixth invalid tier: tests authored at `test/integration/build-wave-golden.test.js:86,149`, UNVERIFIED across waves; three explicit model argv/telemetry routes PASS at :69, and d2 fake-client admission/routing PASS at `test/build-wave-routing.test.js:30,40`.
3. Invalid sidecar tier/provider combination: PASS `test/profile-preflight.test.js:47`; actual provider/model availability remains LIVE-FIRE ONLY.
4. Overlap + wave-2 prerequisite: legacy harness overlap PASS `test/ts-cutover-consumer-fanout-golden.test.js:1394`; fake executable prerequisite checks PASS `test/integration/build-wave-golden.test.js:35`; carried checkpoint inheritance authored at :86, UNVERIFIED.
5. Ownership refusal: existing d2 fake-client test PASS `test/build-wave-routing.test.js:52`; exact required code and real connector/tree evidence authored at `test/integration/build-wave-golden.test.js:162`, UNVERIFIED and code defect 3 confirmed separately.
6. Green unit tests / wiring review / affected repair only: fake executable controls PASS `test/integration/build-wave-golden.test.js:35`; complete two-wave repair/remerge assertions at :86 are UNVERIFIED. Real model review quality remains LIVE-FIRE ONLY.
7. Kill/resume around execute/merge: legacy real-engine/harness crash regressions PASS `test/ts-cutover-consumer-fanout-golden.test.js:1644,1760`; new publication boundary at `test/integration/build-wave-golden.test.js:206` is UNVERIFIED.
8. Mid-wave cancellation of live workers and exclusion of cancelled patches: LIVE-FIRE/D5 evidence still required; not added or claimed here.
9. Exhausted assess rounds / blocked ends failed with findings: fake-client blocked mapping PASS `test/build-output-gate.test.js:23`; full carried-loop terminal evidence remains LIVE-FIRE/UNVERIFIED.
10. Ceiling breach, raised-limit human revise: d2 fake-client PASS `test/build-output-gate.test.js:46,72`; real carried engine/receipt path remains UNVERIFIED.
11. Published checkpoint kill/restart / one checkpoint / no reapplied diff: authored at `test/integration/build-wave-golden.test.js:206`, UNVERIFIED; single base-parent ship/no wave ancestry assertions at :26 also UNVERIFIED.
12. Clean global install parity: LIVE-FIRE/host evidence only; no npm install or installed CLI execution performed.

Sandbox/host handoff: no ps/port denial observed in executed checks. Untagged direct connector calls passed. Flow-tagged worker registration, two-wave dispatch/receipts, unknown-tier failed terminal state, ownership terminal envelope, SIGKILL publication/restart and ship ancestry remain UNVERIFIED because real contract defects stop earlier, not because a sandbox failure was observed. After owning-dispatch fixes, run the full six-test golden command above with 900000ms and the controller's full suite on the host.
Docs touched: `docs/pipelines.md` (existing sidecar home; objects/metadata/ownership/all named failures/ceiling/recovery and current integration limits), `docs/cli.md` (limit/resume/fresh), `CHANGELOG.md` (Unreleased), blueprint-slice3.md (short Implemented block only; body preserved).

## Fixes r1

- Surface requirement/comment now 20 (`receipt.detail`); `REQUIRED_STRATUM_RANGE` remains `>=0.5.0`. No sibling edits, installs or commits; dispatch-3 work preserved.
- Real probe `/tmp/d3-fix-epoch-probe.log`: fresh `execute` lacks parent epoch; all four `fanout.items[].epoch` are 0 (including pending item 4); `audit.carry.wave.value` contains the full list.
- Admission uses `state.epoch ?? state.fanout.items[0].epoch`, requires a nonnegative integer and consistent effective epochs across ALL items, and retains length/index/generation/descriptor checks. Ordinary source steps use the engine's omitted-initial-epoch = 0 convention.
- Nine routing regressions cover fresh carry/plan shapes and absent/mismatched epochs, pending-item epoch, index, generation and length refusal before dispatch.
- Ownership findings/tests/docs now use `FILES_OWNED_VIOLATION`; `OWNERSHIP_EVIDENCE_MISMATCH` unchanged. The earlier historical defect descriptions above are superseded.
- Golden model metadata reads `readFlowSnapshot` with journal revision validation; proposed receipt seq must equal the client's acknowledged seq. No invented audit metadata assertion.
- Fixed fixture nested Node test execution by removing `NODE_TEST_CONTEXT`; ownership golden checks BOTH engine-default attempts for the exact failure code and absent success output.
- Final six-test golden: exit 1, **4 passed / 2 failed**, 0 cancelled/skipped, 18.86s (`/tmp/d3-fix.log`). STOPPED further golden work on the Stratum defect below.
- D2 gate: exit 0, **134/134 passed**, 0 failed/cancelled/skipped, 117.64s (`/tmp/d3-fix-d2.log`). Ownership/surface supplement: **21/21 passed**; syntax and diff checks pass.
- **STOP / controller-owned Stratum:** successful real Codex calls emit fake USD 0.001 but return no `usage.usd` or `usdSource`; persisted paid receipts have `costUnknown:true`. Both remaining goldens pause at assess_gate with `WAVE_COST_UNVERIFIED: Model call has no attributed cost`.
- Exact cause: `../stratum/ts/src/connectors/codex.ts:257,328` accumulate cost; success returns at :267-272 and :414-419 omit it. Standalone reproduction below; asserting `result.usage.usd === 0.001` fails (undefined). Full probe: `/tmp/d3-fix-stratum-cost-repro.mjs`, log alongside; integrated evidence: `/tmp/d3-fix-cost-probe.log`.
- UNVERIFIED: two-wave repair/remerge, complete per-item receipt assertions and squash ship; crash test reached CAS/SIGKILL and resumed, but terminal one-checkpoint/one-ship assertions remain blocked. No ps/port/sandbox denial observed. Beyond this STOP, initial gate/checkpoint epochs and effort-suffixed telemetry assertions still need controller follow-up; no workaround retained.
```bash
node --input-type=module <<'JS'
import {makeWaveGoldenProject} from './test/helpers/build-wave-golden-fixture.js';
import {StratumMcpClient} from './lib/stratum-mcp-client.js'; import {TS_MCP_BIN} from './test/helpers/stratum-test-bin.js';
const f=await makeWaveGoldenProject('repair'), c=new StratumMcpClient();
try { await c.connect({command:process.env.COMPOSE_STRATUM_TS_NODE||process.execPath,args:[TS_MCP_BIN],cwd:f.workspace,env:f.env}); const result=await c.agentRun('codex','## Intent\nD3_WORK {"id":"CORE"}\n\n',{cwd:f.workspace,modelID:'gpt-6-astra',sandboxMode:'workspace-write'}); console.log({emittedUsd:JSON.parse(f.env.COMPOSE_FAKE_CODEX_BEHAVIOR).costUsd,result}); }
finally { await c.close(); await f.cleanup(); }
JS
```

## Fixes r2 (controller, 2026-09-10)

- Stratum @9e6363a: `CodexConnector` success returns dropped `usd`/`usdSource`/`cacheRead` (failure path had them); one shared `codexUsageFields` now feeds both. Regression in `ts/tests/connectors/codex.test.ts` ("carries the reported cost …").
- Stratum @db8666c: the codex `step_usage` event hardcoded `cost_usd: 0`; it now carries the turn's reported cost or omits the key.
- compose `lib/result-normalizer.js`: when streamed events carried no dollar value but the connector's final result reports one with provenance, adopt it (the final result is authoritative for cost).
- compose `lib/build.js` `evaluateConfiguredGate`: audit states are normalised with `epoch ?? 0` (engine convention: an unrevised step omits its epoch) before the gate's staleness fence — a fresh run no longer holds with `GATE_SOURCE_STALE` on every first pass.
- Golden assertions: Codex usage records carry `<model>/<effort>`; the model half is compared to the tier's model and the effort half to the tier's default effort.
- Six-test real-engine golden on the host: **6/6 pass** (two carried waves + affected-only repair + squash ship; unknown-tier zero-dispatch; FILES_OWNED_VIOLATION; SIGKILL after ref CAS → one checkpoint, one ship).
