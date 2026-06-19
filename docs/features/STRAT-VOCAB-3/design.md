# STRAT-VOCAB-3 — Compose Integration for Vocabulary Enforcement

**Status:** COMPLETE (shipped 2026-06-20) — design retained for provenance
**Owner repo:** compose (the integration code lives here; the `vocabulary_compliance` builtin it wires up ships in the sibling stratum-mcp repo)
**Roadmap:** `compose/ROADMAP.md` → STRAT-VOCAB (item 109)

## Related Documents
- Roadmap umbrella: `compose/ROADMAP.md` (STRAT-VOCAB section)
- Upstream (already shipped): STRAT-VOCAB-1 `_load_vocabulary()` + STRAT-VOCAB-2 `vocabulary_compliance()` in `stratum/stratum-mcp/src/stratum_mcp/spec.py`, registered at `stratum/stratum-mcp/src/stratum_mcp/executor.py:279`
- Contract: `compose/contracts/review-result.json` (finding severity vocabulary)

## Context

STRAT-VOCAB-1 (vocabulary file format + loader) and STRAT-VOCAB-2 (the `vocabulary_compliance` ensure builtin) are **already shipped, committed, and green** (44 tests) in the installed stratum-mcp. The builtin:

```python
vocabulary_compliance(path, files_changed, git_fallback=False, base="HEAD") -> bool
```
- Loads `contracts/vocabulary.yaml` (relative to process cwd), greps changed files for rejected aliases (whole-word, case-sensitive).
- Returns `True` when clean **or** when the vocab file is missing/empty/comments-only (`_load_vocabulary` → `{}`). **It is a safe no-op until a project declares a real vocabulary.**
- Raises `ValueError([violation strings])` when violations exist. Each string: `vocabulary violation: <path>:<line> uses '<alias>' — canonical is '<canonical>' (reason: ...)`.

What is **missing** is the compose-side wiring (STRAT-VOCAB-3). Three deliverables.

## Goals / Non-Goals

**Goals**
- `compose init` scaffolds a starter `contracts/vocabulary.yaml`.
- `compose build` attaches the `vocabulary_compliance` ensure to the implementation step by default.
- Violations surface as **must-fix** findings in the Phase-7 fix loop.

**Non-Goals**
- No changes to the `vocabulary_compliance` builtin or `_load_vocabulary` (VOCAB-1/2, already shipped). If we discover a builtin bug, file a follow-up against stratum.
- No `scope` field / domain-grouping (explicitly dropped from VOCAB-1 as YAGNI).
- No new lens in the parallel-review sub-flow — violations ride the existing ensure→findings path.

## Grounding (verified against code)

