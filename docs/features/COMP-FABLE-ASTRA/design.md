---
name: Fable-led Astra Teams
priority: medium
track: orchestration
desc: A Compose team preset where Fable plans and assesses, Astra workers implement in bounded waves, a fresh Astra reviewer checks the integrated result, and Fable issues the repair wave.
---

# COMP-FABLE-ASTRA — Fable-led Astra Teams

Status: PLANNED — design; not implemented or approved for implementation.
Created: 2026-09-09 (Codex/astra draft). Revised: 2026-09-09 (Fable design review;
Codex sol/high review rounds 1 and 2 folded in, see Review log).
Parent phase: COMP-TEAMS (Agent Team Presets).

## Revision note (2026-09-09)

The first draft was a correct statement of orchestration principles that left every
Compose-specific question to blueprint. This revision pins what was open or wrong.
Round 1 review then showed the loop is **not** expressible in the current engine
and that three "already handled by Compose" claims were false, so the feature now
carries explicit dependencies instead of a "one new thing in the preset" story.

1. **Fable is not unresolved.** Fable is `claude-fable-5-1` through the existing
   `claude` provider. What is missing is routing: the Claude tier table in
   `server/model-tiers.js` still names Opus 4.7, Sonnet 4.6 and Haiku 4.5, the tier
   allow-list in `lib/agent-string.js` (`KNOWN_TIERS`) is separate from the model
   table, and the profiles sidecar is loaded fail-open (a parse error yields `{}`
   and an unresolved model is simply omitted from the request, so the connector
   picks a default). Slice 1 fixes all three. No new connector, no adapter.
