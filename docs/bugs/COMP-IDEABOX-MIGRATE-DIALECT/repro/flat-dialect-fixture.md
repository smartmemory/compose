# Forge Ideabox

Lightweight capture for raw ideas before they're ready for ROADMAP.md.

Cluster by potential feature. Statuses: `NEW` | `DISCUSSING` | `PROMOTED (→ <FEATURE-ID>)` | `KILLED`.

---

## Compose Lifecycle Variants

### IDEA-1 — `/compose fix`: fold all bug-fix workflows into Compose
**Status:** PROMOTED (→ COMP-FIX, shipped 2026-05-01; follow-up COMP-FIX-HARD planned) | **Priority:** P0 | **Tags:** #core #compose #bugfix
**Source:** Conversation 2026-05-01 — one Compose, two entry verbs (`/compose build` and `/compose fix`)
**Idea:** Add `/compose fix <bug-ref>` as a sibling entry to `/compose build`, owned by the same Compose skill. Bug-specific phases (Triage, Reproduce, Root-cause via `superpowers:systematic-debugging`) replace the design/PRD/architecture/blueprint phases of `build`; Phase 6 (plan), Phase 7 (TDD fix → E2E → Codex review loop → regression sweep), Phase 9 (docs), and Phase 10 (ship) are reused unchanged. Severity branch: trivial bugs skip Stratum/folder overhead and go straight to TDD-fix-commit; Standard/Hotfix runs the full pipeline with `docs/bugs/<id>/` folder for repro/diagnosis/fix artifacts, vision-item binding via `mcp__compose__*`, `.stratum.yaml` with `ensure` postconditions per phase (`failing_test_exists`, `test_was_red_then_green`, `full_suite_passes`), canonical `ReviewResult` gate (`compose/contracts/review-result.json`, conf ≥ 7) before ship, and `stratum_audit` trace in commit. Deliverables: (a) extend `compose/.claude/skills/compose/SKILL.md` with the `fix` mode, (b) absorb the existing standalone `bug-fix` skill (`~/.claude/skills/bug-fix/SKILL.md`) — its phase logic, gate protocol, path branching all migrate in — and deprecate the standalone skill (redirect to `/compose fix`), (c) absorb references to bug-fix workflow patterns from `superpowers:systematic-debugging`, `superpowers:test-driven-development`, `superpowers:verification-before-completion`, `superpowers:requesting-code-review` as cross-cutting calls inside Compose's bugfix branch — same way `build` already calls them. Net result: one Compose skill, no parallel bug-fix lifecycle skill anywhere.
**Maps to:** `/compose` skill (`compose/.claude/skills/compose/SKILL.md`), `bug-fix` skill (`~/.claude/skills/bug-fix/SKILL.md` — to be absorbed and deprecated)

---

## Review & Quality Gates

### IDEA-2 — Reviewer trust scoring with auto-downgrade on misbehavior
**Status:** NEW | **Priority:** — | **Tags:** #core #compose #review #stratum
**Source:** Ruflo comparison 2026-05-04 — https://github.com/ruvnet/ruflo (federation behavioral trust model)
**Idea:** Track each Codex reviewer's historical reliability and weight their confidence scores accordingly, instead of treating every review pass as equal. Borrow Ruflo's federation formula shape (`0.4×success + 0.2×uptime + 0.2×threat + 0.2×integrity`) adapted for review: success = findings that survived human review or matched later-discovered bugs; integrity = self-consistency across re-runs; threat = false-positive / hallucinated must-fix rate; uptime = completion rate without crashes/timeouts. Trust score feeds the canonical `ReviewResult` confidence gate (currently flat ≥ 7) — high-trust reviewers get findings accepted at lower confidence; low-trust ones need higher confidence or escalate to human. Instant downgrade on detected misbehavior (hallucinated file path, fabricated line number, contradicting prior pass on unchanged code). Storage: per-reviewer-id record in compose MCP, updated each gate. Probably wants a small dashboard surface in Vision Surface so trust drift is visible.
**Maps to:** `compose/contracts/review-result.json`, STRAT-REV review loop, `mcp__stratum__stratum_agent_run` review path

