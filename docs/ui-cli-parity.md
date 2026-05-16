# Compose UI ↔ CLI Parity Map

**Date:** 2026-05-16
**Scope:** Every developer-facing action in the Compose cockpit (`localhost:5195`) mapped to its `compose` CLI equivalent, organized by the typical developer flow. Gaps flagged.

> **Method note:** The live cockpit walkthrough was blocked by a Chrome-extension host-permission limit on `localhost`, so this map is derived from the frontend source (`src/`, `server/` routes) and the CLI source (`bin/compose.js`, pipelines). Source enumeration is exhaustive where a click-through would have been partial.

## Legend

| Mark | Meaning |
|------|---------|
| ✅ **Both** | First-class in CLI **and** UI |
| 🖥️ **UI-only** | No CLI path — gap for headless/scripted/CI use |
| ⌨️ **CLI-only** | No UI surface — gap for discoverability / non-terminal users |
| 🟡 **Partial** | Exists both sides but capability diverges (note explains) |

---

## The typical developer flow

```
onboard → capture ideas → shape product → plan roadmap → design feature
   → build → monitor execution → decide at gates → verify → ship → track loops
```

Each stage below is a table. The right two columns are the parity verdict and the specific gap.

---

### 1. Onboard / set up a project

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Initialize Compose in a repo | `compose init` | — | ⌨️ CLI-only | One-time bootstrap; UI can't exist before init. Acceptable. |
| Install global skill + MCP | `compose setup` / `compose install` | — | ⌨️ CLI-only | Acceptable (env setup). |
| Health-check deps & versions | `compose doctor [--json --strict]` | — | ⌨️ CLI-only | **Gap:** no in-cockpit "environment health" panel. Devs hit broken builds with no UI signal. |
| Import/analyze existing project | `compose import` | — | ⌨️ CLI-only | **Gap:** onboarding an existing codebase is terminal-only. |
| Update/upgrade Compose | `compose update` / `upgrade` | — | ⌨️ CLI-only | Acceptable. |
| Install/remove git hooks | `compose hooks install\|uninstall\|status` | — | ⌨️ CLI-only | **Gap:** hook state (stale/foreign/missing) invisible in UI; silent session-binding failures. |
| Start the cockpit server | `compose start` | — | ⌨️ CLI-only | Acceptable (bootstraps the UI). |

**Verdict:** Setup is entirely CLI, which is expected — but `doctor` and `hooks status` are *operational health* signals that should surface in the cockpit (see Recommendations).

---

### 2. Capture & triage ideas (Ideabox)

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Add idea | `compose ideabox add "<title>" [--source --desc --cluster --tags]` | Ideabox tab → create card; Mobile → Ideas tab | ✅ Both | |
| List ideas | `compose ideabox list` | Ideabox tab (cards + matrix views) | 🟡 Partial | UI adds effort/impact **matrix** view — no CLI equivalent. |
| Set priority | `compose ideabox pri <ID> P0\|P1\|P2` | Idea detail → priority buttons | ✅ Both | |
| Set effort/impact | — | Matrix view drag / selector | 🖥️ UI-only | **Gap:** matrix positioning not scriptable. |
| Discuss idea | `compose ideabox discuss <ID> "<comment>"` | Idea detail → discussion input | ✅ Both | |
| Promote to feature | `compose ideabox promote <ID> [CODE]` | Idea detail → Promote dialog | ✅ Both | |
| Kill idea | `compose ideabox kill <ID> "<reason>"` | Idea detail → Kill form | ✅ Both | |
| Resurrect killed idea | — | Graveyard → resurrect | 🖥️ UI-only | **Gap:** no `compose ideabox resurrect`. |
| Interactive batch triage | `compose ideabox triage [--lens]` | — | ⌨️ CLI-only | UI triages one-at-a-time; no guided batch walk with priority lens. |

**Verdict:** Strong parity. Two small asymmetries: matrix/effort-impact (UI-only) and resurrect (UI-only) vs. lens-driven batch triage (CLI-only).

---

### 3. Shape a new product

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Kick off a product (research→brainstorm→roadmap→scaffold) | `compose new "<intent>" [--auto --ask --from-idea]` | — | ⌨️ CLI-only | **Major gap:** the entire product-inception pipeline has no UI entry. UI only *observes* the resulting pipeline once running. |

**Verdict:** Inception is CLI-only. The UI can watch `new.stratum.yaml` execute (Pipeline tab) but can't *launch* it.

---

