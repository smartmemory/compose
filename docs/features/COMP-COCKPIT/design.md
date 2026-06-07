# COMP-COCKPIT — Cockpit Completeness & Polish (Umbrella Design)

**Status:** DESIGN (Phase 1) — awaiting design gate
**Created:** 2026-06-07
**Source:** 2026-06-07 E2E UX sweep (`docs/ui-cli-parity.md` baseline)
**Sibling:** COMP-PARITY (CLI↔UI capability parity). COMP-COCKPIT covers **in-cockpit** action feedback, observability, onboarding, and correctness.

> **Design gate approved 2026-06-07 — sliced.** This build delivers **Slice A {COCKPIT-2, COCKPIT-1, COCKPIT-6}** (correctness/foundation). **Slice B {COCKPIT-4, COCKPIT-5, COCKPIT-3}** (observability/onboarding) is deferred to a second build. The full umbrella design below is the shared spec for both slices.

## Problem

A UI-first user cannot run their whole dev process in the cockpit without dropping to the terminal. Six concrete gaps, all in the React cockpit (`src/`) plus two server touch-points. Surfaced and line-verified by three exploration passes (notification/dialog layer; build-state/run-history; gate-review/empty-states/host-fetch).

This is an **umbrella** for COMP-COCKPIT-1…-6. They share two cross-cutting primitives, so they are designed together and implemented in dependency order, but each ships as its own verifiable unit.

---

## Shared infrastructure (the two primitives everything else reuses)

The sweep confirmed both primitives **already exist** — most of this umbrella is *wiring*, not new infra.

### P1 — Transient feedback: `NotificationBar.notify()`
- `src/components/cockpit/NotificationBar.jsx:81` exports `notify(message, level, ttl)` (`level ∈ info|warn|error`, default ttl 4000ms), dispatched via a `compose:notify` window event; the bar is a mounted singleton (`App.jsx:1272`). **Not** gate-specific.
- This is the target for every silent `catch` in COCKPIT-1 and the success/failure echo for resolved actions. No new toast system needed — the sweep's premise ("desktop has only GateNotificationBar") was **stale**; `NotificationBar` already is the general system.

### P2 — Confirm/prompt modals: Radix `Dialog`
- `src/components/ui/dialog.jsx` (Radix-backed) is already consumed by `ItemFormDialog` and `SettingsModal`. `window.prompt`/`window.confirm` replacements (COCKPIT-1) and the unified kill-with-reason flow (COCKPIT-6) build on it.
- **New (small) reusable components** to author once and reuse: `ConfirmDialog` (title/body/confirm-label/destructive) and `PromptDialog` (label → string, with validation). These replace native dialogs and back COCKPIT-6.

> Dependency: **COCKPIT-6 consumes P2** (the kill-with-reason modal). COCKPIT-1 authors P2's reusable wrappers. Everything else is independent of the primitives.

---

## Per-feature design

### COMP-COCKPIT-1 — Action feedback + native-dialog replacement  (M)
**Problem:** Core actions fail silently (`console.error` only); two use blocking native dialogs.
**Approach:**
- Wire `notify(..., 'error')` into each silent `catch`, and a success `notify` where the action's outcome isn't otherwise visible:
  - `PipelineView.jsx:49-50/64-65` (approve/reject), `TemplateSelector.jsx:39-40` (draft create), `DocsView.jsx:273` (save — currently *fully* silent, no console.error), `OpenLoopsPanel.jsx:211` (resolve), `ItemDetailPanel.jsx:772/775` (kill), `App.jsx:702` (stop-agent).
- Replace native dialogs with P2 modals:
  - `DesignView.jsx:93` `prompt('Feature code:')` → `PromptDialog`.
  - `OpenLoopsPanel.jsx:209` `window.prompt('Resolve note…')` → `PromptDialog`.
  - **Sweep found two it missed:** `ItemDetailPanel.jsx:791` `window.confirm('Delete … permanently?')` → `ConfirmDialog` (destructive); `SettingsPanel.jsx:89` `window.confirm('Reset all settings?')` → `ConfirmDialog`.
**Key decision:** author `ConfirmDialog`/`PromptDialog` once (reused by COCKPIT-6) rather than inlining per call site.
**Files:** PipelineView, TemplateSelector, DocsView, OpenLoopsPanel, ItemDetailPanel, App.jsx, DesignView, SettingsPanel + 2 new dialog components. (Note `App.jsx`=1331, `ItemDetailPanel`=805, `DocsView`=558 already exceed the 400-line refactor threshold — touch surgically; do not grow them.)

