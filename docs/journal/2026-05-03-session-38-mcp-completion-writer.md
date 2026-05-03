---
date: 2026-05-03
session_number: 38
slug: mcp-completion-writer
summary: Completion writer ships (COMP-MCP-COMPLETION)
feature_code: COMP-MCP-COMPLETION
closing_line: Seven doc-review rounds before code is two too few when the contract has fourteen edges.
---

# Session 38 — COMP-MCP-COMPLETION

**Date:** 2026-05-03
**Feature:** `COMP-MCP-COMPLETION`

## What happened

Sub-ticket #5 of the writer family — typed commit-bound completion records plus an opt-in git post-commit hook.

The pre-code review went seven rounds. Round 1 caught seven contract issues (full-SHA identity, ROADMAP-partial-write status-flip subcase, concurrency claims unsupported by storage, complete_feature split-brain, hook calling `compose` from PATH, files_changed path validation, schema drift on feature_code in records). Each subsequent round caught spec drift I'd left behind in the previous fix sweep — round 2 caught `unknownSections` map-vs-array; rounds 3–6 each caught one more leftover wording. Fourteen total findings on documents alone before any code was written.

Implementation review went two more rounds. Round 1 caught the hook's substring-based qualifier parser would mis-parse `notes="follow-up: tests_pass=false"`, the read-side accepting <4-char SHA prefixes despite the contract floor, and missing `feature_code: null` normalization for legacy records. All three were real bugs that would have shipped.

The cross-cutting wrapper from journal-writer (`err.cause` propagation) earned its keep here: `STATUS_FLIP_AFTER_COMPLETION_RECORDED` carries three documented subcases via `err.cause`, including the subtle `ROADMAP_PARTIAL_WRITE` case where the status WAS flipped on disk but ROADMAP regen failed. The MCP wrapper serialized them all without changes.

Self-application worked first try: this ROADMAP row, this CHANGELOG entry, this journal entry, and the completion record itself were all written by the new tools, dogfooded from a single `/tmp/dogfood-completion.mjs` script.

## What we built

- `compose/lib/completion-writer.js` — `recordCompletion` (validation, full-SHA identity, per-feature lock, write-record, conditional set_feature_status with three failure subcases, audit append) and `getCompletions` (filter by feature/sha-prefix-≥4/since/limit; `feature_code: null` for legacy records).
- `compose/bin/git-hooks/post-commit.template` — hook template with `__COMPOSE_NODE__` / `__COMPOSE_BIN__` placeholders. Tokenized qualifier parsing (notes-extracted-first), unknown qualifiers warn-and-log.
- `compose/bin/compose.js` — `record-completion` and `hooks {install,uninstall,status}` subcommands. Hand-rolled flag parser. `hooks install` reads the template, substitutes `process.execPath` and the absolute path of `bin/compose.js`, writes to `.git/hooks/post-commit` mode 0755, refuses foreign hooks without `--force`.
- `compose/server/compose-mcp{,-tools}.js` — two new MCP tools registered.
- 80 new tests including: full-SHA write rejection, per-feature lock concurrency (`Promise.all` across two SHAs), ROADMAP_PARTIAL_WRITE status-flip subcase, hook `tests_pass` regression test (`notes="follow-up: tests_pass=false"` correctly stays `true`), `<4`-char read-prefix rejection, legacy `feature_code: null` normalization, PATH-independent hook test (`env -i PATH=/usr/bin` with stubbed `git`).
- `compose/docs/mcp.md` Completion writer section; `compose/docs/cli.md` `record-completion` + `hooks` docs.
- `docs/features/COMP-MCP-FEATURE-MGMT/design.md` — pointer to canonical contract.
- Self-applied: `compose/CHANGELOG.md`, `compose/docs/journal/2026-05-03-session-38-mcp-completion-writer.md`, `feature.json` for COMP-MCP-COMPLETION (with completion record + status flipped to COMPLETE), `/Users/ruze/reg/my/forge/ROADMAP.md` row.

## What we learned

1. **Doc-review rounds compound nonlinearly when the contract has many edges.** Seven rounds on three docs caught 14 issues, but each fix introduced one more drift the next round caught. The unit of decay isn't "one issue per round" — it's "one issue per axis of the contract that ever changed." When tightening the SHA contract from 7-40 chars to "full only," every mention of "short SHA" anywhere in any doc had to be hunted down. Mechanical sweep tools would help; for now, a final grep-pass before declaring a doc-review done is cheap insurance.

2. **Cross-cutting wrapper investments pay forward.** The `err.cause` propagation added with COMP-MCP-JOURNAL-WRITER let COMP-MCP-COMPLETION expose three distinct failure subcases through one error code without any wrapper changes. `STATUS_FLIP_AFTER_COMPLETION_RECORDED` with `err.cause.code === 'ROADMAP_PARTIAL_WRITE'` is observable across the MCP boundary entirely because of work shipped two sessions ago.

3. **Hook PATH-independence requires install-time substitution.** A hook script that calls `compose` works when you test it from a shell with `compose` on PATH. It fails silently in a real git hook environment, which has a minimal PATH. The first round of testing nearly missed this — the test was using `bash <hook>` from the parent shell. The fix was to install the hook into a tmp git repo (so the substitution actually happens) AND spawn it with `env -i PATH=/usr/bin` to mirror the real hook environment. Without both halves of that test, the regression would have shipped.

4. **Per-feature locks have to be writer-scoped, not framework-wide.** The completion writer takes its own advisory lock so two parallel completion calls serialize cleanly. Sibling writers don't take it, so a parallel `linkArtifact` can still race against a parallel `recordCompletion` at the `updateFeature` layer. The honest documentation of this — "lock covers parallel `record_completion` calls only; sibling-writer races are a pre-existing hazard" — is more valuable than overstating the guarantee.

## Open threads

- [ ] Three writer sub-tickets remain in the family: `COMP-MCP-FOLLOWUP`, `COMP-MCP-VALIDATE`, plus `COMP-MCP-MIGRATION` to retire free-text writers and reconcile `complete_feature` with `record_completion`.
- [ ] Per-feature lock at the `updateFeature` layer would eliminate the sibling-writer race for the whole family. Out of scope for this ticket; file as cross-cutting follow-up if it bites.
- [ ] `COMP-MCP-VALIDATE` should warn on completion records with `tests_pass: false` against features whose status is `COMPLETE` — that's a smell.
- [ ] The post-commit hook is opt-in via `compose hooks install`. Compose's own repo could install it as part of `compose init` once the family stabilizes.

---

*Seven doc-review rounds before code is two too few when the contract has fourteen edges.*
