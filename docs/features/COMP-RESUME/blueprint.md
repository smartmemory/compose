# COMP-RESUME: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-06-02
**Design:** `docs/features/COMP-RESUME/design.md`

## Corrections Table (spec assumption → verified reality)

| # | Design assumption | Reality (verified) | Resolution |
|---|---|---|---|
| C1 | Scribe/reconciler ship as `.claude/agents/*.md` | Compose has **no** `.claude/agents/` convention; agents run via connector `stratum.runAgentText('claude'\|'codex', prompt, {cwd})` (`lib/build.js:459-473`, `makeAskAgent`) | Scribe & reconciliation agents are **prompt builders** (`lib/checkpoint/prompts.js`) invoked through an injected `runAgent(prompt,{cwd})` fn. No agent files. Injectable → testable. |
| C2 | SmartMemory is a built backend | SmartMemory SDK is **not** a declared dep (`package.json`); user scoped it out of v1 | SmartMemory = **registered seam only**: factory throws `NOT_IMPLEMENTED` with the API mapping in comments. No SDK import. |
| C3 | Tests via vitest ("golden flow") | vitest is **UI-only** (`vitest.config.js` include `test/ui/**`); lib/server tests use `node:test` (`package.json` `test` script) | All COMP-RESUME tests use `node:test` + `node:assert/strict`, real fs via `mkdtempSync`, real git via `execSync`. Files: `test/*.test.js`, `test/integration/*.integration.test.js`. |
| C4 | Per-feature checkpoint files | Existing JSONL stores are **global with a `featureCode` field** (gate-log, feature-events) | Use **feature-scoped** files `checkpoints-<featureCode>.jsonl` — cleaner `readLatest`/`list`, and the explorer confirmed it's an accepted pattern. Still embed `featureCode` in each record. |
| C5 | "phaseHistory never populated" (memory note) | `lifecycle-phase-history.js` **is** the sole writer, called on advance/skip/kill | Gap is **resume-backfill only** (history isn't reconstructed after a crash from a prior session). Reconciler backfills; design wording refined. |
| C6 | Shared atomic-write helper | No shared helper; temp+rename is **copy-pasted per store** (`vision-store.js:132`) | Add one small shared helper `lib/checkpoint/atomic.js` used by the JSONL backend (no churn to existing stores). |
| C7 | Shared git helper exists | No shared git module; each lib wraps `spawnSync('git', …)` (`lib/bug-bisect.js:56`) | Write `lib/checkpoint/git.js` (thin `spawnSync` wrapper) following that pattern. |

## Boundary review (Codex, 2026-06-02)

A Codex review of the Boundary Map + integration points (run before wiring S7-S11) surfaced 5 actionable findings, all resolved here: (1) `buildStreamSeq` read the wrong root → fixed in `fingerprint.js` (composeDir) + Build-stream-path anchor; (2) reconciler couldn't persist → `reconcile` now returns `lifecycleMutations`, route persists (S8/S10); (3) agent connector is private in `build.js` → agent runs at the orchestrator, not via a build.js export (S9); (4) `loadProjectConfig` does not merge defaults → defaults applied explicitly at call sites (Config anchor); (5) `complete` (363) transition site restored to S10. `validateBoundaryMap` → ok, 0 violations.

## Verified anchors (Phase 5 inputs)

| Concern | File:line | Verified fact |
|---|---|---|
| Data dir | `server/project-root.js:49` | `getDataDir()` → `<target>/.compose/data` |
| Config | `server/project-root.js:109-119` | `loadProjectConfig()` returns the **raw** `.compose/compose.json` (NO merge with DEFAULT_CONFIG when the file exists — falls back to defaults only on read failure; see `lib/gsd.js:80`). **Apply `checkpoint.*` defaults explicitly at every call site.** |
| Build-stream path | `lib/build-stream-writer.js:28`, `lib/build.js:553` | `build-stream.jsonl` lives at `<composeDir>/.compose/build-stream.jsonl` — i.e. **`composeDir`, NOT `dataDir`** (`.compose/`, not `.compose/data/`). `captureFingerprint` derives `composeDir = dirname(dataDir)`. |
| Project switch | `server/project-root.js:65,74-88` | `onProjectSwitch(fn)` fires on `switchProject`; stores must re-resolve dataDir or accept it per call |
| Atomic JSON write | `server/vision-store.js:132-143` | temp `name.tmp.<ts>` → `renameSync` |
| JSONL append+read | `server/gate-log-store.js:46-102` | `appendFileSync(JSON+'\n')`, idempotent id-scan, malformed-line-tolerant read |
| Seq-on-resume | `lib/build-stream-writer.js:26-52` | read last line `_seq` to continue monotonically |
| Schema validation | `server/schema-validator.js:13-31` | `new SchemaValidator(path).validateRoot(obj)` (AJV draft-07) |
| Contract metadata | `contracts/judge-result.json:3-5` | `$schema` draft-07, `_source`, `_roadmap` |
| Phase-history writer | `server/lifecycle-phase-history.js:23-44` | sole writer `appendPhaseHistory(item,{from,to,outcome,timestamp})` |
| Phase transition sites | `server/vision-routes.js` advance ~275, skip ~304, kill ~329 | each calls `appendPhaseHistory` then `store.updateLifecycle` + emit |
| Gate resolve site | `server/vision-routes.js` ~810-827 | `store.resolveGate` + `appendGateLogEntry` |
| Iteration report/abort | `server/vision-routes.js` report ~551, abort ~587 | `iterationState` shape; complete/abort set outcome |
| active-build | `lib/build.js:389-411,476-479` | `active-build.json` {featureCode,flowId,currentStepId,status,pid,...}; only `deleteActiveBuild` exported |
| isProcessAlive | `lib/build.js:437-445` | `process.kill(pid,0)` liveness |
| Agent connector | `lib/build.js:459-473` | `stratum.runAgentText('claude', prompt, {cwd})` |
| Session bind | `server/session-routes.js:76-113` | bind requires vision item; reconcile hooks **after** successful bind |
| MCP tool reg | `server/compose-mcp.js` TOOLS array + switch (~596) ; handlers `server/compose-mcp-tools.js` (delegate to `lib/*`) | add `compose_resume`, `write_checkpoint` |

## Component slices (dependency order)

Each slice is independently testable; TDD per slice (`node:test`).

### S1 — Contract `contracts/checkpoint.schema.json` *(new)*
Draft-07 JSON Schema for `Checkpoint` + `EnvFingerprint` (shapes in design Decision 2). Include `_source: docs/features/COMP-RESUME/design.md`, `_roadmap: COMP-RESUME`. Two `$defs`: `EnvFingerprint`, `Checkpoint`. `soft` is `{goal,nextStep,risks[]}|null`.

### S2 — `lib/checkpoint/git.js` *(new)* + `lib/checkpoint/atomic.js` *(new)*
`git(cwd, args)` → `spawnSync` wrapper returning trimmed stdout or `null` (pattern: `bug-bisect.js:56`). Helpers: `head(cwd)`, `branch(cwd)`, `porcelain(cwd)`, `dirtyHash(cwd)` (sha256 of `git status --porcelain` + `git diff`). `atomic.js`: `writeAtomic(file, str)` (temp+rename), `appendJsonl(file, obj)`, `readJsonl(file)` (malformed-tolerant), `readLastJsonl(file)`.

### S3 — `lib/checkpoint/fingerprint.js` *(new)* — BUILT
`captureFingerprint(cwd, {featureDir, flowId, composeDir, dataDir})` → `EnvFingerprint`. Reads build-stream `_seq` from `<composeDir>/build-stream.jsonl` (composeDir defaults to `dirname(dataDir)` — see correction C1/Build-stream-path anchor). Globs phase-signature artifacts under `featureDir` (design.md, blueprint.md, plan.md; implementFiles/contracts empty in v1). `classify(prev, curr)` → `'clean'|'advanced'|'diverged'` (pure; the unit-tested core). Rules: equal git.head & dirtyHash → clean; head moved & clean tree & artifacts ⊇ prev → advanced; else diverged.

### S4 — `lib/checkpoint/store/index.js` *(new)* — interface + registry
`createCheckpointStore(backendId, {dataDir})`. Registry maps `'jsonl'` → JsonlBackend; `'smartmemory'` → throws `NOT_IMPLEMENTED` (seam, mapping in comments); `'memory-pointer'` → seam (deferred). Base contract: `write(cp)`, `readLatest(featureCode)`, `list(featureCode,{limit})`, `capabilities()`. Optional: `semanticRecall`, `temporalRange`, `procedureMatch` (absent on jsonl). Backend selection default `'jsonl'` from `loadProjectConfig().checkpoint?.backend`.

### S5 — `lib/checkpoint/store/jsonl.js` *(new)*
Feature-scoped `checkpoints-<featureCode>.jsonl` under `getDataDir()`. `write` appends (idempotent on `id`); `readLatest` = last valid line; `list` = tail-N newest-first; `capabilities()` = `[]`. Re-resolve dataDir via constructor arg (honor `onProjectSwitch`).

### S6 — `lib/checkpoint/prompts.js` *(new)* — agent prompt builders
`scribePrompt({fingerprint, journalTail, priorCheckpoint})` → string instructing return of **only** `{goal,nextStep,risks}` JSON, every factual claim referencing fingerprint anchors (never assert results, point at `testRef`). `reconcilePrompt({staleCheckpoint, liveFingerprint, envScan})` → instructs emit `{soft, confidence(0-1), resumeAction}` treating env as ground truth.

### S7 — `lib/checkpoint/anchor.js` *(new)* — boundary capture
`captureAnchor({item, trigger, cwd, featureDir, flowId, dataDir, store})` — builds an anchor checkpoint (`soft:null`) from `captureFingerprint` and `store.write`. **Best-effort**: wrap in try/catch, `console.warn` on failure, never throw (pattern: `build.js:1669` emitCheckpoint guard).

### S8 — `lib/checkpoint/reconciler.js` *(new)* — resume orchestration
**Boundary (resolves Codex #2/#3): `reconcile` is deterministic and does NOT persist to the store, mutate the vision DB, or call an LLM.** It computes and RETURNS a `ReconcileResult`; persistence happens at the route (S10) and the agent runs at the orchestrator (S9). This keeps it unit-testable with no `store`-write or connector dependency.

`reconcile({featureCode, item, cwd, featureDir, composeDir, dataDir, store, confidenceThreshold})`:
1. **Rebuild derived state (pure, in-memory):** read append logs (`gate-log`, `feature-events`, build-stream) + `active-build.json` + on-disk artifacts; compute the corrected `currentPhase` and the phaseHistory backfill entries. Mutates the passed-in `item` object **in memory only** and collects them into `result.lifecycleMutations` (the route applies + persists).
2. `store.readLatest(featureCode)` — **read-only** (or `semanticRecall` if `store.capabilities().has('semanticRecall')`).
3. `captureFingerprint` live; `classify(cp.fingerprint, live)`.
4. `clean`/`advanced` → `{action:'resume', nextStep, drift, lifecycleMutations}` (no agent).
5. `diverged` → `{action:'needs-sync', drift, lifecycleMutations, reconcilePrompt: reconcilePrompt({...})}`. The **orchestrator** (S9 `compose_resume` consumer) runs the reconciliation agent with that prompt, then calls `write_checkpoint` with the synced `{soft,confidence}` (trigger `resume-sync`). It then re-submits: confidence ≥ `confidenceThreshold` (default 0.6) → resume; else → gate.
6. Helper `decideAfterSync({confidence, confidenceThreshold})` → `'resume' | 'gate'` (pure, unit-tested) so the gate decision is testable without an LLM.

`ReconcileResult = { action: 'resume'|'needs-sync'|'gate', nextStep?, drift, lifecycleMutations, reconcilePrompt?, gatePayload? }`.

### S9 — MCP surface `server/compose-mcp-tools.js` + `server/compose-mcp.js` *(extend)* + `lib/checkpoint/checkpoint-writer.js` *(new)*
- `write_checkpoint({featureCode, trigger, soft?, confidence?, idempotency_key?})` → builds fingerprint + merges soft → `store.write`. Narrative when `soft` present, else anchor. (Handler delegates to `lib/checkpoint/checkpoint-writer.js`, which calls `captureFingerprint` + `createCheckpointStore`.)
- `compose_resume({featureCode})` → **HTTP-delegates** to `POST /api/session/bind/reconcile` (like `toolBindSession` calls `/api/session/bind` — `compose-mcp-tools.js` talks to the server over HTTP, it has no direct store/connector access). The server route runs `reconcile`, applies `lifecycleMutations`, and returns the `ReconcileResult`.
- **Agent-run boundary (Codex #3):** neither tool calls `runAgentText`. When the returned `action === 'needs-sync'`, the **orchestrator** (Claude Code driving `/compose`) runs the reconciliation agent with `result.reconcilePrompt` (via the Agent tool / connector it already has), then calls `write_checkpoint` with the synced result. No new export from `lib/build.js` is required (its `makeAskAgent`/`readActiveBuild` are private — confirmed; we do not depend on them).
- Wire: TOOLS entries + switch cases + `toolWriteCheckpoint`/`toolComposeResume` delegating to `lib/checkpoint/checkpoint-writer.js`.

### S10 — Boundary wiring `server/vision-routes.js` *(extend)* + reconcile-on-bind `server/session-routes.js` *(extend)*
- After `appendPhaseHistory` at **advance (275), skip (305), kill (334), complete (363)**, after **gate resolve (755)**, and after **iteration report (496) / abort (581)**: call `captureAnchor` (best-effort, behind `loadProjectConfig().checkpoint?.enabled !== false` — defaulted explicitly per C/Config anchor). The `complete` site (363) is included so the terminal transition is captured consistently.
- Add `POST /api/session/bind/reconcile`: looks up the item (like bind), calls `reconcile(...)` server-side (it has the `store`), **applies `result.lifecycleMutations` via `store.updateLifecycle` and emits the same `lifecycleTransition`/decision broadcasts the advance handler uses** (this is the persistence boundary for Codex #2 — reconcile computes, the route persists), then returns the `ReconcileResult`. `compose_resume` calls this route. Bind itself (76-113) stays unchanged and unblocked.

### S11 — `compose.json` *(extend)* + `lib/checkpoint/render.js` *(new)*
Config block `"checkpoint": { "enabled": true, "backend": "jsonl", "confidenceThreshold": 0.6 }`. `render.js`: `renderCheckpoint(cp)` → markdown for human inspection (used by `compose_resume` output + future CLI).

## Boundary Map

| Symbol | Kind | Slice | Consumers | Producers |
|---|---|---|---|---|
| `Checkpoint` | type | S1 | S4,S5,S7,S8,S9 | S1 |
| `EnvFingerprint` | type | S1 | S3,S7,S8 | S3 |
| `captureFingerprint` | function | S3 | S7,S8 | S3 |
| `classify` | function | S3 | S8 | S3 |
| `CheckpointStore` | interface | S4 | S7,S8,S9 | S5 (jsonl impl) |
| `createCheckpointStore` | function | S4 | S7,S8,S9 | S4 |
| `scribePrompt` | function | S6 | S9 | S6 |
| `reconcilePrompt` | function | S6 | S8 | S6 |
| `captureAnchor` | function | S7 | S10 | S7 |
| `reconcile` | function | S8 | S9,S10 | S8 |
| `ReconcileResult` | type | S8 | S9,S10 | S8 |
| `writeCheckpoint` | function | S9 | S9 (tool) | S9 |
| `composeResume` | function | S9 | S9 (tool) | S9 |

**Endpoints (prose, not Boundary Map):** `POST /api/session/bind/reconcile`. **MCP tools:** `write_checkpoint`, `compose_resume`. **Config key:** `checkpoint.{enabled,backend,confidenceThreshold}`. **Invariant:** anchor writes never throw into the build path (best-effort); env is always ground truth on resume.

## Test plan (node:test)

- **Golden** `test/integration/checkpoint-resume.integration.test.js`: real git repo in `mkdtempSync`, simulate phases writing anchors + a narrative cp, kill, `reconcile` → resumes at correct nextStep. Real JSONL backend.
- **Drift table** `test/checkpoint-classify.test.js`: table over clean/advanced/diverged with a fake fingerprint pair each; assert classification + reconcile path (resume vs gate). `runAgent` stubbed.
- **Contract** `test/checkpoint-contract.test.js`: every produced cp validates against `checkpoint.schema.json` (SchemaValidator); jsonl backend passes interface-conformance suite.
- **Best-effort** `test/checkpoint-anchor.test.js`: a throwing `store.write` is swallowed; build path unaffected.
- **Unit**: `classify` (pure), `renderCheckpoint` (pure), `dirtyHash` determinism.
