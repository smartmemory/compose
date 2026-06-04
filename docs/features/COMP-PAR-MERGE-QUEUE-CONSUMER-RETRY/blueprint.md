# COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4). Anchors verified in Phase 5 (Verification table at end).
**Date:** 2026-06-05 · **Design:** [design.md](design.md) (retry model **C** confirmed) · **Repo:** `compose/` only.

## Scope recap

Consumer-path (`executeParallelDispatch`) gains a bounded, bounce-injected retry loop (model **C**: failed-subset re-run, successful diffs replayed onto a throwaway per-round **anchor commit**), the single-agent mis-route is fixed for both outer loops, and `build.stratum.yaml` gets a default-OFF `pre_merge_gate` opt-in. No Stratum change.

## Work units & sequence

| # | Unit | Files | Depends on |
|---|------|-------|-----------|
| W1 | JS bounce formatter `formatBounceForPrompt` (+ inbound-bounce injection at the task-prompt hook) | `lib/step-prompt.js`, `lib/build.js` | — |
| W2 | Anchor-commit helpers (`buildAnchorCommit`, replay) | `lib/build.js` | — |
| W3 | Retry loop in `executeParallelDispatch` (round loop, subset math, goodDiffs accumulation) | `lib/build.js` | W1, W2 |
| W4 | Mis-route guard at both outer `ensure_failed` branches | `lib/build.js` | W3 |
| W5 | D5 opt-in wiring (config gate + `startFresh` param + YAML) | `lib/build.js`, `pipelines/build.stratum.yaml` | — |
| W6 | Tests | `test/*.test.js` | W1–W5 |

W1, W2, W5 are independent (parallelizable); W3 depends on W1+W2; W4 depends on W3.

---

## W1 — Bounce formatter + injection

**New export in `lib/step-prompt.js`** (port of `parallel_exec.py:154-185`), placed next to `buildRetryPrompt`:

