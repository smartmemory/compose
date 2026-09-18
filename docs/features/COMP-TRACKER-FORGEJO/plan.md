# COMP-TRACKER-FORGEJO — Implementation Plan

**Status:** PLAN
**Date:** 2026-09-18
**Feature code:** COMP-TRACKER-FORGEJO

## Related Documents

- Back: `design.md` (rev 4), `blueprint.md` (Boundary Map validated clean)

## Dependency graph

```
T1 (transport) ─┬──────────────────────────────────────┐
T2 (derive fn)  ─┤                                       │
                 ├─→ T5 (push extension) ─┐               │
T3 (4-surface    │                        ├─→ T8 (E2E +   │
    registration)┴─→ T4 (validator) ──────┤    coverage   │
                 └─→ T6 (promotion) ───────┘    sweep)     │
                                          T7 (MCP) ────────┘
```

T1 and T2 are independent of everything and of each other — parallelizable.
T3 must land before T4, T5, and T6 (all three depend on the schema/writer surfaces it adds).
T7 depends only on T3+T6 (the fields `link_features` needs to expose).
T8 runs last, per compose Phase 7's four-step gate (tasks → E2E → review loop → coverage sweep).

## Tasks

### T1 — Forgejo transport
**File:** `lib/tracker/forgejo-api.js` (new)
**Pattern to follow:** `lib/tracker/github-api.js` (class shape, status-returning method convention, base-URL/auth handling)
**What to do:** Implement `ForgejoApi` with `getIssueResult`, `updateStateResult`, `addLabelResult`, `listIssueComments`, `addIssueComment` (design.md Piece 1). Base URL pinned/validated at construction (no caller-controlled origin); token attached only to the pinned origin, never forwarded cross-origin.
**Test:** `test/tracker/forgejo-api.test.js` (new) — mirror `test/tracker/github-api.test.js`'s structure against a fake HTTP layer. Cases: each method's happy path, non-2xx handling (status-returning, no throw), base-URL rejection of a mismatched origin.
**Depends on:** none.

