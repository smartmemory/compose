# COMP-VERIFY-FLOW-1: real-use notes and right answers

Frozen 2026-11-17 before any code (OPS-VERIFY-CONFORM-1 pass 3). The build is done when every case below
gives the right answer when a person runs it by hand, not when its unit tests pass. Never tune a case to
the code: if a case turns out wrong, change it here in its own commit with the reason, before the code
that depends on it.

Surfaces marked **(new)** do not exist yet; everything else is today's Compose. The config shape is fixed
in `plan.md` ("Decisions").

## Who and what

A developer whose project uses Compose. Their feature passes its unit tests, but what a user does (open,
edit, save, reload) is broken. Today `compose record-completion` accepts `--tests-pass=true` or runs
`guard.testCommand`, and the feature becomes COMPLETE. After this feature, a project can declare a few
**flows** (a command that starts the app, drives it the way a user does, checks the result, and cleans up)
and Compose runs the ones a change touches before it calls the feature done.

## Case 1 (replays I17): pipeline edit loses its dependency edges on save and reload

Own-use incident: `smart-memory-ops/units/COMP-PIPE-EDIT-EDGES-1/report.md:19-36`. The pipeline editor model
read 0 of the 62 `after:` dependency edges across the 11 shipped pipelines; the model fix found all 62, but
the save path also needed a server change (ops ledger 2026-11-01, L:22568) that a model-only test missed.

The developer declares, in `.compose/compose.json`:

```json
"verify": { "flows": [ {
  "id": "pipeline-roundtrip",
  "command": ["node", "scripts/flows/pipeline-roundtrip.mjs"],
  "covers": ["src/lib/pipeline-model.js", "src/components/vision/**", "server/pipeline-routes.js", "pipelines/*.stratum.yaml"],
  "expect": ["EDGES build 18", "EDGES bug-fix 8", "EDGES total 62", "EDIT build 19", "KEY after"],
  "timeout_s": 300
} ] }
```

The flow script (project-owned, in Compose's own repo for dogfood) copies the project to a throwaway
workspace, starts the Compose server on a free registered port, and for each shipped pipeline: loads it
through `GET /api/pipeline/spec`, saves it unchanged through `POST /api/pipeline/save`, reloads it, and prints
`EDGES <pipeline> <n>` from the reloaded document. Then it adds one dependency to `build`, saves, reloads and
prints `EDIT build <n>` and `KEY <after|depends_on>` from the saved YAML.

They run:

```
compose verify --flow pipeline-roundtrip            (new)
```

**Right answer on the broken code (before the I17 fix):** `FAIL pipeline-roundtrip` with the first missing
line named (`EDGES build 18` missing; the output had `EDGES build 0`), the log path, exit 1.
**Right answer on the fixed code:** `PASS pipeline-roundtrip (5 of 5 expected lines)`, exit 0, and an
evidence id `ev:<16 hex>` printed for the run.

Then they complete the feature, with the changed files on stdin:

```
git diff --name-only main...HEAD | compose record-completion COMP-PIPE-EDIT-EDGES-1 --commit-sha=<40 hex> --tests-pass=true --files-changed-from-stdin
```

**Right answer on the broken code:** refused, status stays as it was, message names
`FLOW_FAILED pipeline-roundtrip`, the missing expected line, and the log path. `--tests-pass=true` does not
override it. **On the fixed code:** COMPLETE, and the completion record carries the flow's evidence id.

## Case 2 (replays I18): builder Save misses an edit committed on blur

Own-use incident: ops ledger 2026-11-03 10:05 (L:24853) and
`smart-memory-ops/units/FORGE-BATCH-REVIEW-20261103-B/adjudication.md:9`. In the cockpit's Stratum builder
pane, the step ID field commits its draft on blur; Save did not wait for that commit, so Save wrote the old
document. A standalone model test does not see the event order.

Declared flow: `id: "builder-save-blur"`, command `["npx", "playwright", "test", "e2e/builder-save-blur.spec.js"]`,
covers `["src/components/cockpit/StratumBuilderPane.jsx", "server/stratum-spec-routes.js"]`,
expect `["RELOADED id=renamed-step"]`.

The script does what a person does: `compose start` on a throwaway workspace, open the Stratum builder on a
flow, click a step, type `renamed-step` into its ID field, click **Save** without pressing Tab or clicking
elsewhere, reload the page, open the same step, print `RELOADED id=<value>`.

**Right answer on the broken code:** `FAIL builder-save-blur`, output had `RELOADED id=<old id>`.
**Right answer on the fixed code:** `PASS builder-save-blur`.

## Case 3: a project that declares no flows sees no change

```
compose record-completion FEAT-1 --commit-sha=<40 hex> --tests-pass=true
```

with no `verify` block in `.compose/compose.json`.
**Right answer:** exactly today's behaviour and output: COMPLETE, no flow runs, no new warning, no new
prompt. Opt-in means opt-in.

## Case 4: the change does not touch any declared flow

Project declares the two flows above; the changed files are `docs/cli.md` and `lib/version-check.js`.
**Right answer:** completion proceeds; one line says `verify: no declared flow covers the 2 changed files`.
No flow runs.

## Case 5: no changed-file list is given

`compose record-completion FEAT-2 --commit-sha=<40 hex> --tests-pass=true` (no `--files-changed-from-stdin`)
in a project with flows declared.
**Right answer:** every declared flow runs (Compose cannot tell which are touched), and the output says so:
`verify: no changed-file list, running all 2 declared flows`. Same pass/refuse rule as Case 1.

## Case 6: the flow cannot start (a setup error, not a product failure)

The flow command is `["npx", "playwright", "test", ...]` but Playwright is not installed (exit 127 or
`command not found`), or the script exits with the declared setup code.
**Right answer:** refused with `FLOW_SETUP_ERROR builder-save-blur` and the first stderr line, worded
differently from `FLOW_FAILED`, so nobody starts fixing product code for it. Status unchanged.

## Case 7: the flow hangs

A flow runs past its `timeout_s`.
**Right answer:** Compose kills the flow's whole process group (the server it started goes too), refuses with
`FLOW_TIMEOUT <id> after <n> s` and the log path. No orphan server is left on the port.

## Case 8: the flow passes but exits non-zero, or exits zero without the expected lines

Exit 0 with `EDGES build 0`: **FLOW_FAILED** (expected lines are the answer, not the exit code).
Exit 1 with every expected line present: **FLOW_FAILED** (a failing exit is never a pass).

## Case 9: a later reader checks what was proved

```
compose verify --show COMP-PIPE-EDIT-EDGES-1          (new)
```

**Right answer:** for the feature's latest completion, each flow that ran, PASS/FAIL, the evidence id, the
log path, and the commit it ran against. The evidence id re-verifies through the existing evidence store
(`lib/evidence.js` `command` kind: the claimed output line is found in the log).
