# Changelog

## 2026-05-02

### COMP-DOCS-FACTS — Reconcile compose docs with current code

Three rounds of Codex review against `bin/compose.js`, `server/compose-mcp.js`, and the shipped pipeline specs corrected pre-existing factual drift surfaced during the COMP-DOCS-SLIM review. No code changes; one finding (missing `pipelines/new.stratum.yaml`) is a packaging gap filed separately as `COMP-NEW-PIPELINE-MISSING`.

**Changed:**
- `docs/cli.md` — expanded from 9 to all 17 CLI verbs (added `roadmap`, `install`, `fix`, `triage`, `ideabox`, `qa-scope`, `gates`, `loops`); corrected `compose build` flag set (`--all`, `--dry-run` is batch-only, `--skip-triage`, `--cwd`, `--team`, `--template`, multi-code, prefix); fixed `compose import` consumer claim (only `compose new`); fixed `compose ideabox add` flag name (`--desc`); corrected `ideabox promote` and `ideabox list` descriptions; added `bisect` step to `compose fix` pipeline.
- `docs/pipelines.md` — replaced "5 specs" inventory with shipped 7 plus the absent-but-expected `new.stratum.yaml`; fixed Stratum IR field name (`version: "0.3"`, not `ir_version`); corrected `review`/`codex_review` retry documentation (outer steps use defaults; inner `review_check` is 5); expanded `ReviewResult` to canonical shape (`meta`, `lenses_run`, `auto_fixes`, `asks`); added `bisect` step to bug-fix lifecycle row.
- `docs/mcp.md` — removed `agent_run` row (tool removed 2026-04-18 per `STRAT-DEDUP-AGENTRUN`) and added a deprecation note pointing to `mcp__stratum__stratum_agent_run`; corrected `report_iteration_result` outcome enum to runtime values (`clean`, `max_reached`, `action_limit`, `timeout`, `null` while running).
- `docs/lifecycle.md` — corrected `review_check` retry default from 10 to 5.

## 2026-05-02

### COMP-DOCS-SLIM — Slim README into attractor + 9 topic subpages

Reshaped `compose/README.md` from 1025 lines to a 75-line technical attractor (what-it-is paragraph, three-bullet pitch, 30-second example, quick install, documentation index). Detailed content moved verbatim into nine new topic-scoped subpages under `compose/docs/`: `install.md`, `cli.md`, `cockpit.md`, `pipelines.md`, `agents.md`, `lifecycle.md`, `configuration.md`, `mcp.md`, `examples.md`. Pure docs refactor — no code change. Pre-existing factual drift (missing CLI verbs, stale MCP tool list, retry counts, IR field name) deliberately preserved during the move and filed for follow-up as `COMP-DOCS-FACTS`.

**Added:**
- `compose/docs/{install,cli,cockpit,pipelines,agents,lifecycle,configuration,mcp,examples}.md` — topic-scoped reference pages; absorb every former README H2 section.

**Changed:**
- `compose/README.md` — rewritten as 75-line attractor with 5 blocks plus documentation index linking to all 9 new subpages and the existing top-level docs (PRD, ROADMAP, taxonomy, PRODUCT-SPEC, compose-one-pager).

**Snapshot:**
- `docs/features/COMP-DOCS-SLIM/README.original.md` — original 1025-line README preserved for diff/audit.

## 2026-05-01

### COMP-PLAN-SECTIONS — Per-section plan files with "What Was Built" trailers

When a feature plan's task count exceeds `COMPOSE_PLAN_SECTIONS_THRESHOLD` (default 5, env-tunable, clamped to ≥1), Compose now emits per-task `docs/features/<code>/sections/section-NN-<slug>.md` files alongside the consolidated `plan.md` after the plan gate is approved. After the feature-final ship step records a commit, an append-only "What Was Built" trailer is written to each section file with `git diff --stat` filtered to that section's declared files (declared-but-unchanged files surfaced as deviations). Re-runs append `iteration N` blocks. v1 ships sections + trailers only; the Phase 8 report-path roll-up and "changed-but-undeclared" attribution are deferred to follow-up `COMP-PLAN-SECTIONS-REPORT`.

**Added:**
- `lib/sections.js` — `SECTIONS_DIR` consumer; `slugify`, `parseTaskBlocks`, `extractSectionFiles`, `shouldEmitSections`, `emitSections` (idempotent — never overwrites existing section files), `appendTrailers` (append-only, max-N iteration counting via regex over existing trailers), `computeFilteredDiffStat` (per-section filtered `git diff --stat` via `execFileSync` argv — shell-injection safe).
- `lib/build.js` — `maybeEmitSectionsAfterPlanGate(stepId, featureDir, opts)` helper invoked from all three plan-gate approve branches (`policy.mode === 'skip'`, `'flag'`, and human gate with `outcome === 'approve'`). Post-ship trailer-append wrapped in try/catch — trailer failure emits a `build_error` stream event but never fails the ship. `executeShipStep` returns additive `commit` and `filesChanged` fields, each best-effort (failure leaves field empty, ship outcome stays `'complete'`); now exported for testing.
- `lib/constants.js` — `SECTIONS_DIR = 'sections'` (separate top-level export, not a `GATE_ARTIFACTS` entry); `getSectionsThreshold()` reads `COMPOSE_PLAN_SECTIONS_THRESHOLD` (unparseable → 5; finite → `Math.max(1, raw)`).
- `test/sections-constants.test.js`, `test/sections.test.js`, `test/build-ship-fields.test.js`, `test/integration/build-sections.test.js` — 45 new tests covering threshold gating, idempotent emission, append-only trailers, max-N iteration counting, three-branch wiring, best-effort metadata, and a shell-injection regression (`$(echo PWN).txt` declared file).

**Hardened:**
- `executeShipStep` `git add` and `git commit` calls switched from `execSync(shellString)` to `execFileSync('git', argv)` to close a latent shell-injection class on user-controlled inputs (filenames, feature description). Pre-existing risk in the same workflow we touched.

**Knobs:**
- `COMPOSE_PLAN_SECTIONS_THRESHOLD` — int; default 5; clamp ≥1. Set to a high value to disable section emission; set to 1 to emit sections for every multi-task plan.

**Test results:** 2102 unit / 92 UI / 39 integration passed (2 pre-existing `STRAT-DEDUP-AGENTRUN-V3` integration failures unrelated to this feature).

Design: `docs/features/COMP-PLAN-SECTIONS/design.md` · Blueprint: `docs/features/COMP-PLAN-SECTIONS/blueprint.md` · Plan: `docs/features/COMP-PLAN-SECTIONS/plan.md` · Report: `docs/features/COMP-PLAN-SECTIONS/report.md`.

### COMP-FIX-HARD — Hard-bug machinery on the bug-fix pipeline

The 8-step `bug-fix.stratum.yaml` pipeline (shipped as part of COMP-FIX) handled easy and medium bugs but failed silently on hard ones: retries re-proposed disproven hypotheses, `test` exhaustion vanished into the failed-build handler with no recovery state, regression bugs got no `git bisect` help, fix-chain detection was session-scoped, and escalation flagged-but-didn't-act. COMP-FIX-HARD adds the persistent state, structured second opinions, and fresh-context retry path needed for genuinely hard bugs — without slowing the easy cases.

**Added:**
- `lib/bug-ledger.js` — JSONL hypothesis ledger at `docs/bugs/<code>/hypotheses.jsonl`. `appendHypothesisEntry` is idempotent on `(attempt, ts)`; `readHypotheses` tolerates malformed lines; `formatRejectedHypotheses` emits the markdown block injected into diagnose retry prompts.
- `lib/bug-checkpoint.js` — emits `docs/bugs/<code>/checkpoint.md` on Compose-side retry-cap exhaustion. Captures current diff (truncated at `DIFF_CAP=5000` chars; `git diff` `maxBuffer` 2MB), last failure, ledger pointer, and a `compose fix <code> --resume` command for the operator.
- `lib/bug-index-gen.js` — renders `docs/bugs/INDEX.md` from per-bug checkpoints. Atomic tmp+rename write. Same pattern as `roadmap-gen.js`.
- `lib/bug-bisect.js` — `classifyRegression` heuristic (test in main + affected files touched in last 10 commits), `estimateBisectCost` with a 5-min sample timeout, `findKnownGoodBaseline` (v* tags → release-* → HEAD~50), `runBisect` driving `git bisect run` and capturing log to `docs/bugs/<code>/bisect.log`, always with `git bisect reset` in finally.
- `lib/bug-escalation.js` — Tier 1 Codex second opinion (read-only via `stratum.runAgentText('codex', ...)`, parses to canonical `ReviewResult`, appends to ledger as `verdict: 'escalation_tier_1'`) and Tier 2 fresh `claude` agent in detached-HEAD worktree (Tier 2 fires when Jaccard token-overlap < 0.7 vs every prior `rejected` ledger entry; ≥ 0.7 suppresses; produces patch artifact at `docs/bugs/<code>/escalation-patch-N.md`; never commits).
- `pipelines/bug-fix.stratum.yaml` — new `bisect` step + `BisectResult` contract inserted between `diagnose` and `scope_check`. `scope_check.depends_on` retargeted.
- `bin/compose.js` — `compose fix <code>` reads `docs/bugs/<code>/description.md`, scaffolds and exits if missing. New `--resume` flag refuses cross-mode resume.

**Changed:**
- `lib/build.js` — `runBuild` accepts `opts.mode: 'feature' | 'bug'`. Single `resolveItemDir(code)` resolver routes `docs/features/` vs `docs/bugs/` at all three `featureDir` binding sites. `startFresh` dispatches `stratum.plan` with `{task: description}` in bug mode. `context.mode` and `context.bug_code` threaded throughout. Feature-JSON updates gated behind `!isBugMode`. Compose-side retry-cap enforcement: `parseRetriesCap(specYaml)` builds a per-step cap map; when `iterN > maxIter`, force-terminate and (in bug mode for `{test, fix, diagnose}` steps) emit a checkpoint. Active-build state now carries `mode` and `pid`; resume refuses cross-mode and refuses if another live process owns the build. `recordDiagnoseSuccessIfBugMode` helper called from both top-level and child-flow step-completion paths so retries see prior accepted hypotheses.
- `lib/step-prompt.js` — `buildRetryPrompt` prepends `formatRejectedHypotheses` block when retrying `diagnose` in bug mode. Single injection point covers both `build.js:1244` and `build.js:2133` retry call sites.
- `lib/debug-discipline.js` — `AttemptCounter` and `FixChainDetector` rewritten around per-bug `byBug` Map. Existing global API preserved via synthetic `__feature_mode__` slot. `fromJSON` now folds top-level legacy fields into `__feature_mode__` (was `__legacy__` — orphaned slot with no public reader).

**Phase 7 review-loop fixes (3 rounds, 14 findings):** partial-migration data loss in `fromJSON`; `isMateriallyNew` substring containment too aggressive (rewritten to Jaccard ≥ 0.7) and zero-token edge case (treats un-tokenizable Codex summary as novel); Tier 2 worktree create wrapped in try/catch with `rm -rf` cleanup; `estimateBisectCost` 5-min sample timeout; `getCurrentDiff` `maxBuffer` set to 2MB (50MB OOM risk → over-corrected to 20KB → 2MB sweet spot); resume path live-pid check + mode persistence + cross-mode refusal at all three resume entry points; attempt numbering `max+1` not `length+1` to prevent collisions.

**Tests:** 91 new test cases across 12 new test files. Suite at 2064 node + 92 vitest, zero failures.

