# COMP-MODEL-ROUTE S1b — dispatch 3

Date: 2026-09-12. Implementation on `ee0a5c1` (dispatch-2 revisions `975ff50` and `4fb236c` are present). No repository commit or push. **Live-fire gate 5 remains OUTSTANDING.** Controlled SDK inference is not real-provider completion evidence. The parent feature remains incomplete pending S2/S3.

## Scope and implementation

Extended the four specified golden files, plus one backward-compatible SDK-input option on `test/helpers/real-codex-tool.js`. Updated README, team-presets documentation, changelog, blueprint and progress. No production fix was required; no sibling source or frozen fixture was changed. The unrelated untracked `COMP-GUARD-CLAIM-1/audit.json` is untouched.

Source review corrections used during implementation:

| Blueprint description | Actual API / seam | Implementation consequence |
|---|---|---|
| Controlled inference in the older goldens | `installAgentHarness` replaces agentRun; older Claude Build calls use `fakeBuildStratum` | Retain those fixtures as the frozen oracle; new paid cases use actual `StratumMcpClient`, `CodexConnector` and `ClaudeConnector`, controlling only SDK input. |
| Call options carry observation | `routingCallOptions` makes `routingCalls` non-enumerable | The entropy-pinning wrapper preserves property descriptors. Spreading these options would silently remove the observer. |
| Review repair needs a ReviewResult | `deriveConsumerReviewOptions` keys on the contract root and normalization emits the full canonical contract | Load the canonical contract from `presets/team-review.stratum.yaml`; never supply a join or normalized result. |
| Carry delivery can be delayed | The cost ceiling correctly holds on undelivered evidence | The additional adversarial fixture explicitly omits the ceiling; frozen ceiling fixtures remain unchanged. |
| Already-terminal GSD resume | Completed runs have no resumable pause; cancelled engine runs refuse resume | Assert the real refusal and zero further plans/calls, with unchanged retained evidence. Do not fabricate a terminal response. |

`goldenProviderTool` uses `realCodexTool({ sdkEvents })` and real Claude SDK messages. The real connectors create usage, token split, duration, model/effort and cost provenance, including failure evidence. The MCP error adapter forwards connector-owned fields. The normalizer creates repair calls and credited/fallback outputs; the real engine creates tokens, receipts and gate acknowledgements. New tests never seed a routing join, acknowledgement, outcome or ledger row.

## Acceptance gates

Blueprint Dispatch-3 gates **1–4 are closed** by the final positive run and negative controls below. Gate 5 remains **OUTSTANDING**.

1. **Off identity.** The three unchanged v0.5.1 fixtures are consumed by the original production Build/carry/GSD tests. Full call objects retain prompt/provider/model/effort/tool/sandbox/call-count comparisons. Shadow inputs now check the complete input object and validated transport explicitly, without filtering input keys. The new bundled paid-shadow case uses the unmodified `presets/team-fable-astra.stratum.yaml` and still matches the frozen five-call trace. The independent GSD test runs `pipelines/gsd.stratum.yaml` in off and shadow through the actual connector request builder, comparing all four transport requests across pause/continuation. Off cases assert no routing subtree or ledger and byte-unchanged ignore files.
2. **Real-engine ledger and reconciliation.** The bundled paid case has five complete attribution rows: plan/verify/assess $0.25 each, execute/review $0.001 each. Carry primary amounts are independently prescribed as A0=$1, B0=$2, B1=$16; normalization children are $4/$8/$32. Ordinary calls total $1.75. No-repair unique spend is $20.75; each repair variant is $64.75. Tests cover successful, failed and uncredited normalization repairs, failed primary usage, unsupported child observations and unknown USD. Parent totals are $5/$10/$48 with repairs, while child rows remain excluded; `reconcileRoutingPaidReceipts` must deduplicate them. Eligible complete and excluded unique-receipt partitions sum to the same independently expected total. Unknown USD stays null with `missing-usd`, never a free call.
3. **Ownership across reset and late delivery.** A/B use identical standard model/effort profiles. UUID entropy is prescribed independently at the actual connector invocation boundary. Launch order A0/B0/B0-repair/A0-repair differs from return order B0/A0/A0-repair/B0-repair. The real carry gate replaces `[A,B]` with `[B]`, moving B from index 1 to index 0. Paid delivery remains unavailable through terminal materialization; `resumeRouting` and `recoverRoutingEvidence` reopen the journal and deliver original receipts. Every receipt id is checked against original task/epoch/index, parent issuance and independently specified amount. Repeated recovery is byte-idempotent and makes no model call. Sorting the separate frozen trace cannot certify this ownership test.
4. **GSD owners and terminal matrix.** The paid continuation test withholds old-run paid receipts through a real budget pause. The next `runGsd` acknowledges all three old receipts in their original owner journal and records only the new B receipt in the new run. Old/new rows share one start; original paid total is $3.50 and continuation adds $2. Latest validated call heads, resolutions and outcomes are carried into the new journal/ledger, and original rows gain revisions after late acknowledgement. A and decomposition never rerun. The matrix covers normal completion, engine failure after two failed consumer attempts, provider failure, cancellation before calls and after a paid return, already-terminal refusal, pause/continuation and post-call parse exceptions. Existing stuck/crash, three-run lineage, merge reset and uncertain-plan goldens remain in the full run.
5. **LIVE-FIRE COMPLETION EVIDENCE — OUTSTANDING.** No live provider was run. Owner authorization and retained real-provider call/receipt/ledger evidence are still required. No deterministic result closes this gate.

