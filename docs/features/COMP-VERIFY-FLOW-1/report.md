# COMP-VERIFY-FLOW-1 report: a project can prove a user flow before "done"

## TLDR (plain words)

**Compose can now refuse to call a feature finished until a scripted user walk-through has actually worked.**
A project lists its user flows in its config (a command, which files it covers, which lines it must print).
When a feature is marked complete, Compose runs the flows that cover the changed files and refuses if one
fails, no matter what the "tests pass" flag says. A pass leaves a receipt anyone can re-check later.
Compose itself declares two flows, and both were replayed against the real incidents: each one fails on the
code from before the fix and passes on the fix. A project that declares no flows sees exactly the same output
as before, byte for byte.

One thing the coordinator must do on landing: main's `node_modules` has no Playwright, so until
`@playwright/test` 1.65.1 is installed there, Compose's own completions touching the builder pane are
refused as a setup error (by design: "nothing was tested", not "the product failed").

## Setup for every hand run

- CLI: the branch's `bin/compose.js` (`.worktrees/comp-verify-flow-1`), run with cwd = the target checkout.
- `COMPOSE_PORT` set to a dead port, so the completion gate's vision projector never reaches the owner's live
  cockpit on :4001.
- `COMPOSE_EVIDENCE_STORE` = a scratch store, so replay receipts never land in `~/.compose/evidence.jsonl`.
- `SM_SCRATCH_ROOT` = the scratch dir (flow sandboxes and Playwright results go there, then are deleted).
- Replays ran in detached checkouts under `.worktrees/` (never main's tree): `replay-i17-broken` at
  `adaba422` (= `5f1e119d^`), `replay-i17-fixed` at `5f1e119d`, `replay-i18-broken` at `b64d1d0d`
  (= `b8b761d7^`), `replay-i18-fixed` at `b8b761d7`, `replay-cases` at the branch commit. Each got local,
  uncommitted fixtures: the flow files, a `verify` block, `capabilities.guard=false`, and a feature.json in
  IN_PROGRESS where a completion was recorded. All removed at the end.
- The `WARN: phase "..." override ... diverges from rollup` lines and `[smartmemory] ingest failed
  (fail-open)` are the repo's own roadmap and SmartMemory noise, printed by today's main too; they are
  filtered out of the pastes below (count noted).

## Current state re-confirmed (step 1)

Branch `comp-verify-flow-1` off main `6815c7f7`. Before the change: no `verify` key in
`.compose/compose.json`, no `lib/verify-flows.js`, no `compose verify` command in `lib/cli-commands.js`,
`completion-gate.js` had no flow step, and the skill's gate step 2 named a dev server on fixed ports.

## Real-use cases (`real-use-notes.md`)

### Case 1 (replays I17): pipeline editor round-trip

Broken code (`replay-i17-broken`, pre-fix), `compose verify --flow pipeline-roundtrip`:
```
$ compose verify --flow pipeline-roundtrip   # cwd=.worktrees/replay-i17-broken (5f1e119d^)
verify: running pipeline-roundtrip (timeout 300 s)
FAIL pipeline-roundtrip: FLOW_FAILED, missing expected line "EDGES build 18" (output had "EDGES build 0"), 4 more missing, exit 0
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-broken/.compose/data/verify/_adhoc/pipeline-roundtrip-2026-11-17T04-39-32-946Z.log
exit=1
```
Key lines from that flow's log (the exact I17 symptoms: no edges read, the edit saved under the wrong key):
```
# replay-i17-broken: pipeline-roundtrip-2026-11-17T04-39-32-946Z.log
EDGES bug-fix 0
EDGES build-quick 0
EDGES build 0
EDGES content 0
EDGES coverage-sweep 0
EDGES gsd 0
EDGES new 0
EDGES plan 0
EDGES refactor 0
EDGES research 0
EDGES review-fix 0
EDGES total 0
EDIT build 1
KEY depends_on
# exit=0 signal=null timed_out=false duration_ms=1293
```
Completion on the broken code (`git diff --name-only 5f1e119d^..5f1e119d | compose record-completion
COMP-PIPE-EDIT-EDGES-1 --commit-sha=<adaba422, 40 hex> --tests-pass=true --files-changed-from-stdin`):
```
$ git diff --name-only 5f1e119d^..5f1e119d | compose record-completion COMP-PIPE-EDIT-EDGES-1 --commit-sha=adaba422f0361942f0071823a37f300612a29a03 --tests-pass=true --files-changed-from-stdin   # cwd=replay-i17-broken
verify: 1 of 1 declared flow cover the 5 changed files: pipeline-roundtrip
verify: running pipeline-roundtrip (timeout 300 s)
FAIL pipeline-roundtrip: FLOW_FAILED, missing expected line "EDGES build 18" (output had "EDGES build 0"), 4 more missing, exit 0
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-broken/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-42-869Z.log
Refused at verify:
  - FLOW_FAILED pipeline-roundtrip: missing expected line "EDGES build 18" (output had "EDGES build 0"), 4 more missing, exit 0; log /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-broken/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-42-869Z.log
exit=1
status now: "status": "IN_PROGRESS"
```
Fixed code (`replay-i17-fixed`, `5f1e119d`), standalone:
```
$ compose verify --flow pipeline-roundtrip   # cwd=replay-i17-fixed (5f1e119d)
verify: running pipeline-roundtrip (timeout 300 s)
PASS pipeline-roundtrip (5 of 5 expected lines) ev:92394078de0ed06f
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-fixed/.compose/data/verify/_adhoc/pipeline-roundtrip-2026-11-17T04-39-46-559Z.log
exit=0
```
```
# replay-i17-fixed: pipeline-roundtrip-2026-11-17T04-39-46-559Z.log
EDGES bug-fix 8
EDGES build-quick 12
EDGES build 18
EDGES content 3
EDGES coverage-sweep 0
EDGES gsd 2
EDGES new 5
EDGES plan 4
EDGES refactor 6
EDGES research 2
EDGES review-fix 2
EDGES total 62
EDIT build 19
KEY after
# exit=0 signal=null timed_out=false duration_ms=1356
```
Completion on the fixed code (same command, `--commit-sha=5f1e119d…`):
```
$ git diff --name-only 5f1e119d^..5f1e119d | compose record-completion COMP-PIPE-EDIT-EDGES-1 --commit-sha=5f1e119d0fa92d031b0a1e094ad47e9e32dff91b --tests-pass=true --files-changed-from-stdin   # cwd=replay-i17-fixed
verify: 1 of 1 declared flow cover the 5 changed files: pipeline-roundtrip
verify: running pipeline-roundtrip (timeout 300 s)
PASS pipeline-roundtrip (5 of 5 expected lines) ev:38c02edef960d067
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-fixed/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-44-629Z.log
{
  "completion_id": "COMP-PIPE-EDIT-EDGES-1:5f1e119d0fa92d031b0a1e094ad47e9e32dff91b",
  "idempotent": false,
  "status_changed": {
    "from": "IN_PROGRESS",
    "to": "COMPLETE"
  }
}
exit=0
status now: "status": "COMPLETE"
(23 roadmap/SmartMemory noise lines filtered)
```
Branch code (`compose verify --flow pipeline-roundtrip` in the branch checkout):
```
verify: running pipeline-roundtrip (timeout 300 s)
PASS pipeline-roundtrip (5 of 5 expected lines) ev:4083b7c26d8fa579
  log: /Users/ruze/reg/my/forge/compose/.worktrees/comp-verify-flow-1/.compose/data/verify/_adhoc/pipeline-roundtrip-2026-11-17T04-38-52-098Z.log
exit=0
```
**Right:** FAIL naming `EDGES build 18` on the broken code, refused completion with status unchanged; PASS
5 of 5 with an evidence id on the fix and on the branch, completion IN_PROGRESS → COMPLETE.

### Case 2 (replays I18): builder Save misses an edit committed on blur

Broken code (`replay-i18-broken`, `b8b761d7^`), `compose verify --flow builder-save-blur`:
```
verify: running builder-save-blur (timeout 300 s)
FAIL builder-save-blur: FLOW_FAILED, missing expected line "RELOADED id=renamed-step" (output had "RELOADED id=draft-step"), exit 0
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i18-broken/.compose/data/verify/_adhoc/builder-save-blur-2026-11-17T04-50-51-647Z.log
```
```
# replay-i18-broken: builder-save-blur-2026-11-17T04-50-51-647Z.log
RELOADED id=draft-step
  1 passed (7.7s)
# exit=0 signal=null timed_out=false duration_ms=8100
```
Fixed code (`replay-i18-fixed`, `b8b761d7`):
```
verify: running builder-save-blur (timeout 300 s)
PASS builder-save-blur (1 of 1 expected lines) ev:c8601882a74f2618
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i18-fixed/.compose/data/verify/_adhoc/builder-save-blur-2026-11-17T04-51-07-254Z.log
```
```
# replay-i18-fixed: builder-save-blur-2026-11-17T04-51-07-254Z.log
RELOADED id=renamed-step
  1 passed (7.4s)
# exit=0 signal=null timed_out=false duration_ms=7772
```
**Right:** `FAIL builder-save-blur`, output had `RELOADED id=draft-step` (the old id) on the broken code;
PASS on the fix. The flow (Playwright, headless) opens the saved pipeline in the cockpit, clicks the step,
types `renamed-step` into the id field, pauses 600 ms, clicks Save without Tab or clicking elsewhere,
reloads, reopens and prints `RELOADED id=<value>`.

### Case 3: a project that declares no flows sees no change

Two identical throwaway git projects (same commit sha via fixed author/committer dates), no `verify`
block; main's CLI in one, the branch CLI in the other:
```
$ compose record-completion FEAT-1 --commit-sha=<same 40 hex> --tests-pass=true   # main CLI in c3-main, branch CLI in c3-branch
main exit=0, branch exit=0
cmp stdout: identical (171 bytes)
cmp stderr: identical (0 bytes)
feature.json identical except recorded_at
stdout:
{
  "completion_id": "FEAT-1:4224df576779995a3903fb492cffd871ec90e4f4",
  "idempotent": false,
  "status_changed": {
    "from": "IN_PROGRESS",
    "to": "COMPLETE"
  }
}
```
**Right:** stdout and stderr byte-identical (`cmp`), feature.json identical apart from `recorded_at`, same
file tree (no `.compose/data/verify` created).

### Case 4: the change does not touch any declared flow

`printf 'docs/cli.md\nlib/version-check.js\n' | compose record-completion FEAT-4 --commit-sha=<40 hex>
--tests-pass=true --files-changed-from-stdin` (`replay-cases`, both flows declared):
```
verify: no declared flow covers the 2 changed files
(23 roadmap/SmartMemory noise lines filtered)
{
  "completion_id": "FEAT-4:5a2548615b552a5d2b7e5f7d4987a960326fe441",
  "idempotent": false,
  "status_changed": {
    "from": "IN_PROGRESS",
    "to": "COMPLETE"
  }
}
```
**Right:** completion proceeds, one line `verify: no declared flow covers the 2 changed files`, no flow runs.

### Case 5: no changed-file list is given

`compose record-completion FEAT-5 --commit-sha=<40 hex> --tests-pass=true` (no file list):
```
verify: no changed-file list, running all 2 declared flows
verify: running pipeline-roundtrip (timeout 300 s)
PASS pipeline-roundtrip (5 of 5 expected lines) ev:36ad902e6ab1ed4c
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-cases/.compose/data/verify/FEAT-5/pipeline-roundtrip-2026-11-17T04-52-08-456Z.log
verify: running builder-save-blur (timeout 300 s)
PASS builder-save-blur (1 of 1 expected lines) ev:0b4812b801d29ae8
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-cases/.compose/data/verify/FEAT-5/builder-save-blur-2026-11-17T04-52-09-789Z.log
(23 roadmap/SmartMemory noise lines filtered)
{
  "completion_id": "FEAT-5:5a2548615b552a5d2b7e5f7d4987a960326fe441",
  "idempotent": false,
  "status_changed": {
    "from": "IN_PROGRESS",
    "to": "COMPLETE"
  }
}
```
**Right:** `verify: no changed-file list, running all 2 declared flows`, both run and pass, COMPLETE with
2 `verify_flows` entries in the record.

### Case 6: the flow cannot start (setup error, not product failure)

Playwright not installed (the `replay-cases` checkout without `node_modules`),
`printf 'src/components/cockpit/StratumBuilderPane.jsx\n' | compose record-completion FEAT-6 … --files-changed-from-stdin`:
```
verify: 1 of 2 declared flows cover the 1 changed file: builder-save-blur
verify: running builder-save-blur (timeout 300 s)
SETUP-ERROR builder-save-blur: FLOW_SETUP_ERROR, nothing was tested: the flow could not start: spawn node_modules/.bin/playwright ENOENT
  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-cases/.compose/data/verify/FEAT-6/builder-save-blur-2026-11-17T04-52-23-931Z.log
Refused at verify:
  - FLOW_SETUP_ERROR builder-save-blur: setup problem, nothing was tested (the flow could not start: spawn node_modules/.bin/playwright ENOENT); log /Users/ruze/reg/my/forge/compose/.worktrees/replay-cases/.compose/data/verify/FEAT-6/builder-save-blur-2026-11-17T04-52-23-931Z.log
```
And the declared setup exit code (a flow that prints `SETUP: …` and exits 3, `setup_exit_codes: [3, 127]`):
```
verify: 1 of 4 declared flows cover the 1 changed file: setup-code
verify: running setup-code (timeout 600 s)
SETUP-ERROR setup-code: FLOW_SETUP_ERROR, nothing was tested: the flow could not start (exit 3): SETUP: no free port in 19000-19999 after 30 tries
  log: /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-6B/setup-code-2026-11-17T04-52-47-102Z.log
Refused at verify:
  - FLOW_SETUP_ERROR setup-code: setup problem, nothing was tested (the flow could not start (exit 3): SETUP: no free port in 19000-19999 after 30 tries); log /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-6B/setup-code-2026-11-17T04-52-47-102Z.log
```
**Right:** refused with `FLOW_SETUP_ERROR <id>` and the first stderr line, worded "setup problem, nothing
was tested", different from `FLOW_FAILED`; status stays IN_PROGRESS.

### Case 7: the flow hangs

A throwaway project whose flow starts a child server on port 19417 and never finishes, `timeout_s: 3`:
```
verify: 1 of 4 declared flows cover the 1 changed file: hangs
verify: running hangs (timeout 3 s)
TIMEOUT hangs: FLOW_TIMEOUT hangs after 3 s, its process group was killed
  log: /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-7/hangs-2026-11-17T04-52-43-613Z.log
Refused at verify:
  - FLOW_TIMEOUT hangs after 3 s: its process group was killed; log /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-7/hangs-2026-11-17T04-52-43-613Z.log
```
Its log:
```
# compose verify flow=hangs command=["node","hang.mjs"] cwd=/Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78 started=2026-11-17T04:52:43.614Z timeout_s=3
flow started, waiting forever
child server on 19417
# FLOW_TIMEOUT after 3 s: SIGTERM to process group 76892
# exit=null signal=SIGTERM timed_out=true duration_ms=3006
```
`lsof -nP -i :19417` right after: empty (exit 1); `ps` shows no process listening on it (0).
**Right:** whole process group killed (the child server too), `FLOW_TIMEOUT hangs after 3 s` with the log
path, no orphan on the port, status unchanged.

### Case 8: exit code and expected lines disagree

Exit 0 without the expected line:
```
verify: 1 of 4 declared flows cover the 1 changed file: exit0-missing
verify: running exit0-missing (timeout 600 s)
FAIL exit0-missing: FLOW_FAILED, missing expected line "EDGES build 18" (output had "EDGES build 0"), exit 0
  log: /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-8A/exit0-missing-2026-11-17T04-52-46-815Z.log
Refused at verify:
  - FLOW_FAILED exit0-missing: missing expected line "EDGES build 18" (output had "EDGES build 0"), exit 0; log /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-8A/exit0-missing-2026-11-17T04-52-46-815Z.log
```
Exit 1 with every expected line present:
```
verify: 1 of 4 declared flows cover the 1 changed file: exit1-all-present
verify: running exit1-all-present (timeout 600 s)
FAIL exit1-all-present: FLOW_FAILED, exit 1 with all 1 expected lines present: a failing exit is never a pass
  log: /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-8B/exit1-all-present-2026-11-17T04-52-46-962Z.log
Refused at verify:
  - FLOW_FAILED exit1-all-present: exit 1 with all 1 expected lines present: a failing exit is never a pass; log /Users/ruze/reg/my/SmartMemory/scratch/2026-11-17-comp-verify-flow/cases78/.compose/data/verify/FEAT-8B/exit1-all-present-2026-11-17T04-52-46-962Z.log
```
**Right:** both `FLOW_FAILED`, both refused, status unchanged.

### Case 9: a later reader checks what was proved

```
$ compose verify --show COMP-PIPE-EDIT-EDGES-1   # cwd=replay-i17-fixed
COMP-PIPE-EDIT-EDGES-1: latest completion COMP-PIPE-EDIT-EDGES-1:5f1e119d0fa92d031b0a1e094ad47e9e32dff91b recorded 2026-11-17T04:39:45.790Z
  PASS pipeline-roundtrip  ev:38c02edef960d067  commit 5f1e119d0fa92d031b0a1e094ad47e9e32dff91b
    log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-fixed/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-44-629Z.log
    receipt: ev:38c02edef960d067 re-checked: "KEY after" is in /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-fixed/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-44-629Z.log
exit=0
$ compose verify --show COMP-PIPE-EDIT-EDGES-1   # cwd=replay-i17-broken
COMP-PIPE-EDIT-EDGES-1: no completion recorded
  later runs not bound to a completion (1):
    FAIL pipeline-roundtrip FLOW_FAILED  2026-11-17T04:39:42.869Z  log: /Users/ruze/reg/my/forge/compose/.worktrees/replay-i17-broken/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-42-869Z.log
exit=0
```
Each receipt re-verified through the existing evidence code (`lib/evidence.js` `verifyEvidence`, the
`command` kind: the claimed line is found in the log), read-only, all 8 receipts this build minted:
```
e v : 4 0 8 3 b 7 c 2 6 d 8 f a 5 7 9 | PASS | verify-flow:pipeline-roundtrip | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/comp-v
e v : 3 8 c 0 2 e d e f 9 6 0 d 0 6 7 | PASS pipeline-roundtrip | COMP-PIPE-EDIT-EDGES-1 | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/replay
e v : 9 2 3 9 4 0 7 8 d e 0 e d 0 6 f | PASS | verify-flow:pipeline-roundtrip | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/replay
e v : c 8 6 0 1 8 8 2 a 7 4 f 2 6 1 8 | PASS | verify-flow:builder-save-blur | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/replay
e v : 5 5 b c 5 0 a 0 a 0 a 4 3 e d d | PASS | verify-flow:pipeline-roundtrip | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/comp-v
e v : 9 2 9 3 a 6 7 3 d 4 0 0 6 5 a 3 | PASS | verify-flow:builder-save-blur | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/comp-v
e v : 3 6 a d 9 0 2 e 6 a b 1 e d 4 c | PASS pipeline-roundtrip | FEAT-5 | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/replay
e v : 0 b 4 8 1 2 b 8 0 1 d 2 9 a e 8 | PASS builder-save-blur | FEAT-5 | ok=true | {"ok":true,"reasons":[],"checks":["file /Users/ruze/reg/my/forge/compose/.worktrees/replay
```
And earlier through the CLI (`evidence-cli show <id>`):
```
e v : 4 0 8 3 b 7 c 2 6 d 8 f a 5 7 9 show_exit=0 verify=true line present in comp-verify-flow-1/.compose/data/verify/_adhoc/pipeline-roundtrip-2026-11-17T04-38-52-098Z.log
e v : 3 8 c 0 2 e d e f 9 6 0 d 0 6 7 show_exit=0 verify=true line present in replay-i17-fixed/.compose/data/verify/COMP-PIPE-EDIT-EDGES-1/pipeline-roundtrip-2026-11-17T04-39-44-629Z.log
e v : 9 2 3 9 4 0 7 8 d e 0 e d 0 6 f show_exit=0 verify=true line present in replay-i17-fixed/.compose/data/verify/_adhoc/pipeline-roundtrip-2026-11-17T04-39-46-559Z.log
```
**Right:** the latest completion's flow, PASS, evidence id, commit and log, and the receipt re-checks.

### Config refused at load (plan AC)

A `verify` block with an unknown field (`retries`) and a string `command`:
```
$ compose verify
compose verify: VERIFY_CONFIG_INVALID: verify.flows[0] has unknown field "retries"; verify.flows[0].command must be array
exit=2
$ compose record-completion FEAT-9 --commit-sha=<40 hex> --tests-pass=true
Refused at verify:
  - VERIFY_CONFIG_INVALID: verify.flows[0] has unknown field "retries"; verify.flows[0].command must be array
exit=1, status IN_PROGRESS
```
The dogfood config validates against `contracts/verify-config.schema.json`: `{"ok":true,"errors":[]}`.

## The two incident replays

| Incident | Broken code | Fixed code |
|---|---|---|
| I17 pipeline editor dropped `after:` edges | FAIL: `EDGES build 0` (needs 18), `EDIT build 1`, `KEY depends_on`; completion refused | PASS 5 of 5, completion COMPLETE with the receipt |
| I18 builder Save missed the blur commit | FAIL: `RELOADED id=draft-step` | PASS: `RELOADED id=renamed-step` |

## Deviations from the notes and plan, with reasons

1. **`builder-save-blur` runs `node_modules/.bin/playwright test --config e2e/playwright.config.js …`, not
   `npx playwright test …`.** Measured: bare `npx playwright` silently downloads and runs playwright@1.65.1
   when it is not installed (exit 0), so "not installed" would never be a setup error; `npx --no-install`
   exits 1, the same code as a real test failure. The direct path makes "not installed" a spawn ENOENT,
   which is `FLOW_SETUP_ERROR` (Case 6).
2. **The UI flow does not call `compose start`.** `e2e/flow-setup.mjs` starts the same two pieces (this
   checkout's `server/index.js` and its cockpit through Vite) itself, on ports from the 19000-19999 test
   range checked with `port_check.py` and a bind probe. The cockpit's Vite config hard-wires its proxy to
   :4001 (the owner's live cockpit), so the flow serves it through a generated wrapper config that rewrites
   every proxy target to the flow's own server and refuses to start if any still names :4001 or :4002; the
   spec also aborts any browser request to those ports.
3. **`@playwright/test` was added as a devDependency with `npm pkg set`, not `npm install`.** A full install
   in the worktree would replace main's `@smartmemory/stratum` symlink (`../../../stratum/ts`) with the
   registry copy. The worktree's own `node_modules` holds only `@playwright/test`, `playwright`,
   `playwright-core` 1.65.1; everything else resolves from main's. **Land step:** install `@playwright/test`
   1.65.1 into main's `node_modules` without disturbing that symlink (whether `npm install` keeps it is
   unverified). The chromium headless shell build 1255 it needs is now in
   `~/Library/Caches/ms-playwright/chromium_headless_shell-1255` (left in place, shared cache).
4. **The backfill path (`backfill_completions`) does not run flows**: flows test today's tree, not a
   historical commit. Documented in `docs/configuration.md`.
5. **Both I18 checkouts use today's sibling Stratum `FlowBuilder`** (`../stratum/ui/src/builder`, resolved
   the same way by both). Only the Compose pane differs (pre-fix: reads the last `onChange` export 500 ms
   after the last tracked interaction; fix: focusout counts and Save waits for the export). The old id still
   came back on the pre-fix pane, so the replay reproduces I18 as the notes describe.
6. Cosmetic, not fixed: with one declared flow the selection line reads `1 of 1 declared flow cover`
   (verb not singularised). LOW, noted here only.

## Files changed (branch commit)

New: `contracts/verify-config.schema.json`, `lib/verify-flows.js`, `scripts/flows/flow-env.mjs`,
`scripts/flows/pipeline-roundtrip.mjs`, `e2e/playwright.config.js`, `e2e/flow-setup.mjs`,
`e2e/builder-save-blur.spec.js`, `test/verify-flows.test.js`.
Modified: `lib/completion-gate.js` (flow step after evidence, before the lock; refusal `refusedAt:'verify'`),
`lib/completion-writer.js` (`VERIFY_FLOWS` symbol so MCP/REST args cannot forge `verify_flows`),
`bin/compose.js` (`compose verify`, record-completion progress on stderr), `lib/cli-commands.js`,
`.compose/compose.json` (the two flows), `package.json` (devDependency), `docs/configuration.md`,
`docs/cli.md`, `.claude/skills/compose/SKILL.md` (gate step 2), `CHANGELOG.md`. README has no command list,
so it is unchanged.

## Tests

`node --test --test-concurrency=4` on `test/verify-flows.test.js` (22 tests, real child processes, no spawn
mocks), the 12 completion files (`ls test | grep -i completion`) and `test/cli-commands.test.js`:
first run `# tests 218 # pass 217 # fail 1`; the failure was `docs/cli.md embeds the current generated
Command Index` (my hand-written `compose verify` row differed from `renderCommandIndex()`); after using the
generated row, that file reran `# tests 7 # pass 7 # fail 0`. Total 218/218. The full suite was not run
(brief: smallest set).

Reviewer checklist pointers: no-verify-block byte-identical (Case 3); no flag completes over a failed flow
(Case 1 broken with `--tests-pass=true`; test "FLOW_FAILED with tests_pass=true writes nothing"); timeout
kills the group and frees the port (Case 7, plus the timeout row in the test file); setup vs failed
distinguishable in text and code (Cases 6 and 8); every receipt re-verifies (Case 9).

COMP-VERIFY-FLOW-1 cases_right=9/9 replays=2/2 tests=218/218 branch=comp-verify-flow-1 sha=1c32525b pushed=no