| Assumption | Reality | Ref |
|---|---|---|
| build pipeline is generated | It's **static YAML**, mutated at load | `pipelines/build.stratum.yaml`, `build-quick.stratum.yaml` |
| step is named `implement` | It's **`execute`** (a `parallel_dispatch`); flow is `build` not `compose_feature` | `build.stratum.yaml:388` |
| ❌ attach the ensure to `execute` | **BROKEN & DESTRUCTIVE** (Codex design-gate finding). `execute` is `parallel_dispatch`; an aggregate ensure fails *after* all tasks are `complete`, so the retry subset (`status==='failed'`) is empty → retries burn → terminal path **restores the pre-execute snapshot, discarding all implementation work**. | `build.js:4576-4601` |
| flow-step ensure_failed drives a real code-fix loop | Yes — `executeChildFlow` dispatches a generic fix agent with the violation strings, then retries | `build.js:3185-3259` |
| ✅ `review` as the host step | **Chosen.** In both pipelines, runs after `execute`, always runs, before commit, real code-fix loop; existing first ensure `result.clean == True` | `build.stratum.yaml:413-421`, `build-quick.stratum.yaml:320-328` |
| ❌ a *new* top-level step | Rejected (Codex finding #2) — breaks hard-coded step manifests + exact-order tests, and a conditional step can't be cleanly shown in the UI | `cli-progress.js:63,249`, `src/lib/pipeline-steps.js:10,74` |
| `coverage` as the host | Rejected — **skipped when the project has no tests**, conflates with test-fixing | `build.js:1739-1791` |
| `ship` as the host | Rejected — ship **commits in-process before** its ensure → vocab failure fires post-commit | `build.js:2418`, `build.stratum.yaml:537-539` |
| git fallback captures the build's changes | Yes — `git diff --name-only HEAD` + untracked; merge applies diffs via `git apply` (uncommitted) so the working tree carries them until ship | `spec.py:856`, `build.js:3863-3866` |
| ensure cwd is the project root | Yes — existing relative-path ensures (`file_exists(result.artifact)`) work | `build.stratum.yaml:258` |
| capability opt-out pattern | `composeConfig.capabilities.*` (e.g. `preMergeGate`, resolved once) | `build.js:719-726` |
| ensure_failed → findings | `build.js:1940-1941` (main) / `3205-3206` (childflow) call `progress.findings(violations)`; severity parsed from string, defaults to **nit** without a marker | `lib/cli-progress.js:437-439` |
| init create-if-absent idiom | inline `if (!existsSync(dest)) writeFileSync(...)` | `bin/compose.js:478-484` |

## Approach (chosen)

### D1 — `compose init` scaffolds `contracts/vocabulary.yaml`
Add a create-if-absent block to `runInit` (`bin/compose.js`, after the `docs/context/` scaffold ~line 484): `mkdirSync(join(cwd,'contracts'),{recursive:true})` then write a **fully-commented** starter template (canonical→`{reject,reason}` examples, all commented out). Because the scaffold is comments-only, `_load_vocabulary` returns `{}` → the ensure is **armed but inert** until the user uncomments/adds entries. Idempotent: never overwrites an existing file.

### D2 — `compose build` adds the ensure to the existing `review` step
**Revised twice after Codex design-gate findings:** (1) attaching to `execute` is destructive (parallel work-discard); (2) adding a *new* top-level step breaks Compose's hard-coded step manifests (`cli-progress.js:63,249`, `src/lib/pipeline-steps.js:10,74`) and exact-order tests, and a *conditional* step can't be cleanly represented in the UI. **Resolution:** add a second ensure to an **existing** step — the `review` step — so the step list/order is unchanged (zero UI/test surface) while still routing failures through a real code-fix loop.

In both pipelines, append to the `review` step's `ensure` array:
```
vocabulary_compliance('contracts/vocabulary.yaml', [], True)
```
so it reads:
```yaml
      - id: review
        flow: parallel_review
        ...
        ensure:
          - "result.clean == True"
          - "vocabulary_compliance('contracts/vocabulary.yaml', [], True)"   # injected when enabled
```

- **Why `review` (not a new step, not `execute`/`coverage`/`ship`/`docs`):**
  - Its `ensure_failed` already drives the **generic** code-fix loop in `executeChildFlow` (build.js:3185-3259): it dispatches a fixer with the verbatim violation strings ("Fix step review — postconditions failed: - vocabulary violation: …"), then retries — the fixer replaces rejected aliases with canonical names.
  - It is present in **both** `build` and `build-quick`, **always runs** (not skippable, unlike `coverage`), and runs **before any commit** (unlike `ship`, which commits in-process before its ensure).
  - Naming consistency is a review-quality concern → no semantic conflation.
  - Adding an ensure to an existing step changes **no** step list/order → the CLI bar, the shared frontend pipeline template, and exact-order tests are untouched.
- **Ensure form** `vocabulary_compliance('contracts/vocabulary.yaml', [], True)`: empty-list literal + `git_fallback=True` → never references a possibly-missing `result.*` attribute; scans the uncommitted working-tree diff vs `HEAD` (execute's merged changes are present, uncommitted, at review time). No-op when the vocab file is missing/empty.
- **Injection done in JS, both pipelines:** `runBuild` loads one spec (build or build-quick); both have a `review` step whose first ensure is `result.clean == True`. One generic mutation (find the `review` step in the flow, push the vocab ensure if not already present) handles both. Do it in the spec-mutation region (~785-818), **independent of** the existing `if (buildProfile)` block — parse once, apply buildProfile + vocab injection conditionally, stringify once. Tamper-hash is taken before mutation (existing pattern) so this is safe.
- **Gate:** inject only when `composeConfig?.capabilities?.vocabularyCompliance !== false` (default-ON, honoring the roadmap's "by default") **AND** `existsSync(<cwd>/contracts/vocabulary.yaml)`. The file gate makes the generated spec **byte-identical** for any project without a vocab file (zero behavior change, no extra cost). When clean, the added ensure is a cheap git-diff + grep with no extra agent dispatch.

### D3 — Violations surface as must-fix findings
The `ensure_failed → progress.findings(violations)` path already surfaces vocab violations (here via the single-agent handler) and already blocks the step (fix loop → terminal at retry cap). Add **localized must-fix tagging** in `build.js` (at the findings-display site) so strings matching `vocabulary violation:` are classified must-fix rather than nit — display matches the blocking behavior. Contained to build.js; the shared cli-progress parser is untouched.

## Acceptance Criteria
- [ ] `compose init` creates `contracts/vocabulary.yaml` when absent, with commented examples and a format header; re-init preserves a user-customized file (no overwrite).
- [ ] Scaffolded (comments-only) file loads to `{}` — verified the ensure is a no-op against it.
- [ ] `compose build`/`build --quick`: when a vocab file exists and the capability isn't disabled, the `review` step's `ensure` array contains `vocabulary_compliance('contracts/vocabulary.yaml', [], True)` (in addition to `result.clean == True`). The step list/order is unchanged.
- [ ] When no vocab file exists, the generated spec is byte-identical (no extra ensure on `review`).
- [ ] `capabilities.vocabularyCompliance: false` suppresses injection even when a file exists.
- [ ] Injection is idempotent (never adds the vocab ensure twice).
- [ ] A planted rejected alias in a changed file produces a **must-fix** finding; a clean change does not. (Unit-level: the must-fix tagging maps a `vocabulary violation:` string to must-fix.)
- [ ] Full `node --test` suite green (bounded with `--test-timeout`).

## Risks
- **Vendored stratum-mcp is stale** (`compose/stratum-mcp/` lacks `vocabulary_compliance`). The runtime uses the installed server (`.mcp.json`), which has it. Tests target the **injection logic + scaffold + tagging** directly (JS unit/CLI tests) and validate the mutated spec via `stratum_validate` — they do NOT depend on the vendored sandbox evaluating the builtin.
- **git_fallback scans the whole working-tree diff**, not strictly the build's files. In a normal compose build the working tree starts clean, so this equals the build's changes. Acceptable.
- **Per-build agent dispatch** for opt-in projects (one short `vocab_check` turn even when clean). Bounded to projects that created a vocabulary file; suppressible via the capability. Accepted tradeoff for reliable, test-independent enforcement.