2. **Fable's decisions are step outputs, not a live controller.** Compose and Stratum
   already decided that executor choices and re-dispatch come from recorded flow
   state (STRAT-AGENT-INTERP: "no non-deterministic external actor in the executor
   loop"). Fable runs as ordinary steps (`plan`, `assess`) whose outputs are
   validated task graphs, and the loop is the engine's gate revise edge. Resume,
   audit and replay work as for every other preset. The draft's separate
   "coordinator decision ledger" is not built; the flow record is the ledger.
   **Round 1 correction:** carrying a value across a revise edge is not something
   the engine does today; it is Stratum dependency D1 below.
3. **The delta over shipped work is named.** COMP-TEAMS-3 ships plan, fan out,
   merge, verify, once. COMP-AGT-COORD designs messaging, ordering and
   merge-conflict machinery. This feature adds the repeating wave loop whose next
   wave is planned from a fresh reviewer's findings and covers only the affected
   tasks. **Round 1 and 2 correction:** that loop needs two Stratum changes and
   three Compose seams that do not exist (D1 to D5 below). They are
   self-contained, but they are not "in the preset", and two of them are
   cross-repo. This is an epic with a Stratum prerequisite, not an L.
4. **Budget defaults are numeric** (Roles, models and budget), and the
   wave-count semantics are the engine's, not a paraphrase.
5. **Per-task tier routing is in scope (added 2026-09-09).** Fable already sizes
   each task when it bounds it; the same judgment picks a tier, so a wave mixes
   Astra on the hard tasks and terra or spark on the mechanical ones instead of
   paying Astra for everything. Provider stays fixed per stage (the TS engine's
   `agent` is a `claude | codex` literal, `ts/src/ir/schema.ts`; the
   STRAT-AGENT-INTERP roadmap row marked COMPLETE describes the retired Python
   engine and does not hold for TS). Tier is resolved compose-side from the
   sidecar today, so per-item tier needs the engine-recorded item from D1 and one
   Compose seam (D6), not a new Stratum ticket. Cross-provider per-item routing
   and receipt-calibrated estimation are follow-ups, not v1.

## Intent

A `team-fable-astra` preset, selectable through the existing `compose build --team`
flag, in which:

- **Fable** (`claude`, `coordinator` tier) reads the goal and acceptance criteria and
  emits a task graph; after each wave it reads the merged diff, verification
  output and reviewer findings and emits the next graph (a repair wave, another
  implementation wave, or completion).
- **Astra workers** (`codex`, tier chosen per task by Fable, default `critical` =
  `gpt-6-astra`) each implement one bounded task in an isolated worktree and
  return a patch plus evidence. Mechanical tasks run on `standard` (terra) or
  `fast` (spark); the wave is still "Astra-led" because the hard tasks and the
  reviewer are Astra.
- **A fresh Astra reviewer** (`codex`, `critical`, read-only template) reviews the
  integrated result against the goal, not the workers' summaries.
- **Compose and Stratum** own dispatch, worktrees, merge, retries, cancellation,
  usage accounting and the flow record.

Wave boundaries only. **Waves are the dependency mechanism**: a wave contains only
mutually independent tasks; anything that depends on another task goes in a later
wave and starts from the wave commit that contains it (D3). Mid-wave reassignment
and worker-to-worker messaging are out of scope (COMP-AGT-COORD territory).

## Existing foundation (verified)

- [team-feature.stratum.yaml](../../../presets/team-feature.stratum.yaml): decompose
  with `out: TaskGraph` and count ensures, consumer fanout (`concurrency: 3`,
  `isolation: worktree`, `merge: sequential`), an `execute_merge` gate with
  `on_revise: execute`, a flow-level `max_rounds: 10` (required by the validator
  whenever any gate has `on_revise`), then verify. The revise edge exists; a
  revise resets the target **and every descendant**, discarding their outputs.
- [team-feature.profiles.json](../../../presets/team-feature.profiles.json): per-step
  `provider:template:tier` strings applied compose-side. This is where this preset
  pins roles.
- [agent-string.js](../../../lib/agent-string.js) and
  [model-tiers.js](../../../server/model-tiers.js): tier to model literal.
  `CODEX_MODEL_TIERS.critical` is `gpt-6-astra`. The Claude side is stale.
- [consumer-fanout.js](../../../lib/consumer-fanout.js): durable per-task journals,
  retained patches, worktree recovery. **Worktrees are created from `HEAD`; the
  sequential merge lands in the parent working tree without advancing `HEAD`; on
  gate approval the worktrees and retained diffs are dropped.** So a second
  fanout would start from the pre-wave commit, not the integrated tree (D3).
  Merge does not compare a task's changed paths against its `files_owned`; the
  only ownership check is plan-time overlap between tasks (`filesOwnedConflict`
  in build.js) (D4).
- Fanout has no cross-item dependency scheduling (Stratum records this as a v1
  limitation); items are promoted by concurrency only. Hence waves as the
  dependency mechanism.
- Gates take an external `approve | revise | kill` decision. Compose resolves the
  literal `review_gate` from a step output (the review reducer) and every other
  gate from static policy or a human. There is no generic "decide this gate from
  that step's output" (D2).
- Cancellation: the build's signal handler changes local status and closes the
  stream; `compose build --abort` audits and closes its client. Neither cancels the
  Stratum flow or the running agents, although Stratum 0.4.0 ships acknowledged
  cancellation (D5).
- COMP-CODEX-IMPL (COMPLETE): `agent: codex` inside a fanout is supported. Reused.
- `compose build --team <name>`: rewrites to `--template team-<name>`; named
  presets only; batch rejected. Reused.

## The loop, and what it depends on

Step shape (names indicative):

```
plan            claude  (Fable)         -> TaskGraph      wave 1 (independent tasks only)
execute         codex   (Astra x3)      fanout over ${wave} (D1 carried value), worktree, sequential merge
execute_merge   gate                    on_approve: verify, on_revise: execute      (merge retry)
verify          claude  (standard)      -> VerifyResult   runs the suite on the integrated tree
review          codex   (Astra, fresh)  -> ReviewFindings against goal + criteria + diff + VerifyResult
assess          claude  (Fable)         -> WaveDecision   {action, tasks, addressed, open, blocking}
assess_gate     gate                    on_approve: null (complete), on_revise: execute (next wave), on_kill: null (blocked)
```

`assess` receives the merged diff, per-task `TaskResult`s, `VerifyResult` and
`ReviewFindings`, and emits `WaveDecision` whose `tasks` is the next wave. A repair
wave lists only the tasks that own the files the findings touch.

**D1 (Stratum): a loop-carried flow value.** `execute.fanout.over` cannot reference
`assess.output.tasks`: an output reference is a dependency edge, and with
`execute → … → assess` that is a `ROUTING_CYCLE` at validation; even if it were
allowed, the revise resets `assess` and deletes its output before `execute`
re-enters. `fanout.over` also accepts exactly one direct reference, gate
resolution carries a decision but no payload, and fanout state persists item
indices and results but not the resolved input list, so a merge retry has no
durable record of the wave it is retrying. A bare "revise payload" is not enough
(round 2): it has no value on the first `plan → execute` pass and none on an
`execute_merge` retry.

Required instead is a **declared, persisted flow variable**:

```
carry:
  wave:
    initial: ${plan.output.tasks}
    on_revise:
      assess_gate: ${assess.output.tasks}
```

Semantics: `wave` is materialised when `plan` succeeds; `fanout.over: ${wave}` is
an ordinary single reference to a flow value, not to a step, so no dependency
edge and no cycle. On an `assess_gate` revise the engine evaluates the declared
expression **under the gate token, before the reset**, stores the new value with
its provenance (gate id, gate token, source epoch) in the run record, then resets.
An `execute_merge` revise declares nothing, so `wave` is unchanged and the retry
re-fans over the same persisted list. Resume, replay and audit read `wave` from
the run record like any step input; the consumer descriptor gains the resolved
item alongside `itemIndex` so downstream consumers (D4) have an authoritative
binding. Filed as **STRAT-LOOP-CARRY** (supersedes the round-1 name
STRAT-REVISE-PAYLOAD); this feature is blocked on it. Compose must not work around
it by re-planning outside the flow.

**D2 (Compose): output-driven gate resolution.** Generalise what `review_gate`
does by hand: a preset-level mapping `gate.decide_from: { step: assess, field:
action, approve: [complete], revise: [repair, implement], kill: [blocked] }`,
resolved by the build runner before falling through to policy or a human. Fable's
`action` stops being advisory.

**D3 (Compose): wave checkpoints with a recovery rule.** Compose today commits
only at `ship`, after tests and selective staging; there is no policy that can
absorb intermediate commits, so D3 has to define one:

- After `execute_merge` approves, the integrated tree is committed on a
  build-local branch `compose/wave/<flowId>` (created from the build's base at
  wave 1). The next fanout's worktrees are created from that branch tip, so a
  repair wave repairs what was actually integrated.
- The commit is journaled with the wave number and the flow's gate token
  **before** retained diffs are dropped; on resume, Compose compares the branch
  tip with the last journaled wave and either re-applies the retained diffs
  (journal ahead of branch) or trusts the branch (branch ahead of journal, tip
  hash matches the journal).
- At `ship`, the wave branch is squashed onto the base and ship's existing
  staging and commit run unchanged, so the enclosing commit policy sees exactly
  what it sees today. On a failed or killed build the wave branch is left for
  inspection and removed by `--fresh`, which already owns clean-restart.

**D4 (Compose, needs D1): ownership enforcement at merge.** Before a task's
captured diff is merged, its changed paths are compared with the `files_owned` of
the resolved wave item the engine recorded for that consumer (D1's descriptor
change). Neither the rendered prompt nor the worker's self-reported
`files_changed` is trusted. Any path outside fails the task with a named finding.
Plan-time overlap detection stays.

**D6 (Compose, needs D1): per-item tier resolution.** Today
`loadPipelineProfiles` keys the sidecar by step id and `resolveAgentConfig` turns
one `provider:template:tier` string into one model for the whole fanout stage.
D6 lets the sidecar declare a per-item override for a fanout step
(`"execute": { "default": "codex:implementer:critical", "tier_from": "item.tier" }`)
and resolves the tier from the engine-recorded item (D1's descriptor field) at
dispatch, falling back to the default when the item has no tier. Provider and
template stay per stage. The resolved model is written to the run record per item
so the completion evidence can show it.

**D5 (Stratum + Compose): real cancellation.** Compose runs consumer fanout in a
foreground flow; Stratum's only durable flow cancel is for background flows, and
foreground agent cancellation needs the per-call cancellation id held by the MCP
server that started the call. `compose build --abort` opens a fresh client, so it
has neither. Required: a Stratum foreground flow-cancel surface addressable by
flow id (filed as **STRAT-FLOW-CANCEL-FG**), and Compose wiring the signal
handler and `--abort` to it, so a cancel stops workers and no patch captured after
the cancel is merged. This is a general build defect, not a preset feature; it is
a prerequisite for one evidence item.

## Contracts

All are step `out` contracts in the existing contract style; none is new YAML syntax.
Two limits shape them: ensures can read only the current step's `result` (plus
flow `input`, `item`, `prev`), and the expression language has fixed member and
index access with `all`/`any` over an existing array but no projection or
quantifier. So ensures guard **scalar or top-level fields only**, and every
cross-element rule ("each task owns a finding's file", "no task has
dependencies") is a **named Compose-side validator** run before dispatch or before
gate resolution, exactly as `filesOwnedConflict` is today. `TaskGraph` is
currently `tasks: object[]`; the nested task, finding and decision shapes become
named contracts so the validators have a schema to check against.

- **TaskGraph** (exists, task shape now named): tasks with `id`, `description`,
  `files_owned`, `files_read`, `depends_on`, and **`tier: critical | standard |
  fast`** with a one-line `tier_rationale`. Ensure: `len(result.tasks)` in 1..6.
  Compose validators before dispatch: pairwise ownership (`filesOwnedConflict`),
  `depends_on` empty for every task (waves carry dependencies), and `tier` in the
  allow-list (unknown tier fails the wave before dispatch, never silently
  defaults). Fable's planning prompt carries the tier guidance from the routing
  rules: `critical` for tasks with design judgment or root-causing, `standard`
  for brief-bounded implementation, `fast` for transcription-level edits; repair
  waves default to the tier of the task being repaired or higher, never lower.
- **TaskResult** (exists): `outcome`, `summary`, `files_changed`, plus
  `verification` (commands and outcomes) so `assess` reads evidence, not prose.
- **VerifyResult** (exists): `tests_pass`, details.
- **ReviewFindings** (new): findings with `severity`, `files`, `claim`, `evidence`;
  overall `blocking: true|false`. Produced with fresh context: goal, acceptance
  criteria, merged diff, `VerifyResult`. Never the workers' summaries.
- **WaveDecision** (new): `action: repair | implement | complete | blocked`,
  `tasks: TaskGraph`, `rationale`, `addressed_findings[]`, `open_findings[]`,
  `blocking` (copied from the findings it assessed), `open_count` (integer).
  Ensures (scalar): `action == 'complete'` implies `open_count == 0` and
  `blocking == false`; `action == 'blocked'` implies `open_count > 0`.
  Compose validators before gate resolution (D2): `open_count` equals
  `len(open_findings)`; `blocking` equals `review.output.blocking`; for `repair`,
  `tasks` non-empty and each task owns at least one file named by an open
  finding; the resolved decision is recorded with the gate token.

## Roles, models and budget

Profiles sidecar for this preset (target state, after slice 1):

| Step | Agent string | Model |
|---|---|---|
| plan, assess | `claude:orchestrator:coordinator` | `claude-fable-5-1` |
| execute (fanout) | `codex:implementer:critical` default, tier from `item.tier` (D6) | `gpt-6-astra` / high, or `gpt-5.6-terra` / high, or `gpt-5.3-codex-spark` / medium |
| review | `codex:read-only-reviewer:critical` | `gpt-6-astra` / high |
| verify | `claude:orchestrator:standard` | `claude-sonnet-5` |

`coordinator` is added to `MODEL_TIERS` **and** `KNOWN_TIERS`; `critical` stays
Opus 5 so no other preset silently moves to Fable. Slice 1 also adds a preflight
that validates the sidecar and resolves every step's model before the first
dispatch, and fails the build on any unresolved profile or model. Today's fail-open
path is closed for all presets, not only this one.

Limits, as preset inputs (overridable on the command line), with the engine's
actual semantics:

| Limit | Default | Semantics |
|---|---|---|
| Worker concurrency | 3 | fanout `concurrency` |
| Flow `max_rounds` | 4 | total revise rounds across **both** gates; merge retries and repair waves share it |
| `assess_gate.max_rounds` | 2 | at most two repair waves after the first implementation wave (a gate `max_rounds: N` allows N revisions) |
| `execute_merge.max_rounds` | 2 | merge retries |
| Per-run cost ceiling | 150 USD | computed compose-side from Stratum receipts (STRAT-USAGE-SPLIT) between waves; exceeded means D2 does **not** auto-resolve `assess_gate`, which is left `waiting_gate` for a human with the ceiling breach as the reason, so the run is resumable by a human `approve`/`revise`/`kill` after the ceiling is raised |

Exhaustion of either `max_rounds` ends the flow `failed` with reason "gate revision
rounds exhausted"; `blocked` is a `WaveDecision.action` and a gate `kill`, and also
ends the flow `failed`, with the open findings in the run record. "Blocked" is
therefore a documented failure shape, not an engine status, and a terminal run
is not resumable, which is why the cost ceiling pauses rather than kills.
COMP-ITER-BUDGET is not a dependency; the ceiling above is the preset's own.

## Completion evidence

Before this feature is COMPLETE, demonstrate on a live run and record commands,
outcomes and artifact references with the report:

- [ ] Run record shows `claude-fable-5-1` for plan/assess and `gpt-6-astra` for
      review; the installed compose-to-stratum path was used.
- [ ] In one wave with mixed tiers, the run record shows each worker's resolved
      model matching its task's `tier`; a task with an unknown tier fails the
      wave before any dispatch (D6).
- [ ] A sidecar with an unknown tier or an unavailable model fails before the first
      dispatch.
- [ ] Independent tasks in one wave overlap in wall time; a task in wave 2 starts
      from the wave 1 checkpoint and sees its prerequisite's change.
- [ ] A worker edit outside `files_owned` fails that task at merge with a named
      finding (D4).
- [ ] A seeded cross-module wiring break with green unit tests is caught by
      `review` and repaired in the next wave, which dispatches only the affected
      tasks; unaffected accepted work is not re-run and not re-merged (D1, D2, D3).
- [ ] Kill and resume between `execute` and `execute_merge` yields exactly one
      merge per accepted patch.
- [ ] Cancel mid-wave stops workers and no cancelled patch is merged (D5).
- [ ] Exhausting `assess_gate.max_rounds`, and a `blocked` decision, each end the
      flow `failed` with the open findings recorded and no `complete`.
- [ ] Exceeding the cost ceiling leaves `assess_gate` waiting for a human with
      the breach as the reason; a human `revise` after raising the ceiling
      continues the run.
- [ ] Kill the build after a wave checkpoint commit and before retained diffs are
      dropped, then resume: the wave branch and journal reconcile to one
      checkpoint with no re-applied diff (D3).
- [ ] A clean `npm install -g` environment behaves like the checkout.

## Implementation slices

Slice 4 source review (2026-09-10): the brief's concurrency ruling supersedes the
"Limits as preset inputs" table for concurrency: literal 3, customized by copying
the preset. TS supports named nested contracts, pipe enums and integer fields;
flow inputs are type declarations without defaults, so `cost_ceiling_usd: number?`
uses `_costCeiling.default: 150`. Q1/Q2 in progress.md settle `tasks: Task[]` and
approve → ship. The existing feature input envelope also includes optional role
and pre-merge fields. Register `fable-astra` in `KNOWN_TEAMS`; parser/resolver
functions are unchanged. Verification must include added-file diffs because new
merged files can remain untracked before ship; failed verification reaches assess
for repair rather than failing an ensure before review. Scalar implications use
the runtime expression dialect's `||` and `&&`, not `or` and `and`.

Slice 1 source review (2026-09-10): `build.js` starts flows through `startFresh`
→ `stratum.plan`, and previously merged runtime profiles after that start.
The implementation moves runtime validation before fresh flow creation and
rechecks restored resume roles. Agent declarations also occur inside fanout
stages and use runtime input references; preflight covers these via the existing
`resolvePlanSpecValues` resolver. The stream opens after plan/resume to preserve
active-run ownership, so the resolved event is emitted there before dispatch.

1. **Routing** (small, independent, ships first): `MODEL_TIERS` to the Claude 5
   family; `coordinator` in both the model table and `KNOWN_TIERS`; sidecar and
   model preflight that fails closed; tests.
2. **STRAT-LOOP-CARRY** in Stratum (D1: `carry` flow values with `initial` and
   per-gate `on_revise` expressions, persisted with provenance; resolved item on
   the consumer descriptor). This feature is blocked until it ships; nothing in
   slices 3 to 6 is started before it.
3. **Compose seams** (D2 output-driven gate with its validators, D3 wave branch
   with journal reconciliation and ship squash, D4 ownership at merge from the
   recorded item, D6 per-item tier resolution from the recorded item), each with
   its own tests, usable by other presets.
4. **Contracts and preset**: `ReviewFindings`, `WaveDecision`, extended
   `TaskResult`; `team-fable-astra.stratum.yaml` and its sidecar; `--team
   fable-astra`; assess and review prompts with MUST checklists; the cost ceiling.
5. **D5 cancellation**: STRAT-FLOW-CANCEL-FG in Stratum, then Compose wiring; its
   own ticket, landed before live-fire.
6. **Live-fire**: the completion-evidence list, including the seeded wiring break,
   kill/resume and cancel, on a real feature.

Do not create a second execution engine, a coordinator ledger, or a copy of the
build runner. Everything model-specific lives in the sidecar and tier table;
everything loop-specific lives in the preset plus D1 and D2.

## Out of scope

Multi-machine execution (COMP-DIST-EXEC), mid-wave reassignment and peer messaging
(COMP-AGT-COORD), automatic tier changes for other presets, automatic push or
publish. The enclosing workflow's policy governs those, as today.

Two follow-ups filed from the tier-routing addition, not in v1:

- **Cross-provider per-item routing**, filed as **STRAT-AGENT-INTERP-TS**
  (stratum): claude for one task, codex for the next in the same wave. Needs the
  engine's fanout stage `agent` to accept a per-item value; the honest successor
  to the Python-only STRAT-AGENT-INTERP. Until then a preset that wants both
  providers uses two fanout stages.
- **Receipt-calibrated estimation**, filed as **COMP-FABLE-CALIBRATE**. Compare each task's planned `tier` with its
  receipt (STRAT-USAGE-SPLIT tokens and cost), and feed the misses back into
  Fable's planning prompt or a calibration table. Consumer of STRAT-LEARN-COST;
  the E3 complexity-triage idea in the ideabox is the shape.

## Review log

**Round 1, Codex gpt-5.6-sol/high, 2026-09-09.** Nine findings, all accepted:
the repair loop is a routing cycle and the revise reset deletes the source value
(D1, now a Stratum dependency); worktrees start from `HEAD` and fanout has no
dependency scheduling (D3, waves as dependencies); `WaveDecision.action` did not
drive the gate (D2); out-of-scope edits were not rejected at merge (D4); flow
`max_rounds` is mandatory, rounds are shared across gates and `blocked` is not an
engine status (Budget); cancellation was not wired (D5); `KNOWN_TIERS` and the
fail-open sidecar (Revision note 1, slice 1); ensures see only `result`, so
`blocking` moved onto `WaveDecision` and `verify` moved before `review` and
`assess`; budget defaults were not numeric and COMP-ITER-BUDGET is unshipped
(Budget, now the preset's own ceiling).

**Addition, 2026-09-09 (owner question: can the workflow estimate the next
workload and pick a model?).** Not before this change: routing was static per
stage. Added Revision note 5, `tier` on the task contract, D6, one evidence item
and two follow-ups. Verified the TS `agent` field is a literal enum, so per-item
tier is compose-side and needs no third Stratum ticket; STRAT-LOOP-CARRY's
descriptor item now has two consumers (D4, D6) and its ticket says so.

**Round 2, Codex gpt-5.6-sol/high, 2026-09-09.** Six findings on the fixes, all
accepted: a bare revise payload has no first-epoch or merge-retry value, so D1
became a declared, persisted flow variable (STRAT-LOOP-CARRY); foreground flows
have no durable cancel and `--abort` holds no cancellation id, so D5 is Stratum
plus Compose (STRAT-FLOW-CANCEL-FG); the merge boundary has no authoritative
`files_owned` binding, so D4 reads the engine-recorded resolved item (D1); the
expression language cannot express cross-element ensures, so those are named
Compose validators over named nested contracts; wave commits needed a branch,
journal reconciliation and a ship squash (D3); a `kill` on ceiling breach is
terminal and not resumable, so the ceiling now pauses at the gate. Codex also
confirmed D1's core transaction (evaluate under the gate token, reset, persist
once) preserves resume, replay and audit. No round 3 was run: the two blockers
are Stratum prerequisites now named as such, and the rest is blueprint detail.