---

### IDEA-16 — Citation-checked current-state claims in design docs
**Status:** DISCUSSING | **Priority:** P2 | **Tags:** #core #infra
**Triage (2026-07-24):** Real and recurring (the stale-citation class has 10+ logged instances, and the note-based countermeasure failed again the very session this was filed — a note is a hope, not a control). Mechanism already proven by COMP-MCP-VALIDATE's write-time link validation, so this is an extension of a shipped pattern, not a green-field build. Not promoted yet: needs its own design and a target-repo decision (compose `validate` extension vs a stratum-side checker), and it competes with the discovery-loop and canon-guard tracks for the next slice. Honest ceiling stands — it catches stale/false citations, never the wrong-inference class (one of the two motivating errors).
**Source:** Conversation 2026-07-24 — STRAT-SEARCH design gate, where a Codex review caught two false claims I had written about the codebase
**Idea:** Design docs assert facts about the code ("X is enforced at `validate.ts:565`", "`RunStatus` has no non-failure terminal") and nothing checks them, so they are wrong on the day they are written and rot further as code moves. Make each current-state claim carry a `file:line` plus a machine-checkable assertion, and add a checker that re-verifies every citation — at write time like `compose validate`'s link validation, and in CI so drift surfaces as the code changes. **Honest limitation: this catches the stale/false-citation class, not the wrong-inference class** — one of the two errors that motivated it was a correct citation with a false conclusion drawn from it, which no citation checker can catch. Worth building anyway because the stale class is the one that recurs: `feedback_verify_roadmap_rows_vs_disk` records 10+ instances plus a sweep that found 24 stale rows in one repo, and the countermeasure to date is a memory note — which was present, detailed, retrieved, and lost to an assumption anyway. A note is a hope, not a control.
**Maps to:** `idea_artifact_lineage` (memory — artifacts declare upstream `_sources` for staleness; this is its first concrete consumer), COMP-MCP-VALIDATE (compose's write-time link validation — same mechanism, different target), STRAT-SEARCH S1 (same insight one level down: put a program between the actor and its own report), `feedback_verify_before_claims`, `feedback_verify_roadmap_rows_vs_disk`

---

## Output & Presentation

### IDEA-3 — HTML output for presentation surfaces (review reports, dashboards, audit traces)
**Status:** NEW | **Priority:** — | **Tags:** #ux #compose #review #stratum
**Source:** Simon Willison 2026-05-08 — https://simonwillison.net/2026/May/8/unreasonable-effectiveness-of-html/ (Thariq Shihipar's claim that HTML beats Markdown for LLM output now that token budgets are large)
**Idea:** Default LLM-generated *presentation surfaces* in Compose/STRAT-REV/Vision Surface to HTML instead of Markdown. Token-efficiency arguments for Markdown are obsolete; HTML unlocks SVG diagrams, collapsible sections, severity color-coding, in-page nav, inline diff snippets, interactive widgets. High-value targets: (a) STRAT-REV review reports — collapsible findings grouped by severity (must-fix/should-fix/nit), jump-to-file links, inline code excerpts; (b) `stratum_audit` trace viewer — timeline of steps with postcondition pass/fail badges, expandable inputs/outputs; (c) `get_phase_summary` and roadmap dashboards — filter by status, expand task trees, render Mermaid inline (overlaps with parked `idea_mermaid_docs_view`). Constraint: HTML is for *presentation*, not source of truth — keep specs, contracts, plans as Markdown/JSON so they stay diffable in git. Cheapest experiment: add `--html` flag to one Compose review output, see if reviewers actually prefer it over the markdown version before generalizing.
**Maps to:** STRAT-REV (`docs/features/STRAT-REV/`), `compose/contracts/review-result.json`, Vision Surface docs view, `stratum_audit`, `mcp__compose__get_phase_summary`

---

## Parallelization & Subagent Dispatch

### IDEA-6 — RPC subagent dispatch with zero-context-cost turns (STRAT-PAR enhancement)
**Status:** NEW | **Priority:** — | **Tags:** #core #stratum #parallelization
**Source:** Hermes Agent (NousResearch/hermes-agent) competitive scan 2026-05-12 — README explicitly pitches "Spawn isolated subagents for parallel workstreams. Write Python scripts that call tools via RPC, collapsing multi-step pipelines into zero-context-cost turns."
**Idea:** STRAT-PAR (parallel dispatch, COMPLETE) currently spawns subagents whose tool-call costs land in the parent's context unless the dispatching agent explicitly summarises. Hermes' shape: subagents are reachable by RPC from a script the parent writes; the *script* makes the tool calls and returns a single structured result to the parent. Net effect: multi-step pipelines (e.g. "for each of these 20 files, run lint + format + test, report only the failures") cost the parent one turn of context regardless of step count. Investigate whether STRAT-PAR's existing parallel_exec.py side-channel can grow this RPC affordance, or whether it wants a new dispatch mode (`stratum.dispatch.rpc`). The interesting design question: do the subagents stay LLM-driven (orchestrated by the script) or become pure tool runners (script orchestrates, no inner LLM)? Hermes' framing suggests the latter for cost reasons. Pairs with COMP-SANDBOX (container-isolated mode) and the existing parallel_exec.py infrastructure. Worth reading Hermes' implementation before designing.
**Maps to:** STRAT-PAR (parallel dispatch infrastructure, COMPLETE), `parallel_exec.py` side-channel, COMP-SANDBOX (planned)

---

## Skills & Decision Tooling

### IDEA-4 — `/council` skill: 4-voice adversarial decision gate
**Status:** PROMOTED (→ COMP-COUNCIL-1, 2026-05-11) | **Priority:** P2 | **Tags:** #ux #compose #skills
**Source:** ECC (`affaan-m/everything-claude-code`) scan 2026-05-11 — `skills/council/SKILL.md`. Conversation 2026-05-11.
**Idea:** Add a `/council` skill that convenes four voices on ambiguous decisions (monorepo vs polyrepo, ship-now vs polish, scope-cut vs hold-strategic-breadth, etc.). Architect = in-context Claude; Skeptic / Pragmatist / Critic = three subagents launched **in parallel as fresh contexts** with only the question + minimal repo context — *not* the conversation history. That fresh-context spawn is the anti-anchoring mechanism and the only non-obvious part of the design. Architect writes its initial position *before* reading the others, so synthesis isn't a mirror. Each voice returns Position / Reasoning / Risk / Surprise in ≤300 words. Verdict shape preserves raw positions before the synthesis line so the user sees dissent, not just conclusion. Where it fits in Forge: (a) Compose design-gate decisions in `build` mode (currently brainstorming-only), (b) the "is this still the right scope?" check in `fix` mode when Codex review iterations stop converging (per `feedback_codex_review_convergence` memory — known pain point), (c) standalone outside the pipeline for strategic calls. Standalone skill, not baked into `/compose`. Cheap to build (afternoon).
**Maps to:** `/compose` skill (design gate, scope-check), `superpowers:brainstorming` (complement, not replacement), STRAT-REV review-fix loop (convergence-stall trigger)

### IDEA-5 — `/context-budget` skill: token audit across loaded surface
**Status:** PROMOTED (→ COMP-CTXBUDGET-1, 2026-05-11) | **Priority:** P2 | **Tags:** #infra #compose #skills
**Source:** ECC (`affaan-m/everything-claude-code`) scan 2026-05-11 — `skills/context-budget/SKILL.md`. Conversation 2026-05-11.
**Idea:** Audit Claude Code context-window consumption across every loaded component (agents, skills, MCP server schemas, rules, CLAUDE.md chain), classify each into **always / sometimes / rarely needed** buckets, and surface a prioritized cut list. The bucket model is the only non-obvious idea — it forces a lazy-load decision per component, not a one-shot "is this big?" verdict. Forge-specific scope: must count Compose MCP tool schemas (~30+), Stratum MCP tool schemas (~25+), the full local skill catalog, and the user's global `~/.claude/skills/` surface. We've never measured this and it's almost certainly a meaningful fraction of session tokens. Flag heuristics from ECC: skills >400 lines, rules >100 lines, MCP servers with >20 tools (especially ones that wrap simple CLIs), agent files >200 lines, agent descriptions >30 words, duplicate skill copies in `.agents/skills/`. Output: ranked recommendations with estimated reclaim per cut. Cheap to build (afternoon).
**Maps to:** `compose/.claude/skills/`, `compose/.mcp.json`, Stratum MCP surface, user-level `~/.claude/skills/` and `~/.claude/rules/`

### IDEA-17 — Context-budget as a tracked recurring cost, not a one-shot snapshot
**Status:** PROMOTED (→ COMP-CTXBUDGET-2, 2026-08-08) | **Priority:** — | **Tags:** #infra #compose #skills
**Source:** `zwolf25/tokenminning` scan 2026-08-08 — `examples/context-debt.md` ("measure recurring improvements, not one-time optimizations"; audits Manual → Automated) and `examples/rtk-llmlingua-evaluation.md` (the adoption-rate finding, below)
**Idea:** COMP-CTXBUDGET-1 is COMPLETE and COMP-CTXBUDGET-1-2 already made it progressive-disclosure-aware (live-startup vs on-disk estimate), but it remains a **manually-invoked snapshot**: you learn what is big today, never that it grew 12% since June. Three deltas, all small on top of existing `compose/lib/context-budget.js`. (a) **Persist a baseline** — append each run's live-startup total + per-component breakdown to a JSONL series so the skill can print drift ("+8.2K live tokens since 2026-06-06 baseline of ~107.8K"), which is the number that actually justifies a cut. (b) **Run it unattended** — pre-push hook or cron, failing loud (or just reporting) when live startup crosses a configurable ceiling, so context debt surfaces before someone notices sessions feel heavy. (c) **Express reclaim as recurring cost** — rank cuts by tokens/session × sessions/week rather than bytes-on-disk, which reorders the cut list non-trivially (a 400-line rarely-loaded skill is near-free under progressive disclosure; 200 lines of always-loaded `~/.claude/rules/` is not). Second, sharper idea from the same source, worth folding in or splitting later: **audit whether an optimization actually fires.** Tokenminning's one genuinely empirical finding was that a token-saving tool they had installed and trusted was reached by only 6% of eligible calls for 30 days — the tool worked, its trigger didn't ([rtk-ai/rtk#2425](https://github.com/rtk-ai/rtk/issues/2425), verified open 2026-08-08; we do not run RTK, the lesson is the transferable part). We have no instrumentation telling us whether our own hooks, gates, and guards fire at the rate we assume. An adoption-rate pass over Claude Code session history (which hooks fired / which gates were skipped / which skills were never invoked) is the same measurement discipline pointed at enforcement rather than size. Caveat on the source: tokenminning is a 13-star markdown-only philosophy repo whose headline metrics are self-reported n=1 wiki dedup with no control — the framing is worth taking, the numbers are not.
**Maps to:** COMP-CTXBUDGET-1 (COMPLETE — `compose/lib/context-budget.js`, forge baseline ~107.8K live / ~55.5K reclaimable), COMP-CTXBUDGET-1-2 (COMPLETE — live-startup estimate), `/context-budget` SKILL.md, Claude Code hook surface, [[feedback_flush_at_300k]]

---

## Pipeline Enforcement & Guardrails

### IDEA-7 — Per-step `allowed_tools` enforcement in Stratum (state-machine guardrails)
**Status:** NEW | **Priority:** — | **Tags:** #core #stratum #compose #safety
**Source:** statewright/statewright scan 2026-05-14 — https://github.com/statewright/statewright (state-machine tool gating for AI agents; claims local-model 2/10 → 10/10 on 5-task SWE-bench subset with constrained tool spaces)
**Idea:** Stratum steps currently rely on prompt-level "You MUST" checklists (see `feedback_pipeline_intent_specificity`) to keep agents in their lane. Statewright's bet is that the bigger lever is making forbidden tools *invisible* per phase, not describing them better — planning state exposes Read/Grep only; implementing unlocks Edit; testing only allows prefix-matched commands like `pytest`. Hard-enforce at the protocol layer via hooks so the model never sees the disallowed tool list. For Stratum: add optional `allowed_tools: [...]` to each step in `.stratum.yaml`, plus structural caps `max_edit_lines`, `max_files_per_step`, `allowed_commands` (prefix-matched), and Bash discernment (block `>>`, `rm`, `shred`, scripting interpreters when not in a write step even if Bash is in `allowed_tools`). Enforcement wires through the existing Claude Code hook surface — runtime hides non-allowed tools when the step activates and restores them on `stratum_step_done`. Pairs with parked `idea_budget_ceilings` (those caps are the same shape — `max_iterations`, wall-clock, action count). Compose pipelines (build + fix modes) become the first consumer: planning steps lose Edit/Write, implementation steps cap edit size, ship steps lose Bash-write entirely. Also worth examining their "loops not DAGs" framing — Stratum's IR is DAG-shaped with iteration bolted on; statewright treats retry-loops (testing → implementing → testing) as first-class. Caveats: statewright has a patent (pledge covers solo/OSS/single-team self-host, so embedding the *idea* is fine — don't copy their engine); their benchmark is 5 tasks, take numbers as direction not magnitude.
**Maps to:** Stratum IR (`.stratum.yaml` schema), `mcp__stratum__stratum_plan` / `stratum_step_done`, Claude Code hook surface, `idea_budget_ceilings` (parked), Compose pipelines (build + fix), STRAT-IMMUTABLE (spec immutability — complementary, runtime vs spec)

### IDEA-18 — Retry-loop detection at the tool-call layer (PreToolUse warn, not block)
**Status:** PROMOTED (→ COMP-LOOP-DETECT, 2026-08-08) | **Priority:** — | **Tags:** #infra #safety #compose #stratum
**Source:** `zwolf25/tokenminning` scan 2026-08-08 — `examples/rtk-llmlingua-evaluation.md`, the `loop-detect.sh` artifact
**Idea:** A ~15-line PreToolUse hook that counts consecutive **identical** tool calls and, on the 3rd, returns `permissionDecision: "ask"` with a "possible retry loop, confirm to continue" reason. The design choice worth stealing is **warn, not block**: `ask` rather than exit-code-2 preserves legitimate repetition (polling a background job, watching a build) while still interrupting a blind retry loop, so it can be enabled globally without curating an exception list. This sits **below** COMP-ITER-BUDGET, which is the same instinct one layer up: COMP-ITER-BUDGET caps *pipeline* iterations on `start_iteration_loop` with auto-abort and a structured failure report, and cannot see an agent that burns 60 turns re-running one failing command inside a single step. It is also complementary to IDEA-7 above — IDEA-7 makes the wrong tool invisible, this catches the right tool used in circles. Direct hit on a known, costed failure mode: `subagent-model-routing.md` records that the expensive DeepSWE outcome is not a wrong answer but a retry blowup (268 steps / 214K tokens for the same result a converging run got in 95 / 86K), with the standing rule "if a dispatch starts iterating instead of converging, escalate rather than feeding it retries" — currently enforced only by the controller happening to notice. Open questions for scoping: what counts as "identical" (exact command string vs normalized vs same tool + same target file), whether the counter resets on any intervening different call or on a sliding window, and whether the trip count should scale by tool (3 is right for Edit, wrong for a deliberate `sleep`-and-poll). Cheap to build (afternoon); the value is entirely in tuning the identity predicate, not the hook.
**Maps to:** COMP-ITER-BUDGET (pipeline-level iteration caps — this is the turn-level floor beneath it), IDEA-7 (per-step `allowed_tools` — same hook surface), `~/.claude/rules/subagent-model-routing.md` (DeepSWE retry-blowup calibration), Claude Code PreToolUse hook surface / `settings.json`, `mcp__compose__abort_iteration_loop`

---

## Agent Routing & Model Assignment

### IDEA-8 — Declarative per-step Executor/Architect routing in Stratum specs
**Status:** NEW | **Priority:** — | **Tags:** #core #stratum #compose
**Source:** Paul Hoke, "The Executor and the Architect" 2026-05-15 — https://medium.com/@paulhoke/the-executor-and-the-architect-a-framework-for-ai-driven-engineering-52337694b690. Conversation 2026-05-15.
**Idea:** The article's only non-obvious contribution is *model assignment as an explicit protocol driven by task shape* — Executor (Codex: bounded, spec-driven, iterate-to-green, pass/fail metric) vs Architect (Opus: ambiguous, cross-cutting, large-context, completeness over speed). Everything else it describes (the agentic tool loop, iterate-until-green) we already have as `stratum_iteration_start/report` + `ensure` postconditions + the judge kernel — nothing to add there. Today the role split lives as prose in the Compose skill plus the standing `feedback_review_loop_roles` convention (Opus fixes, Codex reviews, never Codex editing files). Proposal: add an optional per-step `role: executor|architect` (or `agent`/`model`) hint to `.stratum.yaml`, so Stratum *routes* explicitly-marked mechanical iterate-to-green steps (dep migrations, pattern replacement, test-to-green) to the write-capable Codex path (`codex-rescue` already exists, `reference_codex_review_tooling`) while design/cross-cutting steps stay on Opus. Makes the Executor/Architect split an auditable, declared spec property instead of buried convention. Preserves `feedback_review_loop_roles` — review stays Codex-reviews-Opus; this only adds an opt-in executor lane for steps that explicitly request it. Same per-step `.stratum.yaml` schema family as IDEA-7 (`allowed_tools` gating) and parked `idea_budget_ceilings` — likely co-designed. Scope discipline: do NOT build a generic "agentic patterns catalog" into Compose; the loop/self-correction/gates/review-roles are already first-class — this is one missing routing knob, not a framework.
**Maps to:** Stratum IR (`.stratum.yaml` schema), `mcp__stratum__stratum_plan` / `stratum_step_done`, IDEA-7 (per-step `allowed_tools` — same schema family), `codex-rescue` (write-capable executor path), `feedback_review_loop_roles` (constraint preserved), Compose pipelines (build + fix)

### IDEA-13 — Pluggable CLI agent-driver seam (host any coding agent, not just Claude+Codex)
**Status:** NEW | **Priority:** — | **Tags:** #core #stratum #compose #integration
**Source:** superset-sh/superset scan 2026-05-24 — https://github.com/superset-sh/superset (Electron app, ELv2, ~11k stars; orchestrates parallel CLI agents — Claude Code, Cursor, Aider, Codex, Copilot — each isolated in a git worktree)
**Idea:** Stratum/Compose execution paths are shaped around Claude+Codex (`mcp__stratum__stratum_agent_run type=codex`, `codex-rescue`, Opus-fixes/Codex-reviews via `feedback_review_loop_roles`). Superset treats every coding agent as a generic CLI process behind a uniform driver, which is what lets them claim universal compatibility. Proposal: extract a small "agent driver" seam — a typed interface (`spawn(prompt, cwd, env) → stream(stdout, stderr) → result`) with concrete drivers for Claude Code, Codex, Cursor CLI, Aider, Gemini CLI. Stratum's existing `stratum_agent_run` becomes one consumer; `codex-rescue` and the review path become driver-agnostic. Same shape as the MM-CINE pluggable capture-driver decision (`project_moviemaker_capture_substrate.md`) — bake in the seam early, ship one driver, let others land later. Preserves `feedback_review_loop_roles` (reviewer driver ≠ fixer driver is still a constraint). Co-design with IDEA-8 (per-step `role` routing) — once routing is declarative, the routed-to agent is just a driver name. Scope discipline: this is an interface refactor + 1-2 reference drivers, NOT a "support every agent on day one" project.
**Maps to:** `mcp__stratum__stratum_agent_run`, `codex-rescue`, STRAT-REV review path, IDEA-8 (per-step role routing — same schema family), `project_moviemaker_capture_substrate` (precedent), `feedback_review_loop_roles` (constraint preserved)

---

## Worktree & Environment

### IDEA-14 — Workspace presets: declarative worktree bring-up spec
**Status:** NEW | **Priority:** — | **Tags:** #infra #compose #stratum #ux
**Source:** superset-sh/superset scan 2026-05-24 — https://github.com/superset-sh/superset (workspace presets: declarative spin-up of a worktree with deps installed, env seeded, agent launched, all from one config)
**Idea:** `EnterWorktree` / `superpowers:using-git-worktrees` give us an isolated checkout, but everything after that (install deps, seed `.env`, start dev servers, launch the right agent) is hand-scripted per feature — and frequently forgotten when parallel runs (`stratum_parallel_start`) spawn fresh worktrees. Proposal: a small declarative spec, e.g. `bring-up.yaml` next to `.stratum.yaml` (or a `bringup:` block inside it), describing: dependency install commands, env-var sources, services to start, optional initial agent invocation, teardown on `ExitWorktree`. One-shot from the executor, idempotent, cached. Cheapest v1: a `bringup` step type that runs a list of shell commands with `ensure: services_up | deps_installed` postconditions; richer formats can land later. Pairs with IDEA-13 (driver picks the agent; preset launches it) and removes a real friction point for parallel runs going sideways — every worktree comes up the same way, so "open in editor" / one-click handoff actually works. Watch-out: don't reinvent docker-compose; this is a thin wrapper over commands the user already runs, not a new build system.
**Maps to:** `EnterWorktree` / `ExitWorktree`, `superpowers:using-git-worktrees`, `mcp__stratum__stratum_parallel_start`, IDEA-13 (agent driver — preset invokes it), `.stratum.yaml` schema family (IDEA-7 / IDEA-8)

---

## Mission & Ideal State

### IDEA-9 — TELOS artifact: durable per-project mission file as a north-star gate
**Status:** NEW | **Priority:** — | **Tags:** #core #compose #stratum
**Source:** PAI (danielmiessler/Personal_AI_Infrastructure) competitive comparison 2026-05-19
**Idea:** PAI ships a `TELOS` file — a persistent declaration of why a project exists, what values it holds, and what "done for this product" means. We have per-feature contracts and acceptance criteria but no equivalent durable "why does this project exist" artifact that gates flow into. Proposal: a `telos.md` (or `.compose/telos.yaml`) that lives at project root, captures mission + non-negotiable constraints + quality bars, and is read by `stratum_goal` at the start of every `compose build` to run a "does this feature serve the mission?" sanity check before design begins. Could also feed `STRAT-JUDGE` as a project-level immutable context (similar to `STRAT-IMMUTABLE` for specs). Low scope: one file, one gate step, no new UI needed for v1.
**Maps to:** STRAT-GOAL (`docs/features/STRAT-GOAL/`), STRAT-IMMUTABLE, `mcp__stratum__stratum_goal`, Compose build lifecycle (design gate)

### IDEA-10 — ISA (Ideal State Artifact): unified per-feature success-criteria format
**Status:** NEW | **Priority:** — | **Tags:** #core #compose #stratum
**Source:** PAI (danielmiessler/Personal_AI_Infrastructure) competitive comparison 2026-05-19
**Idea:** PAI's ISA is a universal doc format declaring "what does done look like for this task." Our success criteria are currently scattered: acceptance checkboxes in plans, `ensure` expressions in `.stratum.yaml`, contract JSON schemas, Codex review gate thresholds — all valid, all separate. Proposal: introduce a canonical ISA block (or file section) that consolidates them in one place per feature: human-readable acceptance criteria + machine-checkable `ensure` expressions + contract refs + review confidence floor. This is not a new format layer — it's a consolidation of what already exists into a single authoritative source that both the Compose skill and Stratum executor read from. Closest antecedents in our system: `idea_artifact_lineage` (parked), STRAT-GOAL deliverables section, planning-standards.md acceptance criteria conventions.
**Maps to:** planning-standards.md, `docs/features/*/plan.md` acceptance criteria, `.stratum.yaml` `ensure` blocks, `compose/contracts/`, STRAT-GOAL, `idea_artifact_lineage` (parked)

### IDEA-11 — Self-rating learn phase as a first-class Stratum loop step
**Status:** NEW | **Priority:** — | **Tags:** #core #stratum #compose
**Source:** PAI (danielmiessler/Personal_AI_Infrastructure) competitive comparison 2026-05-19
**Idea:** PAI bakes a "Learn" phase into every algorithm loop: the system rates its own performance and evolves. We have STRAT-JUDGE-POSTMORTEM (offline calibration corpus + replay) but it's triggered manually. Proposal: add an optional `learn: true` step type to `.stratum.yaml` that runs after a feature ships — auto-appends a scored entry to the postmortem corpus (what went well, what fired unexpected `ensure` failures, how many Codex review iterations were needed, gate pass/fail history) and feeds it into the judge calibration pipeline. Closer coupling than the current manual corpus-regen (`--all` flag). Net: every shipped feature silently improves the judge and the iteration loop, without a human having to remember to run `--all`. Scope discipline: the corpus format and replay harness already exist (STRAT-JUDGE-POSTMORTEM COMPLETE) — this is the auto-append wire-up only, not a new calibration system.
**Maps to:** STRAT-JUDGE-POSTMORTEM (`stratum/.stratum/postmortem/candidates.jsonl`), `mcp__stratum__stratum_audit`, Stratum IR learn step type, Compose ship phase

---

## Distribution & Portability

### IDEA-12 — Packs: AI-installable portable skill bundles (any Claude Code instance)
**Status:** NEW | **Priority:** — | **Tags:** #distribution #compose #skills
**Source:** PAI (danielmiessler/Personal_AI_Infrastructure) competitive comparison 2026-05-19
**Idea:** PAI ships "Packs" — standalone, AI-installable capability bundles usable on any Claude Code instance without the full PAI installation. Our skills are currently repo-local: you get Compose/Stratum skills only if you've set up the Forge repo. `COMP-DEPS-PACKAGE` (shipped) added a dep manifest + `compose doctor` but it's still Forge-internal. Proposal: define a Pack format — a versioned, self-contained directory with skills, agents, contracts, and a `pack.json` manifest — that `compose setup` can install from a URL or registry. A user on any project could run `compose install forge-review-pack` to get the STRAT-REV review lens skills without the full Forge stack. Directly monetizable or community-distributable. Natural v1 candidates: review-lens pack (STRAT-REV), judge-kernel pack (STRAT-JUDGE), brainstorming pack (`superpowers:brainstorming` + council). Constraint: packs should be verifiable (checksum + optional signature) so users can trust what they install.
**Maps to:** `COMP-DEPS-PACKAGE` (shipped — dep manifest foundation), `compose setup`, `compose/.compose-deps.json`, `~/.claude/skills/`, STRAT-REV, STRAT-JUDGE

### IDEA-15 — Stratum Python → TypeScript port (de-risked, deferred)
**Status:** PROMOTED (→ STRAT-TS-PORT, merged & PARKED) | **Priority:** — | **Tags:** #distribution #infra #core
**Source:** Conversation 2026-06-02 — litellm-coverage spike to decide port vs. stay-Python
**Idea:** Merged into the existing roadmap row **STRAT-TS-PORT** (legacy ID T1-12, "TypeScript library `stratum-ts`") in `ROADMAP-ARCHIVE.md`, now PARKED with the litellm-coverage spike findings folded in. See that row and [[project_stratum_ts_port]] for the full de-risk write-up and flip condition. Not a separate ideabox item.
**Maps to:** STRAT-TS-PORT (T1-12, ROADMAP-ARCHIVE.md, PARKED), IDEA-12 (Packs — also distribution-driven)

---

## Killed Ideas

(none yet)