### T2 — Lifecycle derivation function
**File:** `lib/status-projection.js`
**Pattern to follow:** `featureStatusToVisionStatus` (same file, pure function, same file's existing test)
**What to do:** Add `featureStatusToExternalExpect(status)` per design.md Piece 3's mapping table.
**Test:** extend `test/status-projection.test.js` (or create if it doesn't already cover this file) — table-driven over all 8 statuses, asserting `PARKED → null` explicitly (the one non-obvious case).
**Depends on:** none.

### T3 — Provider registration (4 surfaces + schema)
**Files:** `lib/feature-writer.js` (B8-B11), `lib/xref-citation.js` (B13-B14), `contracts/feature-json.schema.json` (B18)
**Pattern to follow:** the existing `github` branch at each site (cited exactly in blueprint.md's Boundary Map)
**What to do:**
- `XREF_PROVIDERS`: add `'forgejo'`.
- `validateExternalArgs`: add `forgejo` branch (repo/issue/expect/expect_labels, mirroring github); `derive_expect` boolean validated **only** when provider is github or forgejo (reject for local/url/reserved).
- External-link identity key: add `forgejo` branch, key = `` `forgejo:${repo}#${issue}` ``.
- `linkFeatureExternal` entry construction: carry `derive_expect` through (currently drops unlisted fields — this is the one-line fix Codex flagged twice).
- `RESOLVABLE_PROVIDERS` + citation grammar: add `forgejo`, with its own `owner/repo#issue` parsing branch (not falling through to generic URL parsing).
- Schema: `forgejo` conditional branch with its own `expect_labels` declaration (it's not inherited from `github`'s — corrections table in blueprint.md), plus `derive_expect: {type: boolean}` inside both the `github` and `forgejo` branches only.
**Test:** extend existing `test/feature-writer.test.js`, `test/xref-citation.test.js`, and the schema's own validation test suite (whichever currently exercises the `github`/`local` conditional branches — mirror those cases for `forgejo`). Explicit regression case: a `local` link with `derive_expect: true` is rejected.
**Depends on:** none, but everything else depends on this.

### T4 — Validator Forgejo resolution + derive_expect normalization
**File:** `lib/feature-validator.js` (`runExternalRefChecks`, ~`:892-949`)
**Pattern to follow:** the existing `github` resolution branch in the same function
**What to do:** Resolve `forgejo` refs via `ForgejoApi` (T1), preserving the exact degrade posture already used for GitHub (confirmed 404 → `XREF_TARGET_MISSING` error; offline/no-token/rate-limit/ambiguous → `XREF_RESOLUTION_SKIPPED`, never guessed). Carry `derive_expect` into the normalized ref and call `featureStatusToExternalExpect` (T2) for `derive_expect`-marked links so the validator's drift check and `xref-push`'s actual push (T5) can never disagree.
**Test:** extend the validator's existing external-ref test file — new cases for forgejo resolution (each degrade path) and a `derive_expect` link whose validator-computed expectation matches `xref-push`'s computed expectation for the same feature/status (a shared-fixture test, not two independently-asserted magic values).
**Depends on:** T1, T2, T3.

### T5 — Push extension
**File:** `lib/xref-push.js`
**Pattern to follow:** existing GitHub eligibility/dispatch logic in the same file
**What to do:** Extend eligibility to `provider === 'forgejo'`. For `derive_expect: true` links, compute `expect` from the feature's *current* status (T2) rather than reading a stored `expect` field. Dispatch Forgejo pushes as two independent calls (`updateStateResult`, `addLabelResult` via T1) instead of GitHub's one combined patch; report `{statePushed, labelsPushed, errors[]}` — a 2xx write is never later reported as "skipped."
**Test:** golden-flow test per design.md — a `derive_expect: true` forgejo link, feature flipped to COMPLETE **via `record_completion`** (not `set_feature_status` — this is the specific case Codex round 2 found broken, so the test must exercise the real completion path, not the easier-to-reach one), next `xref-push --apply` closes the issue against a fake Forgejo transport. Also: dry-run makes zero calls; a link without `push:true` is never touched even under `--apply`; a PR-backed issue is skipped.
**Depends on:** T1, T2, T3.

### T6 — Promotion command
**Files:** `lib/xref-promote.js` (new), `bin/compose.js` (new dispatch block)
**Pattern to follow:** `lib/xref-push.js`'s apply-guard/dry-run structure; `bin/compose.js:1555-1583`'s dispatch block shape
**What to do:** `promoteIssue(cwd, {provider, repo, issue, code, phase, apply})` — PR-backed-issue guard first (mirrors `xref-push.js:64-79`); dry-run by default (zero writes, local or remote); under `--apply`, phased and resumable: (1) create feature with `promoted_from: {provider, repo, issue}` provenance stamp — refuse if an existing feature at `code` has no/mismatched `promoted_from` (real collision vs. resumed retry); (2) attach external link (`push:true`, `derive_expect:true`, `expect_labels` seeded to the acceptance label); (3) additively apply the acceptance label (T1's `addLabelResult`, idempotent — check current labels first); (4) post acceptance comment carrying hidden marker `<!-- compose-promotion:<code> -->` (check via `listIssueComments` before posting — never double-post on retry). Feature `description` is the issue title, normalized to one line; full body preserved separately (a `notes` field or linked file), never injected into the roadmap description cell.
**Test:** golden-flow test per design.md — fake Forgejo issue → dry-run (asserts zero writes) → `--apply` (asserts feature+link+label+comment, in that order, each idempotency-checked) → re-run `--apply` (asserts all four phases no-op) → re-run with a different `--issue` for the same `--code` (asserts refusal, collision detected via `promoted_from` mismatch) → PR-backed issue (asserts refusal before any write).
**Depends on:** T1, T3.

### T7 — MCP surface
**Files:** `server/mcp-tool-defs.js`
**What to do:** `link_features` schema: add `forgejo` to the provider enum, add `push`/`expect_labels`/`derive_expect` fields (currently entirely missing — this is a real capability gap for MCP clients today, not just a Forgejo add-on). `roadmap_xref_push`: no schema change (it has no provider param), but update its description text to mention Forgejo and the `{statePushed, labelsPushed, errors[]}` result shape.
**Test:** contract test asserting the tool schema accepts the new fields and the description text matches actual behavior (per Codex round 3's finding — a test that would fail if the two drift apart again).
**Depends on:** T3, T6 (for the exact field shapes `link_features` needs to expose).

### T8 — E2E + coverage sweep
Per compose Phase 7 steps 2-4: no dedicated UI to smoke-test (backend-only), so "E2E" here means running the full `xref-*`/`feature-writer`/`feature-validator`/tracker test suites together (not just the new files) to catch cross-task interaction, then the standard Codex review loop and coverage sweep.

## Test files touched (new or extended)

- `test/tracker/forgejo-api.test.js` (new)
- `test/status-projection.test.js` (extended)
- `test/feature-writer.test.js`, `test/xref-citation.test.js`, schema validation test suite (extended)
- `lib/feature-validator.js`'s external-ref test file (extended)
- `test/xref-push.test.js` (extended)
- `test/xref-promote.test.js` (new)
- MCP tool contract test file (extended)
