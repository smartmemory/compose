---
date: 2026-07-18
session_number: 90
slug: merge-day-ts-cutover-lands-on-main
summary: "MERGE DAY: the TS cutover lands on main in both repos — atomic develop→main, python tree deleted from stratum, archives published; STRAT-PY-RETIRE is CLOSED"
feature_code: STRAT-PY-RETIRE
closing_line: We spent a week teaching the new engine everything the old one knew, and today we buried the teacher.
---

# Session 90 — STRAT-PY-RETIRE

**Date:** 2026-07-18
**Feature:** `STRAT-PY-RETIRE`

## What happened

The owner called merge day. Everything the epic built over the last week — the TS engine as sole engine, the python execution path deleted from compose, 4,674 tests — had been sitting on local develop branches, unpushed, waiting for this call.

It wasn't a pure fast-forward. While the cutover lived on develop, compose main had quietly gained twelve commits of its own: the whole COMP-TRIAGE-5 feature (E3 front-seam scope estimation + verification-gated escalation, session 86), a validate downgrade, a rules trim. So merge day started with a reconciliation merge of main INTO develop. Three conflicts: two mechanical doc unions, and one real one — `lib/build.js` imports, where TRIAGE-5's lane-gate wiring met the cutover's engine rewrite. The resolution needed actual archaeology: main's import block wanted `shouldRunCrossModel`, but its only caller (`runCrossModelReview`) had been consciously deleted in the endgame commit — cross-model review is engine-native on the TS path now. Body usage decided the imports; TRIAGE-5's own test pack then ran 71/71 against the TS engine it had never met, and the full suite came back 4674/4674 first try.

Stratum's merge-day housekeeping was the emotional beat: `git rm` of the python tree. 260 files, −80,939 lines — stratum-py, the python MCP server, their tests, the packaging. Three tests broke, each a small honest reckoning with what deletion means: a linter test that swept the python suites for embedded v0 fixtures (corpus gone — sweep retired, docs corpus kept), and two guard tests that spawned live python to verify TS-written ledgers (retired; byte parity stays pinned by captured goldens and the committed python-written fixture, which covers the direction that still matters — TS reading python-era history). Then the pre-push hook itself refused the push: it existed to bump the PyPI packages' versions, and both files it bumped were gone. We retired the hook rather than repoint it — TS versioning is a real future decision, not merge-day debris.

Then the flip: fast-forward main to develop in both repos, push main + develop + `python-legacy` archive branches + `pre-ts-cutover` freeze tags. Compose's pre-push hook re-ran the full suite on the way out — green. Stratum's branch protection printed its PR warning and let smartmem-dev through. Both repos flipped within a minute of each other. The epic that started 2026-07-11 is closed.

## What we built

- `compose@219b407` — merge commit: main (COMP-TRIAGE-5 + docs) reconciled into the cutover develop; main and develop both point here now.
- `stratum@6e222b3` — the python tree deletion (src/stratum/, stratum-mcp/, tests/, pyproject.toml; 260 files, −80,939 lines) + same-commit test retirements (migrate/check fixture sweep; two live cross-engine guard tests → one TS round-trip acceptance) + CLAUDE.md repo map rewrite.
- `stratum@4c4f591` — pre-push PyPI auto-bump hook retired; stratum main/develop both point here.
- Published archives in both repos: `python-legacy` branches (compose `cc390a7`, stratum `642dda3` — NEVER delete) and `pre-ts-cutover` freeze tags (compose `869a55b`, stratum `a1ea4ed`).
- Ledger closure entry in stratum `docs/plans/2026-07-11-strat-py-retire-progress.md` (MERGE DAY section).

## What we learned

1. **A frozen main is never actually frozen.** The migration-branch model assumed main held still as the fallback; it grew a whole feature instead. The reconciliation cost was small only because we probed it honestly first (merge-tree dry run, then body-usage archaeology on the one real conflict) instead of assuming develop strictly superseded main.
2. **Deletions keep deleting after the commit.** The python tree took three tests and a git hook down with it, each discovered by running the thing, not by grepping for imports. The hook was the sneakiest: it only fired on push-to-main, so it survived every local suite run and ambushed the actual merge-day push.
3. **Retire parity tests in the right direction.** Live "TS writes → python verifies" dies with python; "TS reads python-written bytes" lives forever as goldens, because history is the thing you must stay compatible with.
4. **Same-commit fallout policy pays off.** Folding test retirements into the deletion commit means the tree is suite-green at every merge-day SHA — nobody bisecting later lands on a red python-less intermediate.

## Open threads

- [ ] PyPI deprecation of `stratum-py` + `stratum-mcp` (D6): archiving is web-UI-only — owner action.
- [ ] stratum #18 — workspace-write bg agent mode (run/poll/cancel + claude allowlists); the real fix for the accepted GSD mid-fanout abort boundary.
- [ ] stratum #19 — deterministic test-judge backend.
- [ ] 3 vacuous CLI-validation tests in `test/compose-fix-resume.test.js` (~192-246): wire to real bin validation or delete.
- [ ] TS engine versioning story (ts/package.json + server.ts are placeholder 0.0.1) — decide when/if npm publishing starts.
- [ ] DEP0205 module.register() deprecation warning in ts CLI bootstrap — track before it breaks a node major.

---

*We spent a week teaching the new engine everything the old one knew, and today we buried the teacher.*
