# COMP-VERIFY-FLOW-1: plan

**Ruling:** C1 in `smart-memory-ops/units/OPS-VERIFY-CONFORM-1/report-significance.md` (row 16, BUILD NOW),
owner "agree all" 2026-11-17. Everything below is by the pass-3 author, not owner-set.
**Real-use notes (frozen first):** [real-use-notes.md](real-use-notes.md). Done = every case there gives its
right answer by hand.
**Value spike:** WAIVED (owner-ruled build on two own-use incidents, I17 and I18).
**Build brief:** [brief-build.md](brief-build.md).

## Goal

A project can declare a few user flows. When a change touches a flow, Compose runs it before the feature
becomes COMPLETE, checks the flow's frozen expected lines, records the run as evidence, and refuses
completion on a failure. Projects that declare nothing see no change.

## Decisions (default by the pass-3 author, not owner-set)

1. **Where flows are declared:** `.compose/compose.json` `verify.flows[]`, next to the existing
   `guard.testCommand` (read today by `server/lifecycle-guard.js:409` `guardTestCommand`). Fields: `id`,
   `command` (argv array, same shape as `guard.testCommand`), `covers` (path globs), `expect` (literal lines
   that must appear in stdout), `timeout_s` (default 600), optional `setup_exit_codes` (default `[127]`).
   Shape lives in a contract file: `contracts/verify-config.schema.json` (new).
2. **What Compose does and does not do:** Compose runs the project's command and judges its output. The
   project writes the flow (Playwright, a node script against its API, anything). Compose ships no browser
   driver and no agent that "explores" an app.
3. **Which flows run:** the ones whose `covers` match the completion's changed files; all of them when no
   file list is given (said in the output); none when no `verify` block exists.
4. **Pass rule:** exit 0 AND every `expect` line present. Anything else is `FLOW_FAILED`, except exit codes
   in `setup_exit_codes` or spawn errors (`FLOW_SETUP_ERROR`) and timeout (`FLOW_TIMEOUT`).
5. **Evidence:** each run writes one log under `.compose/data/verify/<feature>/<flow>-<ts>.log` and records
   an existing `command`-kind receipt (`contracts/evidence.schema.json:126`, `lib/evidence.js`
   `recordEvidence`), whose `output_line` is the last matched expect line. The completion record keeps the
   evidence ids.
6. **Where it is enforced:** in `lib/completion-gate.js`, at the same point the test command runs (outside
   the lock, `completion-gate.js` header note 3, and the `guardTestCommand` call sites at :326 and :952).
   `--tests-pass=true` never overrides a failed flow.

## Files

- `lib/completion-gate.js` (existing): select and run covering flows, refuse on failure, attach evidence ids.
- `lib/verify-flows.js` (new): load and validate `verify.flows`, glob matching, run with timeout and process
  group kill, judge output, write log, record evidence. Pure functions plus one runner.
- `lib/evidence.js` (existing): reuse `recordEvidence`; no new kind.
- `contracts/verify-config.schema.json` (new): the `verify` block.
- `bin/compose.js` (existing): `compose verify [--flow <id>] [--feature <CODE>] [--show <CODE>]`.
- `.claude/skills/compose/SKILL.md` (existing, :296-301 gate step 2 "E2E smoke test"): when the project
  declares flows, the step is `compose verify`; the Compose-repo-specific dev-server prose moves under
  "Compose's own repo".
- Dogfood, Compose's own repo: `.compose/compose.json` (existing) gains the two flows;
  `scripts/flows/pipeline-roundtrip.mjs` (new); `e2e/builder-save-blur.spec.js` (new);
  `@playwright/test` as a devDependency only (not in `npm test`).
- `docs/configuration.md`, `docs/cli.md`, `CHANGELOG.md`, `README.md` (existing): document it.

## Acceptance criteria

- [ ] Case 1 by hand on Compose's own repo: on a checkout of the pre-fix pipeline model (before
  COMP-PIPE-EDIT-EDGES-1), `compose verify --flow pipeline-roundtrip` FAILs naming `EDGES build 18`; on
  main it PASSes with 5 of 5 lines and prints an evidence id.
- [ ] Case 1 completion: `record-completion ... --tests-pass=true --files-changed-from-stdin` is refused with
  `FLOW_FAILED` on the pre-fix checkout and completes on main with the evidence id in the record.
- [ ] Case 2 by hand: with the I18 fix reverted locally, `compose verify --flow builder-save-blur` FAILs with
  the old id in `RELOADED id=`; on main it PASSes.
- [ ] Cases 3-9 each give the right answer from `real-use-notes.md`, pasted into `report.md` with the commands.
- [ ] A project with no `verify` block: `record-completion` output byte-identical to before (Case 3), shown
  by a diff of the two outputs.
- [ ] Timeout kills the process group: after Case 7 the flow's port is free (`lsof -i :<port>` empty).
- [ ] `contracts/verify-config.schema.json` validates the dogfood config; a config with an unknown field or
  a string `command` is refused at load with the field named.
- [ ] Real-backend tests for the runner (real child processes, no mocks of `spawn`): one table-driven file,
  one row per pass/refuse rule in Decision 4, under 30 rows.
- [ ] `docs/configuration.md`, `docs/cli.md`, `CHANGELOG.md` updated in the same commit as the code.

## Explicitly out

- No universal browser agent and no app-exploring agent. The project writes its flows.
- No new daemon, watcher or scheduler. Flows run only inside `compose verify` and the completion gate.
- Opt-in per project. No flow, no change. No default-on gate in any consumer.
- No old-versus-new comparison (that is COMP-VERIFY-DIFF-1, parked) and no setup preflight (that is
  COMP-SETUP-PREFLIGHT-1, built separately).
- No humans required to author every check; owners decide only when an expected answer is ambiguous.
