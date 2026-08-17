# COMP-POLICY-CHECK-1..6 — Shared Implementation Blueprint

**Design:** [`docs/design/2026-05-09-pre-response-policy-check.md`](../../design/2026-05-09-pre-response-policy-check.md)
**Substrate (complete):** SmartMemory CORE-ADHERENCE-1 — detection-pattern blocks in `<memory-dir>/feedback_*.md`, loader semantics in `smart-memory-core/smartmemory/adherence/detection.py` (the JS loader mirrors it)
**Catalog refreshed 2026-08-17:** 6 rules incl. the measured top-3 (`external_prose`, `token_efficiency`, `codex_escalation`) from the DIST-CC-INGEST-1 n=100 run.

## Grounded reference map (explored + verified 2026-08-17)

| What | Where | Fact |
|---|---|---|
| Build-engine violation hook | `lib/build.js:3389` (`checkCapabilityViolation` call), `:3651` (`violations: stepViolations` on `build_step_done`) | the per-step loop where policy scan results join the existing violations stream |
| Violation shape to mirror | `lib/capability-checker.js:20-49` | returns `{violation, severity: 'violation'\|'warning'\|'none', reason}` |
| Stream → UI bridge | `server/build-stream-bridge.js:352`; `src/components/agent/StepOutcome.jsx:8-15`; `ViolationDetail.jsx:17` | `violations: string[]` renders with ZERO UI changes |
| Trace bus | `lib/feature-events.js:27-60` `appendEvent(cwd, event)` → `.compose/data/feature-events.jsonl` | auto-syncs into SmartMemory via `lib/smartmemory-sync.js` — closes the measurement loop |
| Live event builders | `server/decision-event-emit.js:52-175` | add `buildPolicyViolationEvent` following `buildGateEvent` pattern |
| Config pattern | `lib/smartmemory-config.js:20-27` | per-call read of `.compose/compose.json`, try/catch → `{}` = disabled |
| Ensure expressions | `lib/pipeline-cli.js:246` (`result.clean == True`); `lib/result-normalizer.js:593` | ensure is evaluated by the EXTERNAL Stratum engine against `result.<field>` only |
| Test conventions | `node --test`, flat `test/*.test.js`, tmp-dir fixtures (`test/journal-writer.test.js:34-36`), `test/helpers/smartmemory-stub.js` naming | new: `test/policy-catalog.test.js`, `test/policy-check.test.js` |
| Status flips | `lib/feature-writer.js:450-465` via MCP `set_feature_status` | canon = feature.json; ROADMAP.md regenerates; never hand-edit |

## Corrections table (design assumption vs reality)

| # | Design said | Reality | Resolution |
|---|---|---|---|
| 1 | "Fetch catalog via `mcp__smartmemory__memory_get_violation_patterns`" | Compose's engine is plain Node — NOT an MCP client; zero MCP reach in repo. The catalog is local markdown the MCP tool itself merely parses | New `lib/policy-catalog.js` parses the `## Detection patterns` yaml blocks from the memory dir directly (same convention as the Python loader). No network. Absent dir/blocks → empty catalog → no-op |
| 2 | Stratum postcondition `ensure: compose.policy.unsuppressed_violations == 0` | No `compose.*` ensure namespace exists; the external Stratum engine evaluates `result.<field>` from a step's own output contract only | Expose `unsuppressed_violations: <int>` in the step result; document `ensure: ['result.unsuppressed_violations == 0']` (pipeline-cli.js:246 pattern). No engine change |
| 3 | "Session trace" as a distinct log | No single session trace exists; `feature-events.jsonl` is the append-only audit bus and already syncs into SmartMemory | Trace via `appendEvent` rows (`tool: 'policy_check'`) + a live `buildPolicyViolationEvent` broadcast for the cockpit |
| 4 | New UI surface implied for violations | `build_step_done.violations: string[]` → ViolationDetail renders as-is | No UI changes in v1; violation strings carry rule + pattern + suppression note |

## Module plan