## Verification

Positive and check-removal commands ran from `/Users/ruze/reg/my/forge/compose`. Production-reversion commands ran in the disposable local clone `/tmp/d3-evidence/negative-workspace/compose`; its five changed test/helper files were verified byte-identical to the final working tree. This kept reversion controls separate from concurrent positive runs. Every test process had a disposable `STRATUM_STATE_ROOT` and blank RESEND/STRIPE keys. Logs are retained under `/tmp/d3-evidence`. No full `npm test`, GUI, port-binding test or process-inspection command was run.

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 test/integration/build-wave-golden.test.js test/integration/gsd-route-continuation-golden.test.js test/build-team-fable-astra.test.js > /tmp/d3-evidence/golden-verified.log 2>&1
```

**Final: 37 tests / 37 pass / 0 fail / 0 cancelled; exit 0.** The eleven-file 259-test dispatch-2 set was not rerun because no production implementation changed. The shared Codex helper's existing forwarding/local evidence population was rerun separately: 23/23, zero failures/cancellations. The multiple-owner baseline was 1/1. `git diff --check` and `node --check` on all five changed test/helper files passed.

Development runs used the same disposable-root/key environment and `node --test --test-timeout=900000`, adding `--test-name-pattern='<selector>'` when shown. Each invocation redirected directly to `/tmp/d3-evidence/<log>.log`. B = `test/integration/build-wave-golden.test.js`; G = `test/integration/gsd-route-continuation-golden.test.js`; P = `test/build-team-fable-astra.test.js`. These are development results, not negative-control evidence:

| Log | File(s) | Exact selector (absent = entire files) | Tests / pass / fail / cancelled |
|---|---|---|---:|
| paid-first | B | `d3 paid carry primary` | 1 / 0 / 1 / 0 |
| paid-second | B | `d3 paid carry` | 5 / 0 / 4 / 1 |
| paid-third | B | `d3 paid carry (primary\|success)` | 3 / 0 / 2 / 1 |
| paid-fourth | B | `d3 paid carry` | 6 / 3 / 3 / 0 |
| repair-debug | B | `d3 paid carry success` | 1 / 0 / 1 / 0 |
| repair-fifth | B | `d3 paid carry (success\|failed\|uncredited)` | 4 / 4 / 0 / 0 |
| bundled-first | P | `paid shadow` | 1 / 1 / 0 / 0 |
| gsd-first | G | `d3 GSD` | 6 / 4 / 2 / 0 |
| gsd-second | G | `d3 GSD` | 6 / 6 / 0 / 0 |
| gsd-third | G | `d3 GSD` | 6 / 5 / 1 / 0 |
| gsd-failure-final | G | `d3 GSD real producer terminal (failure\|providerFailure)` | 2 / 1 / 1 / 0 |
| gsd-failure-fixed | G | same | 2 / 2 / 0 / 0 |
| golden-final | B, G, P | absent | 36 / 35 / 1 / 0 |
| golden-strengthened | B, G, P | `d3 \|off\|full-call oracle` | 17 / 16 / 1 / 0 |

The cancelled early carry files had unresolved test-fixture barriers after an assertion failed. The final helper releases all waiting providers and awaits the runner on scheduling failure. Those cancellations are inconclusive and are not used to close any gate.

All three fixture bytes equal `git show HEAD:<path>` and retain their dispatch-2 SHA-256 values:

- bundled Build: `dcb7be4001879664d347a12abec6106a458329f7e61ca320ba211e9c7e77bf3a`
- carry: `f806519cb4d86317e4565e0eb9e8280c21e1129ff0c569ae033006f70e9d679c`
- GSD input: `1fa3aae48bb0d0d928e8b6554d6e499f40dfcf32566737f2e5630a3f194b8ae2`

Initial test-development failures were fixture mistakes, not production defects: the new carry fixture initially retained its ceiling during a receipt outage, used the wrong incomplete-reason spelling, dropped the non-enumerable observer while pinning entropy, and declared only part of the canonical ReviewResult. Terminal test assumptions also initially conflated provider failure with engine failure and expected the wrong already-completed resume message. These were corrected at their fixture/expectation source; no frozen expectation was refreshed. The first full golden run was 36 tests / 35 pass / 1 fail / 0 cancelled, on that incorrect completed-resume message. Final reruns supersede it.

## Negative controls

Both directions are required: revert observation wiring while retaining tests, and independently remove checks the observation code must preserve. Production reverts use `scripts/negative-control.sh`; check-removal mutations use a process-local Node load hook and never alter the working tree. The latter preserve executable imports, so a red tally is an assertion failure rather than a module-load failure.

Commands below ran in `/tmp/d3-evidence/negative-workspace/compose`, cloned with `git clone --shared --quiet /Users/ruze/reg/my/forge/compose /tmp/d3-evidence/negative-workspace/compose`. Only the current changed test/helper and documentation bytes were copied; node_modules and the read-only Stratum sibling were linked. No repository commit was made.

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 paid carry primary' --prod lib/build.js lib/stratum-mcp-client.js -- --test test/integration/build-wave-golden.test.js > /tmp/d3-evidence/revert-build-connector.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 paid carry success' --prod lib/result-normalizer.js -- --test test/integration/build-wave-golden.test.js > /tmp/d3-evidence/revert-normalizer.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= bash scripts/negative-control.sh --ref ecea9db --timeout 900000 --test-name-pattern 'd3 GSD production off/shadow' --prod lib/gsd.js -- --test test/integration/gsd-route-continuation-golden.test.js > /tmp/d3-evidence/revert-gsd.log 2>&1
```

