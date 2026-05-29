# COMP-ROADMAP-RT — Deterministic Roadmap Roundtripping: Implementation Report

**Status:** REPORT
**Date:** 2026-05-29

## Summary

Delivered a proven fixed-point + lossless roundtrip guarantee for ROADMAP.md generation, enforced at write time and surfaced through validation and the CLI. The core is a pure `checkRoundtrip(baseText, features, opts)` primitive consumed by three surfaces (write-time guard, `roadmap check`, `validate_project`), backed by a single canonical feature-code regex and a deterministic generator clock. Implemented across 8 TDD tasks via subagent-driven development with per-task spec + code-quality review; full suite stayed green throughout (final: node 2802, UI 139, tracker 100, 0 fail).

## Delivered vs Planned

| Planned | Delivered | Notes |
|---------|-----------|-------|
| Canonical `isFeatureCode` predicate | ✅ `lib/feature-code.js` | Task 1 |
| Fix parser trailing-`-\d+` bug; unify regex | ✅ `lib/roadmap-parser.js` | Task 2 — **recovered 63 live feature codes** previously misclassified as anonymous (whole `COMP-MCP-*` family, `STRAT-IMMUTABLE`, etc.) |
| Preservers share canonical regex | ✅ `lib/roadmap-preservers.js` | Task 3 — no-behavior-change dedup |
| Deterministic `now` clock + `suppressDrift` | ✅ `lib/roadmap-gen.js` | Task 4 |
| `checkRoundtrip` primitive (fixed-point + lossless) | ✅ `lib/roadmap-roundtrip.js` | Task 5 — aggregate-by-code losslessness, anon-exclusion |
| Validator findings | ✅ `lib/feature-validator.js` | Task 6 — `HIERARCHY_DEPTH_INVALID`, `ROUNDTRIP_NOT_FIXED_POINT`, `ROADMAP_LOSSY`, `ORPHAN_PHASE` (+ active-status error escalation) |
| Write-time pre-commit guard | ✅ `lib/feature-writer.js` | Task 7 — local-provider only; `force` exposed on `add_roadmap_entry` schema |
| CLI `roadmap check` + convergent `generate` | ✅ `bin/compose.js` | Task 8 — hardened existing subcommands; shared lossy-diff humanization |

## Architecture Deviations

- **CLI surface:** the plan/design initially imagined `--check`/`--write` flags; implementation hardened the **existing** `roadmap check` and `roadmap generate` subcommands instead (they already existed). No new flags/subcommands.
- **Parser parity (Decision 3 caveat):** unified the *regex* only. The validator's broader-header scan was NOT collapsed onto `parseRoadmap()` — left as-is per the design's fallback.
- **ORPHAN_PHASE escalation:** design wording said "row under it carries active status"; since orphan phases have no backing rows, the implemented signal is the **heading's own** status token (`readPhaseOverrides`). Design doc reconciled.

## Key Decisions

- **Write-time guard is local-provider only** (`provider.name() === 'local'`); remote/GitHub render server-side, out of scope.
- **Guard gates on `!fixedPoint` only, not `lossless`** — a non-fixed-point view visibly churns (user-facing breakage worth blocking); losslessness is the validator's job. Full `RoundtripResult` is still returned for inspection.
- **`now: '0000-00-00'` sentinel** in validator/guard/CLI-check — only two-pass internal consistency matters there; `readPreamble` preserves the real date verbatim once a file has headings, so the sentinel never leaks.
- **One shared `LOSSY_LABELS`/`describeLossyDiff`** exported from `roadmap-roundtrip.js`, consumed by both validator and CLI so user-facing wording can't drift.

## Test Coverage

