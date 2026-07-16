# Full-Suite Failure Triage — 2026-07-16 (pre-flag-day, STRAT-PY-RETIRE)

**Related:** `docs/plans/2026-07-11-strat-py-retire-progress.md` (stratum repo, Phase 2) · harness tasks #6 (flag-day), #11 (endgame) · run captured at compose develop `c325db7` + journal `fa87937`.

Full node suite: **4,676 tests — 17 fail, 10 cancelled** (`node --import ./test/suppress-expected-drift.js --test --test-timeout=120000 test/*.test.js test/comp-obs-branch/*.test.js test/integration/*.test.js`). Triage by codex terra/high (read-only), adjudicated by controller. **Zero failures are E1/E2 regressions.**

## Root cause (covers every B failure)

One mixed-cutover chain, not nine broken behaviors: the client's `plan()` was migrated to the TS request shape — `e29e62b` replaced python `flow`/`inputs` with TS `{spec, input}`, `e193432` added YAML→object parsing (`lib/stratum-mcp-client.js:272`) — while these tests still spawn the **python** `stratum-mcp` default subprocess, which rejects the plan at Pydantic validation. Everything downstream of plan never runs.

**Disposition decision (controller):** we do NOT restore python `plan()` compat ("fix the bridge") — python is being retired. The B tests' fixtures move to the TS bin instead, keeping their behavioral assertions. That work lands with the flag-day slice (task #6), which already requires full suites green.

## Classification: 17 failures = 7 A · 9 B · 1 C; 10 cancellations all B

**A = python-era, delete/replace at endgame (task #11).** 1151 + 1153 `parallel_dispatch branch … existing dispatch branches are untouched` (assert retired `execute_step`/`await_gate`/`execute_flow` source branches; `test/parallel-dispatch-stub.test.js:65`, `test/parallel-dispatch.test.js:93`); 1674 × 5 client subtests `plan returns execute_step dispatch`, `stepDone advances to complete`, `audit returns execution trace`, `resume returns execute_step`, `resume returns correct step` (python vocabulary/`flow_id`; `test/stratum-mcp-client.test.js:103–224`). Replace with TS `ready[]`/consumer-descriptor equivalents where coverage is lost.

**B = must-survive behavior, re-express fixtures on the TS bin at flag-day (task #6).** 194/195/196 build-integration (full build + audit, sub-flow parent completion, resume durability + stale `active-build.json`; `test/build-integration.test.js:218/290/390`); 207/208 build-policy skip/flag auto-approve + stream events (`test/build-policy.test.js:158/199`); 242/243 JSONL stream integration + `build_error` on connector throw (`test/build-stream-writer-integration.test.js:157/262`); 1246/1247 proof-run 16-step pipeline + fix/re-review recovery (`test/proof-run.test.js:232/334`). All fail at plan validation, none disproven. The 10 cancellations are the JSONL parent's leaf tests — rerun after the fixture port.

**C = ordering artifact, no product change.** File-level `test/stratum-mcp-client.test.js` 120s timeout: isolated rerun finishes in 22.4s (with the same 5 A failures, no timeout); failed tests skip their per-test `client.close()`, making the file load-sensitive. Dies with the A deletions; alternatively make teardown unconditional.

## Flag-day checklist deltas

- Add: port B fixtures (build-integration ×3, build-policy ×2, JSONL ×2 + 10 leaves, proof-run ×2) to the TS bin.
- Add: endgame (#11) deletes the 7 A subtests with the python branches/server support.
- No change to the E1-era items (token-less golden calls, compat assertion reversals).