Each script baseline is **1 / 1 / 0 / 0** (tests/pass/fail/cancelled). Each of the four single-file reverts is **1 / 0 / 1 / 0**, RED, Node exit 1. Each script exits 0 because its negative control succeeded. All four production files were restored byte-for-byte; the main checkout's production files never changed. An initial script invocation used the unsupported `--test-name-pattern=...` spelling and exited 2 before running any test; the corrected invocations above are the evidence.

Exact check-removal and corresponding positive commands, in the main checkout:

```sh
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 --test-name-pattern='real normalizer forwarding|real Claude .* forwarding|local SDK raw presence' test/usage-receipts.test.js test/routing-calls.test.js > /tmp/d3-evidence/forwarding-positive.log 2>&1
D3_MODULE=lib/routing-runtime.js D3_SOURCE=/tmp/d3-evidence/no-evidence-checks.js STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --import /tmp/d3-evidence/substitute.mjs --test --test-timeout=900000 --test-name-pattern='real normalizer forwarding|real Claude .* forwarding' test/usage-receipts.test.js > /tmp/d3-evidence/no-evidence-checks.log 2>&1
STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout=900000 --test-name-pattern='residual B0 ownership for a.txt' test/build-model-route-outcomes.test.js > /tmp/d3-evidence/owner-positive.log 2>&1
D3_MODULE=lib/output-gate.js D3_SOURCE=/tmp/d3-evidence/no-owner-check.js STRATUM_STATE_ROOT=$(mktemp -d /tmp/d3-state.XXXXXX) RESEND_API_KEY= STRIPE_API_KEY= node --import /tmp/d3-evidence/substitute.mjs --test --test-timeout=900000 --test-name-pattern='residual B0 ownership for a.txt' test/build-model-route-outcomes.test.js > /tmp/d3-evidence/no-owner-check.log 2>&1
```

The saved load-hook sources remove only the additional forwarding comparisons or change the multiple-owner predicate to `false`; all other source bytes are retained.

Check-removal evidence:

