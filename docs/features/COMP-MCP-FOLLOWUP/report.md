# COMP-MCP-FOLLOWUP — Implementation Report

## Summary

Shipped `propose_followup` MCP tool — an orchestrator that files a numbered
follow-up feature against a parent. Auto-allocates `<parent>-N`, adds the
ROADMAP row, links `surfaced_by` from new → parent, and scaffolds
`design.md` with a `## Why` rationale block. Retry-safe via an inflight
ledger keyed by `(parent_code, idempotency_key)` and a per-parent file lock
guarding allocation.

## Delivered vs Planned

| Item | Status |
|---|---|
| Tool `propose_followup` registered, schema-validated | ✓ |
| Auto-numbering `<parent>-N` | ✓ |
| Surfaced-by link new → parent | ✓ |
| Scaffold + rationale insertion atomic with rollback | ✓ |
| Idempotency: namespaced cache + inflight ledger | ✓ |
| Per-parent file lock + 5 s timeout (`FOLLOWUP_BUSY`) | ✓ |
| Validation envelopes (`INVALID_INPUT`, `PARENT_NOT_FOUND`, `PARENT_TERMINAL`) | ✓ |
| Partial-write envelope (`PARTIAL_FOLLOWUP` with `stage`) | ✓ |
| Audit event via `appendEvent` (best-effort) | ✓ |
| Unit tests (26) + MCP wrapper smoke tests (2) | ✓ |

## Architecture Deviations

None. Implementation matches the design and blueprint, including the
codex-flagged refinements landed during review:

- Cache write happens *before* ledger delete (`proposeFollowup` deletes the
  ledger only after `checkOrInsert` returns) — crash-window safe.
- Resume-duplicate path on `addRoadmapEntry` "already exists" calls
  `writeRoadmap` and surfaces failures as `PARTIAL_FOLLOWUP` (does not
  silently swallow regeneration errors).
- Ledger filename hashes `${parent_code}:${key}` so cross-parent same-key
  partial states do not collide.

## Files Changed

New:
- `compose/lib/followup-writer.js` — orchestrator + helpers
- `compose/test/followup-writer.test.js` — 26 unit tests
- `compose/test/followup-writer-mcp.test.js` — 2 MCP smoke tests
- `docs/features/COMP-MCP-FOLLOWUP/{design,blueprint,report}.md`

Edited:
- `compose/server/compose-mcp-tools.js` — `toolProposeFollowup` wrapper
- `compose/server/compose-mcp.js` — tool definition + dispatch case
- `compose/CHANGELOG.md` — entry under 2026-05-04
- `compose/ROADMAP.md` — flip COMP-MCP-FOLLOWUP to COMPLETE

## Test Coverage

26 unit tests in `followup-writer.test.js`:
- Happy path (cold start, N+1, foreign-named-children skipped, phase
  inheritance, audit event)
- Validation (bad parent_code, empty rationale/description, bad complexity,
  bad status, parent not found, terminal-status parent)
- Idempotency (same-key replay, cache namespacing across parents,
  fingerprint mismatch on arg drift, no-key allocates fresh, crash window
  between cache and ledger delete, cross-parent ledger isolation)
- Internals (sha16 stability, nextNumberedCode gaps, fingerprint
  determinism)

2 MCP wrapper tests in `followup-writer-mcp.test.js`:
- `tools/list` exposes `propose_followup`
- End-to-end: seed parent + file follow-up + verify ROADMAP, design.md, link

Full suite: 2524 unit/integration + 92 UI = 2616 tests, all green.

## Known Limitations

Inherited from the underlying writers (`feature-writer.js`,
`feature-json.js`, `ArtifactManager`): the orchestrator assumes the
default `docs/features` feature root; repos that override `paths.features`
in `.compose/compose.json` are not yet honored consistently across all
writers. Not introduced by this feature; tracked separately.

## Lessons Learned

- The inflight-ledger pattern (write-before-mutate, per-stage advancement,
  rollback-on-failure) is reusable and might generalize to any writer that
  wants resume-across-failure semantics. If COMP-MCP-MIGRATION surfaces
  more orchestrators, consider hoisting it.
- Codex review caught three real correctness gaps (cache/ledger ordering,
  swallowed regen failure, cross-parent collision) that tests would not
  have flagged as wrong by themselves — they pass under "default" inputs.
  Worth keeping the review-loop tight on future orchestrators.