```js
// COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY: Compose-side mirror of Stratum's
// _format_bounce_for_prompt (parallel_exec.py). Injected into a re-run task's
// prompt on the consumer-dispatch path, where Compose (not Stratum) builds prompts.
export function formatBounceForPrompt(bounce) {
  if (!bounce || typeof bounce !== 'object') return '';
  const files = Array.isArray(bounce.files) && bounce.files.length ? bounce.files.join(', ') : '(none reported)';
  const lines = ['## Previous attempt was rejected before merge — fix this before finishing'];
  if (bounce.reason === 'gate_failed') {
    const code = bounce.exit_code == null ? '?' : String(bounce.exit_code);
    lines.push(`Your last attempt FAILED the pre-merge gate \`${bounce.command ?? '?'}\` (exit ${code}). It was not merged.`);
  } else if (bounce.reason === 'merge_conflict') {
    lines.push("Your last attempt produced changes that CONFLICTED with another task's changes at merge time. It was not merged.");
  } else {
    lines.push('Your last attempt was rejected before merge.');
  }
  lines.push(`Files involved: ${files}`);
  if (bounce.excerpt) lines.push('Failure output:', '```', String(bounce.excerpt), '```');
  return lines.join('\n');
}
```

**Injection at the task-prompt hook** — `lib/build.js:3703`, where each task's prompt is built. Add, immediately after `const baseTaskPrompt = buildStepPrompt(syntheticDispatch, context);`:

```js
const inbound = inboundBounces.get(taskId);              // Map<taskId, ParMergeBounce> from prior round
let baseTaskPrompt = buildStepPrompt(syntheticDispatch, context);
if (inbound) {
  try { baseTaskPrompt = baseTaskPrompt + '\n\n' + formatBounceForPrompt(inbound); } catch { /* degrade */ }
}
```

`inboundBounces` is a `Map` owned by the retry loop (W3), empty on round 0. Import `formatBounceForPrompt` into `build.js`. **Update the stale note `step-prompt.js:165-169`** to record that consumer-side injection now exists (`formatBounceForPrompt` + `executeParallelDispatch`), server-side stays in `_render_prompt`.

---

## W2 — Anchor-commit helpers (no base-worktree mutation)

The retry worktree must be seeded with the round's successful work, but `git worktree add --detach HEAD` (`build.js:3646`) ignores base-worktree changes and good diffs are never committed. Build a **dangling anchor commit** via a temp index — **never touches the base working tree or HEAD**:

```js
// COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY: dangling commit = HEAD + replayed good diffs.
// Temp-index only; base working tree and HEAD are untouched. Returns the commit SHA.
function buildAnchorCommit(baseCwd, goodDiffs /* string[] in topo order */, label) {
  const idx = join(baseCwd, '.compose', `par-anchor-index-${process.pid}-${anchorSeq++}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    execSync('git read-tree HEAD', { cwd: baseCwd, env });
    for (const d of goodDiffs) {
      execSync('git apply --cached -', { cwd: baseCwd, env, input: d });   // index-only
    }
    const tree = execSync('git write-tree', { cwd: baseCwd, env }).toString().trim();
    const sha = execSync(`git commit-tree ${tree} -p HEAD -m "${label}"`, { cwd: baseCwd, env }).toString().trim();
    return sha;
  } finally {
    try { rmSync(idx, { force: true }); } catch { /* best effort */ }
  }
}
```

- Round-0 worktrees stay `--detach HEAD` (unchanged). Round N>0 worktrees use `git worktree add "${wtPath}" ${anchorSha} --detach` — a one-line conditional at `build.js:3646`.
- The anchor is a **dangling** commit (no ref) → no cleanup, GC reclaims it. No `reset --hard`, no temp branch, no base-worktree write.
- **`goodDiffs` are captured relative to the real HEAD** (round 0) — but a round-N task's worktree HEAD *is* the anchor, so its newly-captured `git diff --cached HEAD` (`build.js:3779`) is relative to the anchor = **only the new changes**. At merge, `applyTaskDiffsToBaseCwd` applies `goodDiffs (rel HEAD)` first, then `newDiffs (rel HEAD+goodDiffs)` onto `baseCwd@HEAD` — consistent, provided the union is applied in topo order (it already topo-sorts, `build.js:3397`).

---

## W3 — Retry loop in `executeParallelDispatch` (revised after blueprint Codex gate)

> **Codex blueprint-gate findings driving this revision (2026-06-05):** (1) the existing merge primitive **mutates the real base in place** (`applyTaskDiffsToBaseCwd` `git stash push -u … pop`, `build.js:3413/3477`), so re-merging across rounds would double-apply prior good diffs; (2) the helper returns a *file set* + single `conflictedTaskId`, **not per-task apply outcomes**, so "promote tasks in `appliedFiles`" is undefined; (5) `schema_failed` produces no bounce, so a bounce-derived subset is empty for it. The model below fixes all three.

**Core principle: keep today's per-round sequence — apply to the real base BEFORE `parallelDone` (so "complete" is never reported before the write lands, and `context.filesChanged` is set from the apply) — and fix cross-round corruption by RESTORING the base to an entry snapshot between retry rounds.** `applyTaskDiffsToBaseCwd` is reused verbatim on the real base every round; because each round starts from the restored entry base, its internal `git stash push -u … pop` never sees a prior round's union ⇒ no double-apply (fixes finding 1). No probe worktree.

Refactor the straight-line body (`build.js:3577-3883`) into a per-round closure wrapped by a bounded loop.

**Captured at entry (once):** `entrySnapshot` = a temp commit capturing the **full** entry working tree, **including untracked files**, built through a **temp index** so the real index is never mutated (Codex blueprint-gate catches: `git stash create` omits untracked; a real-index `git add -A` would clobber the user's staging on the happy path). Sequence:
```
idx=.compose/par-snap-index-<pid>; GIT_INDEX_FILE=$idx git read-tree HEAD
GIT_INDEX_FILE=$idx git add -A                       # stages tracked+untracked into the TEMP index only
tree=$(GIT_INDEX_FILE=$idx git write-tree)
snap=$(git commit-tree $tree -p HEAD -m entry-snapshot)   # dangling; real index + worktree untouched
rm -f $idx
```
The **real `.git/index` and working tree are untouched at capture** ⇒ the single-round happy path is unchanged. `snap` records working-tree content (tracked + untracked) for restore.

**Index/staging semantics (explicit):** the snapshot preserves working-tree *content*, not the staged-vs-unstaged split. That split is **not** a preserved invariant — `applyTaskDiffsToBaseCwd` already normalizes the index via its own `git stash push -u … pop` at the start of every round (`build.js:3413/3477`), so the next round re-normalizes regardless. On the happy single-round path the snapshot is captured but never used, so the index is byte-identical to today.

**State across rounds:**
- `goodDiffs: Map<taskId, diff>` — captured diffs of tasks **not** in the failed subset, accumulated.
- `goodResults: Map<taskId, result>` — their `{task_id, status:'complete', result}` for the aggregate.
- `subset: task[]` — tasks to run this round (round 0 = all).
- `inboundBounces: Map<taskId, ParMergeBounce>` — prior round's bounces, drives W1 injection.
- `round`, `cap`.

**Per round:**
1. `anchorSha = round === 0 ? 'HEAD' : buildAnchorCommit(baseCwd, topoOrder([...goodDiffs.values()]), label)`. Worktrees: `git worktree add "${wt}" ${anchorSha} --detach`.
2. Run `subset` tasks (existing per-task block: prompt + W1 injection → `runAndNormalize` → gate `runPreMergeGateLocal` → capture diff on pass). Round-N capture is `git diff --cached HEAD` in a worktree whose HEAD **is** the anchor ⇒ diff is relative to the anchor = the task's new work only.
3. **Merge to the real base (today's call + order):** `union = topoOrder(goodDiffs ∪ this round's new diffs)`; `const m = applyTaskDiffsToBaseCwd(allTasks, unionMap, baseCwd, …)` (`build.js:3834`); **set `context.filesChanged` from `m.appliedFiles`** (today, `build.js:3837` — preserved). `m.conflictedTaskId` → `buildMergeConflictBounce`. Each round's apply starts from the restored entry base (step 6), so there is no cross-round double-apply.
4. **Aggregate:** `taskResults` = `goodResults` (carried) + this round's results (`complete`/`failed`; conflict-loser marked `failed`, `build.js:3847-3852`). `bouncedTasks` = round gate bounces + conflict bounce. `mergeArg` shape unchanged (`build.js:3879-3882`).
5. `env = await stratum.parallelDone(dispFlowId, dispStepId, taskResults, mergeArg)` — **after** the base write, exactly like today (so a failed real-base apply prevents a `complete`).
6. **Decide:**
   - **Terminal complete** (`env.status === 'complete'`): the base already holds the merged union and `context.filesChanged` is set; emit `build_step_done` and `return env`. *On round 0 this is one apply + one `parallelDone` + one emit — same final base, same event content, same stratum call as today.*
   - **Retry** (`env.status ∈ {ensure_failed, schema_failed}` ∧ `Array.isArray(env.tasks)` ∧ `env.step_id === dispStepId` ∧ `round+1 ≤ cap`):
     - `subset = taskResults.filter(r => r.status === 'failed')` → task specs — **the authoritative failed set** (covers gate-failed, `schema_failed`, AND the conflict-loser; fixes findings 2 + 5). Never-applied later-topo tasks stay `complete` ⇒ their diff goes to `goodDiffs` and **replays**, re-validated by the next round's full-union apply.
     - `goodDiffs`/`goodResults` ← every non-failed task's captured diff/result.
     - `inboundBounces = Map(bouncedTasks.map(b => [b.task_id, b]))`.
     - **Restore the base working-tree content to `entrySnapshot`**: `git checkout -- . && git clean -fd` (drop this round's tracked + untracked changes back to HEAD) → `git checkout $snap -- .` (re-materialize the entry tracked **and** untracked files from the snapshot tree) → `git reset -q` (unstage; the next round's `applyTaskDiffsToBaseCwd` stash normalizes the index anyway). Restores entry **content** (staging split intentionally not preserved — see semantics note above) so the next round starts clean. (Conflict rounds already self-rolled-back in `applyTaskDiffsToBaseCwd`; the restore is idempotent.)
     - `round++`; continue — **no `build_step_done` this round** (intermediate emits suppressed, mirror `build.js:3270`).
   - **Cap exceeded / terminal non-complete:** restore base to `entrySnapshot` (the step failed → leave the base clean) and `return { ...env, _parallelRetriesExhausted: true }` (the marker W4 keys on). No partial merge left behind.

**Why no per-task helper output is needed (finding 2):** the full `union` is re-applied every round, so `applyTaskDiffsToBaseCwd` re-validates every task in topo order each round; a task is "successful" iff it is not in `taskResults.failed` — a clean boolean, never inferred from `appliedFiles`.

**Behavioral parity (honest framing — finding 3):** on `round 0` terminal-complete with the gate off, the apply→`context.filesChanged`→`parallelDone` sequence and the final base contents are **identical to today**. The **one deliberate change**: `build_step_done` is emitted *after* `parallelDone` and only on the terminal round (matching the server-dispatch path's discipline, `build.js:3270`), rather than unconditionally before `parallelDone` as the consumer path does today — because terminality is only known after `parallelDone`, and emitting a `build_step_done` on a round we then retry would falsely signal step completion. This is an intentional alignment with the server path, asserted in tests (single `build_step_done`, same content), **not** claimed as byte-identical ordering. The entry-snapshot/restore path is never touched on a single-round dispatch.

---

## W4 — Mis-route guard (both outer loops)

With W3, `executeParallelDispatch` owns its retries and returns either `complete`/`killed` (the loop exits) or a **failed terminal envelope explicitly tagged `_parallelRetriesExhausted: true`** (the cap-exceeded case). The guard keys on that explicit marker — **not** on the brittle "does `response.tasks` exist" heuristic Codex flagged (a terminal envelope can still carry task metadata).

- `build.js:1640` (runBuild) and `build.js:2784` (executeChildFlow), at the top of the `ensure_failed`/`schema_failed` branch:
  ```js
  if (response._parallelRetriesExhausted) {
    // Parallel step exhausted its own retry loop (W3). Do NOT single-agent-retry.
    streamWriter?.write({ type: 'build_error', stepId: response.step_id, error: 'parallel step failed after retries', flowId: response.flow_id });
    response.status = 'killed';   // terminal — exits the while-loop; no base-cwd single agent, no stepDone re-run
    continue;
  }
  ```
  Concretely: the marker forces a terminal exit instead of the legacy single-agent retry. (Exact terminal shape — `killed` vs a dedicated failed status — pinned in TDD so the outer-loop exit condition `status !== 'complete' && status !== 'killed'` is satisfied without falsely reporting success; a failed parallel step must surface as a build failure, not a silent complete.)
- The marker is the **only** new coupling between W3 and the outer loops — no "prior dispatch was parallel" bookkeeping in the loops (Codex finding 4).
- Test (W6): a child-flow parallel failure retries **inside** `executeParallelDispatch`; the child loop's fix/retry branch (`build.js:2784-2843`) is never entered for it (no double-handle); on cap-exhaustion it sees the tagged terminal and exits without a single-agent fix pass.

---

## W5 — D5 opt-in (default-OFF, field-omitted)

**`pipelines/build.stratum.yaml`** (copy GSD verbatim):
- `workflow.input` (lines ~14-20): add
  ```yaml
  pre_merge_gate:
    type: array
    required: false   # COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY: default-OFF per-task gate (lint+build)
  ```
- `flows.build.input` (lines ~189-192): add `pre_merge_gate: {type: array}`.
- `execute` step (lines ~339-359): add `pre_merge_verify: "$.input.pre_merge_gate"`.

**`lib/build.js` runBuild** — resolve once, gate default-OFF, **omit when off**:
```js
// near composeConfig load (build.js:620-627)
let preMergeGate;   // undefined ⇒ omitted from planInputs ⇒ byte-identical
if (composeConfig?.capabilities?.preMergeGate) {
  preMergeGate = resolvePreMergeGate(agentCwd, opts.preMergeGate);   // gsd.js export; defaults to a non-empty gate
}
```
Thread `preMergeGate` into `startFresh` (new trailing param) at all 5 sites (`build.js:871/874/887/898/908`). In `startFresh` (`build.js:3885-3913`), fold into `planInputs` **only when defined**:
```js
const planInputs = mode === 'bug'
  ? { task: description }
  : { featureCode, description, ...(preMergeGate !== undefined ? { pre_merge_gate: preMergeGate } : {}) };
```
- Import `resolvePreMergeGate` from `./gsd.js`.
- Add `capabilities.preMergeGate` to the design's config docs; default-absent ⇒ `false` ⇒ field omitted.

---

## Boundary Map

- **`formatBounceForPrompt(bounce: ParMergeBounce) -> string`** — `function` (new, `lib/step-prompt.js`). Produces: a prompt section. Consumes: `ParMergeBounce` (`contracts/par-merge-bounce.json`). Consumed by: W3 task-prompt injection.
- **`buildAnchorCommit(baseCwd, goodDiffs, label) -> string`** — `function` (new, `lib/build.js`). Produces: a dangling commit SHA. Consumed by: W3 worktree creation.
- **`executeParallelDispatch(...) -> envelope`** — `function` (modified, `lib/build.js:3577`). Now produces **only terminal** envelopes. Consumed by: `runBuild` (`build.js:1830`) + `executeChildFlow` (`build.js:2863`).
- **`startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode, preMergeGate?) -> response`** — `function` (modified signature, `lib/build.js:3885`). Consumes new optional `preMergeGate`. Produces: `planInputs` with `pre_merge_gate` present iff resolved.
- **`resolvePreMergeGate(cwd, override) -> string[]`** — `function` (reused, `lib/gsd.js:456`). Imported into `build.js`.
- **Invariant (prose):** when `capabilities.preMergeGate` is falsy, `pre_merge_gate` is **absent** from the plan-input envelope (not `[]`), and round-0 clean dispatch is byte-identical to pre-feature behavior.
- **Reused unchanged:** `applyTaskDiffsToBaseCwd` (`build.js:3387`), `buildMergeConflictBounce` (`build.js:3315`), `runPreMergeGateLocal` (`build.js:3355`), `parallelDone` `{status, bounced_tasks}` channel.

---

## Test plan (W6)

| Test | Asserts |
|------|---------|
| retry re-runs only the failed subset | a 3-task step, task 2 gate-fails round 0; round 1 re-runs only task 2; tasks 1,3 not re-run (their diffs replayed) |
| bounce-prompt injection | the round-1 prompt for task 2 contains `formatBounceForPrompt` output (gate `exit`, files, excerpt) |
| anchor seeding | round-1 worktree for the failed task is created off an anchor containing tasks 1,3's diffs (file from task 1 visible in the retry worktree) |
| gate-round vs conflict-round | both reach a clean terminal via the same loop; conflict-loser is the only re-run; later-topo task replays |
| subset = failed taskResults | a `schema_failed` task (no bounce) is still selected into the retry subset; a clean task is not |
| base restored between rounds | after a non-terminal round the base is restored to the entry snapshot (no leftover/partial union); a 2-round retry that finally succeeds leaves base = entry + final merged union only — never a doubled diff |
| restore preserves untracked entry files | a pre-existing **untracked** file in the base survives a retry round (snapshot captures it; `clean -fd` removes it; `git checkout $snap -- .` brings it back) |
| build_step_done emitted once | a multi-round retry emits exactly one `build_step_done` (terminal), not one per round |
| mis-route fixed (runBuild) | a cap-exhausted parallel step returns `_parallelRetriesExhausted`; the `build.js:1640` branch exits terminal — never a single base-cwd agent / `stepDone` |
| mis-route fixed (child flow) | same marker handling at `build.js:2784`; no double-handle in its fix/retry branch |
| depth cap | exceeding the cap returns a tagged terminal envelope (force-fail), bounded rounds; no infinite loop |
| default-OFF byte-identical | `capabilities.preMergeGate` absent ⇒ `planInputs` has **no** `pre_merge_gate` key; a clean no-gate round-0 produces the same `parallelDone` call + `build_step_done` event + final base diff as the pre-feature baseline, and makes no `buildAnchorCommit`/probe-worktree call |
| opt-in on | `capabilities.preMergeGate:true` ⇒ `pre_merge_gate` resolved via `resolvePreMergeGate` and present in `planInputs`; gate runs in worktrees |

E2E note: no UI surface — the "golden flow" is an integration test driving `executeParallelDispatch` with a stubbed `stratum` whose `parallelDone` returns `ensure_failed` once then `complete`, asserting the subset/anchor/injection behavior end-to-end.

## Verification table (Phase 5) — VERIFIED 2026-06-05 (all anchors confirmed; one correction)

**Result:** every anchor below confirmed against `git`-current source. Correction: the `execute` `parallel_dispatch` step is at `build.stratum.yaml:340-341` (blueprint prose said ~339); `executeChildFlow` at `build.js:2594`, `executeParallelDispatchServer` at `:2945`. No stale references; zero Boundary Map violations.

| Anchor | Claim | Verified |
|--------|-------|----------|
| `build.js:3577` | `executeParallelDispatch` signature | ⬜ |
| `build.js:3646` | `git worktree add … --detach HEAD` | ⬜ |
| `build.js:3703` | `buildStepPrompt(syntheticDispatch, context)` prompt hook | ⬜ |
| `build.js:3779` | `git diff --cached HEAD` capture | ⬜ |
| `build.js:3834,3879-3882` | apply-before-`parallelDone`; mergeArg shape | ⬜ |
| `build.js:3387,3397` | `applyTaskDiffsToBaseCwd` + topo sort | ⬜ |
| `build.js:1640`, `:2784` | single-agent `ensure_failed` branches | ⬜ |
| `build.js:1830`, `:2863` | parallel call sites | ⬜ |
| `build.js:3885-3913`, 5 call sites 871/874/887/898/908 | `startFresh` + `planInputs` | ⬜ |
| `build.js:620-627` | `composeConfig` load | ⬜ |
| `gsd.js:456` | `resolvePreMergeGate` export + signature | ⬜ |
| `step-prompt.js:165-169` | stale consumer-injection note | ⬜ |
| `build.stratum.yaml:14-20,189-192,339-359` | input blocks + `execute` step | ⬜ |
| `parallel_exec.py:154-185` | `_format_bounce_for_prompt` (port source) | ⬜ |
