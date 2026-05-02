# 2026-05-02 — Session 31: Reconciling docs with code (COMP-DOCS-FACTS)

## What happened

Yesterday's COMP-DOCS-SLIM Codex review surfaced six pre-existing factual drift items that we deliberately preserved and filed as a follow-up ticket. Today we cashed it in.

The interesting part wasn't the first round of fixes — those were the obvious ones from yesterday's report (pipeline inventory, IR field name, retry count, removed MCP tool). The interesting part was that the *first* Codex review of the fixes flagged **five new** drift items. The second review flagged **three more**. Each round, we fixed the issues and ran another review until we got REVIEW CLEAN on iteration 3.

The cumulative finding list:

| Round | New issues found | What kind |
|---|---|---|
| Yesterday's COMP-DOCS-SLIM review | 6 | Original drift |
| Round 1 (after the 6 fixes) | 5 | Adjacent drift the first scan didn't surface |
| Round 2 (after those fixes) | 3 | Even-narrower drift |
| Round 3 | 0 | REVIEW CLEAN |

Round 1 caught: `compose build --dry-run` requires batch context; `--template` flag missing; `compose import` falsely claimed to feed `compose build`; `ideabox add --description` should be `--desc`; `ideabox list` doesn't take filters; `ideabox promote` is simpler than I described; `review`/`codex_review` retries documented wrong; `ReviewResult` contract incomplete; bug-fix steps wrong.

Round 2 caught: bisect step missing from bug-fix description; `review_check` shape still incomplete in the sub-flow narrative (we'd updated the contracts list but not the prose); `report_iteration_result` outcomes wrong in `mcp.md`.

The lesson is the same as yesterday's, just sharper: a Codex review pass on *one section* of docs surfaces drift in *adjacent* sections that wasn't on the original list. The drift we shipped to fix wasn't the only drift. Fixing made hidden drift visible. We could have gone for round 4 — Codex always finds something — but the round-3 finding rate was zero, which is the actual exit criterion.

## What we built

**Changed:**
- `compose/docs/cli.md` — expanded from 9 verbs to all 17 (added `roadmap`, `install`, `fix`, `triage`, `ideabox`, `qa-scope`, `gates`, `loops`); corrected `compose build` flag set including the batch-only `--dry-run` constraint, `--skip-triage`, `--cwd`, `--team`, `--template`; fixed `compose import` consumer claim; corrected `ideabox` add flag name and `promote`/`list` descriptions; added `bisect` step to `compose fix`.
- `compose/docs/pipelines.md` — corrected pipeline inventory to shipped 7 + the absent-but-expected `new.stratum.yaml`; fixed Stratum IR field name; corrected `review`/`codex_review` retry documentation; expanded `ReviewResult` to canonical shape; added `bisect` step to bug-fix lifecycle row.
- `compose/docs/mcp.md` — removed `agent_run` row + added deprecation note; corrected `report_iteration_result` outcome enum.
- `compose/docs/lifecycle.md` — corrected `review_check` retry default 10 → 5.
- `compose/CHANGELOG.md` — entry under 2026-05-02.

**Filed:**
- `COMP-NEW-PIPELINE-MISSING` (in `ROADMAP.md`) — `pipelines/new.stratum.yaml` is referenced by `bin/compose.js` and `lib/new.js` but isn't in the shipped package; `compose new` would error out today. Code/packaging fix, not docs.

## What we learned

1. **Drift is fractal.** Fixing one layer of factual drift in a doc surfaces another layer underneath. The first round of fixes *creates* the conditions for the next round to find more — closer examination, sharper claims, better surface area for comparison against code.

2. **`compose new` is broken in shipped builds.** The fact that we discovered this through *docs review* rather than usage tells us either nobody is running `compose new` against a fresh project right now, or the failure mode has been silently absorbed. Either way: COMP-NEW-PIPELINE-MISSING is the surprise of this session.

3. **Stop on zero, not on confidence.** We could have stopped at round 1 thinking "the obvious stuff is fixed." The exit criterion was `REVIEW CLEAN`, not "feels done." Round 3 finding zero things is what tells us we're actually done — not our intuition.

4. **`--description` vs `--desc` is the kind of thing only code can answer.** No amount of careful writing protects against flag-name drift. The only real source of truth is the handler.

## Open threads

- [ ] `COMP-NEW-PIPELINE-MISSING` — restore or reconstruct `pipelines/new.stratum.yaml`
- [ ] Consider adding a CI check that does what we did manually here: cross-reference doc claims against code (handler signatures, MCP tool definitions, pipeline step lists)

If you fix a thing, look again — it'll show you what else is wrong.
