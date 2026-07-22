# COMP-JUDGMENT-WRITER — Implementation Plan

**From:** [blueprint.md](blueprint.md) (Phase 5 verified — Corrections Table is BINDING; code against corrected refs, not the assumption table). Slices execute in Boundary Map order S01→S07; TDD per task (test first, watch fail, implement, watch pass). Tests: `node --test test/<file>`.

## T1 — S01: contract + schema loader

- [ ] Write `contracts/judgment-record.schema.json`: definitions for `position_revision` (claims[]{id,text,grounding,supports[]}, conviction{level,source}, rejected_alternatives[], supersedes `<slug>#r<N>` pattern, retracted?, provenance), `joint` (branches REQUIRED, cost enum exactly hours|days|weeks|months, state enum, resolve_by enum, ext/straddle packages, resolution outcome enum exactly resolved|inconclusive|failed_to_run|superseded, dissolution artifact, flags), `prediction`, `ledger_event` (kind-specific required fields incl. commit-decide trigger+open_joints+prediction, postmortem recall_verdict+attribution, override reason, CONSTRUCT prediction), `pending_intent`. Provenance block: actor const 'agent', session nullable, written_at, via enum ['import'] optional; elicitation block shape for ASSERT grounding.
- [ ] `lib/judgment/schema.js`: `JUDGMENT_SCHEMA_PATH` (const), `getJudgmentValidator()` memoized → `new SchemaValidator(JUDGMENT_SCHEMA_PATH)` (A6 corrected: class, instantiate; definitions path needs `$id`).
- [ ] Test first: `test/judgment-schema.test.js` — valid/invalid fixture per definition; MUST include: ASSERT-without-elicitation invalid; minutes cost invalid; single-branch joint invalid; outcome 'dissolved' invalid; owner-locked grounding invalid everywhere.

## T2 — S02: records store + registry