### 4. Plan the roadmap & features

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| View roadmap / next buildable | `compose roadmap` | Dashboard + Tree/Graph (vision items) | 🟡 Partial | UI shows items/graph; CLI gives topo-sorted **build order** explicitly. Different framings. |
| Add a single feature | `compose feature <CODE> "<desc>"` | — | ⌨️ CLI-only | **Gap:** can't scaffold a feature folder from the UI (only via idea-promote). |
| Regenerate ROADMAP.md | `compose roadmap generate` | — | ⌨️ CLI-only | Acceptable (file gen). |
| Migrate ROADMAP→feature.json | `compose roadmap migrate` | — | ⌨️ CLI-only | Acceptable (one-time). |
| Consistency check | `compose roadmap check` | — | ⌨️ CLI-only | **Gap:** no UI surfacing of roadmap drift. |
| Triage feature → build profile | `compose triage <CODE>` | (auto during build unless `--skip-triage`) | 🟡 Partial | No standalone "show recommended profile/tier" view in UI. |
| Edit item status/phase/confidence/desc | — | Item Detail panel (PATCH) | 🖥️ UI-only | **Gap:** item-level edits (status, confidence, phase, group, rename, description) are UI-only. CLI only flips status via `record-completion`. |
| Create/delete connections | — | Item Detail → Connect / delete | 🖥️ UI-only | Graph relationships (informs/supports/blocks/contradicts) UI-only. |
| Pressure-test an item | — | Item Detail → Pressure Test | 🖥️ UI-only | Contradiction-finding is UI-only. |

**Verdict:** Diverges most here. CLI owns *file/feature scaffolding & roadmap regen*; UI owns *item graph editing & relationships*. Neither is a superset.

---

