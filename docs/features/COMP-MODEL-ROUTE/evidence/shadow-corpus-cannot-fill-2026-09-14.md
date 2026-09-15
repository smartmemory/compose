# Shadow mode refuses every ordinary build. The corpus cannot fill. Cost: $0 (found by running one build).

**2026-09-14.** Found while running an ordinary `compose build COMP-TUI-4` to seed the shadow
corpus that Q3 (repair floor) and S2 (hindsight report) both consume.

## What happened

```
$ node bin/compose.js build COMP-TUI-4 --route-mode=shadow
Build failed: Participating flow must declare all optional routing transport strings
Routing observation refused this run (ROUTING_INPUT_UNDECLARED).
```

The build refused before dispatching anything. Re-running with `--route-mode=off` proceeded
normally, so nothing else is wrong with the build.

## Root cause — 13 of 15 shipped specs cannot participate

`lib/routing-ledger.js:202` refuses unless the entry flow declares ALL FIVE transport keys as
optional strings:

```js
const transport = ['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'];  // :26
if (!transport.every(k => flow?.input?.[k] === 'string?')) refuse('ROUTING_INPUT_UNDECLARED', …);  // :202
```

Measured across every shipped spec (`grep -c 'route_mode\|routing_mode\|route_run_id'`):

| Declares transport | Specs |
|---|---|
| **yes (2)** | `pipelines/gsd.stratum.yaml`, `presets/team-fable-astra.stratum.yaml` |
| **no (13)** | `bug-fix`, `build`, `build-quick`, `content`, `coverage-sweep`, `new`, `plan`, `refactor`, `research`, `review-fix`, `team-feature`, `team-research`, `team-review` |

`build` and `build-quick` are what `compose build` actually runs. **So shadow mode refuses on
every ordinary build, and the corpus can never accumulate on ordinary work.**

## Why the 09-13 slice's tests did not catch it

`docs/features/COMP-MODEL-ROUTE/progress.md` (2026-09-13) claims three END-TO-END tests through
"the real `runBuild`" with `template: 'bug-fix'`, and concludes "this repo's `.compose/compose.json`
now sets `routing.mode: "shadow"`, so the corpus accumulates during ordinary work at no extra
model spend."

`test/helpers/routing-runtime-fixture.js:34`:

```js
writeFileSync(join(cwd, 'pipelines', `${name}.stratum.yaml`), YAML.stringify(spec));
```

The fixture **overwrites** the shipped pipeline with `simpleSpec()` (`:14-16`), which spreads
`transport` (`:13`) into the flow's `input`. The tests drive the real `runBuild`, but never the
real `bug-fix.stratum.yaml`. The one property the slice existed to establish — that a SHIPPED
pipeline can participate — is the one property its fixture replaced.

This is [[project_compose_pipeline_dialect_drift]] from the other direction: that memory says
never use a shipped spec as a test dialect fixture; this is a synthetic fixture standing in for
a shipped spec while the claim is ABOUT the shipped spec.

## Consequence

- **Q3 (repair floor) cannot be settled by evidence.** Its deferral rationale — "the shadow
  corpus should settle it before S3 builds enforcement" — rests on a corpus that has never
  collected a single row from ordinary work and cannot.
- **S2's hindsight report has no input** on ordinary builds for the same reason.
- `.compose/routing/` does not exist in this repo. That was read on 2026-09-14 as "no builds
  since the switch was flipped". It is not: builds refuse.
- The refusal is loud and correctly refuses rather than storing a censored sample (that design
  decision is sound and is NOT what is wrong here). What is wrong is that no shipped ordinary
  pipeline can satisfy the precondition.

## Smallest correct change (stated, not designed)

Declare the five transport keys as `string?` on the entry flow of the specs that should
participate — at minimum `build` and `build-quick`. Then pin it with a test that reads the
SHIPPED spec files rather than a fixture-authored one: assert every spec intended to participate
satisfies the `:202` predicate. That test is the missing oracle, and it is cheap.

## FIXED 2026-09-15 — and one limitation that survives the fix

All 15 shipped specs now declare the five keys on the flow the PRODUCTION resolver selects
(verified independently against `createRoutingStart`'s own expression, not a grep). The missing
oracle shipped too: `test/routing-shipped-spec-participation.test.js` reads the real files,
applies production's resolver, and compares an explicit participation registry against the
on-disk inventory — so a new spec fails the test until someone decides, and declarations moved
to a subflow fail it as well. Red-before-green: 0/3 with the YAML reverted, naming all 13.
Full suite 7156/7156.

**Limitation, NOT fixed:** `compose init` copies only ABSENT specs (`bin/compose.js:584`) and a
local copy wins over the packaged one. **A workspace that already initialised keeps its old
specs and will still refuse shadow mode.** No local workspace is affected (checked: compose,
forge, compose-develop, compose-lab, stratum all carry 0 copied specs), but any distributed
install that ran `init` before this fix needs its copies refreshed or deleted. Falsifier:
`ls <workspace>/.compose/pipelines/*.stratum.yaml` non-empty AND those files lack `route_mode`.

Spec digests DO change, but `legacyRoutingSpecPin` already strips these declarations before
comparing old specs, so resume compatibility for pre-existing non-routing runs is handled.

## Falsifiers

- `grep -c route_mode pipelines/build.stratum.yaml` returns 0 → still broken.
- `node bin/compose.js build <any feature> --route-mode=shadow` refuses → still broken.
- `ls .compose/routing/` does not exist after an ordinary shadow build → still broken.
