# COMP-MOBILE-1 — Mobile Monitoring-Loop Completeness: Design

> **Status: DESIGN DOCUMENT — Phase 1 artifact, nothing here is implemented yet.**
> Reviewers: evaluate this as a design (decisions, scope, contracts), not as shipped code.

**Related Documents**
- Roadmap row: `ROADMAP.md` → COMP-MOBILE-1 (Wave 2: UX Journey Gaps, position 5)
- Parent feature: `docs/features/COMP-MOBILE/design.md`, `blueprint.md` (mobile PWA shell, COMPLETE)
- Deferred sibling: `docs/features/COMP-MOBILE-REMOTE/design.md` (remote transport — explicitly out of scope here)
- Next artifact: `blueprint.md` (Phase 4, forward link)

## Why

The mobile PWA (`/m`) handles gates, build start/abort, agents, and ideas well, but cannot complete its core *monitoring* journeys. Gate/build events arrive over `/ws/vision` yet the user is never alerted; failing builds show only a raw log; there is no build history; the roadmap tab is read-mostly. The alerted-and-able-to-act loop is half-missing. This feature closes the loop — UI only, zero backend changes (verified: every endpoint needed already exists).

**Out of scope:** remote reachability (servers bind `127.0.0.1`; that is COMP-MOBILE-REMOTE), push notifications/service-worker notifications (requires REMOTE), session-history UI beyond per-build context (see D3), desktop changes other than the shared-lib extraction in D2.

## D1 — Notification badges + alert bar (sub-items 1)

### Event sources (all existing, verified)
- `/ws/vision` broadcasts: `gateCreated`, `gateResolved`, `buildState`, plus coalesced `visionState`/`hydrate` snapshots.
- Mobile hooks `usePendingGates` (gates) and `useActiveBuild` (build state) already subscribe; today each consumer opens its own WS connection (existing pattern, kept — consolidation is not this feature).

### Design: lift state, derive badges, add an alert strip
1. **Lift the three monitoring hooks into `MobileApp.jsx`.** `usePendingGates()`, `useActiveBuild()`, and `useRoadmapItems()` move up from `AgentsTab`/`BuildsTab`/`RoadmapTab` and their values flow down via props (tabs keep working unchanged; the tab-level hook calls are removed to avoid duplicate pollers). This gives the shell a single source of badge/alert truth that survives tab switches.
   **Latent-bug fix folded in:** `useRoadmapItems.js:63` listens for WS types `itemCreated`/`itemUpdated`/`itemDeleted`/`state`, but the server actually broadcasts `visionState`/`hydrate` snapshots (vision-server.js:68, :412) — the hook's live updates are dead code today (it works via initial HTTP fetch only). The lift includes rewiring its WS handler to consume `visionState`/`hydrate` snapshot messages (replacing items wholesale, preserving in-flight optimistic edits), keeping the legacy granular types accepted for back-compat. Optimistic create/delete reconciliation in D4 depends on this fix.
