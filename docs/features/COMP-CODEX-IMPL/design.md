# COMP-CODEX-IMPL — Codex as the implementation agent (Claude reviews)

**Status:** SHIPPED 2026-06-19 — design 3 rounds CLEAN, impl 4 rounds CLEAN; 18 new tests; full compose suite green. Follow-up: COMP-CODEX-IMPL-SPIKE (Codex `isolation: none` fallback).
**Owner:** Compose
**Roadmap:** compose/ROADMAP.md row 301 (PLANNED)
**Depends on:** STRAT-AGENT-INTERP (SHIPPED — interpolatable per-step `agent:`).

## Problem

Today every Compose build step that writes code runs Claude (Opus). Codex is
already a first-class *reviewer* (`review_check`/`test_review` sub-flows use
`agent: codex`, and `runCrossModelReview` runs a Codex second opinion). We want to
**flip the implementer to Codex while keeping cross-model review** — Codex writes
the code, **Claude reviews** it (Codex must never review its own work).

## Grounding (verified against disk via 3 parallel explorers)

- **Flag mechanism:** `--quick` is pure sugar — `bin/compose.js:2062` sets
  `singleOpts.template = 'build-quick'`, consumed by `runBuild(code, opts)`
  (`lib/build.js:779`, `resolveTemplatePath` `:590`). `fix` sets `template:'bug-fix'`.
- **The implement step is a `parallel_dispatch`** named `execute`, hardcoded
  `agent: claude` (`pipelines/build.stratum.yaml:381`, `build-quick:297`),
  `isolation: worktree`. Server-side dispatch sends only `flow_id`+`step_id`
  (`lib/build.js:3313` → `parallelStart`); the **per-task agent is resolved on the
  Stratum producer from the step's `agent` field** — which STRAT-AGENT-INTERP just
  made interpolatable (incl. the parallel_dispatch `ParallelExecutor` construction,
  `server.py` `effective_agent`). So a single spec can pick the executor at runtime.
- **Reviewers (verified):** `parallel_review` lenses are already Claude
  (`claude:read-only-reviewer`, `:138`). The Codex cross-model passes are in
  sub-flows `review_check` (`review` step `agent: codex`, `:86`) and `test_review`
  (`review_generated_tests` `agent: codex`, `:204`), invoked by main-flow steps
  `codex_review` (`:414`) and the test-review step. Each sub-flow has its own
  `$.input` scope (`task`, `blueprint`).
- **The fix-routing swap (`lib/build.js:3124-3125`):**
  `const stepAgent = resp.agent ?? 'claude'; const fixAgent = stepAgent === 'codex' ? 'claude' : stepAgent;`
  In `executeChildFlow`'s `ensure_failed` handler: when a (codex) reviewer's
  `ensure` fails, the **fix** is dispatched to a *different* model (claude). This
  hardcodes "codex reviews, claude fixes." `recovery_agent` appears only in YAML
  comments — **never read by code**; the swap is the only carrier. Same pattern in
  `lib/new.js:259,351` (the `new` command — out of the build path).
- **`runCrossModelReview` (`lib/build.js:2732-2890`):** on large diffs, runs a Codex
  second-opinion pass (`agent:'codex'`, `:2771`) + a Claude synthesis (`:2844`).
- **Caps are already inert for the implementer:** the `execute` step's template is
  `implementer` with `allowedTools: null` (`server/agent-templates.js:23`), so the
  Claude-specific caps vocabulary (`capability-checker.js`) is a **no-op** for it
  today — even for Claude. Cert injection is already gated on
  `agentType.startsWith('claude')` (`lib/build.js:4239`; producer gives Codex raw
  intent, `test_cert_executor.py:71`). **No caps/cert changes needed.**
- **Worktree isolation:** per-task worktrees via `git worktree add --detach`
  (`lib/build.js:4146`); the agent runs with `cwd = <worktree>`
  (`result-normalizer.js:294`). **Codex self-applies a Seatbelt sandbox**
  ([[project_codex_seatbelt_nonnesting]]); whether its profile tolerates writing
  inside a `--detach` worktree (whose `.git` is a *file* pointer) is **UNVERIFIED —
  no codex+worktree path exists in the repo today** (Codex only ever runs read-only
  reviews with `cwd` at the repo root).

## Roles (the model this feature introduces)

| Role | Default | `--codex` | What it does |
|---|---|---|---|
| **implementer** | `claude` | `codex` | writes the feature code (the `execute` step) |
| **reviewer** | `codex` | `claude` | the cross-model review pass — always ≠ implementer |
| **fixer** | = implementer | = implementer | applies review-finding fixes to the implementer's own code |

Invariant: **reviewer ≠ implementer** (cross-model), and **fixer = implementer**
(whoever wrote the code fixes it). Today's hardcoded swap accidentally satisfies
this only because implementer is always Claude; making the implementer Codex breaks
it, which is the core of this feature.

## Approach — single spec, interpolated agents (uses STRAT-AGENT-INTERP)

No `build-codex.stratum.yaml` duplicate. One spec, two new flow inputs, runtime role
selection. This is exactly why STRAT-AGENT-INTERP was built first.