### 5. Design a feature

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Run a design session (Q&A, decision cards, research) | — (design runs *inside* `compose build`'s `explore_design` step) | Design tab → Start/message/card-select/revise/complete (SSE stream) | 🟡 Partial | **Gap:** the interactive design *conversation* (decision cards, revise-decision, draft doc editing) is UI-only. CLI runs design only as a non-interactive build phase. |

**Verdict:** Interactive design is a genuine UI-only capability. CLI has no `compose design` command.

---

### 6. Build a feature

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Build one/many features | `compose build [CODE...] [--dry-run --skip-triage --template --team]` | Pipeline tab → template→draft→**Approve Draft**; Mobile → Builds → Start | 🟡 Partial | Both can start a build. CLI exposes flags (`--team`, `--template`, `--dry-run`, multi-code/prefix) the UI draft flow doesn't. |
| Build entire roadmap | `compose build --all` | — | ⌨️ CLI-only | **Gap:** no "build all PLANNED" button. |
| Abort active build | `compose build --abort` | Agent Stream → Stop; Mobile → Abort | ✅ Both | |
| Per-task fresh-context dispatch | `compose gsd <CODE>` | — | ⌨️ CLI-only | **Gap:** GSD/boundary-map dispatch has no UI trigger. |
| Bug-fix lifecycle | `compose fix <BUG> [--resume --abort]` | — | ⌨️ CLI-only | **Major gap:** the entire reproduce→diagnose→fix→verify→ship flow is CLI-only; UI can't launch or resume a fix. |
| Approve/reject a pipeline draft | — (CLI starts build directly) | Pipeline tab → Approve/Reject Draft | 🖥️ UI-only | The draft-review step is a UI-only ergonomics layer. |

**Verdict:** `build` itself has parity; `build --all`, `gsd`, and **`fix`** are CLI-only — the bug-fix lifecycle being UI-invisible is the biggest single gap for a daily dev.

---

### 7. Monitor execution

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Watch live build stream | (terminal stdout of `compose build`) | Agent Stream panel; Pipeline tab live steps | 🟡 Partial | UI is far richer (phase-grouped steps, agent badges, relay feed). CLI = raw stdout only. |
| Inspect sessions | — | Sessions tab; Item Detail → session history | 🖥️ UI-only | **Gap:** no `compose sessions` list. |
| Spawned-agent tree / interrupt | — | Agent Stream / Mobile Agents → Interrupt | 🖥️ UI-only | **Gap:** can't interrupt a specific agent from CLI. |
| Stratum execution trace / violations | (in stdout / `stratum_audit`) | Item Detail → Stratum trace & violations | 🟡 Partial | UI visualizes ensure-failures; CLI buries them in logs. |

**Verdict:** Monitoring is overwhelmingly a UI strength. CLI users are limited to scrollback.

---

### 8. Decide at gates

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| See pending gates + artifact assessment | — | Gates tab / Dashboard / Item Detail lifecycle | 🖥️ UI-only | **Gap:** no `compose gates list`/`pending`. Headless runs can't see what's blocking. |
| Approve / Revise / Kill a gate | — | Gate card → Approve/Revise/Kill | 🖥️ UI-only | **Major gap:** gate resolution is UI-only. A CLI/CI run cannot advance a blocked pipeline. |
| Audit gate decisions (rubber-stamp detection) | `compose gates report [--since --feature]` | Dashboard decision timeline (visual) | 🟡 Partial | CLI does the *audit/stats*; UI does the *timeline visualization*. Complementary, not equivalent. |

**Verdict:** Asymmetric and important: **resolving** gates is UI-only; **auditing** them is CLI-only. No single surface does both.

---

### 9. Verify & validate

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Validate features vs roadmap/artifacts | `compose validate [--scope --code --json]` | — | ⌨️ CLI-only | **Gap:** no UI "validation findings" panel. |
| QA scope (changed files → routes) | `compose qa-scope <CODE>` | — | ⌨️ CLI-only | **Gap:** affected-route analysis is terminal-only. |
| Coverage sweep | (auto in build pipeline) | Pipeline tab step status | 🟡 Partial | Visible as a step in UI; not independently triggerable either side. |

**Verdict:** Verification tooling (`validate`, `qa-scope`) is entirely CLI — invisible to UI-first users.

---

### 10. Ship / record completion

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Record completion bound to commit SHA | `compose record-completion <CODE> --commit-sha=…` | — | ⌨️ CLI-only | **Gap:** completion provenance is CLI/hook-only (intentional — needs a real SHA — but no UI confirmation/override). |
| Flip feature status | (via `record-completion` / hooks) | Item Detail → status dropdown | 🟡 Partial | UI sets status freely (no SHA binding); CLI binds to commit. Different guarantees. |

**Verdict:** Completion is correctly CLI-anchored (commit-bound), but the UI's free status dropdown can diverge from recorded completions — a consistency risk.

---

### 11. Track open loops & docs

| Action | CLI | UI location | Parity | Gap / note |
|---|---|---|---|---|
| Create/list/resolve open loops | `compose loops add\|list\|resolve` | (Attention queue *shows* loops) | 🟡 Partial | **Gap:** UI displays loops in the attention queue but offers no create/resolve action. |
| Browse/edit project docs & artifacts | — | Docs tab → tree + editor (PUT /api/file) | 🖥️ UI-only | In-cockpit doc editing has no CLI equivalent (edit files directly instead). |
| Graph / timeline / lifecycle viz | — | Graph, Decision Timeline, Lifecycle, Connection graph | 🖥️ UI-only | Pure visualization — no CLI need. |

---

## Consolidated gap register

### ⌨️ CLI-only — no UI surface (hurts UI-first / non-terminal devs)
- `compose new` (entire product inception) — **high impact**
- `compose fix` (entire bug-fix lifecycle) — **high impact**
- `compose build --all`, `compose gsd`
- `compose feature <CODE>` (scaffold a feature)
- `compose validate`, `compose qa-scope`, `compose roadmap check`
- `compose doctor`, `compose hooks status`, `compose import`
- `compose ideabox triage` (lens-driven batch)
- `compose gates report` (audit/rubber-stamp stats)

### 🖥️ UI-only — no CLI/CI path (hurts headless / automation)
- **Gate resolution** (approve/revise/kill) — **high impact: blocks CI/headless pipelines**
- Pending-gate visibility & artifact assessment
- Interactive **design session** (decision cards, revise, draft editing)
- Item editing: status/phase/confidence/group/rename/description
- Connections (create/delete) & **pressure-test**
- Sessions list, agent tree, **agent interrupt**
- Ideabox: effort/impact matrix, **resurrect**
- Pipeline draft approve/reject

### 🟡 Divergences (both sides exist but differ)
- `build`: CLI has `--team/--template/--dry-run`/multi-code; UI has draft-review step
- Gates: CLI **audits**, UI **resolves** — no overlap
- Completion: CLI commit-SHA-bound, UI free status dropdown — can desync
- Roadmap: CLI topo build-order, UI item graph

---

## Recommendations (ordered by dev-flow friction)

1. **Gate resolution from CLI** (`compose gate list` / `compose gate resolve <id> --approve|--revise|--kill`). Highest impact: today a headless or CI-driven build *cannot* clear a gate, so the UI is a hard dependency for any pipeline that gates. Mirrors the existing `/api/vision/gates/{id}/resolve` endpoint.
2. **`compose fix` and `compose new` launchers in the UI.** The two richest lifecycles are invisible to UI-first users; the Pipeline tab already renders them once running — add a "Start fix / Start product" entry.
3. **Environment-health panel in the cockpit** surfacing `doctor` + `hooks status`. Silent hook/version drift currently causes mystery build failures with zero UI signal.
4. **Loop create/resolve in the UI.** The attention queue already *shows* loops; add the verbs so loop hygiene isn't terminal-only.
5. **Reconcile completion vs. status.** Either gate the UI status dropdown behind a commit binding, or show "recorded completion: <sha>" next to status so the two can't silently diverge.
6. **`compose validate` findings panel** so verification isn't invisible to UI-first review.

---

## Related documents
- `docs/cli.md` — CLI reference
- `docs/cockpit.md` — cockpit UI guide
- `docs/command-flows.md` — end-to-end flows
- `docs/lifecycle.md` — lifecycle/gate model
- `ROADMAP.md` — Phase 8 (cinematic capture) and feature backlog
