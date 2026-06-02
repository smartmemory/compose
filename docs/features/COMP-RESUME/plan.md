# COMP-RESUME: Implementation Plan

**Status:** PLAN
**Blueprint:** `docs/features/COMP-RESUME/blueprint.md`
**Contract:** `contracts/checkpoint.schema.json`
**Execution:** TDD per slice (`node:test`). Leaf units delegated to parallel subagents (disjoint files); orchestration + integration owned by lead.

## Execution waves

**Wave 0 (lead, foundational):**
- [ ] S1 `contracts/checkpoint.schema.json` (new) — draft-07; `$defs` EnvFingerprint + Checkpoint; `_source`/`_roadmap`.

**Wave 1 (parallel subagents, disjoint files, TDD):**
- [ ] **Unit A — environment capture:** `lib/checkpoint/git.js`, `lib/checkpoint/atomic.js`, `lib/checkpoint/fingerprint.js` (+ `test/checkpoint-fingerprint.test.js`, `test/checkpoint-classify.test.js`).
  - `git(cwd,args)` spawnSync wrapper (pattern `bug-bisect.js:56`); `head/branch/porcelain/dirtyHash`.
  - `writeAtomic/appendJsonl/readJsonl/readLastJsonl`.
  - `captureFingerprint(cwd,{featureDir,flowId,dataDir})`; `classify(prev,curr)` pure → `clean|advanced|diverged`.
- [ ] **Unit B — store:** `lib/checkpoint/store/index.js`, `lib/checkpoint/store/jsonl.js` (+ `test/checkpoint-store.test.js`).
  - `createCheckpointStore(backendId,{dataDir})`; registry: `jsonl`→impl, `smartmemory`→throws NOT_IMPLEMENTED (seam, mapping in comments), `memory-pointer`→seam.
  - base `write/readLatest/list/capabilities`; jsonl feature-scoped `checkpoints-<code>.jsonl`, idempotent on `id`.
- [ ] **Unit C — text:** `lib/checkpoint/prompts.js`, `lib/checkpoint/render.js` (+ `test/checkpoint-prompts.test.js`).
  - `scribePrompt`, `reconcilePrompt` (return-only-JSON, anchor-referencing).
  - `renderCheckpoint(cp)` → markdown.

**Wave 2 (lead, orchestration, TDD):**
- [ ] S7 `lib/checkpoint/anchor.js` (new) — `captureAnchor(...)` best-effort, never throws.
- [ ] S8 `lib/checkpoint/reconciler.js` (new) — `reconcile(...)`: rebuild derived state, backfill phaseHistory, classify, agent-sync on diverge, gate on low confidence. `ReconcileResult`.
- [ ] `test/integration/checkpoint-resume.integration.test.js` (golden), `test/checkpoint-anchor.test.js` (best-effort), `test/checkpoint-contract.test.js`.

**Wave 3 (lead, integration to existing files):**
- [ ] S9 `lib/checkpoint/checkpoint-writer.js` (new) + `server/compose-mcp-tools.js` (extend) + `server/compose-mcp.js` (extend): tools `write_checkpoint`, `compose_resume`.
- [ ] S10 `server/vision-routes.js` (extend): `captureAnchor` after advance:275 / skip:305 / kill:334 / complete:363 / iteration report:496 / abort:581 / gate resolve:755 (best-effort, behind `checkpoint.enabled`). `server/session-routes.js` (extend): `POST /api/session/bind/reconcile`.
- [ ] S11 `.compose/compose.json` + default-config: `checkpoint:{enabled,backend,confidenceThreshold}`.

**Wave 4 (lead, gates):**
- [ ] `npm test` full suite green.
- [ ] Codex review loop until REVIEW CLEAN.
- [ ] Coverage sweep until TESTS PASSING.
- [ ] Docs (CHANGELOG, README/CLAUDE if needed), report, ship.

## Acceptance criteria
- [ ] All new checkpoints validate against `checkpoint.schema.json`.
- [ ] `classify` returns correct class for clean/advanced/diverged fixtures.
- [ ] Golden: anchors written across phases → kill → `reconcile` resumes at correct nextStep (real git, real jsonl).
- [ ] Anchor writes are best-effort: a throwing store never breaks the build path.
- [ ] `smartmemory` backend id is registered but throws `NOT_IMPLEMENTED` (seam intact, no SDK dep).
- [ ] Reconcile gates only when confidence < threshold or irreconcilable; clean/advanced auto-resume.
- [ ] Full `npm test` suite passes (not just targeted).
