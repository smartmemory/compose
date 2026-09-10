# Slice 4 preset implementation

2026-09-10. Base Compose `53e3710`; read-only sibling Stratum `db8666c` (surface 20).
Implemented the brief; no engine/runner seam change was required.

Ruling: concurrency is the numeric literal `3`, overriding the design's input table.
Customize concurrency by copying the preset YAML and adjacent profiles sidecar.
`cost_ceiling_usd` remains a flow input; sidecar default is 150, overridden by `--cost-ceiling-usd`.

Implementation:
- Added `presets/team-fable-astra.stratum.yaml` and `.profiles.json`: plan → consumer/worktree execute → merge gate → verify → fresh read-only review → assess → output gate → ship.
- Carry starts at plan.tasks; assess revise carries Task[] before resetting execute and descendants. Merge revise preserves the wave. Verify explicitly follows execute_merge; both gates allow 2 revisions, flow total 4.
- Named Task/Verification/Finding contracts back TaskGraph, TaskResult, VerifyResult, ReviewFindings and WaveDecision. ShipResult matches the existing in-process ship envelope.
- Profiles pin Fable plan/assess, Sonnet verify, per-item Codex tiers and read-only Astra review; ownership, independence, checkpoints, decision validators and ceiling use the exact shipped sidecar shapes.
- MUST checklists cover independent waves, literal/disjoint ownership, tier guidance, verification evidence, cross-module wiring, every finding's disposition and affected-only repair.
- Reviewer receives description/criteria instructions, merged diff and VerifyResult, with no execute-output reference. Assess additionally receives current tasks and TaskResults.
- Registered `fable-astra` in `lib/team-flag.js`'s KNOWN_TEAMS constant. No production function changed: existing parser rewrites to team-fable-astra and resolveTemplatePath selects the bundled pair.
- Updated README, docs/pipelines.md, docs/cli.md, docs/team-presets.md, CHANGELOG Unreleased and a short source-review note in design.md. Historical roadmap/release entries remain historical.

Dialect decisions and corrections:
- TS supports named nested types, Task[]/Finding[], integer, boolean and pipe enums; no string-plus-ensure fallback needed (schema.ts and validate.ts parseContractType).
- Flow input contracts have no default-value syntax: declare `cost_ceiling_usd: number?`, use `_costCeiling.default: 150`. Accept optional role/pre-merge fields already supplied by feature-mode startFresh.
- Scalar implications use `||`/`&&`. Static validation accepted `or`/`and`, but the first runtime assess failed; corrected to the actual expr.ts dialect and reran the golden successfully.
- VerifyResult uses boolean tests_pass, command/outcome arrays and merged_diff. Failed verification reaches review/assess for repair instead of failing a tests_pass ensure before the loop can decide.
- New merged files remain untracked before ship, so verification captures tracked diff PLUS added-file diffs; the golden exercises this case. No production workaround added.

Real validator (exit 0), command:
```bash
node ../stratum/ts/src/cli/bin.mjs validate presets/team-fable-astra.stratum.yaml
```
Actual combined output (`/tmp/s4-validate.log`):
```text
(node:62723) ExperimentalWarning: Transform Types is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
{"valid":true}
```

Validation:
```bash
node --test --test-timeout=300000 test/profile-preflight.test.js test/build-team-fable-astra.test.js test/build-wave-routing.test.js test/build-output-gate.test.js > /tmp/s4.log 2>&1; echo $?
```
Output: `0`. 65 tests passed, 0 failed/cancelled/skipped; 20.656s. Auto-discovery includes the new bundled sidecar/preset.
- `node --test test/team-cli.test.js`: exit 0, 10/10 passed (`/tmp/s4-team-cli.log`).
- `node --check test/build-team-fable-astra.test.js` and `git diff --check`: passed.
- New golden uses the unmodified bundled YAML/sidecar in feature-mode runBuild, d2 fakeBuildStratum/agentResult/decision fixtures, real MCP engine and real Codex connector invoking a fake executable. Claude outputs are recorded fixtures; verify actually runs the disposable unit test and captures diff.
- Assertions prove both approve gates, completed flow, succeeded ship, exactly one checkpoint, one base-parent commit, identical checkpoint/ship trees, no wave commit in ancestry, unchanged sentinel, exactly one worker/reviewer call, model routes, read-only sandbox and absence of worker-summary sentinel in the actual review prompt.
- Smoke scope is flow completion/ship, not feature-registry promotion: the disposable fixture has no registered roadmap feature. No live inference or installed-package parity is claimed.

Slice 6 still must prove ALL design Completion evidence on a live installed run:
1. Fable plan/assess and Astra review identities; mixed-tier worker receipts and unknown-tier zero dispatch; invalid/unavailable sidecar failure before dispatch.
2. Independent worker overlap in wall time; wave-2 prerequisite visibility from wave-1 checkpoint; named out-of-ownership refusal.
3. Seeded cross-module defect despite green unit tests, affected-only repair, no repeat dispatch/remerge of accepted unaffected work.
4. Execute/merge kill-resume exactly-once application; mid-wave cancellation stops workers and excludes cancelled patches.
5. Exhausted assess rounds and blocked decisions end failed with open findings; cost hold followed by explicit human revise after raising the ceiling.
6. Post-checkpoint/pre-cleanup kill/restart reconciles one checkpoint without reapplication; completed ship has one base-parent commit; clean global-install parity.

No Git commit, npm install, full-suite run, GUI launch or sibling write. Only lib/ change is the team-name constant; no production function edits. Existing brief/progress edits and unrelated audit.json preserved. Stratum needs a release with surface-20/cost fixes before Compose ships.

## Fixes r1
- Added exported `requirePipelineSidecar`, called in `runBuild` immediately after spec resolution/existence checking, before profile loading or any plan/flow.
- General basename rule covers bundled presets and pipelines; missing required local sidecars raise `PROFILE_SIDECAR_REQUIRED` with the copy-both-files guidance. Custom specs and counterparts without sidecars remain unchanged.
- Unit coverage checks YAML/YML names, preset/pipeline pairs, bundled paths, present sidecars, optional cases, and real `runBuild` rejection with zero plan/resume/agent calls.
- Moved cost-ceiling extraction before team positional counting; CLI capture regressions prove both value spellings pass numeric 200 to one `runBuild('X', ...)`, while `X Y --team fable-astra` is refused.
- Updated team/pipeline documentation and team-feature/init comments; synthetic golden `build` fixtures now supply explicit empty sidecars.
- Runtime reviewer probe: `node /tmp/slice4-runtime.mjs missing` exits 0 (probe catches refusal); `/tmp/slice4-missing.json` records the named error, null audit, zero calls/PIDs and unchanged HEAD (zero commits).
- Original CLI probe directory was empty: literal rerun passed team parsing, then refused the missing workspace. Recreated minimal X workspace and reran with a runBuild capture loader: exit 0, one call `{featureCode:"X", options:{abort:false,template:"team-fable-astra",costCeilingUsd:200}}` (`/tmp/slice4-cli-calls.jsonl`). No live inference.
- Requested five-file command: exit 0; 77 tests passed, 0 failed/cancelled/skipped (5 suites, 20.406s), `/tmp/s4-fix.log`.
- `git diff --check` passed. No full suite, Git commit, GUI launch, or sibling write; prior uncommitted work preserved.
