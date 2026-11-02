<!-- CANONICAL copy, backed up in git (compose repo). Working copy that Compose tools read and edit: forge/ROADMAP.md; copy it here and commit after every edit there. Relative links below resolve from forge/, not from this folder. 2026-11-02, D-0019 backup. -->
# Forge Roadmap

**Project:** Forge — unified roadmap for Compose (lifecycle runtime) and Stratum (execution substrate).
Compose orchestrates multi-agent workflows via Stratum specs: gates that block, policies that enforce,
iterations that loop across agents, artifacts that are tracked. Stratum is the execution layer used by
Compose and exposed standalone via `stratum-py` and `stratum-mcp`.

**Last updated:** 2026-09-09

Active and planned work only. Completed, superseded, parked, and deferred work, including
shipment and reconciliation history, lives in [ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md#archive-update-2026-09-09).

## Roadmap Maintenance

**Automation planned:** [COMP-ROADMAP-ARCHIVE](compose/docs/features/COMP-ROADMAP-ARCHIVE/design.md) makes this partition and link repair automatic during normal Compose processing; see its [implementation plan](compose/docs/features/COMP-ROADMAP-ARCHIVE/plan.md). The current split is manual cleanup only, not a shipped system capability.

- Keep `PLANNED`, `IN_PROGRESS`, `PARTIAL`, and `BLOCKED` entries here.
- When a feature becomes `COMPLETE`, `SUPERSEDED`, `PARKED`, `DEFERRED`, `KILLED`, or `CANCELLED`, move its full row and feature-specific notes to [ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md) in the same edit. Preserve IDs, evidence, artifact links, and the reason or condition for reactivation.
- Move an entire section only when all its entries are inactive; otherwise retain its active entries here and move only the inactive rows. Keep unfinished follow-ups under their own IDs.
- Repair incoming links and moved fragment links; use explicit archive anchors when historical headings repeat. Put shipment logs in the archive.
- Reactivating parked or deferred work moves its entry back here with the new status and an updated link from its archive location. Do not keep duplicate live rows.
- These rules apply to this narrative-owned Forge roadmap. Product repositories retain their own trackers and roadmap update mechanisms.

---

## Roadmap Model

Decided 2026-05-17 after evaluating GitHub Issues/Projects as a roadmap backend. Codifies the
ownership split this workspace already operates under (`feedback_roadmap_ownership`).

**The tracker provider is per-project, not global.** Each workspace's `.compose/compose.json`
selects its backend independently. There is no single roadmap store; there are independent
roadmaps linked by reference.

- **forge-top (this file): prose + local, narrative-owned.** No tracker provider. ROADMAP.md is
  hand-authored markdown — active cross-product strategic items and planning notes live here.
  Dated reconciliation logs and inactive feature narratives live in ROADMAP-ARCHIVE.md. Strategic rows that map to real implementation **cite** the owning project's
  feature/issue via an *external reference* — they do not embed or mirror its status.
- **Product repos: local feature.json, or GitHub Issues/Projects.** The pluggable provider
  (`compose/lib/tracker/`) already supports both. A product that wants the GH board as its UI
  sets `tracker.github` (issues labeled `compose-feature`, status in a fenced JSON block,
  Projects v2 as the board view). A product that doesn't stays on local feature.json. Either way
  that repo, not forge-top, owns its feature rows.

**References, not sync.** A forge-top row pointing at `owner/repo#123` is a pointer, never a
synchronized copy. We deliberately do **not** implement bidirectional reconciliation (its failure
mode — two authorities silently diverging — is unsolvable). Instead, a stale pointer is a
*detectable linting problem*: `validate_project` resolves external refs read-only (issue exists,
open/closed state not blatantly contradicting the prose claim), emits a drift finding in the
pre-push hook / CI, and **never writes back**. This trades an unsolvable problem for a bounded one,
consistent with how Compose treats all drift (mechanical detection, surface it, don't auto-resolve).

JOURNAL and VISION have no clean issue representation and always fall back to local regardless of
provider — a "GitHub roadmap" is therefore always really features-in-GH + narrative/journal-local.
That hybrid is the intended end state, not a compromise.

---

## Standalone Tickets — Active and Planned

Filed 2026-04-28 during the codex-review tooling cleanup; promoted into the active roadmap on 2026-05-08.

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | COMP-CODEISLAND-BRIDGE | Surface compose's agent activity into Code Island's UI via `claude-agent-sdk`. Scope narrowed after discovering Claude's hook already provides the inbound signal — remaining work is the outbound display. | PLANNED |
| — | COMP-XREF-JIRA | **Jira external-ref resolver.** Graduate the reserved `provider:jira` from url-class to a real read-only resolver: Jira REST + token, issue state → drift rule mirroring the github path, own degrade matrix (offline/no-token/rate-limit → `XREF_RESOLUTION_SKIPPED`). No write-back. Schema already accepts `provider:jira` (reserved in `COMP-XREF-SCHEMA`) so no breaking change. Depends on `COMP-XREF-VALIDATE`. Impl owned by compose (`COMP-MCP-FEATURE-MGMT` #17). | PLANNED |
| — | COMP-XREF-LINEAR | **Linear external-ref resolver.** As `COMP-XREF-JIRA` but Linear GraphQL API. Graduates reserved `provider:linear` to a real resolver; same read-only/degrade discipline. (`notion`/`obsidian` stay url-class by design — no canonical state.) Depends on `COMP-XREF-VALIDATE`. Impl owned by compose (`COMP-MCP-FEATURE-MGMT` #18). | PLANNED |
| — | COMP-SANDBOX | **Container-isolated autonomous mode.** `compose start --sandbox` runs the build inside a container with cwd-only mount, explicit egress denylist, and capability drops. Default-on for autonomous loops (long `--resume` runs, COMP-FIX-HARD tier-2 worktree escalation) where the current detached-HEAD defense is too soft. Inspired by ctx.rs Host vs Sandbox split. | PLANNED |
| — | COMP-VCC-INTEROP | **VCC transcript-recovery interop.** Detect [lllyasviel/VCC](https://github.com/lllyasviel/VCC) at startup; expose a cockpit panel that opens the current Claude Code session's JSONL through VCC's compiled views (UI / Full / Adaptive). Adds `/recall` and `/searchchat` analogues for Compose users so post-`/compact` decisions are recoverable mid-flow. Optional dep, not vendored. | PLANNED |
| — | COMP-ORIGIN-TIER | **Origin tier on Compose events.** Adopt SmartMemory's tier model on decision events, gate-log entries, and audit traces: tier 1 (user-confirmed), 2 (CLI/MCP write), 3 (agent-inferred), 4 (auto-scan / fixture). Audit views and recall filters honor tier; default cockpit views hide tier 4. Distinguishes "the user said this" from "the agent thinks this" without losing either. | PLANNED |
| — | [COMP-COUNCIL-1](docs/features/COMP-COUNCIL-1/plan.md) | **`/council` skill: 4-voice adversarial decision gate.** Architect (in-context) + Skeptic / Pragmatist / Critic spawned as fresh subagents with only the question + minimal context — no conversation history. Architect commits to a position before reading external voices (anti-mirror guardrail). Each voice returns Position / Reasoning / Risk / Surprise in ≤300 words. Verdict preserves raw positions before synthesis. Integrates into `/compose build` design gate (opt-in branch) and `/compose fix` scope-stall trigger (≥3 non-converging Codex review iterations). Lifted from ECC competitive scan 2026-05-11. Promoted from [IDEA-4](docs/product/ideabox.md). | PLANNED |
| — | STRAT-ADMIT | **Pre-commit admission gate for skill-class assets** (guardrail 5 of every apply path, named since STRAT-DISTILL-APPLY but never specified). Three critics intercepting disjoint classes of harm (structural validity / behavioral harmlessness / semantic consistency with claimed evidence), subset-level marginal-gain admission over the existing pool, and lineage captured **at authoring time** with a revert that walks descendants instead of reporting only the asset it removed. Grounded in the contamination chain that STRAT-DISTILL's own inventory phase creates: a defective asset becomes reference material for the next one, so per-asset rollback recovers little (arXiv:2608.05810 — mechanism only, magnitudes explicitly barred from becoming thresholds). Review falsified the original memory-class exemption: this repo's memory format carries `**How to apply:**` sections, so notes ARE instructions — memory-class applies run the critics and subset admission, and skip only lineage. **Hard precondition** for extending any apply path to skills/agents/commands. DESIGN ONLY, not implemented. `stratum/docs/features/STRAT-ADMIT/`. | PLANNED |
| — | [COMP-INSTINCT-HOOK-1](docs/features/COMP-INSTINCT-HOOK-1/plan.md) | **Forge hook + projection layer for `learned`-type memory.** Migrates existing `~/.claude/projects/-Users-ruze-reg-my-forge/memory/*.md` files to SmartMemory `learned` items (via `add_learning()`, workspace-scoped to git-remote hash). Wires PreToolUse/PostToolUse/Stop hooks to emit `hook:observe` events; SmartMemory's existing `ObservationSynthesisEvolver` (CORE-GAPS-5) clusters them into `learned` items asynchronously. Renders SessionStart `MEMORY.md` view from `search(expertise=True)` / `/recall` (DIST-CC-SKILLS-1) instead of local markdown. Emits `hook:correction` for detected user corrections (decrement handled by SmartMemory `CORE-LEARNED-REINFORCE-1` Phase 2). **Reshape 2026-05-11:** original plan assumed new SmartMemory primitives (~15-19d); roadmap scan revealed substrate is already shipped (CORE-EXPERTISE-1, CORE-GAPS-5, CORE-MEMORY-DYNAMICS-1, CORE-ORIGIN-1, HOOK-RECALL-RELEVANCE-1) — Forge work drops to ~3-5d. Soft dep on SmartMemory `CORE-LEARNED-REINFORCE-1` for correction-signal Phase only. | PLANNED |
| — | STRAT-AGENT-VIS | **Stratum agent capability surface + harness visibility.** Discussion: what capabilities are exposed to agents dispatched via `stratum_agent_run`, what events they can emit (tool-call detail, intermediate results, streaming), and how harnesses like Claude Code surface this activity in their UI (agent bar, progress view, telemetry). Starting point: the gap between Stratum's internal telemetry (`build_task_start`/`build_task_done`, the `STRAT-WORKFLOW-BG` stream) and what Claude Code's dynamic-workflow progress panels actually render. Goal is to close that gap so Stratum flows are first-class citizens in Claude Code's native visibility layer, not a black box. **Scoped 2026-07-10** (harness facts verified vs Claude Code docs): MCP tool calls can never appear in the harness task list (no MCP async-task support; progress notifications unrendered) — the bridge is the harness's own backgroundables (Bash `run_in_background`, Agent tool, Monitor). First slice shipped as STRAT-AGENT-BG (see [archived entries](ROADMAP-ARCHIVE.md#archived-standalone-tickets--planned)). **Reconciled 2026-09-05 → PARTIAL:** three slices shipped — `STRAT-AGENT-BG` (07-10), `STRAT-AGENT-BG-MONITOR` (07-10), `STRAT-AGENT-BG-WRITE-1` (07-19, stratum `c44e08e`, workspace-write bg runs + tool allowlists over MCP; row preserved in the archive). `-BG-CLAUDE`, `-BG-BUDGET` and `STRAT-JUDGE-BG` remain PLANNED with no feature folder and no commits since 07-10, so nothing is in progress; the umbrella stays open only for them. **Corrected 2026-09-15:** that sentence was wrong — stratum `c44e08e` (07-19, `STRAT-AGENT-BG-WRITE-1`) had already shipped claude background runs, so `STRAT-AGENT-BG-CLAUDE` is COMPLETE under WRITE-1's name; `STRAT-AGENT-BG-BUDGET` is SUPERSEDED by `stratum_usage_report` receipts (MCP surface 15); `STRAT-JUDGE-BG` is SUPERSEDED by the TS cutover (no blocking `stratum_judge` tool exists). All three rows moved to the archive. The umbrella stays PARTIAL for one live slice only: `STRAT-AGENT-PEER-1`. **2026-09-15:** `STRAT-AGENT-PEER-1` SHIPPED (stratum); the umbrella now waits on `STRAT-AGENT-PEER-2` (claude bg runs as peers, filed in the stratum roadmap). | PARTIAL |
| — | STRAT-AGENT-PEER-1 | **Register Codex agent runs as Claude Code peer sessions** (slice of STRAT-AGENT-VIS; filed 2026-09-09). Today a `stratum_agent_run(type="codex", background=true)` is invisible to `ListAgents`/`/agents` in the parent Claude session — only Claude subagents and peer sessions show, so the user cannot see a running astra build/review and the parent must poll with a `kill -0 <pid>` Bash loop capped at 10 min. Claude Code's peer list is a file registry: `~/.claude/sessions/<pid>.json` (`pid, sessionId, cwd, name, kind, status idle\|busy\|shell, startedAt, updatedAt, version, peerProtocol: 1, peerFeatures [notify_idle, ...], messagingSocketPath /tmp/cc-socks/<pid>.sock`) plus a `<pid>.<sha256>.key` file; the lister reads live-pid records. **Phase 1 (list only):** on launch write `~/.claude/sessions/<codex-pid>.json` with `kind: "codex"`, `name: "<model>:<label>"` (label from the prompt/flow), `cwd`, `status` driven from the stream (`busy` while items arrive, `idle` on completion), `updatedAt` on every stream item; delete the record on exit. Reverse the `.key` file format from a live session first (undocumented; stamp the Claude Code `version` we matched against). **Phase 2 (messaging):** serve the peer socket under `/tmp/cc-socks/<pid>.sock` speaking peer protocol 1 — accept `SendMessage` (append to the run's prompt queue or refuse as read-only) and emit `notify_idle` on completion so the parent wakes without the Bash wait loop. Risk: the registry shape is version-coupled to Claude Code (record carries `version: 2.1.261`); gate the writer behind a version allowlist and fail silent-but-logged when it drifts. Origin: SmartMemory CORE-ONTOLOGY-PARITY-1 session, user asked why the astra reviewer was not in the agent list. **SHIPPED 2026-09-15 → stratum** (`stratum/docs/features/STRAT-AGENT-PEER-1/`, commits `bdef29f`…; live tracker is the stratum feature folder, this row is a breadcrumb). Corrections found on the way: `kind` must be `bg` (not `codex`), listing itself requires a reachable socket so a per-run detached sidecar owns pid/record/key/socket, and the idle notice is only admitted when it echoes the requester's `from_mode`. Claude bg runs are the follow-up `STRAT-AGENT-PEER-2` (stratum roadmap). | COMPLETE |
| — | STRAT-NARRATIVE-1 | **PROMOTED 2026-08-08 → stratum** (`stratum/docs/features/STRAT-NARRATIVE-1/plan.md`; live tracker is the stratum feature folder, this row is a breadcrumb). **Stratum public narrative** (ideabox IDEA-1201, Escepine teardown 2026-08-06 — waitlist vaporware marketing our exact reasoning/execution-split thesis; category-formation signal). Three artifacts: decide/execute one-liner ("Your agent decides. Stratum verifies."), Lusser's-Law compound-reliability exhibit (`R_sys = R_step^n`, 96%/step → 44% by step 20) as the mathematical case for per-step `ensure` checks, and a failure-vector → shipped-mechanism table (audit traces, server-side re-checked constraints/STRAT-IMMUTABLE, guard ledger) claiming ONLY what is shipped. Marketing, not engineering. | PLANNED |

---


## FORGE-DS: One design system for the Forge UIs — PLANNED

OWNER DECISION D-0018 (2026-11-02, ops ledger `c798bfe19d52`): last in the D-0018 order, after COMP-SUBAPP 306-311 (`compose/ROADMAP.md`; 311 COMP-SUBAPP-VERB-ROOMS-1 is D-0019) and CADENCE-UI-AUTHOR-1 (`cadence/docs/ROADMAP.md`).

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | FORGE-DS-1 | One tokens + primitives package that the three UI packages (`@smartmemory/stratum-ui`, `@cadence/ui`, `@wiki/components`) depend on. First decision in the row: reuse `smart-memory-design-system` or fork it for Forge. | PLANNED |

**FORGE-DS-1: acceptance**
- [ ] Reuse-or-fork decision recorded in this row, against `/Users/ruze/reg/my/SmartMemory/smart-memory-design-system` (existing)
- [ ] One package holds the tokens and primitives (location per the decision, new)
- [ ] `stratum/ui/package.json`, `cadence/ui/package.json` (existing) and the wiki components package (existing) depend on it
- [ ] `stratum/ui/src/styles.css` and `cadence/ui/src/styles.css` (existing) consume the shared tokens instead of local values
- [ ] Compose cockpit renders all three mounted rooms with one set of tokens

---

## COMP-BENCH: Model Benchmark Suite — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 78 | COMP-BENCH-1 | Seed repo: ~2k LOC task management API (Express + SQLite + integration tests). Planted race condition for BENCH-4. Pre-initialized `.compose/` manifest. Deterministic `npm test`. | PLANNED |
| 79 | COMP-BENCH-2 | Feature specs: 5 canonical requests as YAML — OAuth (hard), repo refactor (medium), WebSocket notifications (hard), race condition fix (medium), CSV export (easy). Machine-checkable acceptance criteria + judge rubric per feature. | PLANNED |
| 80 | COMP-BENCH-3 | Benchmark harness: runner with git worktree isolation per run, connector config per model, `audit-scorer.js` (6 automated axes from Stratum audit), `judge-scorer.js` (5 qualitative axes, blind evaluation, 3x inter-rater check). | PLANNED |
| 81 | COMP-BENCH-4 | Scoring and calibration: composite score (50% automated + 50% judge), cost-efficiency ratio, rubric anchor calibration from baseline runs. Judge stddev < 2 across repeated evaluations. | PLANNED |
| 82 | COMP-BENCH-5 | `compose bench` CLI: `compose bench run --model X --feature Y`, `compose bench report --compare X,Y,Z`. Results persisted in `bench/results/{model}-{feature}-{timestamp}/`. | PLANNED |

---

## Future — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | COMP-SCHEMA-COMMONS | Typed domain knowledge index (Schema Commons) — Qdrant-backed library of curated industry schemas (FHIR, Stripe, ISO 20022, OpenAPI, Prisma, etc.) that Phase 1 explorer agents MATCH against, supplying typed contracts to blueprints. Front-loads rigor for domain-bound features; lets cheap models codegen against tight derived tests. Inspired by eclusa/eclusa. | SUPERSEDED (2026-10-26) by CODEGEN-DESIGN-2 (`smart-memory-ops/units/CODEGEN-DESIGN-2/design.md`) |