**Follow-up tickets filed:** COMP-MAXITER-DRIFT (cosmetic log fix), COMP-BUG-FORMATTER (`compose bug show <code>`), STRAT-RETRIES-ENFORCE (Stratum-side enforcement; the YAML's `retries:` field is currently declared-but-ignored in `stratum_mcp/executor.py` — Compose enforces in the consumer for now).

### COMP-DEPS-PACKAGE — External skill dependency manifest + `compose doctor`

`compose setup` previously only synced compose-owned skills; the lifecycle's references to external skills/commands (`superpowers:*`, `interface-design:*`, `codex:review`, `refactor`, `update-docs`) had no install check, no warning when missing, and no documented degrade behavior. On a fresh-box install the lifecycle would die mid-phase the first time it invoked a missing dep.

**Added:**
- `compose/.compose-deps.json` — manifest of 12 external skill/command deps with `id`, `required_for`, `install`, `fallback`, `optional` fields. Single source of truth for dep IDs and per-dep degrade behavior.
- `compose/lib/deps.js` — `loadDeps()`, `checkExternalSkills()`, `printDepReport()`. Scans five filesystem patterns (bare `~/.claude/skills/`, marketplace skills A/B, marketplace commands A'/B', versioned cache C). Bare-vs-namespaced match split prevents false positives.
- `compose doctor` CLI subcommand. `--json` for machine-readable output (full dep records), `--strict` for non-zero exit on missing required deps, `--verbose` lists scanned paths.
- `compose setup` now runs the dep check at the end and copies `.compose-deps.json` next to the installed compose SKILL.md so the lifecycle can read it as a fallback when the CLI is unreachable.
- `compose/test/comp-deps-package.test.js` — 16 tests covering manifest schema, drift guard (every manifest ID appears in SKILL.md), bare-vs-namespaced false-positive guard, full-record JSON output, and live `compose doctor` subprocess.

**Fixed:**
- `package.json` `files` allowlist now includes `.compose-deps.json`, `.claude/skills/**`, and `skills/**`. Previous published installs printed `Warning: no skills found to install` because the skill source dirs weren't in the allowlist — silently broken since adoption.

**Updated:**
- `compose/.claude/skills/compose/SKILL.md` §Dependencies — replaced the per-dep external-deps table with a pointer to the manifest as source of truth, plus a "Degrade pattern" subsection describing how the lifecycle uses `compose doctor --json` at Phase 1 entry.

## 2026-04-27

### COMP-AGENT-CAPS-5 — Capability enforcement: integration test, settings UI, severity bucketing

Three polish items completing COMP-AGENT-CAPS-4 (commit `03ebfff`):

**D1 — Integration test for enforcement block/log modes** (`test/capability-enforcement-block.test.js`, new, 9 tests):
Inline reimplementation of the post-step enforcement block from `build.js:763-794` driven by synthetic tool observations. Test 1: `enforcement: 'block'` + disallowed tool throws `StratumError('CAPABILITY_VIOLATION')` with the offending tool names in the message. Test 2: `enforcement: 'log'` (default) — same input, no throw, `capability_violation` event emitted with correct severity. Also covers: absent `settings.json` defaults to `log`; multiple violations reported together in block mode; `violation` vs `warning` severity bucketing in log mode.

**D2 — Settings UI** (`src/components/vision/SettingsPanel.jsx`, modified):
Added "Capability Enforcement" section with a `log` / `block` radio group. Uses the existing `onSettingsChange({ capabilities: { enforcement: value } })` pattern — no new state manager or mutation layer. The `capabilities` section is already a supported top-level key in `settings-store.js` and the PATCH `/api/settings` route. Helper text: "Block stops the build on disallowed tool use; Log records but continues."

**D3 — Build summary bucketing** (`lib/build-stream-writer.js`, `lib/build.js`, `server/build-stream-bridge.js`, `src/components/vision/visionMessageHandler.js`, `src/components/cockpit/ContextStepDetail.jsx`, `src/App.jsx`, modified):
`writeViolation` previously omitted the `severity` field (`'violation'|'warning'`). Added it as an optional param (default `'violation'`). `build.js` now passes `check.severity`. The bridge lacked a `capability_violation` case — events fell to `default: return null` and never reached the UI. Added the bridge case forwarding all fields including `severity`. `visionMessageHandler.js` now accumulates `capability_violation` events into `activeBuild.capabilityEvents`. `ContextStepDetail` accepts a `capabilityEvents` prop and renders a bucketed count: `N findings (X violations, Y warnings)`. `App.jsx` passes `activeBuild?.capabilityEvents`.

**Tests:** 1920 node + 87 UI, 0 failures.

### STRAT-XMODEL-PARITY — Route runCrossModelReview synthesis through canonical normalizer

`runCrossModelReview` in `build.js` previously used a hand-rolled `text.match(/\{[\s\S]*\}/)` + `JSON.parse` block to parse synthesis output, producing a `{consensus, claude_only, codex_only}` shape outside the canonical `ReviewResult` contract. Synthesis output now routes through a new `normalizeCrossModelResult` normalizer that applies the same parse + repair-retry + text-mode fallback + `applied_gate` stamping + `clean` derivation machinery as `normalizeReviewResult`.

A concrete correctness bug was caught and fixed during review: the `codexAsFallback` object used `confidence: 6, applied_gate: 7` — sub-gate, causing all fallback Codex findings to be silently dropped by the normalizer, incorrectly returning `clean: true` on synthesis failure. Fixed by raising fallback confidence to 7 (at-gate).

**New files:**
- `contracts/cross-model-review-result.json` — JSON Schema draft-07 for `CrossModelReviewResult`: extends `ReviewResult` with `consensus`, `claude_only`, `codex_only` arrays of canonical finding items. Sets `_source`/`_roadmap` provenance fields per convention.
- `lib/review-normalize.js` — `normalizeCrossModelResult(rawText, opts)` + `buildCrossModelRepairPrompt` helper added. Normalizes all three partitioned arrays: severity vocab, applied_gate stamping, confidence gate filtering. Falls back to `claudeFindingsFallback`/`codexFindingsFallback` arrays on parse failure.

**Modified:**
- `lib/build.js` — `normalizeCrossModelResult` imported and wired at the synthesis parse site. `codexAsFallback` confidence raised to 7. Synthesis prompt updated to instruct emission of `CrossModelReviewResult` schema with canonical severity/confidence. JSDoc updated.
- `test/cross-model-review.test.js` — replaced "intentionally outside canonical" documentation test with proper `CrossModelReviewResult` schema assertions. Added `normalizeCrossModelResult` test suite: canonical shape, severity normalization, confidence gate filtering, applied_gate stamping, clean derivation, fallback behavior on parse failure.

**Tests:** 1911 node + 87 UI tests, 0 failures. 2 Codex review iterations; prior iteration surfaced the confidence gate bug; second iteration returned REVIEW CLEAN.

### STRAT-CLAUDE-EFFORT-PARITY — Unify Claude/Codex review output contract

Both review paths in compose's build pipeline (`review_check` Codex single-pass and `parallel_review` Claude+lens multi-pass) now produce a single canonical `ReviewResult` schema. Severity vocabulary unified (`must-fix`/`should-fix`/`nit`), confidence scale standardized (1–10), `clean` derivation moved out of the model into a deterministic post-hoc reducer. Downstream consumers — `vision-routes.js:452 result.clean === true` gate, `selective-rerun.test.js`, `lib/health-score.js`, the `.compose/prior_dirty_lenses.json` sidecar — work unchanged.

**New files:**
- `contracts/review-result.json` — canonical JSON Schema (first contract in this dir; sets `_source`/`_roadmap` provenance convention).
- `lib/review-prompt.js` — shared prompt scaffold builder (severity vocab, confidence scale, output format, per-model nudge).
- `lib/review-normalize.js` — parse + one-shot repair retry + text-mode regex fallback + `applied_gate` stamping + deterministic `clean` derivation + summary synthesis.

**Modified:**
- `lib/build.js` — `buildReviewPrompt` wired at all 3 call sites (main 685, retry 1247, parallel-task 2655). `reduce_mode: "true"` flag gates scaffold prepend on the merge step (reducer gets normalization, not reviewer framing). Symmetric retry-path gating. `runCrossModelReview` JSDoc + synthesis prompt strings updated (parser unchanged).
- `lib/review-lenses.js` — 5 occurrences of `LensFinding` in description strings renamed to "ReviewResult finding". `reasoning_template` field preserved.
- `lib/health-score.js` — JSDoc renames; removed dead `?? mergedResult.all_findings` fallback.
- `pipelines/build.stratum.yaml` — dropped `LensFinding`/`LensResult`/`MergedReviewResult` contracts; added canonical `ReviewResult`. Rewrote `review_check`, `review_lenses`, `merge` step bodies. `>= 80` → `>= 7`. `reduce_mode: "true"` on merge step.
- `pipelines/review-fix.stratum.yaml` — `>= 80` → `>= 7`.
- `presets/team-review.stratum.yaml` — drop local `MergedReviewResult`; reference canonical; rename `LensFinding[]`; `reduce_mode` on merge.

The `review_mode` hook scaffold in `lib/result-normalizer.js` shipped with the prior commit (STRAT-DEDUP-AGENTRUN-V3); this commit activates it.

**Tests:** `test/review-parity.test.js` (new, 32 tests) covers parity assertions across Claude/Codex paths, schema validation, applied_gate stamping, repair-retry, scaffold-injection, reduce_mode gating, single-cert-block. `test/cross-model-review.test.js` extended with 3 canonical-schema tests. `test/selective-rerun.test.js` (14/14) and `test/review-lenses.test.js` (32/32) pass without modification. **Full suite: 1906 node + 87 UI tests, 0 failures.**

**Process:** 3 review iterations on the blueprint (5 must-fix, 7 should-fix, 5 nits surfaced and resolved before code) and 3 review iterations on the implementation (caught a critical unwired-deliverable: `buildReviewPrompt` shipped as dead code on first pass — runtime parity didn't exist until iteration 2 fix).

**Why:** Closes the parity gap flagged as a follow-up in `STRAT-DEDUP-AGENTRUN-V3` (2026-04-26). Two paths feeding the same `result.clean === true` gate must emit the same shape.

**Out of scope (follow-ups):** `STRAT-XMODEL-PARITY` (`runCrossModelReview` synthesis output canonicalization); `STRAT-CALIBRATION` (confidence-scale calibration spike); compose-reviewer fallback agent migration (still on 0–100 scale).

## 2026-04-26

### STRAT-DEDUP-AGENTRUN-V3 — Retire Compose's Node connector tree

Removed all 6 JS connector files (`server/connectors/{agent,claude-sdk,codex,opencode,connector-discovery,connector-runtime}-connector.js`) and the `connectors/` directory. All internal agent dispatch now flows through `mcp__stratum__stratum_agent_run` over the persistent stdio MCP session. `stratum_agent_run` extended to emit typed `BuildStreamEvent`s via `ctx.report_progress` — preserves cockpit visibility for one-off agent calls (gates, single steps, child flows, retries) that previously went through the JS tree.

**Producer:** Python `ClaudeConnector`/`CodexConnector` `stream_events()` extended to yield `step_usage` ConnectorEvents (post-Codex-review fix — was silently zero before). New `stratum_cancel_agent_run(correlation_id)` MCP tool. `make_agent_connector` accepts tier primitives (`allowed_tools`/`disallowed_tools`/`thinking`/`effort`).

**Consumer:** `lib/stratum-mcp-client.js` gains `agentRun()` / `runAgentText()` / `cancelAgentRun()`. `lib/result-normalizer.js#runAndNormalize` reimplemented on top of `agentRun()` + `onEvent()` — public `(connector, prompt, dispatch, opts) → {text, result, usage}` shape preserved (first arg ignored). 18 call-sites migrated across `build.js`, `new.js`, `import.js`, `step-validator.js`. Server surfaces (`vision-server.js`, `compose-mcp-tools.js`, `design-routes.js`) migrated; `design-routes.js` uses lazy `StratumMcpClient` singleton + SSE bridging from typed envelopes.

**Codex review (Phase 7) caught two blockers — both fixed before ship:** schema double-injection (client + server both injected) and missing `step_usage` envelope emission (cost telemetry silently zero on streaming path).

**Retired:** `stratum/stratum-mcp/tests/test_codex_connector_sync.py` (interim drift guard — failure class is now structurally impossible). 3 connector-specific test files deleted.

**Tests:** stratum-mcp 889 + 8 new = 889 pass; compose 1871 unit + 87 UI + 32 integration = 1990 pass. **Aggregate: 2,879 passing, 0 regressions.** Live E2E confirms typed envelope wire (`agent_started` + `agent_relay` + `step_usage` with contiguous per-scope seq, correct flow_id/step_id, task_id absent).

**Diff totals:** stratum +596 / -127; compose +1,131 / -1,693. Net **-1,093 lines** across both repos.

**Why:** Eliminates the two-trees drift class structurally. The 2026-04-19 codex hang (Python on opencode while JS on direct codex) is exactly what this prevents. Closes the `STRAT-DEDUP-AGENTRUN` umbrella.

**Known follow-ups:** `STRAT-CLAUDE-EFFORT-PARITY` (Claude SDK has no `effort` param — accepted but no-op, matches prior JS behavior); `connector-factory-shim.js` retained for ~6 legacy tests using `connectorFactory:` injection (debt; tests should migrate to `opts.stratum`).

### STRAT-PAR-STREAM — Typed event streaming for parallel_dispatch

Added server-push event channel from stratum-mcp to Compose during `parallel_dispatch`. Producer-side: `ClaudeConnector` and `CodexConnector` gain `stream_events()` async iterators yielding connector-local `ConnectorEvent`s; `parallel_exec._run_one` mints `BuildStreamEvent` envelopes (per-`(flow_id, step_id, task_id)` `seq`) and forwards via `ctx.report_progress(message=json)`. Consumer-side: `lib/stratum-mcp-client.js` gains `onEvent(flowId, stepId, handler)`; `executeParallelDispatchServer` subscribes before the polling loop (subscription cleanup wrapped in `try/finally`), forwards valid v0.2.5 envelopes to `BuildStreamWriter`; `build-stream-bridge` maps to SSE `{type: 'buildStreamEvent', event}`.

**Schema bump:** CONTRACT v0.2.4 → v0.2.5 (additive). New `BuildStreamEvent` 12-kind discriminated union: 3 live (`agent_started`, `tool_use_summary`, `agent_relay`) + 3 reserved (`iteration_update`, `tier_result`, `health_event`) + 6 legacy imports from `BuildStreamWriter` with open metadata.

**Tests:** stratum-mcp 892 pass (883 existing + 9 new); compose 1902 unit + 87 UI + 28 integration pass; 0 regressions. **Aggregate: 2,909 tests passing.**

**Why:** Gates `STRAT-DEDUP-AGENTRUN-V3`. Without typed streaming, retiring the Node connector tree would silently downgrade cockpit visibility to coarse polling-only updates. v3 effort drops from ~2 weeks to 4–6 days now that the streaming path is settled.

**Out of scope (follow-ups):** `STRAT-PAR-STREAM-LEGACY-CLOSE` (tighten 6 legacy kinds to closed metadata, schema v0.2.6); `STRAT-PAR-STREAM-CONSUMER-VALIDATE` (consumer-side schema validation of received envelopes); cockpit UI renderer for the new typed events; PII redaction policy. End-to-end smoke test of the live Python↔Node↔SSE↔UI loop is an open thread.

## 2026-04-25

### Wave 6 close — integration review signed off

All seven Situational Awareness features shipped against the v0.2.4 contract. Sign-off note authored at `docs/features/COMP-OBS-CONTRACT/integration-review.md`. Wave-6 batch test suite (`npm run test:wave-6`) is 59-pass, 0-fail, 0-skip; full compose suite is **1897 pass, 0 fail, 0 skips**. Stale `COMP-OBS-BRANCH/feature.json` corrected (status was still `PLANNED` from before the 2026-04-20 ship; now `COMPLETE` with `completed: 2026-04-20` and `ship_commit: 644587d`). ROADMAP.md `## Wave 6` heading marked `COMPLETE (2026-04-25)`.

### COMP-OBS-STEPDETAIL — Step Detail surface + budget pill (Wave 6 complete)

Final Wave 6 feature. UI-extension only — no schema bump. Three new sections in `ContextStepDetail` (retries summary, postcondition violations, live iteration counters), a compact budget pill on the ops strip, and a read-only `GET /api/lifecycle/budget` endpoint backed by the existing budget ledger.

**Server:**
- `lib/budget-ledger.js` extended with `readBudget(composeDir, featureCode, settings)` returning `{feature_total, per_loop_type: {review, coverage}, computed_at}`. The ledger does not currently break out per-loopType usage; v1 reports `feature_total.usedIterations` against each loopType's `maxTotal` (documented limitation; ledger refinement is a follow-up).
- `server/vision-routes.js` adds `GET /api/lifecycle/budget?featureCode=<FC>` with 400 on missing featureCode.

**Client:**
- `src/components/cockpit/stepDetailLogic.js` *(new)* — pure helpers `selectRetriesSummary`, `selectViolations`, `findLoopForStep`, `selectLiveCounters`, `formatBudgetCompact`.
- `src/components/cockpit/ContextStepDetail.jsx` rewritten: replaced the self-fetch path (was at :184-212, fired once per `stepId` change) with `useVisionStore` subscription on `activeBuild` + `iterationStates`, so the existing 5s store poller drives updates instead of a one-shot. Promoted the existing `step.retries` and `step.violations` render blocks into clearly-labeled "Retries" and "Postcondition violations" sections (earlier draft inverted the field name — the shipped data is `violations`, not `postconditions`). Added a "Live counters" section gated on `findLoopForStep` returning a running loop, with per-second tick. Net line count dropped from 478 → 350 because the deleted self-fetch effect was larger than the three new sections.
- `src/components/cockpit/OpsStrip.jsx` gains a compact budget pill (`r 5/15 · c 8/15`) when the active feature has any non-null `maxTotal`. Fetched once per featureCode change, refetched when the iteration-count sum changes (proxy for "an iteration completed" without coupling to a specific WS message type).

**Notes:**
- Per-attempt retry timeline is **out of scope for v1** — shipped `iterationStates` is a latest-snapshot `Map` (no per-attempt history). Retries section therefore renders the scalar `step.retries` count from build state.
- Step → loop join walks `iterationStates.values()` and matches on `iter.stepId === stepId`. If iteration entries lack `stepId`, the live-counters section degrades gracefully without a per-step lookup.
- No schema change. STEPDETAIL is UI-extension only.

**Tests:** 39 new (7 budget-route + 27 step-detail-logic + 17 context-step-detail UI + 5 ops-strip-budget UI + 5 wave-6 integration STEPDETAIL slices). Full suite: **1897 pass, 0 fail, 0 skips**.

### COMP-OBS-DRIFT — Mechanical drift axes + ribbon (Wave 6 data plane closed)

Final Wave 6 data-plane feature. Three deterministic ratios per feature recompute on every state-changing event; rising-edge breaches emit `kind=drift_threshold` DecisionEvents that survive WS reconnect via persisted breach-edge metadata.

**Schema bump (v0.2.4):**
- `DriftAxis` gains optional `breach_started_at` (date-time, nullable) and `breach_event_id` (uuid, nullable). Required to make rehydration produce the same DecisionEvent id as the live emit; without these the recomputed event id would drift on every reconnect.

**Axes (Decision 1):**
- `path_drift` — files touched since last `phaseHistory.to === 'plan'` entry that are NOT in the plan's declared paths, divided by total touched. Sources unioned: committed-since-anchor + uncommitted worktree changes + untracked files (mirrors `compose/lib/build.js`'s pattern). Anchor uses the MOST RECENT plan entry to handle replans correctly.
- `contract_drift` — JSON-schema fields added/removed/retyped between anchor commit and HEAD; recursive walk on fully-qualified paths so nested retypes are caught.
- `review_debt_drift` — STRAT-REV JSON `findings[]` entries with `status` ∉ `{resolved, closed, fixed}`, divided by total findings. Missing review files → `threshold: null` (axis disabled), not `ratio: 0`.
- All axes return `threshold: null` rather than false-clean ratio=0 when their source is missing or unparseable.

**Defaults (Decision 2):** `path_drift: 0.30`, `contract_drift: 0.20`, `review_debt_drift: 0.40`.

**Server pipeline:**
- `server/drift-axes.js` *(new)* — pure `computeDriftAxes(item, projectRoot, now)`.
- `server/contract-diff.js` *(new)* — `diffContracts(anchorRef, headPaths, projectRoot)` with recursive `walkSchema` + `collectFieldTypes`.
- `server/drift-emit.js` *(new)* — recompute → preserve breach metadata for axes still breached / assign fresh ids on rising edge / clear on falling edge → `updateLifecycleExt` → broadcast `driftAxesUpdate` → emit `DecisionEvent[kind=drift_threshold]` for newly-breached axes.
- `server/decision-event-id.js` + `decision-event-emit.js` — `driftThresholdDecisionEventId(featureCode, axisId, breachStartedAtIso)` + `buildDriftThresholdEvent(...)`.
- `server/decision-events-snapshot.js` — 5th rehydration source reads persisted `breach_event_id` + `breach_started_at` directly (no recompute).
- `server/vision-routes.js` — DRIFT emit BEFORE STATUS at every state-changing site (12 sites: 5 lifecycle + 4 iteration + 2 gate + 3 loop) so STATUS reads freshly persisted axes.
- `server/cc-session-watcher.js` + `vision-server.js` — DRIFT emit wired post-lineage.

**Client:**
- `src/components/vision/DriftRibbon.jsx` *(new)* — 28px ribbon, region ⑥, mounted as first child of `ItemDetailPanel`'s ScrollArea body. Hidden when no axis breached. Click expands axis table.
- `src/components/vision/driftRibbonLogic.js` *(new)* — pure helpers.
- `src/components/vision/visionMessageHandler.js` — `driftAxesUpdate` patches the affected item's `lifecycle.lifecycle_ext.drift_axes`.

**Reviews:** 6 Codex spec rounds reaching REVIEW CLEAN (initial findings: snapshot rehydrate identity, plan-anchor outcome assumption, STATUS already-correct, missing git-utils.js, file-source semantics for review_debt, working-tree git diff vs commit-only). 1 implementation review caught two more bugs: nested retypes silently undercounted in contract-diff, and plan-anchor used FIRST not LAST plan entry (broke replan semantics). Both fixed with regression tests pinned. REVIEW CLEAN at round 2.

**Tests:** 57 new (14 drift-axes + 13 drift-emit + 7 contract-diff incl. nested-retype regression + 22 ui/drift-ribbon + integration). Full suite: **1858 pass, 0 fail, 0 skips**. Wave 6 data plane closed — DRIFT was the final unshipped sibling on the contract-compliance suite.

### COMP-OBS-GATELOG + COMP-OBS-LOOPS — Gate audit log + Open Loops panel

Combined commit because both touch `status-snapshot.js` (gate_load_24h rollup + open_loops_count semantic fix + isStaleLoop extraction).

**COMP-OBS-GATELOG — Gate decision audit + report CLI:**
- `server/gate-log-store.js` *(new)* — `appendGateLogEntry` (idempotent on id), `readGateLog({since, featureCode})`, `mapResolveOutcomeToSchema` (`approve→approve`, `revise→interrupt`, `kill→deny`). Storage: project-scoped JSONL at `<dataDir>/gate-log.jsonl` (NOT app-global — gate decisions belong to the project they were made in).
- `server/decision-event-id.js` extended with `gateDecisionEventId(featureCode, gateLogEntryId)` (uuidv5).
- `server/decision-event-emit.js` extended with `buildGateEvent(...)` returning a `DecisionEvent[kind=gate]` with `metadata.gate_log_entry_id` populated and `decision` mapped to schema vocab.
- `server/vision-routes.js` `gateResolved` route: new outcome whitelist (`approve|revise|kill` only); lazy-expiry guard parity with GET (returns 409 for expired pending gates); per Decision 3 emit-first-then-append — emit DecisionEvent first, then `appendGateLogEntry` with `decision_event_id` set on success or `null` on emit-throw. Featureless gates (no `lifecycle.featureCode`) skip both writes per Decision 1b. Expired gates skip per Decision 1c (no schema enum value).
- `server/decision-events-snapshot.js` — gate events now rehydrate from `gate-log.jsonl` on WS connect, so live gate cards persist across reconnect.
- `server/status-snapshot.js` — `gate_load_24h` reads from `readGateLog({since: now - 86400000}).length`.
- `bin/compose.js` — new `compose gates report [--since 24h] [--feature FC] [--format text|json] [--rubber-stamp-ms N]` subcommand.

**COMP-OBS-LOOPS — Open Loops panel + CLI + STATUS rollup fix:**
- `server/open-loops-store.js` *(new)* — `addOpenLoop`/`resolveOpenLoop`/`listOpenLoops`/`isStaleLoop`. Server fills `id` (UUID v4), `created_at`, `parent_feature` (from item lifecycle); rejects when item lacks `featureCode`. Append-only: resolution mutates in-place, never deletes.
- `server/vision-routes.js` — 3 new REST endpoints (`GET/POST .../loops`, `POST .../loops/:loopId/resolve`). Schema-aligned validation: `kind ∈ {deferred, blocked, open_question}`, `summary` 1–280 chars, `ttl_days` non-negative integer. Each route broadcasts `openLoopsUpdate` + recomputes status snapshot.
- `server/status-snapshot.js` — `open_loops_count` is now `filter(l => l.resolution == null).length` (was `.length` — counted resolved entries forever); inline TTL math replaced by `isStaleLoop` import so panel/CLI/STATUS agree exactly.
- `src/components/vision/OpenLoopsPanel.jsx` *(new)* — 320px sticky right panel collapsible to 40px (per CONTRACT layout.md §④); per-feature scope; oldest-first sort; inline resolve; add modal; `localStorage` collapse persisted as `compose:<feature-code>:openLoopsCollapsed`.
- `src/components/vision/openLoopsPanelLogic.js` *(new)* — pure helpers mirroring server predicates.
- `src/components/vision/visionMessageHandler.js` — `openLoopsUpdate` handler patches the affected item's `lifecycle.lifecycle_ext.open_loops` in-place.
- `src/App.jsx` — mounts `<OpenLoopsPanel>` adjacent to ContextPanel; `handleAddLoop`/`handleResolveLoop` REST callbacks wire the panel to the new endpoints.
- `bin/compose.js` — new `compose loops add|list|resolve --feature <FC> ...` subcommand. `--feature` is required on every action (cross-feature aggregate listing is explicitly out of scope for v1).

**Reviews:** 4 Codex spec rounds across both designs (8+ findings → 4 → 2 → 1 → 0, REVIEW CLEAN); 2 Codex implementation rounds. Round 1 caught six bugs that tests had passed: (1) outcome whitelist missing on resolve (any string passed through), (2) lazy-expiry guard missing on resolve (parity with GET), (3) gate events absent from hydrate snapshot (live cards disappeared on reconnect), (4) `OpenLoopsPanel` mounted in App.jsx without `onAddLoop`/`onResolveLoop` callbacks (UI was non-functional), (5) gate-log was COMPOSE_HOME-scoped (would bleed across repos), (6) OpenLoop request body bypassed schema constraints. All six fixed; round 2 REVIEW CLEAN.

**Tests:** 90 new tests (15+6+6 GATELOG node:test + 22+11+9+14 LOOPS node:test/vitest + 7 wave-6 integration/compliance). Full suite: **1823 pass, 0 fail, 1 intentional skip** (DRIFT only — the last unshipped Wave 6 sibling). Wave 6 contract-compliance suite un-skipped both placeholders.

### COMP-OBS-STATUS — Situational status band + main-cockpit mount fix

**Why:** Wave 6 region ① per CONTRACT layout — the one-sentence "where are we, what's next" projection. Server rolls per-feature state (active phase, pending gates, drift breaches, stale open loops, iteration in flight) into a `StatusSnapshot` and broadcasts on every state-changing event. Click expands a 200px detail panel showing `pending_gates`, `drift_alerts`, `open_loops_count`, `gate_load_24h` verbatim. Also fixes a previously-shipped TIMELINE bug — both region ① and region ② were only mounted in the popout `VisionTracker`, not in the main cockpit (`App.jsx → CockpitView`). They are now mounted at the top of `<main>` so the status surface is visible in the primary UI.

**Server (snapshot producer + 11-site dual-emit + REST):**
- `server/status-snapshot.js` *(new)* — pure `computeStatusSnapshot(state, featureCode, now)` returning a contract-valid `StatusSnapshot`. Internal `buildStatusSentence(...)` implements 8 deterministic rule branches (no-feature → killed → complete → pending gate → drift breach → stale open loops → iteration in flight → idle baseline) with explicit null/unknown-phase fallbacks. Sentence ≤280 chars; gate id truncated with ellipsis when needed.
- `server/status-emit.js` *(new)* — `emitStatusSnapshot(broadcastMessage, state, featureCode, now)` recomputes + broadcasts `{type: 'statusSnapshot', featureCode, snapshot}`. Single choke point.
- `server/vision-routes.js` — emit at every state-changing site: lifecycleStarted, lifecycleTransition (advance/skip/kill/complete), iterationStarted, **iterationUpdate (per-attempt — STATUS-only, TIMELINE intentionally skips)**, iterationComplete (report + abort), gateCreated, gateResolved. New `GET /api/lifecycle/status?featureCode=<FC>` returns `{snapshot}`.
- `server/cc-session-watcher.js` — optional `emitStatusSnapshot` + `getState` deps; emit after lineage broadcast.
- `server/vision-server.js` — wires the deps into `CCSessionWatcher` construction.

**Client (32px sticky band + main-cockpit + popout mount + reconnect invalidation):**
- `src/components/vision/StatusBand.jsx` *(new)* — 32px sticky region ①, renders the sentence only (v1: `cta` is always `null`; no CTA element). Click toggles a 200px expansion panel showing snapshot fields.
- `src/components/vision/statusBandLogic.js` *(new)* — pure helpers (`truncateForSentence`, `formatExpansionPanel`).
- `src/components/vision/DecisionTimelineStrip.jsx` — sticky `top: 0 → 32px`, `z-index: 10 → 20` so it stacks below STATUS.
- `src/components/vision/useVisionStore.js` — `statusSnapshots: {}` slice (map keyed by featureCode) + `setStatusSnapshot(featureCode, snap)` + new `clearStatusSnapshots()` action (called on hydrate; ensures WS reconnect refetches against current server state).
- `src/components/vision/visionMessageHandler.js` — `statusSnapshot` WS handler; `clearStatusSnapshots()` on hydrate.
- `src/App.jsx` — imports `StatusBand` + `DecisionTimelineStrip`; mounts both at the top of `<main>` so they render in the cockpit (not just popout); adds a `useEffect` that fetches `/api/lifecycle/status` on `activeFeatureCode` change. **This also fixes TIMELINE's invisible-in-main-cockpit bug** (it had the same VisionTracker-only mount).
- `src/components/vision/VisionTracker.jsx` (popout) — retains its own band + strip mount + hydration effect; both surfaces now keep parity.

**Reviews:** 4 Codex review rounds against the design (5 → 4 → 1 → 0 actionable findings, REVIEW CLEAN), 2 rounds against the implementation. Round 1 caught two real bugs: (a) HIGH — the band was only mounted in the popout `VisionTracker`, never in the main cockpit (TIMELINE had the same bug, fixed in this commit); (b) MEDIUM — `statusSnapshots` would go stale indefinitely on WS reconnect because there was no invalidation path. Both fixed: dual-mount in `App.jsx` + popout, plus `clearStatusSnapshots` called from the hydrate handler. Refactor pass also removed a leaky `_openLoopsCount` field injected onto `iterationState` — replaced with an explicit `openLoopsCount` parameter on `buildStatusSentence`. REVIEW CLEAN at round 2.

**Tests:** 70 new tests (36 snapshot-branch + 6 emit + 10 route + 12 band-logic + 11 ui + 5 integration + 1 compliance activated). Full suite: **1747 pass, 0 fail, 3 intentional skips** (siblings DRIFT / GATELOG / LOOPS still pending). Wave 6 contract-compliance suite un-skipped STATUS placeholder.

### COMP-OBS-TIMELINE — Decision timeline strip + dual-emit pipeline

**Why:** Wave 6 region ② per CONTRACT layout. Closes the orphaned `decisionEvent` broadcast that COMP-OBS-BRANCH has been emitting into the void since 2026-04-20, and adds two new event kinds (`phase_transition`, `iteration`) so the strip is populated immediately on first lifecycle interaction. Strip already renders `gate` and `drift_threshold` cards via the same `DecisionCard` component — zero code change here when GATELOG and DRIFT ship their emitters.

**Server (single emit choke point + dual-emit at every existing broadcast site):**
- `server/decision-event-emit.js` *(new)* — `emitDecisionEvent(broadcastMessage, event)` + per-kind builders (`buildPhaseTransitionEvent`, `buildIterationEvent`). Builder output byte-matches BRANCH's existing emit envelope (`cc-session-watcher.js:146-167`).
- `server/decision-event-id.js` — extended with `phaseTransitionDecisionEventId(featureCode, fromPhase, toPhase, timestamp)` and `iterationDecisionEventId(featureCode, loopId, stage)`. Same uuidv5/per-feature-namespace pattern as existing `branchDecisionEventId`. Deterministic — re-derive == identity.
- `server/lifecycle-phase-history.js` *(new)* — sole writer for `lifecycle.phaseHistory[]`, plugging `project_lifecycle_phasehistory_gap` (memory note). Entries carry BOTH the legacy shape (`phase`, `step`, `enteredAt`, `exitedAt`, `outcome`) consumed by `ItemDetailPanel.jsx`, `ContextPipelineDots.jsx`, and `session-routes.js`, AND the new shape (`from`, `to`, `outcome`, `timestamp`) consumed by snapshot derivation. Appending a successor closes out the prior entry's `exitedAt`.
- `server/decision-events-snapshot.js` *(new)* — `deriveDecisionEvents(state, featureCode)` walks `phaseHistory[]` + `iterationState` + `lifecycle.lifecycle_ext.branch_lineage.branches[]` to seed the strip on WS connect. Computes `sibling_branch_ids` per fork_uuid grouping (matches BRANCH live-emitter semantics — including self).
- `server/vision-routes.js` — dual-emit at 8 broadcast sites (lines 183, 237, 260, 283, 305 for phase transitions; 357, 414, 446 for iteration start/complete/abort; line 418 deliberately untouched — per-attempt `iterationUpdate` does not flood the strip).
- `server/vision-server.js` — `getVisionSnapshot` now attaches `decisionEventsSnapshot` to the hydrate envelope.

**Client (region ② render + store wiring):**
- `src/components/vision/DecisionTimelineStrip.jsx` *(new)* — 72px sticky band, full-width, horizontally scrollable, newest-right ordering. Filtered to current feature.
- `src/components/vision/DecisionCard.jsx` *(new)* — 160px card per CONTRACT layout.md §②: timestamp top-right, title, role chips (`IMPLEMENTER` / `REVIEWER` / `PRODUCER`), linked-run status dot.
- `src/components/vision/decisionTimelineLogic.js` *(new)* — pure helpers (`formatRelativeTime`, `kindIcon`, `kindColor`, `roleChipClass`, `sortAndFilterEvents`).
- `src/components/vision/useVisionStore.js` — `decisionEvents: []` slice + `setDecisionEventsSnapshot(arr)` and `appendDecisionEvent(ev)` (dedupe by id).
- `src/components/vision/visionMessageHandler.js` — handlers for `decisionEvent`, `decisionEventsSnapshot`, plus seeding from `hydrate.decisionEventsSnapshot`.
- `src/components/vision/VisionTracker.jsx` — strip mounted at top-of-tree.
- `src/components/vision/constants.js` — `DECISION_KINDS` map for color/icon/label.

**Reviews:** 2 Codex review rounds against the implementation. Round 1 surfaced three real bugs that tests had passed over: (a) `phaseHistory` writer used the new `{from, to, outcome, timestamp}` shape only — silently broke `ItemDetailPanel`, `ContextPipelineDots`, and `session-routes` legacy readers; (b) snapshot derivation read `item.lifecycle_ext` (top-level) instead of the production-real `item.lifecycle.lifecycle_ext`, so cold reconnect would have dropped all branch cards; (c) snapshot rebuilt branch events with hardcoded `sibling_branch_ids: []`, dropping fork context after refresh. All three fixed; round 2 added an executable assertion for sibling rehydration. REVIEW CLEAN at round 2 close.

**Tests:** 121 new tests (117 node:test + 10 vitest, plus regression tests for the three Codex fixes). Full suite: **1677 pass, 0 fail, 4 intentional skips** (siblings STATUS / GATELOG / LOOPS / DRIFT awaiting ship). Wave 6 contract-compliance suite un-skipped TIMELINE placeholder.



### COMP-OBS-CONTRACT — Wave 6 shared contract, locked

**Why:** Gates the rest of Wave 6 (Situational Awareness). Six sibling features (COMP-OBS-STATUS, TIMELINE, STEPDETAIL, LOOPS, GATELOG, DRIFT) now build against a single frozen schema + layout + integration-smoke spec, so cross-feature drift (the failure class that motivated `feedback_integration_review`) can't land silently.

**Schema (`docs/features/COMP-OBS-CONTRACT/schema.json` → v0.2.3):**
- Propagates the 2026-04-23 SURFACE → TIMELINE+STEPDETAIL split through `_consumers`. Emitter ownership restated: BRANCH→kind=branch, GATELOG→kind=gate, TIMELINE→kind=phase_transition + kind=iteration, DRIFT→kind=drift_threshold.
- `StatusSnapshot.drift_alerts[]` now a closed subschema that mandates `breached: true` (STATUS can no longer emit non-alert axes through the alerts field).
- Gate `DecisionEvent.metadata.gate_log_entry_id` promoted to required. Canonical join is the forward edge; `GateLogEntry.decision_event_id` remains nullable only as an emission-failure escape hatch, with reconciliation rule documented (gate_id + timestamp ±5s).

**Spec artifacts:**
- `design.md` *(new)* — unifying index, read order, versioning discipline, in-/out-of-scope for v1.
- `layout.md` — region ⑤ rewritten to describe the shipped `BranchComparePanelMount` at `ItemDetailPanel.jsx:419-422`; region ⑥ (DRIFT ribbon) re-anchored above BRANCH mount (the former "above chat input" anchor didn't exist in code); mobile-stacking and 50-branch-pagination claims relaxed to match shipped BranchComparePanel (no responsive breakpoint, no branch-picker UI in v1).
- `integration-test.md` — two-file ownership documented (BRANCH-slice integration + new contract-compliance); golden flow extended with `kind=drift_threshold` so Timeline exercises all five DecisionEvent kinds.
- `blueprint.md` *(new)* — file:line-verified plan with corrections table (wave-6-integration.test.js already existed; Playwright deferred; real-CC-in-tests a non-goal).
- `plan.md` *(new)* — ordered T1–T10 acceptance-gate plan.

**Code:**
- `compose/test/wave-6-contract-compliance.test.js` *(new)* — 30 tests, 5 intentional `test.skip()` placeholders (one per unshipped sibling, named after its feature code so `grep COMP-OBS-<CODE>` finds the un-skip line on landing). Covers: schema-load, dataset gate, per-fixture BranchOutcome round-trip (6 fixtures including `failed-branch` and `truncated` so state=failed is exercised), BranchLineage positive + unbound-branches negative, state=unknown shape, DecisionEvent all five kinds + gate-without-`gate_log_entry_id` negative + per-kind metadata `additionalProperties` closure negative, OpenLoop positive/resolved/non-UUID, 4 error-harness rows, 50-branch lineage + `pickInitialPair`.
- `compose/package.json` — new `test:wave-6` script runs both Wave 6 files as one suite.

**Tests:** 25 new tests (30 defined, 5 skipped). Full suite: 1558 pass, 0 fail, 5 intentional skips.

**Reviewed:** 3 Codex review rounds against the spec artifacts (6 findings → 3 follow-ups → REVIEW CLEAN), 2 Codex review rounds against the implementation (2 findings → 1 follow-up → implicit clean after state=unknown coverage added).



**Why:** First shipping feature of Wave 6 (Situational Awareness). Forge reads Claude Code's existing parent-pointer branch tree at `~/.claude/projects/**/*.jsonl` — no new fork mechanism, no new storage. Ships first because it's the structural validator that the CC JSONL assumption holds; failures here invalidate the branch-outcome shape the rest of the Wave 6 batch depends on.

**Producer (backend):**
- `server/schema-validator.js` *(new)* — ajv wrapper over `docs/features/COMP-OBS-CONTRACT/schema.json` v0.2.2. Used at the lineage-POST boundary and in tests.
- `server/cc-session-reader.js` *(new)* — parses a single CC session JSONL, builds a parent-pointer tree over non-sidechain records, classifies each leaf's state (`running` / `complete` / `failed` / `unknown`), derives BranchOutcome metrics per blueprint §6.5. Truncated files tolerated.
- `server/cc-session-feature-resolver.js` *(new)* — joins `cc_session_id` → `feature_code` via (1) `basename(transcriptPath)` match in `.compose/data/sessions.json`; (2) fallback probe of `docs/features/<CODE>/sessions/<cc_session_id>.*`; (3) unbound → null (counted in `stats.unbound_count`, never emitted per the contract's required `feature_code` rule).
- `server/decision-event-id.js` *(new)* — deterministic `uuidv5` event id keyed on `(feature_code, branch_id)` + pure `shouldEmit` dedupe helper. Prevents full-rescan replay on restart.
- `server/cc-session-watcher.js` *(new)* — orchestrator. Per-feature × per-session accumulator (so a feature with multiple CC sessions never has branches clobbered on POST), aggregated lineage POST, debounced `fs.watch` with polling fallback, persisted `emitted_event_ids` round-trip across restart.
- `server/vision-store.js` — `updateLifecycle` now preserves prior `lifecycle_ext` across partial-update callers (the 31 existing callsites, notably `feature-scan.js`, safely write non-extension fields without clobbering Wave 6 additions). New `updateLifecycleExt(id, key, value)` is the single public method Wave 6 features use to write extensions.
- `server/vision-routes.js` — new `POST /api/vision/items/:id/lifecycle/branch-lineage`, schema-validated at the boundary; emits `branchLineageUpdate` WebSocket event. Idempotent.
- `server/vision-server.js` — opt-in `CCSessionWatcher` wire-up. **Default OFF.** Enable via `capabilities.cc_session_watcher: true` in `compose.json` or `CC_SESSION_WATCHER=1` env var. When on, seeds emitted event ids from persisted lineage on startup (no replay), runs a full scan, then watches.

**Consumer (frontend):**
- `src/components/vision/BranchComparePanel.jsx` *(new)* — collapsed 1-liner (`N branches · last fork Xh ago · [Compare]`); expanded 2-column metric grid with inline `ArtifactDiff` below. Compare button disabled when <2 `state: complete` branches; mid-progress shows `X of N branches ready`. Metric rows pluggable via `extraMetricsForBranch` prop (future COMP-OBS-DRIFT injection point).
- `src/components/vision/branchComparePanelLogic.js` *(new)* — pure helpers (summary/age/number formatters + `pickInitialPair`) extracted for unit testing without a DOM.
- `src/components/vision/useVisionStore.js` — Zustand `selectedBranches: { [featureCode]: [branchIdA, branchIdB] }` slice + `setSelectedBranches` action. Session-local, not persisted.
- `src/components/vision/ItemDetailPanel.jsx` — mounts `<BranchComparePanel>` as the first child of the scroll body when `item.lifecycle.featureCode` is set.

**Dependencies:** `ajv` `^8.18.0`, `ajv-formats` `^3.0.1` — JSON Schema draft-07 + date-time/uuid formats, used at all contract boundaries.

**Tests:**
- `test/fixtures/cc-sessions/` *(new)* — 6 synthesized+scrubbed JSONL fixtures + multi-session dir + byte-deterministic `capture.js`. Covers linear, two-branch fork, three-branch fork, mid-progress, failed-branch (via `tool_result.is_error:true`), truncated.
- 9 new test files under `test/comp-obs-branch/` + `test/vision-store-server.test.js` + `test/wave-6-integration.test.js`. Coverage: schema boundaries (12), reader (24), resolver (9), event id (8), watcher (6), route (7), logic (27), store (11), integration (6) = 110 new tests.
- Integration test runs entirely on tmp dirs — never touches `~/.claude/projects/` or `$HOME`.

**Verified:**
- Full suite `node --test test/*.test.js test/comp-obs-branch/*.test.js`: **1522/1522 pass** (1515 pre-review + 7 added in response to Codex findings), zero regressions across the 31 existing `updateLifecycle` callsites.
- `npm run build` succeeds in ~8.5s.
- UI not manually verified in a browser (dev server was not started to avoid disrupting the active developer session). Vite dev server smoke via curl: `BranchComparePanel.jsx`, `ItemDetailPanel.jsx`, `branchComparePanelLogic.js`, `useVisionStore.js` all serve HTTP 200 with compiled JSX — import graph resolves cleanly.

**Codex review pass (2026-04-20):** six findings, five accepted + fixed, one deferred with rationale:
1. ✅ **Bug** — `parseJsonlSafe` silently dropped mid-line parse failures. Fixed: any unparseable line now flags `truncated=true`, and `running` leaves under a truncated session are downgraded to `unknown` (positive identifications on the leaf itself — `is_error`, `stop_reason: end_turn` — remain trustworthy).
2. 📎 **Deferred** — Codex flagged that `failed` branches get completion-only metrics (`turn_count`, `files_touched`, etc.) populated, citing per-field "Populated when state=complete" descriptions. The plan (T1 acceptance criteria) and the schema's `ended_at` description ("Populated when state is terminal (complete / failed). Null while running.") both codify "terminal = complete OR failed" for completion-only fields. Keeping implementation aligned with the plan. If COMP-OBS-CONTRACT wants stricter semantics, it needs a schema bump that unambiguously says "complete only" across all completion-only fields.
3. ✅ **Contract** — `final_artifact.path` was chosen at the reader before `feature_code` resolution, so a session touching multiple feature folders could attach another feature's artifact. Fixed: watcher re-filters `final_artifact` against `docs/features/<resolved feature_code>/` and nulls it when out-of-scope.
4. ✅ **Contract** — Branch-lineage route didn't verify `body.feature_code === item.lifecycle.featureCode`. Fixed: route rejects with 400 when the item has no `lifecycle.featureCode` or when `feature_code` mismatches.
5. ✅ **Race** — `_flush()` broadcast DecisionEvents before persisting the updated `emitted_event_ids`, so a crash between broadcast and POST could replay. Fixed: `_flush()` now stages ids in the lineage payload, POSTs first, and only commits ids to the in-memory dedupe set + broadcasts on POST success. On POST failure, the set is untouched and the next scan retries.
6. ✅ **Schema** — Production watcher path bypassed schema validation (direct `updateLifecycleExt`). Fixed: `vision-server.js`'s `postBranchLineage` callback now validates against `BranchLineage` and verifies the `feature_code`/`featureCode` match before persisting.

**Not in v1** (per feature.json): no new fork mechanism (users still fork via CC `Esc Esc` / rewind); no transcript-level side-by-side diff; no tool-call timeline; no cross-session ancestry; no mid-session fork UI in Forge. Read-only visualizer over CC's native state.

**Heuristic-in-v1 metrics:** `tests.passed/failed/skipped` parsed from `tool_result` stdout via a pytest/jest/vitest/mocha regex — exact where matchable, else `0`. `cost.usd` is `0` unless `CC_USD_PER_1K_INPUT` / `CC_USD_PER_1K_OUTPUT` env vars are set. `final_artifact.snapshot` is `null` (lazy-load via `path` deferred to v2).

## 2026-04-18

### COMP-REACT19 — React 18.3.1 → 19.2.5

**Why:** Unblocks COMP-TUI-COCKPIT (ink 7.x requires React ≥19.2.0); also picks up `use()`, form actions, and ref-as-prop ergonomics for the app.

**Changes:**
- `package.json`: `react` `^18.3.1` → `^19.2.5`; `react-dom` `^18.2.0` → `^19.2.5` (aligned).

**Verified safe:**
- No `ReactDOM.render`/`hydrate`, no `propTypes`/`defaultProps` on function components, no string refs, no legacy context usage.
- Zero block-bodied `useMemo`/`useCallback` with implicit-undefined returns (breaking change #6 is a no-op here).
- `src/main.jsx` already uses `createRoot`; app is not wrapped in `<StrictMode>` (no double-invoke surfacing).
- `React.forwardRef` (61 call sites across 13 UI files) retained — still supported in React 19; ref-as-prop codemod deferred to a future cleanup.
- All React-consuming deps (`@radix-ui/*`, `@hello-pangea/dnd`, `@tanstack/react-virtual`, `react-markdown`, `lucide-react`, `ink`, `zustand`) compatible with React 19 at current pins.

**Tests:** 1420 tests pass (baseline unchanged); 10 integration tests pass; `npm run build` succeeds in 5.07s.

### T2-F5-CONSUMER-MERGE-STATUS-COMPOSE — close the T2-F5 arc

**Why:** T2-F5-COMPOSE-MIGRATE-WORKTREE landed with a known trade-off (W1): client-side merge conflicts halted the CLI via a throw, but the stream-writer closed with `buildStatus='complete'` because the throw bypassed the terminal `buildStatus='failed'` branch. The flow state also reported `merge_status='clean'` server-side — Stratum auto-advanced before Compose could report the real status. T2-F5-DEFER-ADVANCE (stratum-side) added the back-channel; this feature wires Compose up to it.

**Changes:**

- `lib/stratum-mcp-client.js`: new `parallelAdvance(flowId, stepId, mergeStatus)` method.
- `lib/build.js`: split `applyServerDispatchDiffs` into a pure `applyServerDispatchDiffsCore` (returns `{mergeStatus, conflictedTaskId, conflictError, appliedFiles}`) + a thin throwing wrapper preserving the legacy non-deferred contract. Specs that haven't opted into `defer_advance: true` keep the old throw-on-conflict semantics.
- `lib/build.js:executeParallelDispatchServer`: now branches on `pollResult.outcome?.status === 'awaiting_consumer_advance'`. Defer path calls Core + `parallelAdvance(mergeStatus)`, replaces the sentinel with the real advance result (flow advances with truth). Legacy path uses the throwing wrapper. Defensive "spec mispairing" branch: if sentinel arrives without `capture_diff: true`, call `parallelAdvance('clean')` to unblock the flow and emit an actionable `build_error`.
- `lib/build.js`: new exported `resolveBuildStatusForCompleteResponse(response)` helper. In the main loop's complete branch, `buildStatus` is now derived via this helper — returns `'failed'` when `response.output.merge_status === 'conflict'`, else `'complete'`. Narrow check (not `output.outcome === 'failed'`) to avoid flipping on unrelated failure-flavored completions.
- `pipelines/build.stratum.yaml`: `execute` step opts in with both `capture_diff: true` and `defer_advance: true`. Under `COMPOSE_SERVER_DISPATCH=1` this activates the new path; otherwise the spec flags are inert (consumer-dispatch runs the agents itself).

**Tests:** 10 new (1 client + 4 integration with real temp git repos + 5 buildStatus unit). **1407 total passing**, 0 fail.

**T2-F5 arc status:** CLOSED end-to-end. Server-side enforcement, Python connectors, Compose routing for both isolation modes, diff export, defer-advance, and consumer merge status all shipped. Remaining T2-F5 tickets (BRANCH, DEPENDS-ON, STREAM, OPENCODE-DISPATCH, CLAUDE-CANCEL, RESUME, LEGACY-REMOVAL) are quality-of-life enhancements, not correctness gaps.

## 2026-04-17

### CodexConnector: swap opencode backend for the official `codex` CLI

**Why:** Codex review was broken for everyone — the opencode-backed path hit persistent auth/model-access issues. The official OpenAI `codex` CLI (`@openai/codex`) is the same primitive used by the `openai/codex-plugin-cc` Claude Code plugin and is the supported path going forward.

**Changes:**
- `server/connectors/codex-connector.js`: full rewrite. No longer extends `OpencodeConnector`; now spawns `codex exec --json --skip-git-repo-check --sandbox read-only -m <model> -C <cwd>` and translates its JSONL event stream (`item.completed` / `turn.completed`) into the shared connector envelope. `<model>/<effort>` suffix parses into `-c model_reasoning_effort=<effort>`.
- Supported model IDs unchanged (`CODEX_MODEL_IDS`). Auth via `codex login` (ChatGPT OAuth) or `OPENAI_API_KEY`.
- `OpencodeConnector` retained for non-Codex providers — only the Codex subclass was rewired.

**Setup:** `npm i -g @openai/codex` (or `brew install codex`), then `codex login`. See README.

**Tests:** Existing `test/codex-connector.test.js` (5 cases) passes. Live smoke test against `codex` returns assistant/usage/result events correctly.

### T2-F5-COMPOSE-MIGRATE-WORKTREE: Worktree Diff Consumption in Server-Side Dispatch

**Feature:** Extended T2-F5-COMPOSE-MIGRATE to accept `isolation: "worktree"` + `capture_diff: true` on server-dispatch. New `applyServerDispatchDiffs()` wrapper reads `ts.diff` from poll response and delegates to shared `applyTaskDiffsToBaseCwd` helper (extracted from consumer-dispatch). Both dispatch paths now merge through the same code. Client-side merge conflicts emit `build_error` and throw to halt CLI. Known trade-off: merge_status visibility gap until T2-F5-CONSUMER-MERGE-STATUS lands Stratum-side defer-advance (flow state stays advanced server-side; manual resume required).

**Changes:**
- `lib/build.js`: New `applyServerDispatchDiffs()` wrapper + extracted shared `applyTaskDiffsToBaseCwd()` helper from consumer-dispatch. Merge conflicts throw to halt CLI.
- `test/build.test.js`: 10 new tests (6 routing, 4 integration): worktree routing with `capture_diff`, diff application, conflict handling, merge failures

**Tests:** All new tests passing. Full suite: 1397 passing (10 new).

### T2-F5-COMPOSE-MIGRATE: Server-Side Parallel Dispatch for Read-Only Steps

**Feature:** Compose's `parallel_dispatch` branch now routes through Stratum's server-side `stratum_parallel_start` + `stratum_parallel_poll` when `COMPOSE_SERVER_DISPATCH=1` AND `isolation: "none"`. Code-writing paths (`isolation: "worktree"`) remain on consumer-dispatch pending T2-F5-DIFF-EXPORT. Poll loop correctly breaks on `outcome != null`, not `can_advance`, so failure-path `ensure_failed` / retry dispatches propagate correctly.

**Changes:**
- `lib/stratum-mcp-client.js`: Added `parallelStart()` and `parallelPoll()` client methods for server-side dispatch
- `lib/build.js`: Added `executeParallelDispatchServer()` executor function with routing check at top of `executeParallelDispatch()`
- `README.md`: Documented `COMPOSE_SERVER_DISPATCH` and `COMPOSE_SERVER_DISPATCH_POLL_MS` environment variables
- Test coverage: 15 new tests (2 client + 7 server + 6 routing), 1387 total passing

**Tests:** All new routing + server dispatch tests passing. Full suite clean.

## 2026-04-12

### Test suite fixes (34 failures across 15 suites)

**Root causes fixed:**
- Pipeline YAML specs: removed `metadata` top-level key rejected by stratum-mcp 0.1.0; removed `retries` on flow steps (not allowed per stratum schema)
- Pipeline spec: fixed `$.steps.execute.output.files_changed` reference (parallel_dispatch output uses `tasks` key)
- `visionMessageHandler`: test mocks missing new setters (`setSpawnedAgents`, `setAgentRelays`, `setIterationStates`, `setFeatureTimeline`, etc.) added in recent features
- `settings-store`: tests updated for `defaultView` change from `'attention'` to `'graph'`
- `selective-rerun`: tests updated to include `debug-discipline` in BASELINE_LENSES (added by COMP-DEBUG-1)
- `parallel-dispatch`: tests searched inline branch but code was refactored to `executeParallelDispatch()` function
- `project-config`: test imported removed `TARGET_ROOT` export, updated to `getTargetRoot()`
- `build-dag`: deduplicate entries by code to handle ROADMAP.md summary tables that repeat feature codes
- `vision-store`: gate labels updated to match `GATE_STEP_LABELS` constants (`'Review Design'` not `'design gate'`)
- `init`: test expected `stratum` skill but source only ships `compose` skill
- `proof-run`: mock connector updated for new pipeline steps (triage, merge, lens tasks, ship plan_items)

### COMP-DEBUG-1: Debug Discipline Engine (design)

**Feature design and pipeline enhancement for disciplined bug resolution.**

Derived from SmartMemory weekly retro analysis (132 commits, 4:1 fix:feat ratio). Four anti-patterns identified and codified:

1. **Fix-chain detection** — git analysis detects repeated edits to same file/function across commits, signals thrashing vs. root-cause fixing
2. **Trace-before-fix enforcement** — `diagnose` step now requires `trace_evidence` postcondition (actual command output, not prose assumptions)
3. **Cross-layer grep audit** — automatic scope expansion when diagnose detects provider switches, field renames, or config changes spanning repos
4. **Attempt counting with escalation** — hard stop on visual/layout bugs at attempt 2, cross-agent handoff to break "one more tweak" loops

**Pipeline changes:**
- `bug-fix.stratum.yaml`: 6 → 8 steps (added `scope_check` and `retro_check`)
- New contracts: `TraceEvidence`, `DiagnoseResult`, `ScopeResult`, `RetroCheckResult`
- `diagnose` step now has `ensure:` postconditions requiring trace evidence

**Docs:**
- `docs/features/COMP-DEBUG-1/design.md` — full feature design
- `docs/ROADMAP.md` — added to Phase 7 (Trusted Pipeline Harness)

## 2026-04-09

### COMP-IDEABOX Batch 3: Advanced Features (Items 184, 186, 187, 188, 189)

**Item 184: Lifecycle integration**
- **build.js:** after each agent step, scans output text for "we should/could/might" patterns and emits `idea_suggestion` stream events (hints only, nothing auto-filed).
- **bin/compose.js:** `compose new --from-idea <ID>` flag pre-populates intent from an ideabox entry's title + description + cluster, skips duplicate questionnaire fields.
- **AttentionQueueSidebar.jsx:** "Ideas" section below the attention queue showing untriaged idea count. Click navigates to the ideabox view.

**Item 186: Discussion threads**
- **lib/ideabox.js:** `parseIdeabox` and `serializeIdeabox` support inline discussion entries (`**Discussion:**` block with `- [date] author: text` entries). Discussion field parsed to `[{ date, author, text }]`.
- **lib/ideabox.js:** `addDiscussion(parsedData, ideaId, author, text)` mutation helper.
- **server/ideabox-routes.js:** `POST /api/ideabox/ideas/:id/discuss` endpoint.
- **bin/compose.js:** `compose ideabox discuss <ID> "<comment>"` subcommand.
- **IdeaboxView.jsx:** discussion thread rendered in detail panel; inline input to add comments.
- **useIdeaboxStore.js:** `addDiscussion` and `updateIdea` actions.

**Item 187: Impact/effort matrix**
- **lib/ideabox.js:** `effort` (S|M|L) and `impact` (low|medium|high) fields added to idea schema. Parsed from `**Effort:**` and `**Impact:**` lines.
- **server/ideabox-routes.js:** PATCH allows `effort` and `impact` fields.
- **IdeaboxMatrixView.jsx (new):** 2x2 scatter plot with Quick Wins / Big Bets / Fill-ins / Money Pits quadrants. Unassigned tray with inline EffortImpactForm. Dot colors by cluster.
- **IdeaboxView.jsx:** "Cards | Matrix" tab toggle in header.

**Item 188: Roadmap graph integration**
- **GraphView.jsx:** "Ideas" toggle (default off). When on, renders idea nodes as dashed amber circles connected via dashed edges to their `mapsTo` feature targets.

**Item 189: Source analytics + digest dashboard**
- **IdeaboxAnalytics.jsx (new):** collapsible analytics section in header — source breakdown bars, NEW→DISCUSSING→PROMOTED status funnel with kill rate, cluster health with promotion rate. Pure derived computation from store data.

- **Tests:** 68 tests, all passing. New suites: discussion parsing, addDiscussion, effort/impact fields, resurrectIdea.

### COMP-OBS-GATES: Tiered Gate Evaluation (Wave 4)

- **gate-tiers.js (new):** 5 tiers (T0 schema → T1 lint → T2 tests → T3 llm-review → T4 cross-model) with cost estimates. `classifyStepAsTier()` maps pipeline steps. `evaluateTiers()` short-circuits on first failure, tracks cost saved from skipped tiers.
- **build.js:** Accumulates tier results per step, emits `gate_tier_result`/`gate_tier_failed`/`gate_tier_summary` events, persists savings to `.compose/data/gate-savings.json`.
- **ContextStepDetail.jsx:** `TierPipeline` component with colored dots (green=pass, red=fail, gray=skipped), cost-saved badge, click-to-expand.
- 14 tests, all passing.

### COMP-QA: Diff-Aware QA Scoping (Wave 4)

- **qa-scoping.js (new):** `mapFilesToRoutes()` — framework-aware file→route mapper supporting Next.js (pages/app), Express, React Router, explicit routes.yaml config. React Router filename pattern takes precedence over routes/ directory (avoids misclassifying `AuthRoute.tsx`).
- **classifyRoutes():** splits into affected vs adjacent via path-prefix matching.
- **detectDevServer():** probes ports 3000/3001/4000/5173/8080 with AbortController timeout.
- **isDocsOnlyDiff():** flags builds where only docs/config changed.
- **build.js:** Emits `qa_scope` event before coverage dispatch. Persists `filesChanged` to feature.json for CLI inspection.
- **bin/compose.js:** `compose qa-scope <featureCode>` command reads feature's filesChanged and prints mapped routes.
- 39 tests, all passing.

### COMP-HEALTH: Quantified Quality Score (Wave 4)

- **health-score.js (new):** 6-dimension weighted score (test_coverage 25%, review_findings 25%, contract_compliance 15%, runtime_errors 15%, doc_freshness 10%, plan_completion 10%). Missing dimensions re-normalized out (no penalty). `computeCompositeScore()` returns score + breakdown + missing list.
- **health-history.js (new):** Append-only `.compose/data/health-scores.json`. `getTrend()` returns improving/declining/stable.
- **build.js:** Collects signals per phase (test_coverage from coverage_check, review_findings from parallel_review, plan_completion from ship, runtime_errors from violations, doc_freshness from staleness check, contract_compliance from ensure pass/fail tracking). Emits `health_score` event at build end. Persists to history.
- **settings-store.js:** `health.enabled`, `health.gate_threshold`, `health.weights` config. Validation: threshold 0-100, weights sum 1.0.
- **Enforcement:** When gate_threshold is set and score < threshold, build status downgraded to 'failed'.
- **ContextStepDetail.jsx:** Health Score panel with big color-coded number, trend arrow, per-dimension mini bars.
- **App.jsx:** Wires tierEvents and healthEvents from activeBuild to ContextStepDetail.
- 55 tests, all passing.

**Codex fixes:** health threshold now enforces via build status downgrade, App.jsx wires tier/health events to ContextStepDetail, filesChanged persisted to feature.json for qa-scope command, contract_compliance dimension now populated from ensure pass/fail tracking, React Router filename detection precedes routes/ dir check.

### STRAT-TIER: Model Tier Routing (Wave 4)

- **agent-string.js:** Extended parser to support `provider:template:tier` format. `parseAgentString()` returns `{ provider, template, tier }`. `resolveAgentConfig()` resolves tier → modelID.
- **model-tiers.js (new):** MODEL_TIERS map (critical → Opus, standard → Sonnet, fast → Haiku). `resolveTierModel()` lookup.
- **agent-chains.js (new):** Chain presets (plan-execute-review, review-fix, security-audit). `applyChain()` rewrites agent strings to include tier so runtime actually routes.
- **build.js:** defaultConnectorFactory passes resolved model via both `model` and `modelID` for cross-connector compatibility. Emits `step_model` stream events with tier + modelID.
- **build.stratum.yaml:** Targeted tier assignments — blueprint → critical, ship → critical, run_tests → fast. Defaults unchanged.
- 46 tests (model-tiers + agent-string extensions).

### COMP-OBS-COST: Token and Cost Tracking (Wave 4)

- **model-pricing.js (new):** Per-model token pricing (Opus $15/$75, Sonnet $3/$15, Haiku $1/$5 per MTok). `calculateCost()` with prefix matching for dated variants.
- **claude-sdk-connector.js:** Extracts usage from SDK result messages, yields `usage` events.
- **opencode-connector.js:** Forwards `step_finish` cost/token data as `usage` events (previously logged to stderr only).
- **result-normalizer.js:** Accumulates usage per step, calculates cost_usd via `calculateCost`, returns `{ text, result, usage }`, forwards per-step usage to streamWriter.
- **build-stream-writer.js:** `writeUsage()` emits `step_usage` events. `close()` accepts cost totals for `build_end`.
- **build.js:** Accumulates `buildCostTotals`. Includes tokens/cost on `build_step_done`. Emits cumulative totals on `build_end`. Persists to active-build.json so resumed builds seed correctly.
- **build-stream-bridge.js:** Passes through cost fields on build_step_done, build_end, and new step_usage event type.
- **opsStripLogic.js:** `formatCost()` helper. Active build entry shows `· $0.42` when cost > 0.
- **ContextStepDetail.jsx:** Per-step cost row + sortable breakdown table (most expensive step highlighted).
- 27 tests (model-pricing + cost-tracking).

**Codex fixes:** Chain presets now actually rewrite agent strings (were inert). Resumed builds seed cost totals from active-build.json (were zero-reset). Tier model passed as both `model` and `modelID` for Codex+Claude connector compat.

### COMP-IDEABOX: Product Idea Capture & Triage (Wave 3) — Batches 1+2

**Batch 1 (Backend + CLI):**
- **lib/ideabox.js (new):** pure markdown parser/writer. parseIdeabox/serializeIdeabox round-trip, addIdea, promoteIdea, killIdea, resurrectIdea, setPriority, addDiscussion, loadLens. Handles SmartMemory canonical format.
- **server/ideabox-routes.js (new):** REST API — GET, POST, PATCH, /promote, /kill, /resurrect, /discuss. PATCH rejects status mutations (must use /promote or /kill).
- **server/ideabox-cache.js (new):** mtime-invalidated JSON cache for fast UI queries.
- **bin/compose.js:** `compose init` scaffolds `docs/product/ideabox.md`. `compose ideabox` subcommands: add, list, promote, kill, pri, triage, discuss. Respects `paths.ideabox` and `paths.features` from compose.json.
- 48 parser/CLI tests.

**Batch 2 (Core Web UI):**
- **IdeaboxView.jsx (new):** main view with digest header, filter bar (tag/status/priority/search), priority lanes, drag-and-drop, click-to-detail panel, graveyard.
- **IdeaboxTriagePanel.jsx (new):** modal triage flow with keyboard shortcuts, similarity hints, progress.
- **IdeaboxPromoteDialog.jsx (new):** 3-step wizard (feature code → preview → confirm).
- **useIdeaboxStore.js (new):** Zustand store with WS-driven hydration.
- ViewTabs registers ideabox tab; App.jsx routes it.
- 24 store tests.

**Batch 3 (Advanced + Integrations):**
- **Discussion threads:** parse/serialize, addDiscussion endpoint, CLI `compose ideabox discuss`, detail panel thread UI.
- **Effort/impact matrix:** schema fields with enum validation, IdeaboxMatrixView.jsx (2x2 scatter with quadrants, unassigned tray).
- **Graph integration:** GraphView "Ideas" toggle renders idea nodes as dashed amber circles connected to mapsTo features. Nodes carry status='idea' for handler compatibility.
- **Source analytics:** IdeaboxAnalytics.jsx — source breakdown bars, status funnel, cluster health.
- **Lifecycle integration:** build.js scans agent output for "we should/could" patterns, emits idea_suggestion stream events. AttentionQueueSidebar shows untriaged count. `compose new --from-idea <ID>` pre-populates intent.
- 20 additional tests (discussion, addDiscussion, effort/impact, resurrect).

**Codex fixes:** REST promote now creates feature folder (CLI parity), enum validation on effort/impact, idea graph nodes interactive, idea_suggestion events bridged to UI.

92 total tests, all passing.

### COMP-CTX: Ambient Context Layer (Wave 3)

- **compose init:** scaffolds `docs/context/` with tech-stack.md, conventions.md, decisions.md. Path configurable via `compose.json` `paths.context`.
- **step-prompt.js:** ambient context injected into every agent prompt as `## Project Context`. Cached per-build, invalidated after decision log append.
- **staleness.js:** `checkStaleness()` reads `<!-- phase: ... -->` markers from artifacts, flags stale files in gate context.
- **Decision log:** gate outcomes auto-appended to decisions.md with date, feature, step, outcome, rationale.
- 33 tests, all passing.

### COMP-CAPS-ENFORCE: Runtime Violation Detection (Wave 3)

- **result-normalizer.js:** `onToolUse` callback tap on tool_use events — passive, doesn't change event flow.
- **capability-checker.js:** `checkCapabilityViolation()` compares tools against agent template. Violation (disallowed) vs warning (not in allowedTools).
- **build.js:** violations checked in both main loop and child flow steps. Logged to stream + console.
- **settings-store.js:** `capabilities.enforcement` setting — `log` (default) or `block`. Block mode fails the step on violation.
- 11 tests, all passing.

### COMP-TEST-BOOTSTRAP: Test Framework Bootstrap (Wave 3)

- **test-bootstrap.js:** `detectTestFramework()` checks config files + package.json deps. `scaffoldTestFramework()` creates vitest/jest/pytest/go/rust test setup.
- **build.js:** before coverage step, detects framework; if missing, scaffolds then annotates step intent for golden flow generation.
- **Ship step:** uses detected test command instead of hardcoded `npm test`.
- 25 tests, all passing.

### COMP-OBS-SURFACE + COMP-OBS-STREAM (Wave 3)

- **OBS-SURFACE:** Items 146, 148, 150 already implemented. Item 192 (live budget counters): OpsStrip shows "review 3/5, 2:34/15:00" during active iterations with live elapsed timer.
- **OBS-STREAM:** Items 145, 151-152 already implemented. Bridge mapping, ToolResultBlock, verbose gating all in place.

### COMP-UX-3: Workflow Approachability (Wave 3)

- **Scaffold defaults (137):** `compose feature` detects language, test framework, counts existing features. Pre-populates profile in feature.json (needs_prd, needs_architecture, etc.).
- **Conversational gates (138):** `buildRecommendation()` derives 1-sentence summary + recommended action from artifact assessment. Enter key defaults to recommendation. "d" shows full details. Web UI RecommendationBadge above gate actions.
- **Status narration (139):** 1-line console summaries after each step, gate resolution, and iteration. Full detail still in stream events.

### STRAT-REV-7: Cross-Model Adversarial Synthesis (Wave 2)

- **review-lenses.js:** `classifyDiffSize()` (small/medium/large by file count) and `shouldRunCrossModel()` gate.
- **build.js:** `runCrossModelReview()` — after Claude lenses complete on large diffs (≥9 files), dispatches Codex review, parses string findings, runs Claude synthesis agent to classify CONSENSUS/CLAUDE_ONLY/CODEX_ONLY. Fail-open: Codex errors return original result.
- **Opt-out:** `opts.skipCrossModel`, `COMPOSE_CROSS_MODEL=0` env var, graceful skip when Codex unavailable.
- No pipeline YAML changes — all orchestration in build.js.
- 29 tests (13 diff-size + 16 cross-model), all passing.

### COMP-DESIGN-2: Compose New Integration (Wave 2)

- Already implemented in prior session. `compose new` detects `docs/design.md`, appends to intent, skips questionnaire. Each pipeline step receives design doc via `$.input.intent`.

### COMP-BUDGET: Iteration Budget Enforcement (Wave 1)

- **vision-routes.js:** Wall-clock timeout enforcement (checked at each report, configurable per loop type), action count ceiling (accumulated from agent reports), auto-abort with structured outcomes (`timeout`, `action_limit`).
- **budget-ledger.js:** Cumulative cross-session budget tracking in `.compose/data/budget-ledger.json`. `recordIteration()` called from both report and abort routes. `checkCumulativeBudget()` blocks iteration start when cumulative limits exceeded (429).
- **settings-store.js:** Per-loop-type settings: `iterations.review.timeout` (15min default), `iterations.coverage.timeout` (30min), `iterations.review.maxTotal` (20), `iterations.coverage.maxTotal` (50).
- **visionMessageHandler.js:** Client handles `timeout` and `action_limit` outcomes with distinct messages.
- 15 tests, all passing.

### HOOK-CACHE: Read Cache Hook (Wave 1)

- **read-cache.py:** PreToolUse hook on Read. Per-agent mtime + line-range tracking. Blocks redundant reads of unchanged files with covered ranges. Merges overlapping intervals. Metrics to `stats.json`.
- **read-cache-invalidate.py:** PostToolUse hook on Edit/Write/MultiEdit. Invalidates cache entry for modified file.
- **read-cache-compact.py:** PreCompact hook. Clears entire session cache (context no longer has the content).
- **hooks.json:** Registered all three hooks, replacing old `read-cache.sh`.
- 15 tests, all passing.

### COMP-PLAN-VERIFY: Plan-Diff Verification (Wave 1)

- **plan-parser.js:** Agent-side helper — `parsePlanItems()` extracts checkbox items with file paths and critical flags, `matchItemsToDiff()` classifies done/missing/extra.
- **spec.py:** `plan_completion(plan_items, files_changed, threshold=90)` ensure builtin. Division-by-zero guard. Critical missing items → plain string violations. Below threshold → violation with percentage.
- **executor.py:** Registered `plan_completion` in ensure sandbox.
- **build.stratum.yaml:** Ship step ensure clause: `plan_completion(result.plan_items, result.files_changed)`. Ship step intent updated to instruct agent to extract plan items.
- 12 Python + 16 JS tests, all passing.

### STRAT-IMMUTABLE: Spec Immutability During Execution (Wave 1)

- **Stratum executor:** `spec_checksum` on FlowState — SHA-256 of parsed FlowDefinition computed at flow start, verified at every `stratum_step_done` and `stratum_parallel_done`. Detects in-memory spec mutation. Checksum persisted/restored across MCP restarts.
- **build.js Layer 2:** Pipeline file hash and policy hash captured at build start. `verifyPipelineIntegrity()` re-reads YAML from disk before each step transition — detects on-disk tampering. `verifyPolicyIntegrity()` hashes settings.json policies before gate resolution — detects gate criteria weakening.
- 9 Python tests + 7 JS tests, all passing.

### COMP-AGENT-CAPS: Agent Capability Profiles (Wave 1)

- **agent-templates.js:** 4 built-in profiles — `read-only-reviewer` (Read/Grep/Glob only), `implementer` (full access), `orchestrator` (no Edit/Write), `security-auditor` (Read/Grep/Glob/Bash).
- **agent-string.js:** Centralized `parseAgentString("claude:read-only-reviewer")` → `{ provider, template }` + `resolveAgentConfig()` for full resolution with tool restrictions.
- **claude-sdk-connector.js:** Accepts `allowedTools`/`disallowedTools`, passes to SDK. Falls back to `preset: claude_code` when no restrictions (backward compat).
- **build.js:** `defaultConnectorFactory` resolves agent string through template registry. Emits `capability_profile` stream events.
- **build.stratum.yaml:** Review sub-flow steps use `claude:orchestrator` (triage, merge) and `claude:read-only-reviewer` (lens dispatch).
- 28 tests, all passing.

### COMP-TRIAGE: Task Tier Classification (Wave 1)

- **triage.js:** Pure file analysis — counts paths in plan/blueprint, detects security/core paths, assigns tier 0-4 and build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`).
- **build.js integration:** Triage runs before `stratum_plan()`, mutates `skip_if` on skippable steps based on profile. Cached in feature.json with mtime-based invalidation.
- **CLI:** `compose triage <feature>` standalone command. `compose build --template <name>` and `--skip-triage` flags.
- No new pipeline templates — reuses existing `build.stratum.yaml` with `skip_if` toggling.
- 13 tests, all passing.

### COMP-DESIGN-1c: Live Design Doc (Wave 0)

- **DesignDocPanel.jsx** (new): Context panel component showing a live markdown preview of the design document as it builds from decisions. Preview mode (react-markdown + remark-gfm) and edit mode (monospace textarea). Manual edits survive across assistant turns. "Reset to auto-generated" rebuilds from current decisions.
- **designSessionState.js**: Added `buildDraftDoc(messages, decisions)` — constructs markdown draft from problem statement + active decisions + open threads. Added `buildTopicOutline(messages, decisions)` — extracts decided topics for the research sidebar.
- **useDesignStore.js**: New state fields (`draftDoc`, `docManuallyEdited`, `researchItems`, `topicOutline`). Draft rebuilds on each assistant turn unless manually edited. Manual edit state preserved across rehydration.
- **design-routes.js**: `POST /api/design/complete` accepts optional `draftDoc` body field — uses human-edited draft as seed for final LLM polish pass instead of generating from scratch.
- **App.jsx**: Context panel auto-shows DesignDocPanel when design view is active.

### COMP-DESIGN-1d: Research Sidebar (Wave 0)

- **DesignSidebar.jsx**: Added tab bar (Decisions / Research) with count badges. Existing decision log under Decisions tab. Research tab shows live research activity.
- **ResearchTab.jsx** (new): Three collapsible sections — Topic Outline (decided/open topics), Codebase References (Read/Grep/Glob tool uses with file paths), Web Searches (queries + summaries). Live updates as research events stream in.
- **design-routes.js**: Broadcasts `research` and `research_result` SSE events from `tool_use` and `tool_use_summary` events during design conversations. Unique `tu-N` IDs for reliable event correlation.
- **useDesignStore.js**: SSE handlers for research events with ID-based correlation. Research items accumulate across the full session.
- 38 design tests, all pass. 8 new test cases for `buildDraftDoc` and `buildTopicOutline`.

## 2026-03-28

### STRAT-REV: Parallel Multi-Lens Review (1-4, 6)

- **Stratum:** Added `isolation: "none"` to IR v0.3 schema (`spec.py`) for read-only parallel_dispatch tasks. 2 new tests.
- **Lens library:** `lib/review-lenses.js` — 4 lens definitions (diff-quality, contract-compliance, security, framework) with confidence gates and false-positive exclusions. `triageLenses()` activates lenses based on file patterns. 10 tests.
- **Pipeline:** `pipelines/build.stratum.yaml` — new contracts (LensFinding, LensTask, LensResult, TriageResult, MergedReviewResult), `parallel_review` sub-flow (triage → parallel lens dispatch → merge), main flow review step wired to `parallel_review`.
- **Build.js:** Review timeout bumped to 15min, added triage (2min) and merge (3min) timeouts. `isolation: "none"` path verified for read-only tasks.
- **Fix loop:** Parent-level ensure/retry drives the fix loop — ensure fails → build.js claude fix → whole sub-flow re-invoked with fresh triage/lenses/merge.
- STRAT-REV-5 (selective re-review) complete: sidecar `.compose/prior_dirty_lenses.json` written on review ensure_failed, triage reads it on retry. STRAT-REV-7 (cross-model synthesis) deferred.

### COMP-UI-6: Polish and Teardown

- Deleted dead components: `AppSidebar.jsx` (~120 lines), `ItemRow.jsx` (~960 lines)
- Cleaned `VisionTracker.jsx`: removed @deprecated tag, scoped to PopoutView only
- Consolidated 13 scattered JS color constants from 9 files into `constants.js`
- Wrapped 6 remaining UI zones in `PanelErrorBoundary` (NotificationBar, GateNotificationBar, ChallengeModal, CommandPalette, ItemFormDialog, SettingsModal)
- Removed 8 dead functions from `vision-logic.js` (kept `filterSessions`, `relativeTime`)
- Deleted 17 dead `--row-*` CSS variables and `.row-chevron` class from `index.css`
- Removed dead `expandAgentBar()` export from `agentBarState.js`
- Updated tests: removed dead function tests, all 46 remaining tests pass
- **COMP-UI feature complete** — all 6 items done

### COMP-AGT-1-4: Agent Lifecycle Control

- `server/agent-health.js`: HealthMonitor class — stdout+stderr liveness probes, 60s silence warning, 5min auto-kill, wall-clock timeout, memory RSS polling, terminal reason tracking
- `server/worktree-gc.js`: WorktreeGC class — .owner file ownership, orphan scanning, age-based pruning, git worktree remove + rm fallback
- `server/agent-spawn.js`: `POST /api/agent/:id/stop` (SIGTERM→grace→SIGKILL), `POST /api/agent/gc`, health monitor wiring, terminal state precedence
- `server/agent-server.js`: 5s interrupt escalation timer for SDK sessions
- `server/agent-registry.js`: getRunning() and updateStatus() methods
- `lib/build.js`: .owner file on worktree creation, disk quota check (500MB default)
- UI: kill button per agent tab, silence warning yellow dot, agentKilled terminal state
- 16 tests (agent-health: 10, worktree-gc: 6)

### COMP-PIPE-1-3: Pipeline Authoring Loop

- 4 new pipeline templates: bug-fix (6 steps), refactor (7), content (4), research (3)
- Metadata blocks on all 7 templates (id, label, description, category, steps, estimated_minutes)
- `server/pipeline-routes.js`: template listing, spec fetch, draft CRUD with draftId concurrency, approve/reject with safe lifecycle
- `lib/build.js`: template selection via `opts.template`
- Store: `pipelineDraft` state + WS handlers for `pipelineDraft`/`pipelineDraftResolved`
- `TemplateSelector.jsx`: template card picker
- `PipelineView.jsx`: three modes — Empty (template selector), Draft (read-only + approve/reject), Active (existing)
- Version-aware step derivation (v0.1 flows + v0.3 workflow)
- Approved specs written to `.compose/data/approved-specs/` (not template library)
- 18 tests for pipeline-routes

### Phase 6.9: Agent Fleet Management — Roadmap

Added 17 items (COMP-AGT-1 through COMP-AGT-17) across 5 feature groups:
- Agent Lifecycle Control: interrupt, health monitoring, resource limits, worktree GC
- Agent Coordination: parent-child RPC, inter-task coordination, message ordering
- Merge & Recovery: conflict recovery strategies, graceful degradation with retry
- Registry & Observability: rich queries, structured metrics, dependency validation
- Agent Templates & Parent Skills: template library, capability registry, root parent
  orchestration skill, parallel dispatch skill, persistent state machine

### COMP-UX-11: Feature Event Timeline

- Collapsible right panel on Dashboard showing chronological feature lifecycle events
- 5 event categories: Phase, Gate, Session, Iteration, Error — each with distinct icons and severity colors
- Historical hydration from sessions.json + gates; live updates via WebSocket
- Virtualized scrolling (`@tanstack/react-virtual`) for large event histories
- Filter chips to narrow by event category
- Added client-side handlers for previously unhandled `lifecycleStarted` and `lifecycleTransition` WebSocket messages
- Gate outcome normalization handles both short-form (`approve`) and long-form (`approved`) variants
- New files: `timelineAssembler.js`, `EventTimeline.jsx`, `TimelineEvent.jsx`
- 11 unit tests for timeline assembler

## 2026-03-19

### Phase 4.5 Closed + Phase 6 Closed

**18h: Acceptance Gate (Phase 4.5)**
- Registered `agents` MCP server in `.mcp.json` — `agent_run` tool now discoverable
- Copied `review-fix.stratum.yaml` to `pipelines/` (was only in worktree)
- Fixed JSON code block extraction in `agent-mcp.js` schema mode
- Golden flow tests: 6 MCP protocol tests + live smoke test stubs
- `run-pipeline.mjs` script for end-to-end pipeline acceptance testing
- Phase 4.5 fully closed (all 18a–18h items COMPLETE)

**ITEM-23: Policy Enforcement Runtime**
- `evaluatePolicy()` pure function — reads per-phase policy modes from settings
- Build.js integration: skip (silent), flag (auto-approve + notify), gate (human approval)
- Gate records enriched with `policyMode` and `resolvedBy` fields
- Settings loaded lazily from disk at build start
- 10 unit tests + 2 Stratum integration tests (skip + flag paths verified e2e)

**ITEM-24: Gate UI Polish**
- `resolvedBy` badge on resolved gates (human vs auto-flag/auto-skip)
- Full gate history (replaces "Resolved Today" — last 10, expandable to 50)
- Prior revision feedback displayed on re-gated pending gates
- Handles both normalized outcome forms (approve/approved, revise/revised)

**ITEM-25a: Subagent Activity Nesting**
- `AgentRegistry` class — persistent parent-child tracking of spawned agents
- `agent-spawn.js` registers with registry, derives agentType from prompt heuristics
- `agentSpawned` WebSocket event broadcast on spawn
- `GET /api/agents/tree` returns hierarchy for current session
- AgentPanel "Subagents" section: pulsing dot for running, check/X for complete
- 11 unit tests for AgentRegistry

**ITEM-26: Iteration Orchestration**
- 3 REST endpoints: `iteration/start`, `iteration/report`, `iteration/abort`
- 3 MCP tools: `start_iteration_loop`, `report_iteration_result`, `abort_iteration_loop`
- Server-side exit criteria evaluation (review: clean==true, coverage: passing==true)
- Server-side max iteration enforcement (from settings: review=4, coverage=15)
- `iterationState` on item.lifecycle with full iteration history
- WebSocket broadcasts: iterationStarted/Update/Complete (client handler pre-existed)
- `coverage-sweep.stratum.yaml` pipeline
- 9 integration tests

**COMP-UI-6: Polish and Teardown**
- Deleted `compose-ui/` (old prototype), `SkeletonCard`, unused hooks
- Zone error boundaries on header, sidebar, ops strip, agent bar
- Migrated all legacy CSS token refs to modern `hsl(var(--*))` across 11 files
- Deleted legacy CSS token block from `index.css`
- Zero legacy token refs remaining in `src/`

## 2026-03-16

### COMP-DESIGN-1: Interactive Design Conversation

- **Design tab** in cockpit header — new view for interactive product design conversations with the LLM
- **Decision cards** — LLM presents options as clickable cards with recommendations; cards render from inline ` ```decision ``` ` JSON blocks in markdown
- **Design sidebar** — running decision log replacing AttentionQueueSidebar when Design tab is active; supports decision revision
- **Session management** — one session per scope (product or feature), persisted to `.compose/data/design-sessions.json`, survives page reloads
- **SSE streaming** — real-time LLM response streaming via session-scoped Server-Sent Events with in-flight dispatch guard
- **Design doc generation** — "Complete Design" action writes structured design doc to `docs/design.md` (product) or `docs/features/{code}/design.md` (feature)
- **`compose new` integration** — detects existing design doc and uses it as enriched intent, skipping the questionnaire
- **Security hardening** — prototype pollution protection, input validation, completed session guards, optimistic rollback

## 2026-03-15

### COMP-UX-1d: Ops Strip

- **OpsStrip component** (`src/components/cockpit/OpsStrip.jsx`): persistent 36px bar between main workspace and agent bar, surfaces active builds, pending gates, and recent errors as horizontally-scrollable pills
- **OpsStripEntry component** (`src/components/cockpit/OpsStripEntry.jsx`): pill component with design-token colors (blue/amber/red/green HSL), inline gate approve button, dismiss button for errors
- **Pure logic module** (`src/components/cockpit/opsStripLogic.js`): `deriveEntries()` and `filterRecentErrors()` — testable without React
- **recentErrors derived state** in `useVisionStore`: filters `agentErrors` to 60s window (max 5), recomputes on 10s interval for reactive aging
- **Entry animations**: slide-in on enter, flash green on build complete (2s), fade-out on dismiss
- **Visibility**: hidden when `activeView === 'docs'`, hidden when no entries
- **Build key uniqueness**: keyed by flowId/startedAt to prevent dismissal collision across builds for the same feature

## 2026-03-13

### STRAT-COMP-6: Web Gate Resolution

- **Gate enrichment**: CLI populates `fromPhase`, `toPhase`, `artifact`, `round`, and `summary` on gate creation
- **Shared constants** (`lib/constants.js`): canonical `STEP_LABELS`, `GATE_ARTIFACTS`, and `buildGateSummary()` — single source for CLI and frontend
- **GateView enhancements**: summary display, artifact link (opens canvas), build-gate prominence (amber border, larger buttons when `flowId` present), feature grouping by `itemId`, collapsible gate history with count badge
- **Imperative outcome vocabulary**: `approve`/`revise`/`kill` throughout GateView, ItemDetailPanel, and resolve calls (legacy past-tense keys retained as fallbacks in color maps)
- **`gateCreated` event**: renamed from `gatePending`; `visionMessageHandler.js` and tests updated
- **URL-encoded gate IDs**: `encodeURIComponent(gateId)` in `useVisionStore.js` resolve calls and `visionMessageHandler.js` fetch
- **Idempotent re-resolve**: `POST /api/vision/gates/:id/resolve` returns 200 on already-resolved gates instead of 400
- **StratumPanel gate link**: gate list replaced with "View gates in sidebar" link using `sessionStorage` + custom event for cross-panel navigation
- **VisionTracker listener**: responds to `vision-view-change` event to switch sidebar view

### STRAT-COMP-4: Vision Store Unification

- **Canonical port resolution** (`lib/resolve-port.js`): `COMPOSE_PORT > PORT > 3001` used by all components
- **Server probe** (`lib/server-probe.js`): lightweight health check with timeout for dual-dispatch routing
- **Dual-dispatch VisionWriter**: routes mutations through REST when server is up, writes directly to disk when down
- **featureCode migration**: legacy `featureCode: "feature:X"` auto-migrated to `lifecycle.featureCode` on load
- **Gate outcome normalization**: canonical `approve`/`revise`/`kill` enforced at all write boundaries
- **Atomic writes**: temp file + `renameSync` in both VisionStore and VisionWriter
- **AD-4 gate delegation**: server stores gate state and broadcasts events; CLI owns all lifecycle transitions
- **Gate expiry persistence**: expired gates written to disk so restarts don't resurrect them
- **55 integration tests** across 5 test files covering all unification behaviors

### STRAT-COMP-5: Build Visibility

- **Atomic `active-build.json`**: writes via temp file + rename, extended fields (stepNum, totalSteps, retries, violations, status, startedAt)
- **Terminal state retention**: completed/aborted builds retain `active-build.json` on disk (overwritten on next build start)
- **`buildState` WebSocket handler**: `visionMessageHandler.js` handles `buildState` messages, updates `activeBuild` state
- **File watcher extension**: server watches `.compose/` directory for `active-build.json` changes

### STRAT-COMP-7: Agent Stream Bridge

- **`BuildStreamWriter`** (`lib/build-stream-writer.js`): appends JSONL events to `.compose/build-stream.jsonl` with monotonic `_seq` and ISO timestamps
- **`BuildStreamBridge`** (`server/build-stream-bridge.js`): watches JSONL file, maps CLI events to SSE-compatible shapes, broadcasts to AgentStream
- **Build instrumentation**: `build.js` creates `BuildStreamWriter` after plan/resume, writes `build_start`, `build_step_start`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error`, and `build_end` events
- **Crash detection**: bridge emits synthetic `build_end(crashed)` after configurable timeout during active step
- **27 tests** covering writer, bridge, event mapping, crash detection, and stale file handling