2. **Badge model** — `BottomNav` gains an optional `badges` prop: `{ [tabId]: { count?: number, level?: 'info'|'warn'|'error' } }`.
   - `agents` tab: `count = pendingGates.length` (gates are acted on from AgentsTab today), level `warn`.
   - `builds` tab: dot (no count) when `active?.status === 'failed'` (level `error`), or level `warn` when gate-pending is *derived* the way desktop derives it (`graphOpsOverlays.js:67`): `status === 'running' && currentStepId?.endsWith('_gate')` with an unresolved gate. There is no literal `'gate_pending'` status on activeBuild — the derivation predicate is extracted as `isGatePending(activeBuild, pendingGates)` into the shared lib (D2.1's `pipeline-steps.js`) so mobile and desktop can't drift.
   - Rendered as a small absolutely-positioned pill/dot on the nav button; `data-testid="mobile-nav-badge-<tab>"`.
3. **Alert bar** — new `MobileAlertBar.jsx` rendered in the shell between header and main. Reuses the desktop `notify()` contract: listens for the same `compose:notify` CustomEvent (`{ message, level, ttl }`) so any shared lib code that calls `notify()` works on mobile too. A new tiny `useMonitorEvents` effect in the shell maps WS transitions → `notify()`:
   - `gateCreated` → "Gate pending: <item title>" (warn, sticky until tap). The WS payload carries only `{ gateId, itemId, timestamp }` (vision-routes.js:813) — no phase fields. Item title is looked up from the items already in memory via `useRoadmapItems`; falls back to "Gate pending" if the item isn't loaded.
   - `buildState` with status transition → `failed` → "Build failed: <featureCode>" (error, sticky)
   - `buildState` transition → `complete` → "Build complete: <featureCode>" (info, 4s)
   - Transition detection compares previous status per `flowId` in a ref — no event storms from the 16ms-coalesced `visionState`.
   - Tapping an alert navigates to the relevant tab and dismisses.
   - **Health-gate caveat (known contract limitation):** `active-build.json` is written `complete` *before* the post-build health gate runs (`lib/build.js:1895`); the gate can downgrade the result to `failed`, which lands only in the history append (`lib/build.js:2005`) — the `buildState` WS message never reflects it. Mobile alerts therefore reflect pre-health terminal status. Mitigation (UI-only): D3's delayed history refetch compares the freshly-appended entry's status against the last alerted status for that build, and emits a corrective "Build failed post-checks: <featureCode>" (error, sticky) on mismatch. Fixing `buildState` itself to re-broadcast the downgrade is a backend change — out of scope, noted as a follow-up candidate for the report.
4. **Why not reuse desktop `NotificationBar.jsx` directly:** it is desktop-styled and stacks at top-right; mobile needs a full-width strip under the header with safe-area awareness. The *event contract* is shared; the component is mobile-specific (~60 LOC).

## D2 — Pipeline step breakdown in BuildDetailView (sub-item 2)

### Existing logic to extract
Desktop `PipelineView.jsx:178-199` merges the `PIPELINE_STEPS` template (`src/components/vision/constants.js:89-114`) with `activeBuild.steps[]` (right-spread, live overrides template, dynamic steps appended).

### Design
1. **Extract `src/lib/pipeline-steps.js` (new, shared):** `mergePipelineSteps(templateSteps, liveSteps) -> Step[]` — pure function, copied verbatim from PipelineView's merge block. `PIPELINE_STEPS` moves here too (re-exported from `constants.js` for desktop back-compat; desktop PipelineView switches to the shared function — same-behavior refactor, covered by snapshot of current merge output in tests).
2. **New `BuildStepsList.jsx` (mobile):** vertical step list — one row per merged step: status icon (pending ○ / active ◉ pulse / done ● / failed ✕), step name, agent chip, phase grouping headers. Failed step row is expandable to show `currentStepId` context. Compact: collapses long runs of `done` steps into "N done" when not expanded.
3. **`BuildDetailView.jsx` becomes two sections:** steps list on top (the "which step failed" answer), raw log stream below (existing behavior preserved), toggleable. Data comes from the already-lifted `useActiveBuild` — no new fetching.

## D3 — Build history (sub-item 3, scope decision)

**Decision: build history, not session history.** `GET /api/session/history` requires `featureCode` (per-feature only) — a global mobile history view cannot be backed by it without N queries. `GET /api/builds?limit=N` (build-routes.js:28, no auth) returns global build history. Session history is deferred; if a past build is opened, its `featureCode` makes a per-feature session call possible later.

**Contract reality check:** history entries carry only summary fields — `featureCode`, `status`, `stepCount`, `failureReason`, timestamps (`lib/build-history.js:41`, writer at `lib/build.js:2009`). **No per-step data.** Historical step-by-step breakdown is therefore out of scope (would need a backend contract change — filed as a follow-up candidate, not done here).

1. **New `useBuildHistory(limit=20)` hook:** fetch on mount + refetch when a `buildState` WS message reports terminal status. **Race handling:** the history entry is appended *after* the terminal `active-build.json` write (`lib/build.js:1895` vs `:2005`), so a refetch on the terminal WS event can return stale history. The hook refetches, and if the finished build is absent, schedules one delayed retry (~2.5s); a manual pull-refresh path also exists via the list. **Matching is by `flowId`** — present in both `active-build.json` and history records (`lib/build.js:2014`, `:4261`) — never by featureCode+recency, so a quick rerun of the same feature can't mis-associate the corrective health-gate alert (D1) with the wrong terminal record.
2. **New `BuildHistoryList.jsx`:** rendered in `BuildsTab` below the active-build card. Rows: featureCode, status pill, relative completedAt, and `failureReason` (truncated) for failed builds. Tapping a row expands it inline to the full summary (all fields incl. `stepCount`, full failure reason) — no historical step list (see contract reality check above).

## D4 — Roadmap mutations: create / delete / connections (sub-item 4)

All endpoints exist (vision-routes.js): `POST /api/vision/items` (guardAuth, item `type` required from `VALID_TYPES`), `DELETE /api/vision/items/:id` (guardAuth), `GET /api/vision/items/:id` (returns `connections[]`), `POST /api/vision/connections` (**`{fromId, toId, type}` — `type` is required** and must be one of `VALID_CONNECTION_TYPES = ['informs','blocks','supports','contradicts','implements']`; no label field exists — vision-store.js:294), `DELETE /api/vision/connections/:id`.

**Auth reality check:** the token *helper* exists (`withComposeToken()` in `src/lib/compose-api.js`) and build/agent mutations use it, but `useRoadmapItems`'s existing PATCH sends bare headers (`useRoadmapItems.js:103`) and no roadmap create/delete/connection client path exists yet. **This slice adds token plumbing to all roadmap mutations** (PATCH included — fixing the existing gap) by routing them through `withComposeToken()`. With `guardAuth` default-OFF this is behavior-neutral locally; it future-proofs for REMOTE.

1. **Create:** FAB (`+`) on `RoadmapTab` opens new `CreateItemSheet.jsx` (pattern: existing `CaptureSheet.jsx` from ideabox). Fields: title (required), description, group (datalist of existing groups), status (default `planned`), confidence; `type` fixed to `'feature'` v1 (no type picker). POST → optimistic prepend via `useRoadmapItems` (WS `visionState` reconciles).
2. **Delete:** `ItemDetailSheet` gains a Delete button → inline two-tap confirm ("Delete?" → "Confirm delete") — no browser `confirm()` dialog. DELETE → optimistic removal with rollback on error (existing `applyOptimisticEdit` pattern extended with `applyOptimisticRemove`).
3. **Connections (scope-capped):** `ItemDetailSheet` gains a Connections section: list existing edges (lazy `GET /api/vision/items/:id` on sheet open), each row shows direction + other item title + connection type + remove (✕, two-tap confirm); "Add connection" opens a searchable item picker (reuses the items list already in memory from `useRoadmapItems` — no new fetch) plus a required type selector (the 5 valid types, default `'informs'`), creating `{fromId: thisItem, toId: picked, type}`. **Cap: no type editing after creation, no graph view, no labels (the API has none).**

## D5 — AGENT_PORT hygiene (sub-item 5)

Replace the three local `AGENT_PORT` + `agentUrl()` re-declarations with imports of `agentServerUrl()` from `src/lib/agentServer.js`:
- `src/mobile/components/AgentCard.jsx:5-10`
- `src/mobile/components/AgentDetailView.jsx:6-10`
- `src/mobile/hooks/useInteractiveSession.js:14-20`

Pure refactor; behavior identical (helper defaults to `VITE_AGENT_PORT || '4002'`, same fallback).

## Slice plan (independently committable)

| Slice | Contents | Depends on |
|---|---|---|
| **S1** | D5 hygiene + D1 badges/alert bar (incl. 3-hook lift + useRoadmapItems WS rewire) | — |
| **S2** | D2 shared merge-lib extraction + BuildStepsList + D3 history (incl. corrective health-gate alert) | S1 (lifted useActiveBuild, alert bar) |
| **S3** | D4 roadmap create/delete/connections + token plumbing | S1 (rewired useRoadmapItems) — parallel-safe with S2 |

## Testing

Per harness conventions (`test/ui/mobile-*.test.jsx`, vitest+jsdom+testing-library, inline fetch/WS mocks, `data-testid="mobile-*"`):
- S1: badge rendering from injected gate/build state; alert bar shows on `compose:notify` and on simulated WS `gateCreated`; tap-to-navigate; AGENT_PORT — assert built URLs unchanged.
- S2: `mergePipelineSteps` unit tests (template-only, live-override, dynamic-append, failed-step) + snapshot vs desktop merge behavior; BuildStepsList render states; history list fetch/render/tap.
- S3: create POST payload (incl. `type:'feature'`) + optimistic prepend; delete confirm flow + rollback on 500; connections list/add/remove payloads incl. required connection `type`. All mutations assert `x-compose-token` header (added in this slice via `withComposeToken()`).
- Full `npm test` (node suite with `--test-timeout=90000`) before each slice commit.

## Risks
- **Hook lift (D1.1)** touches AgentsTab/BuildsTab wiring — the one cross-cutting change; mitigated by doing it first in S1 with existing tests as the guard.
- **Desktop PipelineView refactor (D2.1)** is the only desktop-touching change; behavior-preserving, covered by merge-logic unit tests.
- **guardAuth default-OFF:** mutations work without token locally today; tests still assert the header so REMOTE's token-required future doesn't break mobile.

## Technical assumptions (gate checkpoint)
None unproven — every endpoint, message type, and merge behavior was verified against source during research (2026-06-11).