- [ ] `lib/judgment/store/records.js` `RecordsStore(cwd)`: revision-chain reads/writes (`docs/judgment/records/positions/<slug>/r<N>.json`), joints, predictions, `appendLedgerEvent` (JSONL), intent persist/read/clear. ALL writes atomic via `${path}.tmp.${process.pid}` + rename (A3 corrected — feature-json idiom, NOT journal-writer's). Derived position status helper (supersedes-refs / tombstone / live) lives here.
- [ ] `lib/judgment/store/index.js`: `createJudgmentStore(cwd)` reads `.compose/compose.json#judgment.provider` (default `'records'`); `'smartmemory'` throws `NOT_IMPLEMENTED` AT SELECTION (A11 corrected — no stub object); `capabilities()` is a backend method; records backend returns empty enrichment set.
- [ ] Test: chain append/derive-status; provider default; NOT_IMPLEMENTED throw; atomicity (tmp file never left behind on injected failure).

## T3 — S03: write guard (pure leaf)

- [ ] `lib/judgment-write-guard.js`: `JudgmentWriteValidationError{kind,violations}`; `assertValidRecord` (schema); `assertGrounding` (ASSERT⇒elicitation block; owner-locked ⇒ refuse unless `via:'import'`); `assertEdgeArtifact` (the design's edge→artifact table verbatim, incl. re-dispose input, dissolution artifact, no free under_test→open); `assertMethodGate` (EXT sharpened-or-judgment-dispatch; STRADDLE signal+kill-criteria; SILENT⇒inconclusive only). Import discipline mirrors `feature-write-guard.js:20-23` (A7 corrected).
- [ ] Test: one refusal case per rule; error `kind` values asserted.

## T4 — S04: projections

- [ ] `lib/judgment-gen.js`: `regenerateProjections(cwd)` — records → `REGISTER.md`, `LEDGER.md`, `OBJECTIVE.md`, `positions/<slug>.md`, bundle `index.md`. Per-item files carry OKF frontmatter (type, title, timestamp; `resource` ONLY when `provider_ids.smartmemory` exists; `smartmemory:{reference:true,origin:'compose-projection'}`); bundle root carries `okf_version: "0.1"` and then `type` is optional (A15 corrected). Pure `generateFromRecords(records, {now})` core, injectable `now`; `checkProjectionRoundtrip` = regen-of-own-output is byte-identical. NO preserved sections — note records render curated prose.
- [ ] Test: fixed-point; hand-edit overwritten; OKF frontmatter parses (fence, type rules, no literal `/` in emitted item ids).

## T5 — S05: writer (the core)

- [ ] `lib/judgment-writer.js`: six ops per design Decision 4. MUST: validate inputs sync BEFORE `maybeIdempotent`-style wrapper (A1/A4); own advisory lock dir `.compose/data/judgment.lock` (A2 recipe); transitions intent-first (persist complete mutation, then `guardedTransition(...)` when `capabilities.guard` — code against `{applied, refused?, verdict, ledgerRef, currentState}` and `{applied:false,error}` (A12 corrected) — then apply + clear intent); `replayPendingIntents` on every write + `getJudgmentState`; ONE-UNDER-TEST inside the lock (probe guard predicate expressibility once, note result in report); rank change ⇒ atomic `rank` event; CONSTRUCT/commit events spawn predictions; postmortem grades them; position create/supersede/amend = new immutable revision (amend delta restricted to grounding/conviction); audit `appendEvent(cwd,{tool:'judgment_*',...})` best-effort AFTER commit (A5); results small (AUDIT-19); errors `code`/`cause` (`JUDGMENT_PARTIAL_WRITE` on compensated rollback).
- [ ] Golden flow test FIRST (`test/judgment-writer.test.js`): P1→P7 of the process manual through the writer API against `freshCwd()` — position with cited-ASSERT claim, joints (one EXT blocked unsharpened, refused under_test; one CONSTRUCT with prediction), ONE-UNDER-TEST refusal, resolve, inconclusive→re-dispose, P4 commit-decide (trigger+open_joints+prediction), P6 amend grounding downgrade + reopen, P7 postmortem grading the prediction; projections regenerate fixed-point after every op. Plus kill-between-steps intent-replay test.

## T6 — S06: MCP surface

- [ ] FOUR sites per tool (A8 corrected): shim import (`compose-mcp.js:~30`), TOOLS entry, dispatch case, shim export (`compose-mcp-tools.js`). Six tools: `judgment_position_create|judgment_position_amend|judgment_joint_add|judgment_transition|judgment_ledger_append|get_judgment_state`. Terse schema descriptions (token budget note in compose-mcp.js header).
- [ ] `server/mcp-tool-policy.js`: `get_judgment_state` → REVIEWER_ALLOW; write tools rely on default reviewer-deny.
- [ ] E2E test (`test/judgment-writer-mcp.test.js`): McpClient + `COMPOSE_TARGET` (A9/A14); golden-lite through tools; forbidden-tag rejection with import/override paths named in message; reviewer-policy assertions; error code passthrough.

## T7 — S07: importer + cutover

- [ ] `bin/judgment-import.js` `runJudgmentImport(cwd,{dryRun})`: parse current `REGISTER.md`/`LEDGER.md`/`positions/*.md`/`OBJECTIVE.md` → writer calls with `via:'import'` (owner tags preserved; minutes→hours with note; curated banners → note records with anchors). Dry-run prints diff of regenerated projections vs current files.
- [ ] Test on fixture copies of the real files (A14 fixture pattern).
- [ ] CUTOVER (human-gated): run import on live repo, regenerate, present diff to owner, single commit (records + projections + importer + CHANGELOG entry). ROADMAP status via `set_feature_status`.

## Exit gates (Phase 7 steps 2–4)

- [ ] Full suite green (`npm test` — note proof-run hang: `--test-timeout=90000` if needed)
- [ ] Codex review loop on the diff until REVIEW CLEAN (sol/xhigh per standing directive)
- [ ] Coverage sweep until TESTS PASSING
- [ ] E2E: MCP server boots with the six tools listed; `get_judgment_state` returns post-import state

**Deliberately deferred:** W4 enrichment (own blueprint); SmartMemory RFC items 1–3 (filed in SmartMemory repo when W4 starts); epic S4–S6 enforcement.