### `lib/policy-catalog.js` (new) — COMP-POLICY-CHECK-1
- `loadCatalog(memoryDir)` — parse `feedback_*.md` (and `*.md` generally, mirroring the Python loader's rule_type default) for `## Detection patterns` fenced yaml: `patterns: [{regex|phrase|exclude_regex}]`, `suppression_signals: [...]`. Malformed yaml → skip file with a `console.warn` (degrade-never-fail, but NEVER silently: warn per skipped file).
- `getCatalog(cwd, {memoryDir})` — resolves the memory dir (config override → `~/.claude/projects/<encoded-cwd>/memory` default, encoding: `/` and `.` → `-` prefixed, mirror how Claude Code encodes), caches per process keyed by dir, invalidates on max-mtime change.
- Config: `.compose/compose.json` → `policyCheck: {enabled, memoryDir?}`; **absent block = ENABLED** (design: "ship as the Compose default"), `enabled: false` is the kill switch. Empty catalog = silent no-op either way.
- No new deps if a yaml parser already exists in the dep tree (check `package.json` / lockfile — `js-yaml` likely present transitively; if NOT a direct dep, hand-parse the two-key subset rather than adding a dependency: the block grammar is only two list-of-maps keys).

### `lib/policy-check.js` (new) — COMP-POLICY-CHECK-2 + 3
- `classifyUserMode(recentUserTurns, catalog, {skillGated})` → `'AUTONOMOUS' | 'PACED' | 'SKILL_GATED'`. PACED when any rule's `suppression_signals` matches any recent user turn (last 2 turns). SKILL_GATED passed by the caller when the active phase is a gate (build.js knows its own gate state).
- `scanResponse(text, catalog, userMode)` → `[{rule, matched, suppressed, reason}]` mirroring capability-checker's shape. `exclude_regex` entries remove matched spans before pattern evaluation (code fences etc.). Regexes compiled once per catalog load; invalid regex → warn + skip pattern.
- `toViolationStrings(records)` → `string[]` for the existing UI: `"policy: <rule> — matched '<pattern>' (unsuppressed; revise unless precedence applies)"`.

### `lib/build.js` wiring — COMP-POLICY-CHECK-3 + 4 + 6
- After a step's agent response text is available (same region as the `:3389` capability check), run `scanResponse`; append unsuppressed violation strings to `stepViolations`.
- **Revision pass (one, max):** when unsuppressed violations exist, re-prompt the agent once with the violation notice appended ("Your draft contains pattern X for rule Y; revise unless precedence applies"), re-scan; second result stands either way. Never hard-block. Follow the existing retry machinery in build.js rather than inventing a parallel loop — find the step-retry path and reuse it with a `policy_revision` marker.
- Include `unsuppressed_violations: <count>` in the step's result payload so Stratum specs can declare `ensure: ['result.unsuppressed_violations == 0']` (COMP-POLICY-CHECK-6 = documentation + this one field; no engine work).

### Trace — COMP-POLICY-CHECK-5
- Every scan with ≥1 match (flagged OR suppressed) → `appendEvent(cwd, {tool: 'policy_check', build_id, step_id, rule, matched, suppressed, user_mode})`, one row per (rule, match).
- `server/decision-event-emit.js`: add `buildPolicyViolationEvent` (kind `policy_violation`) and emit from the build-stream bridge alongside the step event, for live cockpit visibility.

## Tests (node --test, tmp-dir fixtures)
- `test/policy-catalog.test.js`: parses a fixture memory dir (valid block, malformed yaml warns + skips, no-block files ignored, mtime cache invalidation, encoded-path resolution, kill switch).
- `test/policy-check.test.js`: mode classification (autonomous default; paced on suppression phrase in recent turn; skill_gated passthrough), scanning (regex + phrase + exclude_regex span removal; the external_prose em-dash pattern must NOT fire inside a code fence), suppression semantics per mode, violation-string shape, invalid-regex resilience.
- Build wiring test: extend the narrowest existing build.js step test (find one touching capability violations) or add an integration-style test with a stubbed agent response showing: violation → one revision prompt → re-scan → `unsuppressed_violations` in result + `feature-events.jsonl` rows. Fixture catalog via `test/helpers/policy-catalog-stub.js`.
- UI: none (reuse proven surface).

## Rollout / safety
- Default ON but structurally inert without a catalog; kill switch `policyCheck.enabled=false`.
- False-positive tuning is expected (design risk 1): suppression signals live in the CATALOG (user-authored markdown), not in Compose code — tuning never needs a Compose release.
- Success metrics (design): unsuppressed CONTRADICTED <5% on the next n=100 run; false-positive <5% on PACED sessions; revision-acceptance >70%.
