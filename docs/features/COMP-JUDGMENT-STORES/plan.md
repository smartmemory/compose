# COMP-JUDGMENT-STORES — Implementation Plan

**Status:** PLAN
**Date:** 2026-07-23
**Design:** [design.md](design.md) (GATED r12) · **Blueprint:** [blueprint.md](blueprint.md) (BINDING — Corrections Table C1–C15 override any conflicting prose)

Tasks map 1:1 to design slices S1–S6; the blueprint's per-slice notes carry the
file:line patterns and test idioms. TDD per task: write the slice's failing tests
first, implement to green, never weaken an assertion. Sequential — each task
consumes the previous task's symbols (Boundary Map backward edges).

## T1 — Contracts (S1)

Files: `contracts/judgment-record.schema.json` (existing), `lib/judgment/schema.js` (existing), `test/judgment-schema.test.js` (existing)

- [ ] `person` / `situation_entity` / `goal_version` / `goal_state` record defs; two CLOSED fact schemas (`person_fact`, `situation_fact`) sharing per-property definitions (Draft-07 — no allOf merge); base-field parity contract test
- [ ] Universal sub-entry ids, `removed` blocks, unified trace shape, fill/reopen traces; clause sub-schema with elicitation citation
- [ ] Intent schema gains required `kind`, `tool`, `op` (C2/C3); attestation ledger-event shape (writer-reserved, caller-forgery rejected)
- [ ] `provenance.via: "migration"` + optional `provenance.intent_id`; `rests_on` on ledger events (C6); `ratification`/`provocation` (nullable under migration/import)

## T2 — Store + effective view (S2)

Files: `lib/judgment/store/records.js` (existing), `lib/judgment/store/index.js` (existing), `test/judgment-store.test.js` (existing)

- [ ] People/situation aggregate accessors; `goal/state.json` sidecar persistence
- [ ] Parameterized chain primitive (C4) — position wrappers unchanged, goal `v<N>` wrappers on it
- [ ] Writer-owned lock-protected high-water ID allocator per record+prefix, duplicate → `JUDGMENT_CONFLICT`, no reuse (C5)
- [ ] `effectiveStore(store)` adapter — pending-intent snapshot filters files + ledger lines; derived status reimplemented on filtered reads (C7); `goalCutoverComplete` predicate helper
- [ ] `clearIntent` idempotent only for ENOENT, rethrows otherwise (C15)

## T3 — Person + situation writer ops (S3)

Files: `lib/judgment-writer.js` (existing), `lib/judgment-write-guard.js` (existing), `test/judgment-writer.test.js` (existing)

- [ ] `judgment_person_write`: create · add_fact · correct · open_field · edge · load_link (+ remove/reopen variants, `pair_with`/`clear`)
- [ ] `judgment_situation_write`: create · add_fact · correct · owed · load_link (+ remove/reopen)
- [ ] Invariants 1, 2, 5, 6 as prechecks with designed codes; nested provenance from allowlisted scalars only (C10); UndoLog `capture`/`created` refactor (C9)
- [ ] Rejection tests assert code + message per acceptance-criteria rows; person/situation golden flows

## T4 — Goal ops + intent publication (S4)

Files: `lib/judgment-writer.js` (existing), `test/judgment-writer.test.js` (existing), `test/judgment-guard-integration.test.js` (existing)

- [ ] `judgment_goal_write`: cut (ratification citation) · correct (wording, traced) · joint_link · load_link (sidecar, traced removes)
- [ ] Invariants 3, 4, 7 (effective/pending predicate + error-code precedence); migration-intent fencing (`JUDGMENT_INTENT_PENDING`)
- [ ] Intent publication redesign (C1): shared `publishIntentLocked` helper — apply → attest (deduped `{intent_id, tool, op}`) → clear (= publication) → regen; post-publication regen failure surfaces as projection-stale, never rolls records back
- [ ] Typed intent-kind fail-closed replay dispatch (C2): `transition` handled; reserved kinds blocked-in-place; unknown kinds retained + typed error
- [ ] `rests_on` resolution through the effective chain in `execute` (C6); crash-window/kill-mid-write replay tests; attestation-before-clear ordering tests (C14)

## T5 — Projections (S5)

Files: `lib/judgment-gen.js` (existing), `test/judgment-gen.test.js` (existing)

- [ ] `people/<slug>.md`, `SITUATION.md` — audit-complete per-fact rendering (channel, via, at, visible correction lines), full edge/open/owed/load state
- [ ] `OBJECTIVE.md` dual-read via `goalCutoverComplete` — full audit surface (elicitation + ratification citations, joints, load-link bill, trajectory with diff_note + wording marks); legacy suppression + orphan pruning post-cutover (C8)
- [ ] Generator reads exclusively through `effectiveStore`; pending-intent tombstone does not flip derived status (test)
- [ ] `get_judgment_state.counts` typed shape; fixed-point + hand-edit-overwrite tests

## T6 — MCP registration + e2e (S6)

Files: `server/compose-mcp.js` (existing), `server/compose-mcp-tools.js` (existing), `server/mcp-tool-policy.js` (existing), `test/judgment-writer-mcp.test.js` (existing)

- [ ] Three shim imports + definitions + dispatch cases — assert 49/49 and nine judgment tools (C11); no `.mcp.json`/`package.json` edits (C12)
- [ ] Policy: comment fix only, no allowlist entries; policy test literal + reviewer-denial assertions for all three (C13)
- [ ] MCP e2e golden flow exercises all three tools over the real transport

## Exit gates (Phase 7, all four required)

1. All tasks green, full suite green (`npm test`, `--test-timeout=90000` for the proof-run hang)
2. MCP e2e smoke green
3. Codex review loop (sol/xhigh) on the implementation until REVIEW CLEAN (max 5)
4. Coverage sweep until TESTS PASSING

Canon-manifest handoff rows land in the blueprint/design only (COMP-CANON-GUARD
consumes them); no guard code in this feature.

## Files Summary

| File | Tasks |
|------|-------|
| `contracts/judgment-record.schema.json` (existing) | T1 |
| `lib/judgment/schema.js` (existing) | T1 |
| `lib/judgment/store/records.js` (existing) | T2 |
| `lib/judgment/store/index.js` (existing) | T2 |
| `lib/judgment-writer.js` (existing) | T3, T4 |
| `lib/judgment-write-guard.js` (existing) | T3 |
| `lib/judgment-gen.js` (existing) | T5 |
| `server/compose-mcp.js` (existing) | T6 |
| `server/compose-mcp-tools.js` (existing) | T6 |
| `server/mcp-tool-policy.js` (existing) | T6 |
| `test/judgment-*.test.js` (existing) | T1–T6 |