### 1. Flag → role inputs (`bin/compose.js`, `lib/build.js`)

- Parse `--codex` (mirrors `--quick`, `bin/compose.js:1977`) into `opts.codex`.
  **v1 rejects `--codex` + `--quick`** (build-quick Codex parity is deferred, §6) and
  `--codex` + batch (same as `--quick`, narrow first). So `--codex` is full-`build`,
  single-feature only in v1.
- `runBuild` derives roles on a **fresh** start: `implementerAgent = opts.codex ?
  'codex' : 'claude'`, `reviewerAgent = opts.codex ? 'claude' : 'codex'`. Inject both
  into the flow inputs at fresh-plan construction (`startFresh`, `lib/build.js:4515`
  and its callers `:969/:972`) so `$.input.implementer_agent` /
  `$.input.reviewer_agent` always resolve. (Stratum persists flow inputs in FlowState,
  so the *interpolated spec* resolves correctly on resume without re-passing them.)
- **Roles must be durable across resume (Codex review finding #1).** The compose-side
  `context.implementerAgent`/`reviewerAgent` drive build.js fix-routing (§3) and
  cross-model suppression (§4) — these are rebuilt **locally** on every invocation
  (`lib/build.js:1051`), so a `--codex` build **resumed without the flag** would
  silently revert to claude-implementer roles and re-enable Codex self-review. Fix:
  - **Persist** `implementerAgent`/`reviewerAgent` into active-build state on fresh
    start and on resume-refresh (`lib/build.js:943`/`:4520`), alongside the existing
    `mode`/`pid` fields (same pattern as GSD-6 state checkpointing).
  - On **resume** (`lib/build.js:920`/`:982`), **restore roles from active-build
    state**, not from the current invocation's flags; the flow's persisted inputs are
    the source of truth and the local context must match them. A resume that passes a
    conflicting `--codex`/no-`--codex` is reconciled to the persisted roles (warn on
    mismatch).

### 2. Spec wiring (`pipelines/build.stratum.yaml`)

- **Add `implementer_agent` and `reviewer_agent` to BOTH input declarations** — the
  spec declares its input surface twice: `workflow.input` (`build.stratum.yaml:14`)
  **and** `flows.build.input` (`:226`). Updating only one ships a half-wired spec
  (Codex review finding). Both get `implementer_agent`/`reviewer_agent`
  (`type: string, required: false` — compose always supplies them; `required:false`
  only so a hand CLI run without them still *parses*, though it would then fail
  resolution, which is acceptable since compose is the sole driver).
- `execute.agent: "$.input.implementer_agent"` (was `claude`).
- **Thread the reviewer into the codex sub-flows** (each has its own `$.input`):
  - `review_check`: add `reviewer_agent` input; `review` step
    `agent: "$.input.reviewer_agent"`. Main-flow `codex_review` step passes
    `reviewer_agent: "$.input.reviewer_agent"`.
  - `test_review`: add `reviewer_agent` input; `review_generated_tests` step
    `agent: "$.input.reviewer_agent"`. Its invoking main-flow step passes it through.
- `parallel_review` lenses stay Claude (always) — they are the primary review and are
  cross-model whenever the implementer is Codex.

Default-path identity: with `implementer_agent=claude`, `reviewer_agent=codex`, every
resolved agent equals today's literal, so existing builds are byte-identical
(`resolve_agent` returns the resolved literal; STRAT-AGENT-INTERP guarantees this).

### 3. Role-aware fix routing (`lib/build.js:3124-3125`)

Replace the hardcoded swap with the role:

```js
const fixAgent = context.implementerAgent || 'claude';   // fixer = implementer
```

The implementer fixes its own code regardless of who reviewed. Default
(implementer=claude) reproduces today's `codex→claude` outcome exactly (a codex
reviewer's finding is fixed by claude, the implementer); `--codex` routes fixes to
codex. The main-loop retry path (`lib/build.js:1859`) already keeps `response.agent`
and does not swap — no change there.

### 4. Suppress Codex self-review (`lib/build.js` cross-model + a `skip_if`)

- `runCrossModelReview` (`:2732`): when `context.implementerAgent === 'codex'`, **skip
  the Codex second-opinion pass** (it would be Codex reviewing its own diff). The
  Claude `parallel_review` already provides cross-model coverage; log the skip.
- The pipeline `codex_review` step (`:414`) is handled by §2 (its sub-flow now runs
  `reviewer_agent`, which is Claude when Codex implements) — no self-review, no skip
  needed.

### 5. Isolation — PREFLIGHT PROBE + fail-fast, not a warning (Codex review finding #2)

The Codex-Seatbelt-vs-worktree interaction is unverified and there is no precedent in
the repo. The implement step is `isolation: worktree` (`build.stratum.yaml:378`) and a
detached worktree is created before the agent runs (`lib/build.js:4146`). If Codex
cannot write inside that worktree under its Seatbelt, the build **hard-fails at
`execute`** — a runtime warning would only explain the failure after it happens. Per
[[feedback_verify_isolation_primitives]] (don't claim isolation works unverified) and
[[project_codex_seatbelt_nonnesting]], v1 gates on a **real probe**, not a warning:

- **Preflight probe (compose-side, runs once when `--codex` and the producer/consumer
  would use worktrees):** create a throwaway detached worktree, run a trivial
  Codex write task in it (`stratum.runAgentText('codex', "<write a sentinel file>",
  {cwd: probeWorktree})`), assert the sentinel landed on disk, then remove the
  worktree. This exercises the exact primitive (Codex + Seatbelt + detached worktree +
  `.git`-file pointer) before any real work.
- **On probe success** → proceed with worktree isolation (unchanged spec).
- **On probe failure** → **abort the `--codex` build fast** with a clear, actionable
  error: Codex cannot write inside a detached worktree in this environment; this is the
  known `COMP-CODEX-IMPL-SPIKE` limitation; re-run without `--codex`, or wait for the
  `isolation: none` fallback. It never proceeds into a build that would fail mid-`execute`.
- The probe result is cached per-repo (so it runs once, not per build) and is skippable
  via an env override for CI/testing.
- **`COMP-CODEX-IMPL-SPIKE` follow-up** still owns the *proper* fix: a Codex-specific
  `isolation: none` execution path so `--codex` works even where the worktree probe
  fails (today `isolation` is not interpolatable, so this needs either a producer-side
  change or a `build-codex` execute variant — out of v1 scope).

v1 thus **fails fast with a clear message** instead of asserting the primitive works.

### 6. Scope / non-goals (ship narrow first)

**In v1:** `--codex` flag (full `build`, single-feature; rejects `--quick`/batch);
role inputs + interpolated implementer/reviewer in `build.stratum.yaml` (both input
blocks); role-aware fix routing; Codex self-review suppression; resume role durability
(§1); the **preflight worktree probe with fail-fast abort** (§5). Caps/cert require
**no change** (already inert/gated for Codex).

**Deferred (each a named follow-up):**
- `COMP-CODEX-IMPL-SPIKE` — a Codex-specific `isolation: none` execution path so
  `--codex` works even where the worktree probe fails (the probe itself ships in v1;
  this follow-up is only the *fallback* for the probe-fails case).
- `build-quick.stratum.yaml` Codex parity (same mechanical edits) — v1 is `--codex`
  on the full `build` pipeline only; `--codex` + `--quick` rejected in v1.
- `lib/new.js:259,351` swap role-awareness (the `new` command, off the build path).
- A Codex/gpt tier→model map in `server/model-tiers.js` (today Codex gets the
  producer's default model for `type:codex`; no compose-side model id) — only needed
  if we want to pin a specific Codex model per tier.

## Backward compatibility & risk

- **Default path byte-identical:** defaults (`claude`/`codex`) make every interpolated
  agent equal today's literal. A test asserts the default `execute` dispatch resolves
  to `claude` and the codex sub-flows to `codex`.
- **The one real risk:** the flow now *requires* `implementer_agent`/`reviewer_agent`
  to be present (an interpolated `$.input.x` raises if absent). Mitigation: inject
  them at **every** build-flow plan/resume site; a test exercises the resume path.
- **No app-breakage:** spec + JS-logic changes only; no UI. `verifyPipelineIntegrity`
  re-hashes the edited spec automatically (`lib/build.js:788`).

## Test plan (TDD — vitest, repo runner)

1. **Flag → roles:** `--codex` ⇒ `implementerAgent='codex'`, `reviewerAgent='claude'`;
   absent ⇒ `'claude'`/`'codex'`. `--codex` + batch rejected; `--codex` + `--quick`
   rejected (v1).
2. **Flow-input injection:** `startFresh` puts both role inputs into the fresh plan
   inputs (default + `--codex` values).
2b. **Resume role durability:** a `--codex` build persists `implementerAgent='codex'`/
   `reviewerAgent='claude'` into active-build state; resuming it **without** the flag
   restores `codex`/`claude` from state (not the default), so fix-routing and
   cross-model suppression keep the right roles. A conflicting resume flag warns and
   reconciles to persisted state.
3. **Spec resolves:** parse `build.stratum.yaml`; with default inputs the `execute`
   dispatch agent resolves to `claude` and `review_check`/`test_review` to `codex`;
   with `--codex` inputs, `execute`→`codex`, sub-flow reviews→`claude`. (Drive via the
   Stratum dispatch envelope, asserting the resolved `agent`.)
4. **Fix routing:** `fixAgent` equals the implementer (`claude` by default, `codex`
   under `--codex`) — not the old hardcoded swap.
5. **Cross-model suppression:** `runCrossModelReview` skips the Codex pass when
   `implementerAgent==='codex'`; runs it (unchanged) by default.
6. **Preflight probe:** with `--codex`, a mocked probe success lets the build proceed;
   a mocked probe failure **aborts** with the actionable `COMP-CODEX-IMPL-SPIKE` error
   and never dispatches `execute`. Probe result is cached per-repo; env override skips it.
7. **Spec integrity:** edited `build.stratum.yaml` still passes the pipeline schema /
   `verifyPipelineIntegrity`.
8. Full compose test suite green (`npm test` node suite, `--test-timeout` bounded).