- `checkRoundtrip`: fixed-point (idempotent/divergent/boundary), lossless MISSING/EXTRA/CHANGED, anon-exclusion, sub-item aggregation.
- Validator: each new finding kind + a **clean-project false-positive guard** (no findings on a healthy project) + ORPHAN error-escalation.
- Write guard: convergent mutation succeeds + `roundtrip` exposed on return.
- CLI: generate→check golden path (exit 0) + ghost-row drift (exit 1 + diagnostic).
- **Gaps (tracked, non-blocking):** no CLI-level test of the `generate` canonicalize branch or a non-convergent `force` bypass — synthesizing a non-convergent mutation is impractical; the convergence logic is unit-covered in Task 5.

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `lib/feature-code.js` | modify | `isFeatureCode` predicate (canonical source) |
| `lib/roadmap-parser.js` | modify | consume canonical regex; fix trailing-`-\d+` bug |
| `lib/roadmap-preservers.js` | modify | consume canonical regex |
| `lib/roadmap-gen.js` | modify | `now` clock + `suppressDrift` |
| `lib/roadmap-roundtrip.js` | new | `checkRoundtrip` + `LOSSY_LABELS`/`describeLossyDiff` |
| `lib/feature-validator.js` | modify | 4 new findings; shared label map |
| `lib/feature-writer.js` | modify | pre-commit guard helpers + wiring |
| `bin/compose.js` | modify | roundtrip-backed `check`; convergent `generate` |
| `server/compose-mcp.js` | modify | `force` on `add_roadmap_entry` inputSchema |
| `test/*` | new/modify | feature-code, parser, preservers, checkroundtrip, validator, writer, cli-roadmap-rt |

## Known Issues / Live Findings (running `compose roadmap check` on the live compose ROADMAP.md)

The tool works and immediately surfaced real state. **The fixed point HOLDS** (no `FIXED_POINT_DIVERGENCE`). Losslessness findings:

1. **2 genuine status drifts** on feature.json-backed features — actionable now:
   - `COMP-MCP-MIGRATION-2-1`: feature.json `PARTIAL` vs roadmap `COMPLETE`.
   - `COMP-MCP-MIGRATION-2-1-1-1`: feature.json `PLANNED` vs roadmap `COMPLETE`.
2. **1 parser robustness bug (false drift)** — `COMP-PARITY-1`: its description cell contains unescaped pipes (`--approve|--revise [--comment]|--kill`), so the markdown-table parser mis-splits columns and reads a description fragment as the status. Routed to **COMP-ROADMAP-RT-GENFIX**.
3. **~200 "not backed by feature.json" (`LOSSLESS_EXTRA`)** — 80 feature.json dirs vs ~280 typed roadmap rows. 46 are external `STRAT-*` (live in the stratum repo); the remainder are pre-feature.json-migration historical rows. This is the partial-migration reality, not a code bug — but it means **`roadmap check` currently exits 1 on the live project**, dominated by external + historical rows.

**Open product decision (surfaced from real data, not visible at design time):** how should `check`/`validate` treat unbacked rows? Options: (a) honor `external_prefixes` (e.g. `STRAT-`) like the validator already does, and treat remaining historical rows as a non-failing warning; (b) migrate historical rows to feature.json (`compose roadmap migrate`); (c) keep EXTRA as a hard failure. This should be decided before `roadmap check` is wired as a CI gate. Filed for follow-up.

## Lessons Learned

- The parser trailing-`-\d+` bug had real blast radius (63 dropped codes) — unifying the regex was load-bearing, not cosmetic.
- Running the new check against real data is where the feature proved its worth (caught 2 drifts + a parser bug) and where the next requirement (external-prefix awareness) revealed itself. Design-time reasoning could not have surfaced the 200-unbacked-row reality.
- Subagent review caught two contract gaps a happy-path implementation missed: the unreachable `force` escape hatch on `add_roadmap_entry`, and the user-facing wording drift between CLI and validator.

## Follow-ups

- **COMP-ROADMAP-RT-GENFIX** — parser/gen lossiness defects (SKIP_STATUSES override rewriting sub-item rows; malformed-code non-convergence; **+ unescaped-pipe-in-description-cell misparse**).
- **COMP-ROADMAP-XREF-SYNC** — external cross-reference reconciliation (deferred from this scope).
- **EXTRA-handling decision** (above) — external-prefix awareness / EXTRA-as-warning before CI gating.
- Other modules (`journal-writer`, `changelog-writer`, `completion-writer`, `xref-citation`, `feature-writer`) still carry their own local `FEATURE_CODE_RE` copies (all the strict pattern) — out of scope here; candidate for a DRY sweep.
