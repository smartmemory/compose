# COMP-TRACKER-FORGEJO — Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-09-18
**Feature code:** COMP-TRACKER-FORGEJO

## Related Documents

- Back: `design.md` (rev 4, 5 Codex review rounds folded in)
- Forward: `plan.md` (to be written)

## Corrections table (spec assumption vs reality, found while grounding this blueprint)

| Design assumption | Reality | Disposition |
|---|---|---|
| `expect_labels` is a common link field | It's only declared inside the `github` conditional branch (`feature-json.schema.json:120`), not at the top-level `properties` (`:92-101`) | The `forgejo` branch must declare its own `expect_labels`, same as `github` does — it is not inherited from a common location |
| The link-item schema might reject unknown fields like `derive_expect` outright | No `additionalProperties: false` is set on the link-item object (`:90-152`) — an untyped field is silently *ignored by validation*, not rejected | Matches design.md's claim ("currently untyped", not "currently rejected") — `derive_expect` needs an explicit `type: boolean` declared in the schema to be validated at all, but its absence wasn't a hard error, just a silent gap |

## Boundary Map

Per `.claude/skills/compose/templates/boundary-map.md` — this feature has clearly more than 2 work units (transport, 4-surface provider registration, lifecycle derivation, promotion command).

| # | Symbol | Kind | File | Notes |
|---|---|---|---|---|
| B1 | `ForgejoApi` | class | `lib/tracker/forgejo-api.js` (new) | Mirrors `GitHubApi` (`lib/tracker/github-api.js:12`) shape; methods below |
| B2 | `ForgejoApi.getIssueResult` | function | `lib/tracker/forgejo-api.js` (new) | `GET /repos/{owner}/{repo}/issues/{index}`, status-returning |
| B3 | `ForgejoApi.updateStateResult` | function | `lib/tracker/forgejo-api.js` (new) | `PATCH .../issues/{index}` with `{state}` only |
| B4 | `ForgejoApi.addLabelResult` | function | `lib/tracker/forgejo-api.js` (new) | `POST .../issues/{index}/labels`, additive |
| B5 | `ForgejoApi.listIssueComments` | function | `lib/tracker/forgejo-api.js` (new) | `GET .../issues/{index}/comments`, paginated |
| B6 | `ForgejoApi.addIssueComment` | function | `lib/tracker/forgejo-api.js` (new) | `POST .../issues/{index}/comments` |
| B7 | `featureStatusToExternalExpect` | function | `lib/status-projection.js` | New sibling to `featureStatusToVisionStatus` (`:33`) — pure, no IO |
| B8 | `XREF_PROVIDERS` | const | `lib/feature-writer.js:973` | Add `'forgejo'` |
| B9 | `validateExternalArgs` | function | `lib/feature-writer.js:995` | Add `forgejo` branch (mirrors `github` branch `:1002-1019`); scope `derive_expect` to github/forgejo only |
| B10 | external-link target-key computation | function (inline) | `lib/feature-writer.js:1075-1088` | Add `forgejo` branch: key = `` `forgejo:${repo}#${issue}` `` |
| B11 | `linkFeatureExternal` entry construction | function | `lib/feature-writer.js:1098` | Carry `derive_expect` through (currently drops unlisted fields) |
| B12 | `addRoadmapEntry` field list | function | `lib/feature-writer.js:251-278` | Add `promoted_from` to the typed create field list |
| B13 | `RESOLVABLE_PROVIDERS` | const | `lib/xref-citation.js:28` | Add `'forgejo'` |
| B14 | citation grammar branch | function (inline) | `lib/xref-citation.js:166` | Add `forgejo` branch parallel to the `github` branch (currently only `github` gets `owner/repo#issue` parsing) |
| B15 | `runExternalRefChecks` | function | `lib/feature-validator.js` (~`:892-949`) | Resolve `forgejo` refs via `ForgejoApi`; carry `derive_expect` into the normalized ref; reuse `featureStatusToExternalExpect` (B7) so validation and push agree; preserve the 404-vs-skip distinction (`:943-949`) |
| B16 | `planPush` / eligibility check | function | `lib/xref-push.js:38`, `:198-226` | Extend eligibility to `provider === 'forgejo'`; for `derive_expect: true` links, compute `expect` via B7 from the feature's current status instead of reading a stored `expect` |
| B17 | Forgejo push dispatch | function (inline) | `lib/xref-push.js` (~`:214-221`) | Dispatch to `ForgejoApi`'s separate state/label calls (B3/B4) instead of the GitHub combined-patch call; report `{statePushed, labelsPushed, errors[]}` |
| B18 | `contracts/feature-json.schema.json` link-item schema | type | `contracts/feature-json.schema.json:92-150` | Add `forgejo` conditional branch (mirrors `github` `:114-122`, including its own `expect_labels`); add `derive_expect: {type: boolean}` inside both the `github` and `forgejo` branches only |
| B19 | `promoteIssue` orchestrator | function | `lib/xref-promote.js` (new) | New module, sibling to `xref-push.js`/`xref-sync.js`; implements dry-run-default, PR guard, provenance check, phased idempotent writes (create → link → label → comment) |
| B20 | `promote-issue` CLI dispatch | inline block | `bin/compose.js` (sibling to `:1555-1583`) | New `subcmd === 'promote-issue'` block |
| B21 | `link_features` MCP tool schema | type | `server/mcp-tool-defs.js:449-468` | Add `forgejo` to provider enum; add `push`, `expect_labels`, `derive_expect` fields |
| B22 | `roadmap_xref_push` MCP tool description | prose | `server/mcp-tool-defs.js:398` | Update description text to mention Forgejo + partial-success result shape (no schema change — `:395-404` has no provider param) |

