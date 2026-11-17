# Build brief: COMP-VERIFY-FLOW-1 (a project can prove a user flow before "done")

hard: new enforcement inside Compose's completion gate, plus two real UI/API dogfood flows
Model: opus. Repo: `/Users/ruze/reg/my/forge/compose`. Tier: logic change, one per-unit post-land review.

## Owner words (verbatim, 2026-11-17, to s1-chat)
"agree all" (to the ranked list in `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md`,
where C1 is BUILD NOW). Everything else in this brief is by the pass-3 author, not owner-set.

## Current state (written 2026-11-17; step 1 re-confirms each line)
- Feature filed PLANNED: `docs/features/COMP-VERIFY-FLOW-1/feature.json`, ROADMAP section "COMP-VERIFY".
- Completion today: `lib/completion-gate.js` (1475 lines) runs `guard.testCommand` from
  `.compose/compose.json` (`server/lifecycle-guard.js:409`) at :326 and :952; `--tests-pass` is the
  fallback. Nothing runs a user flow.
- Evidence: `lib/evidence.js` `recordEvidence` (:407) and a `command` kind
  (`contracts/evidence.schema.json:126`) that re-checks a claimed output line in a log.
- Skill: `.claude/skills/compose/SKILL.md:296-301` asks for an "E2E smoke test" in prose only.
- Compose has no Playwright installed (`node_modules/.bin` has none).

## Read first
1. `docs/features/COMP-VERIFY-FLOW-1/real-use-notes.md`: the frozen cases and right answers. **This is the
   definition of done.** Do not edit a case to fit the code; if one is wrong, stop and report it.
2. `docs/features/COMP-VERIFY-FLOW-1/plan.md`: decisions, files, acceptance criteria, what is out.
3. `lib/completion-gate.js` header (lines 1-60) for the lock and test-command rules.

## Do
1. Re-confirm the "Current state" lines (paste the greps into `report.md`).
2. `contracts/verify-config.schema.json` (new) and `lib/verify-flows.js` (new) per plan Decisions 1, 3-5.
3. Wire `lib/completion-gate.js` per Decision 6: select, run outside the lock, refuse with
   `FLOW_FAILED` / `FLOW_SETUP_ERROR` / `FLOW_TIMEOUT`, keep evidence ids in the completion record. A
   project with no `verify` block takes exactly today's path.
4. `compose verify` in `bin/compose.js` (`--flow`, `--feature`, `--show`).
5. Dogfood in Compose's own repo: the two flows in `.compose/compose.json`,
   `scripts/flows/pipeline-roundtrip.mjs`, `e2e/builder-save-blur.spec.js`, `@playwright/test` as a
   devDependency (use `npm install --save-dev`; never `npm ci`, never commit a `package-lock.json` change
   unless the repo already tracks it, check `git ls-files package-lock.json` first). Flows start servers on a
   throwaway workspace copy and a port checked with `~/.claude/scripts/port_check.py <port>` first.
6. Replay I17 and I18 by hand (plan AC 1-3): pre-fix checkout or local revert in a `.worktrees/` checkout,
   never on main's working tree.
7. Skill text, `docs/configuration.md`, `docs/cli.md`, `CHANGELOG.md`, `README.md` if it lists commands.
8. Tests: one table-driven real-process file for the runner (under 30 rows). Run only it and the existing
   completion-gate test files (`ls test | grep -i completion`), `-n`-style concurrency at most 4. Not the
   full suite.

## Reviewer checklist (given to the author up front)
- Does a project with no `verify` block get byte-identical output and behaviour?
- Can `--tests-pass=true` or any flag complete a feature whose covering flow failed?
- Is a flow killed with its whole process group on timeout, and is the port free after?
- Are `FLOW_SETUP_ERROR` and `FLOW_FAILED` distinguishable in text and in the completion refusal code?
- Does each evidence id re-verify (`compose` evidence CLI) against the log it names?
- Were real-use cases 1-9 run by hand and pasted with output, including both incident replays on broken
  and fixed code?

## Rules
No push, no merge to main: commit on a branch `comp-verify-flow-1` in a `.worktrees/` checkout; the
coordinator lands. No `--no-verify`, no `git stash`, no `pkill`, no sudo. Never print an environment or a
token. Sealed list: `smart-memory-ops/claude/rules/files-and-docs.md` ("Sealed list"), nothing more.
Small tool output (`> run.log 2>&1; tail -n 30 run.log`). Scratch under
`/Users/ruze/reg/my/SmartMemory/scratch/<date>-comp-verify-flow/`, deleted at the end.

## Report
`docs/features/COMP-VERIFY-FLOW-1/report.md`: plain-words TLDR, then each real-use case with the command
and its output, the two incident replays (broken and fixed), files changed, tests run with counts. Last
line, exactly:
`COMP-VERIFY-FLOW-1 cases_right=<n>/9 replays=<n>/2 tests=<pass>/<total> branch=<name> sha=<short> pushed=no`
