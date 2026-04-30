# Session 29 — STRAT-PAR-STREAM-LEGACY-CLOSE + CONSUMER-VALIDATE + COMP-AGENT-CAPS-6

**Date:** 2026-04-29
**Session number:** 29

## What happened

Three deferred PLANNED tickets executed as a single batch, producing two commits (one per repo) with a Codex review pass in between.

**Ticket 1: STRAT-PAR-STREAM-LEGACY-CLOSE**

Audited all emit sites for the 6 legacy `BuildStreamEvent` kinds across `build-stream-writer.js`, `build.js`, and `build-stream-bridge.js`. The kinds are emitted exclusively through `BuildStreamWriter` typed methods (no raw `write({ type: ... })` calls that would bypass the documented field contract). The bridge consumer reads a consistent field set per kind.

Created `contracts/build-stream-event.v0.2.6.schema.json` in stratum-mcp — the canonical JSON Schema contract with `additionalProperties: false` on all 6 metadata blocks plus `reply_required: boolean` (Option A, additive). Bumped `events.py` default `schema_version` from `0.2.5` to `0.2.6` and added `reply_required: bool = False` to the dataclass. Updated two test files that had hardcoded `0.2.5` assertions.

**Ticket 2: STRAT-PAR-STREAM-CONSUMER-VALIDATE**

Created `lib/build-stream-schema.js` — an AJV 2020 compiled validator for the envelope plus per-kind closed metadata schemas mirroring the contract. Wired it into `#makeProgressHandler` in `stratum-mcp-client.js`: invalid events are now `console.warn`-ed with kind/schema_version/error then dropped. Valid events pass through unchanged.

The initial implementation left the top-level envelope `additionalProperties: true` (a "should-fix" caught by Codex review). Fixed in a follow-up commit: envelope closed to match the producer contract exactly. Also removed `task_id: null` from test envelopes (producer omits the key when None; null-typed field fails the closed schema correctly).

Added 22 table-driven test cases in `test/build-stream-validate.test.js` covering: valid envelopes pass, missing required fields fail, unknown schema_version fails, mismatched closed-kind metadata fails, open kinds accept any shape.

Added 3 wiring integration tests in `stratum-mcp-client-parallel.test.js` exercising the actual `makeProgressHandler` → validate → warn/drop path (not just the pure validator).

**Ticket 3: COMP-AGENT-CAPS-6**

Found that `executeChildFlow` in `build.js` was collecting capability violations (introduced in CAPS-5) but never reading `enforcement` mode and never throwing in `block` mode. The enforcement block existed only on the main step path (lines 763-794).

Applied the mirror: after the violation collection loop in `executeChildFlow`, added a `childEnforcement` read (same `join(dataDir, 'settings.json')` pattern) and a `block` + violations check that throws `StratumError('CAPABILITY_VIOLATION', ...)`. The `detail` field passed to `writeViolation` in the child path already included the tool name (inherited from CAPS-5 code), which is a minor cosmetic divergence from the main path — noted by Codex as a nit, not actionable.

Added 4 CAPS-6 test cases to `capability-enforcement-block.test.js`: child block mode throws, log mode does not throw, stream event emitted before throw, no throw when no violations.

## What we built

**Stratum-mcp (commit d4f5672 → pushed as part of pre-push hook bump 0.2.38):**
- `stratum-mcp/contracts/build-stream-event.v0.2.6.schema.json` — canonical v0.2.6 JSON Schema contract (new)
- `stratum-mcp/src/stratum_mcp/events.py` — BuildStreamEvent dataclass (new file in git; bumped to v0.2.6, added reply_required)
- `stratum-mcp/tests/test_stream_events.py` — updated schema_version assertions
- `stratum-mcp/tests/test_agent_run_streaming.py` — updated schema_version assertions

**Compose (commits 95cf9da, 23c0dd3 → pushed to main):**
- `lib/build-stream-schema.js` — Ajv2020 validator (new)
- `lib/stratum-mcp-client.js` — imports validator, wires into makeProgressHandler
- `lib/build.js` — CAPS-6 child-flow enforcement block
- `test/build-stream-validate.test.js` — 22 cases (new)
- `test/capability-enforcement-block.test.js` — +4 CAPS-6 cases
- `test/stratum-mcp-client-parallel.test.js` — step_usage metadata fixed, task_id: null removed, +3 wiring tests

## What we learned

1. **Emit-site audits are fast when typed methods exist.** `BuildStreamWriter` encapsulates all 6 legacy kinds behind named methods — the audit confirmed no raw callers escaped the contract. Typed emit layers pay off at schema-close time.

2. **AJV 8's default entry point uses draft-07; use `ajv/dist/2020.js` for draft-2020-12 schemas.** The `$schema` URI in inline schemas caused a "no schema with key or ref" crash at compile time when using the default `Ajv` import. Switching to `Ajv2020` fixed it without any other changes.

3. **`additionalProperties: true` on a "closed" envelope is a silent correctness bug.** The consumer-side envelope schema started open — Codex review caught this as a should-fix. The intent was closed but the implementation forgot the flag. Rule: explicitly set `additionalProperties: false` even on "obviously closed" schemas.

4. **`task_id: null` vs omitting the key are not equivalent in closed schemas.** The Python producer drops `task_id` when None; test envelopes were passing `null` which would fail a closed schema. Cleaning this up before closing the envelope avoided a silent drop of all agent_relay events from existing tests.

5. **Codex review caught the envelope openness in one pass.** The two should-fix items were both real, neither was a false positive. The 2-iteration flow (code → review → fix → re-review → CLEAN) worked cleanly here.

## Open threads

- [ ] `reply_required: boolean` is reserved but no live kind sets it. Wire it to the first gate/permission kind when COMP-OBS-GATES reply path is implemented.
- [ ] STRAT-PAR-STREAM-CONSUMER-VALIDATE design doc should be updated to COMPLETE status.
- [ ] Producer-side validation (stratum-mcp validates at emission) was noted as out-of-scope in the design doc; still deferred.

---

Schema closes the 6 legacy kinds, consumer drops drift, child-flow enforcement finally bites.