### COMP-COCKPIT-2 — ChallengeModal hostname portability  (S)
**Problem:** `ChallengeModal.jsx` hardcodes `http://localhost:4001` (agent API) and `:4002` (workspace terminal server) at `:36, :196, :227`, breaking every non-localhost deploy; fails to `console.error` only.
**Approach:**
- `:196`/`:227` (port **4001**, orchestrator API — same origin as the served cockpit) → **relative** `/api/agent/...` through `wsFetch` (which already injects the workspace header and passes relative URLs to page origin). `src/lib/wsFetch.js`.
- `:36` (port **4002**, workspace *agent/terminal* server — different origin) → **reuse the existing convention**, not a new config source: `defaultAgentStreamUrl()` (`src/lib/agentStream.js:179`) already resolves the agent server as *page hostname + `VITE_AGENT_PORT`*, and `AgentStream.jsx:24` follows it. Extract/share that base-URL helper and route the terminal-inject call through it. (Resolves former open-decision #2 — no new `compose.json`/discovery/env decision needed.)
- Add `notify('…','error')` on failure (folds in the COCKPIT-1 pattern).
**Files:** `ChallengeModal.jsx`; optionally extract a shared `agentServerBase()` helper from `agentStream.js`.

### COMP-COCKPIT-3 — Run history / past builds  (M, heaviest)
**Problem:** Cockpit tracks only the single active build (`active-build.json`, overwritten each run). `SessionsView` browses Claude-Code agent sessions, **not** build runs.
**Key finding:** all the data a history surface needs — `featureCode`, `status` (complete/failed/aborted), `startedAt`/`completedAt` (→ duration), `cumulative_cost_usd`, `total_{input,output}_tokens`, per-step `steps[]` — is **already in `active-build.json` at the moment it goes terminal** (`lib/build.js:1894/1912/1929`). It is simply discarded on the next build.
**Approach (v1):**
1. **Archive on build-end:** at the three terminal sites in `lib/build.js` (`:1892/:1910/:1927`), append the final build record to a new append-only `.compose/data/build-history.jsonl` (atomic append; reuse `build-stream-writer` patterns). **Assemble the record from the in-memory build context for *that* run — do NOT re-read `active-build.json`.** (Per Codex + [[project_compose_idempotency_gaps]], `active-build.json` is last-writer-wins across concurrent builds; re-reading it at the terminal site can archive the wrong run.) Captures outcome, duration, cost, tokens. **`failureReason` is not persisted today** — add it explicitly: derive at the fail/abort sites from the terminal status + last failed step and carry it into both the archive record and (optionally) the terminal `active-build.json` write.
2. **Endpoint:** `GET /api/builds` (registered in `server/build-routes.js`) → tail-read the JSONL (most-recent-first, bounded N). No sensitive token (read-only, same as `/api/build/state`).
3. **UI:** new `PastBuildsView` mirroring `SessionsView`'s toolbar+rows+empty-state layout — per row: feature code, status badge, relative time, duration, cost chip, failure reason.
**Scope decision (gate):** v1 records *only builds that run after this ships* (no backfill — historical runs were never persisted). Backfill from sparse `completions[]`/`gate-log.jsonl` is explicitly out of scope (can't reconstruct duration/cost/failure). Surface an honest empty state until the first archived run.
**Files (new):** `build-history` writer (lib), `PastBuildsView.jsx`; (edit) `lib/build.js` (3 terminal sites), `server/build-routes.js`, route mount, store hydration, nav entry.

### COMP-COCKPIT-4 — Inline artifact content in gate review  (M)
**Problem:** `GateView.jsx` shows only artifact *metadata* (`% complete`, word count, missing sections, `:21-49`); reviewing the actual `design.md` means leaving for the Docs tab.
**Approach:**
- Extract a shared `MarkdownViewer` from DocsView's existing render path (`DocsView.jsx:520-539`, ReactMarkdown + remarkGfm + mermaid) — DRY, and DocsView (558 lines) benefits from the extraction.
- **Render `gate.artifactSnapshot` as the inline body — NOT a live `/api/file` fetch.** (Per Codex: gates persist an `artifactSnapshot` at creation — `server/vision-routes.js:772`, `lib/build.js:1396`; rendering the live file would let post-gate edits change what the reviewer sees, breaking gate immutability.) Show the snapshot inline (collapsible) under the assessment. Optionally offer an explicit "compare to latest" affordance that fetches the current file as a *diff against the snapshot* — never as a silent replacement. Reuse `ArtifactDiff` (`src/components/shared/ArtifactDiff.jsx`, imported by GateView as `../shared/ArtifactDiff.jsx`) for that diff.
**Files:** new `MarkdownViewer.jsx`; (edit) `GateView.jsx`, `DocsView.jsx` (swap inline render for the shared component).

### COMP-COCKPIT-5 — First-run empty-state CTAs  (M)
**Problem:** Fresh-project views dead-end to the terminal: Graph `"No items match the current filters"` (`GraphView.jsx:1044`), Tree `"No items to display"` (`TreeView.jsx:431`), Dashboard `"Run /compose … in the terminal"` (`DashboardView.jsx:313-315`).
**Approach:**
- Disambiguate **empty project** vs **filters exclude everything**: Graph already distinguishes (`:1041` checks post-filter); **TreeView does not** (`tree.length === 0` is ambiguous) — add the unfiltered-count check.
- Add a "Create your first feature" CTA on the empty states. **The in-UI feature-create path does not exist yet and must be built** (Codex correction): today `App.onCreate` (`App.jsx:242`) creates a plain `task` immediately, only `TreeView` (`:402`) receives that callback, and `ItemFormDialog` (`shared/ItemFormDialog.jsx:23`) has **no feature preset**. The backend *can* create `type:'feature'` (`server/vision-store.js:155`). So v1 must: (a) add a `feature` preset to `ItemFormDialog`, (b) thread the dialog-open callback to `DashboardView` and `GraphView` (not just Tree), (c) wire the CTA to open it. This is real plumbing, not a one-line CTA — re-scope COCKPIT-5 effort accordingly.
**Scope boundary:** `ItemFormDialog` creates a *vision item* (type=feature), not a full feature folder + `/compose build`. Full scaffold-and-build from the UI is **COMP-PARITY-9** (not yet built); v1 stops at create-item and links onward. Honest about the boundary rather than faking a scaffold.
**Files:** `GraphView.jsx`, `TreeView.jsx`, `DashboardView.jsx`, `shared/ItemFormDialog.jsx`, `App.jsx` (callback threading).

### COMP-COCKPIT-6 — Gate-kill guardrail consistency  (S)
**Problem:** `DashboardView.jsx:203` fires `onResolveGate(gate.id, 'killed')` with **no reason/confirmation**, while `GateView.jsx:126-131` and `ItemDetailPanel.jsx:256` require a non-empty comment. Instant, no-undo kills from the dashboard.
**Approach:** route the dashboard Kill button through the P2 `ConfirmDialog` (with a required reason field), calling `onResolveGate(id, 'killed', comment)`. `resolveGate(gateId, outcome, comment)` already accepts the comment (`useVisionStore.js:348-361`); only the dashboard call site omits it.
**Dependency:** consumes COCKPIT-1's P2 modal → implement after COCKPIT-1.
**Files:** `DashboardView.jsx`.

---

## Dependency graph & recommended implementation order

```
P2 modals (in COCKPIT-1) ──► COCKPIT-6
COCKPIT-1, -2, -3, -4, -5  ── independent of each other
```

Recommended order (each independently shippable / gated):
1. **COCKPIT-2** (S) — smallest, isolated, immediate portability win. Warm-up.
2. **COCKPIT-1** (M) — authors P2 primitives + clears all silent failures.
3. **COCKPIT-6** (S) — consumes P2; closes the unsafe-kill gap.
4. **COCKPIT-4** (M) — extract `MarkdownViewer`, inline gate artifact.
5. **COCKPIT-5** (M) — empty-state CTAs + Tree disambiguation.
6. **COCKPIT-3** (M, heaviest) — archival write + endpoint + `PastBuildsView`.

This front-loads correctness (2,1,6), then observability (4,5,3), and puts the one feature with a server/persistence change last.

## Open decisions for the gate
1. **Sequencing:** all six in one lifecycle (order above), or slice into **A: correctness/foundation {2,1,6}** then **B: observability {4,5,3}** as two builds? (Recommended: one umbrella build, but B is a clean cut point if you'd rather ship A first.)
2. **COCKPIT-3 backfill:** confirm v1 is **forward-only** (no historical reconstruction). Recommended: yes — the data never existed before.

*Resolved by the Codex design pass:* former decision on COCKPIT-2's host source (→ reuse `defaultAgentStreamUrl()`); former assumption that COCKPIT-5 could wire to an existing create-feature path (→ it must be built; effort re-scoped above).

## Unproven assumptions / risks
- **A1 (COCKPIT-2):** that 4001 is same-origin as the served cockpit in production (so relative URLs work). Needs confirmation against the prod serving model in blueprint; dev uses Vite proxy.
- **A2 (COCKPIT-3):** the in-memory build context at each of the three terminal sites (`:1892/:1910/:1927`) exposes featureCode, start/end timestamps, cumulative cost/tokens, and step summaries for *that* run, and a `failureReason` can be derived at the fail/abort sites. Blueprint must confirm each site has the run-scoped state in scope (the whole point of archiving from memory, not from the shared last-writer-wins file).
- **A3:** no schema/contract changes required (UI + one new JSONL + one read endpoint). If `build-history.jsonl` warrants a contract, add one under `contracts/`.

## Test strategy (per testing rules)
- **Golden flow (COCKPIT-3):** run a build → it goes terminal → record appears in `build-history.jsonl` → `GET /api/builds` returns it → `PastBuildsView` renders it. Real backend, no mocks.
- **Error harness (COCKPIT-1):** table-driven — each silent site, force the failure, assert `notify('…','error')` fired (assert user-visible outcome, not the console).
- **Unit (COCKPIT-2):** host-resolution helper resolves relative vs. configured-host correctly.
- **Component (COCKPIT-4/5/6):** gate renders artifact body inline; Tree empty-state distinguishes empty-vs-filtered; dashboard kill is blocked without a reason.
- E2E smoke for the gate-review and past-builds flows in Phase 7.