## Task-level plan (feeds `plan.md`)

1. **T1 — Forgejo transport** (B1-B6): new `lib/tracker/forgejo-api.js`. Base URL pinned/validated at construction (design.md's egress contract). Unit tests against a fake HTTP layer, mirroring `github-api.js`'s existing test shape.
2. **T2 — Lifecycle derivation function** (B7): new pure function in `status-projection.js`. Table-driven unit test covering all 8 statuses including `PARKED → null`.
3. **T3 — Provider registration, 4 surfaces** (B8-B11, B13-B14, B18): schema, citation grammar, identity key, `validateExternalArgs`, `linkFeatureExternal` entry construction. This is the task most likely to have cross-cutting test breakage (existing GitHub-path tests must stay green) — run the full `xref-*`/`feature-writer` test files after, not just new tests.
4. **T4 — Validator forgejo resolution + derive_expect normalization** (B15): extend `runExternalRefChecks`.
5. **T5 — Push extension** (B16-B17): extend `xref-push.js` eligibility + dispatch. Golden-flow test: a `derive_expect: true` forgejo link, feature status flips COMPLETE via `record_completion` (not `set_feature_status`, per the design's finding-5 fix — the test must go through the real completion path to prove the derivation actually covers it), next `xref-push --apply` run closes the issue.
6. **T6 — Promotion command** (B19-B20): new `lib/xref-promote.js` + CLI wiring. Golden-flow test: fake Forgejo issue → promote (dry-run shows no writes) → promote `--apply` (feature created with `promoted_from`, link created, label added, comment posted) → re-run `--apply` (idempotent no-op on all four phases) → mismatched re-run (different issue, same code) refused.
7. **T7 — MCP surface** (B21-B22): schema + description updates, contract tests.
8. **T8 — E2E + coverage sweep**: per compose Phase 7 steps 2-4.

## Boundary Map validation

Ran `validateBoundaryMap({blueprintText, blueprintPath, repoRoot})` (`lib/boundary-map.js`) against this document: `{"ok": true, "violations": [], "warnings": []}`. Topology, file-plan-or-disk, symbol presence, and producer/consumer checks all pass. (Note for future readers: `lib/boundary-map.js` contains a literal NUL byte used as a key separator inside a template literal — `grep`/`rg` silently return nothing against it, per `reference_nul_bytes_break_grep`. Use `node -e "import(...)"` or `Read`, not grep, to inspect it.)

Symbols B7-B18, B21-B22 are existing-file modifications with kind `function`/`const`/`type`/`inline block` as applicable; B1, B19 are new files (kind `class`/`function` for their exports). No `component`/`hook` entries — this is backend-only, no UI surface.

## Verification Table (Phase 5)

Every file:line reference below was checked against the current checkout by one of: (a) direct `Read` in this session, or (b) an adversarial Codex review round (`b3cfe6fc3e25`, `753010bb2040`, `7bbc8bcaf9c2`, `29a5cb019141`, `042dc88f1d55` — 5 rounds, each re-verifying references against live code, not just trusting the prior round's citations) that explicitly checked it and found it accurate. No stale references were carried forward — every citation below survived at least one independent check after the text around it was last edited.

| Ref | Verified by | Status |
|---|---|---|
| `github-api.js:12,51,60,64-68` (B1-B6 template) | Direct Read (this session) + Codex round 1 | Confirmed |
| `status-projection.js:1-37` (B7 template) | Direct Read (this session) | Confirmed — `featureStatusToVisionStatus` pattern exists exactly as described |
| `feature-writer.js:973,995,1002-1019` (B8-B9) | Direct Read (this session) + Codex rounds 1-4 | Confirmed |
| `feature-writer.js:1075-1088` (B10) | Codex round 1 (finding 4) | Confirmed — GitHub-only branch, forgejo would collide without this |
| `feature-writer.js:1098` (B11) | Codex round 4 (finding 1) | Confirmed — fixed-field-list copy drops unlisted fields |
| `feature-writer.js:251-278,246` (B12) | Codex round 3 (finding 2) | Confirmed |
| `feature-writer.js:459,532,455-530` (completion/status split, informs B7/B16) | Codex round 2 (finding 1) + direct Read (this session, `:450-464`, `:480-555`) | Confirmed — this is the finding that drove the Piece 3 redesign |
| `completion-gate.js:643-661` (informs B16) | Codex round 2 (finding 1) + direct Read (this session) | Confirmed |
| `xref-citation.js:28,166,216` (B13-B14) | Codex round 1 (finding 4) | Confirmed |
| `feature-validator.js:892,917,943-949` (B15) | Codex rounds 1, 5 (finding 8, finding 4) | Confirmed |
| `xref-push.js:38,64-79,120,198-226,214-221` (B16-B17) | Codex rounds 1-3, 5 | Confirmed |
| `feature-json.schema.json:92-150` (B18) | Direct Read (this session, `:85-163`) | Confirmed — corrections table above records the one gap found (`expect_labels` not common) |
| `xref-push.js:221` (dry-run apply-guard precedent, informs B19) | Codex round 1 (finding 2) | Confirmed |
| `bin/compose.js:1555-1583` (B20) | Codex round 1 (finding 11, correcting an earlier wrong `:1138` citation) | Confirmed |
| `mcp-tool-defs.js:395-404,449-468`, `compose-mcp-tools.js:634`, `mcp-tool-policy.js:47-54` (B21-B22) | Codex rounds 1, 3 (finding 7, both rounds) | Confirmed |

**Zero stale entries.** The one wrong reference that ever appeared (`bin/compose.js:1138`, rev 1) was caught and corrected in rev 2 before reaching this blueprint.