| Change | Selector / file | Tests / pass / fail / cancelled |
|---|---|---:|
| Intact forwarding checks, plus local raw-effort tests | `real normalizer forwarding\|real Claude .* forwarding\|local SDK raw presence`, usage-receipts + routing-calls | 23 / 23 / 0 / 0 |
| Remove added duration/model/effort/provenance/split comparisons; retain USD/token comparisons | `real normalizer forwarding\|real Claude .* forwarding`, usage-receipts | 21 / 4 / 17 / 0 |
| Intact multiple-owner refusal | `residual B0 ownership for a.txt`, build-model-route-outcomes | 1 / 1 / 0 / 0 |
| Remove only multiple-owner refusal | same | 1 / 0 / 1 / 0 |

The missing-refusal failures are actual `assert.rejects`/ownership assertions. The controls do not count import errors, cancelled files or exit status alone as evidence.

## Host adjudication 2026-09-12 — two test defects found and fixed after the dispatch

The dispatch's own 37/37 was real but environment-dependent. The HOST is the arbiter, and the
first host run of the three golden files was **36 / 31 pass / 0 fail / 5 cancelled,
duration_ms 900008** — exactly the whole-file `--test-timeout` cap. `fail 0` with `cancelled 5`
is a HANG, not an assertion failure; the four `not ok` subtests plus the file name no real defect.

**Defect 1 — the goldens were hermetic only under `npm test`.** These tests reach a real
`execute_merge` gate. `lib/build.js:5915` calls `probeServer()` and, whenever a Compose server
answers, delegates the gate to the web UI and polls `pollGateResolution` for a human. The port
comes from `resolvePort()` (`COMPOSE_PORT > PORT > 4001`, `lib/resolve-port.js:12`). `npm test`
escapes this only because `package.json:23` preloads `--import ./test/suppress-expected-drift.js`,
which sets `COMPOSE_PORT=19997` (`test/suppress-expected-drift.js:23`). The targeted golden
command documented in `blueprint-slice1b.md` omits that preload, so on a machine with the dev
server up on 4001 — the owner's normal state, pid 78098 at the time — the documented command
hangs for 900s and reports as failures. The dispatch sandbox cannot bind ports, so `serverUp` was
false there and the delegation branch was never reached.

Fixed with a control rather than a note: `test/helpers/build-wave-golden-fixture.js` now sets
`COMPOSE_PORT=19997` when it is unset. All three golden files import that helper, so the guard
covers each of them, and an explicit `COMPOSE_PORT` (a live-server test) is never overridden.
ESM hoists the helper's imports above the assignment, which is harmless because `resolvePort()`
reads `process.env` at CALL time during the gate, not at module load. **Control: with the server
UP on 4001 and `COMPOSE_PORT`/`PORT` both unset (`env -u COMPOSE_PORT -u PORT`), the three files
now run 37 / 37 / 0 / 0 in 271s** — the same 37 the dispatch reported, without the hang.

**Defect 2 — an ordering assertion over a race the harness deliberately leaves free.** With the
hang removed, two tests failed for real (`fail 2`, `cancelled 0`): `d3 paid carry success` and
`d3 paid carry failed`, both asserting `['A0','B0','B0repair','A0repair']` and observing
`['B0','A0',...]`. `f.paidCalls` records LAUNCH order, pushed at tool entry
(`build-wave-golden-fixture.js:369`), and A0/B0 are launched by the parallel `execute/N`
scheduler — the run log shows `execute/1` starting before `execute/0`. The latch at `:413`
waits until BOTH have arrived and only then forces the RETURN order (B0 then A0), so `returned`
is deterministic while `calls` is not. Pinning launch order also contradicts this gate's own
requirement that ownership survive **adversarial** A/B ordering.

Fixed at `test/integration/build-wave-golden.test.js:344` by comparing launch order as a
multiset (membership and multiplicity, `.sort()` on both sides) and leaving the forced
`returned` sequence exact. This is not a weakened assertion: launch sequence was never the
property under test. **Negative control:** mutating one expected member (`B0repair` -> `B9repair`,
same count) makes it **1 / 0 / 1 / 0**, a real `deepStrictEqual` failure, so the relaxed
assertion is not vacuous. The mutation was reverted from the working tree.

Neither defect is in production code. No production file was changed by the dispatch or by this
adjudication; the three frozen fixtures remain byte-identical to HEAD. Gate 5 is unaffected and
still OUTSTANDING.

## Remaining evidence

Live-fire gate 5 is **OUTSTANDING**. Full-suite host verification remains the host's responsibility; this sandbox run makes no full-suite claim. No report product, calibration prompt, feedback, learned/active selection, trial, exploration or repair-floor enforcement was added. No feature status changed.
