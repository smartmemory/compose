# COMP-MOBILE — Blueprint

**Status:** IN_PROGRESS
**Phase:** 4 (blueprint)
**Predecessor:** [design.md](./design.md)
**Audit date:** 2026-05-10

---

## Verification table

All 13 items from the audit, current code state confirmed.

| # | Item | Design claim | Verified | Status |
|---|---|---|---|---|
| V1 | `src/main.jsx` route branching | Branch on `window.location.pathname.startsWith('/m')` | Lines 7–10, `<App />` unconditional today | ✅ insertion site clear |
| V2 | `src/lib/compose-api.js` | Add `setSensitiveToken(t)` runtime override | 7-line file. Exports `COMPOSE_API_TOKEN` + `withComposeToken(headers)`. No runtime override yet | ✅ extension point clear |
| V3 | `index.html` SW killer | Scope to non-`/m` paths | Lines 11–16 unregister unconditionally | ✅ wrap in pathname check |
| V4 | `wsFetch.js` + `WorkspaceContext.jsx` | Reusable from mobile | 29 + 70 LOC, no heavy deps | ✅ clean reuse |
| V5 | WS reconnect pattern | Reuse `useVisionStore.js:103` | Found at 97–206. **2s fixed delay**, no exponential backoff | ⚠ M4 should add exponential backoff for mobile cellular |
| V6 | Agent SSE consumer | Reuse cockpit's | Found in `AgentStream.jsx:261`. Module-level `_state` singleton | ⚠ M4 needs to extract to a shared hook |
| V7 | Build start/stop endpoints | NEW in M5 | Don't exist. `bin/compose.js build` is CLI-only side effect, not importable | ✅ M5 ships server + client |
| V8 | Bundle import audit | Mobile under 300KB gzipped | wsFetch + WorkspaceContext have zero heavy transitive deps; Cytoscape/Mermaid/KaTeX already in their own chunks | ✅ achievable with manual chunks |
| V9 | Vision PATCH editable fields | status, group, **priority** | `vision-store.js:208` allows status, group, type, title, description, confidence, phase, etc. **No `priority` field on vision items** | 🛑 **Design correction: priority is ideabox-only** |
| V10 | Ideabox routes | All design routes correct | All 8 routes verified (list, create, patch, promote, kill, resurrect, discuss, delete-405) | ✅ |
| V11 | Vite manual chunks | Mobile may need its own chunk | `vite.config.js` has no `manualChunks` config today | ✅ M1 adds manualChunks for the mobile slice |
| V12 | Test harness | vitest + RTL | Confirmed via `test/ui/branch-compare-panel.test.jsx` | ✅ pattern fits |
| V13 | Current bundle size | ~2.2MB main | 2.1MB (`index-CUs2IjFj.js`); diagram libs already split | ✅ baseline |

## Corrections to design

| # | Design said | Reality | Resolution |
|---|---|---|---|
| C1 | M2 edits "status/group/priority" on roadmap items | `priority` is not a vision-item field — only ideabox has it | M2 scope: status, group, confidence (which IS a vision-item field). Priority editing stays in M3 (ideabox). |
| C5 | Design says "filter by status/group/track/keyword" and "edit status/priority/group/tags" on roadmap | `track` is not a first-class field — desktop scrapes `Track:` from item.description text (`src/App.jsx:628`). `tags` is not in the vision-item allowlist (`vision-store.js:208`). | M2 filter set: status, group, keyword (substring on title/description). M2 edit set: status, group, confidence. **Track-based filtering and tags editing dropped from v1**; if needed, add them as follow-ups (track filtering can ship as a regex over description; tags requires schema change). |
| C2 | "reuse desktop's existing WS reconnect" | Reconnect is fixed 2s delay, baked into a Zustand store (not a hook) | Extract reconnect logic to `src/lib/wsReconnect.js` as a hook usable from both desktop and mobile. Add exponential backoff (capped at 30s) for mobile cellular reliability. |
| C3 | "extract agent SSE consumer for mobile reuse" | Today it's a module-level singleton in `AgentStream.jsx` | Extract to `src/lib/agentStream.js` (consumer) + `src/hooks/useAgentStream.js` (hook). Refactor `AgentStream.jsx` to consume the hook. |
| C4 | `compose-api.js` helper name | Existing helper is `withComposeToken(headers)` — design referenced "compose-api helper" generically | Use the actual export name in M1 plan. |

## File touch list

### M1 — Shell + plumbing

**New:**
- `src/mobile/MobileApp.jsx` — root: header, `<main>`, bottom nav, tab switching, token pairing flow, SW registration
- `src/mobile/mobile.css` — mobile-only styles (no leakage to desktop via class scoping or scoped CSS)
- `src/mobile/components/BottomNav.jsx` — 4-button nav (icon + label, aria-pressed, ≥44px touch targets)
- `src/mobile/components/StatusPill.jsx` — status indicator primitive (planned/in_progress/blocked/...)
- `src/mobile/tabs/AgentsTab.jsx` — M1 placeholder ("Coming in M4")
- `src/mobile/tabs/RoadmapTab.jsx` — M1 placeholder ("Coming in M2")
- `src/mobile/tabs/IdeasTab.jsx` — M1 placeholder ("Coming in M3")
- `src/mobile/tabs/BuildsTab.jsx` — M1 placeholder ("Coming in M5")
- `public/manifest.webmanifest` — `name`, `short_name`, `start_url: "/m"`, `display: "standalone"`, theme/background colors, 192/512 icons
- `public/m-icon-192.png`, `public/m-icon-512.png` — placeholder PWA icons (will use compose logo or simple monogram for v1)
- `public/m-sw.js` — minimal app-shell service worker (cache HTML/JS/CSS for offline boot, network-first for `/api/*`)
- `test/ui/mobile-app.test.jsx` — renders shell, tab switch, token persistence, SW registration smoke

**Modified:**
- `src/main.jsx` (line 9) — branch on `window.location.pathname.startsWith('/m')` to render `<MobileApp/>` vs `<App/>`
- `src/lib/compose-api.js` (extend at end of file) — add `let _runtimeToken = null`, `export function setSensitiveToken(t)`, modify `withComposeToken` to prefer `_runtimeToken` over `COMPOSE_API_TOKEN` when set
- `index.html` (lines 11–16) — wrap SW unregister in `if (!window.location.pathname.startsWith('/m'))`. Also conditionally inject `<link rel="manifest" href="/manifest.webmanifest">` and `<meta name="theme-color" content="...">` for `/m`
- `vite.config.js` — add `build.rollupOptions.output.manualChunks` to keep mobile bundle clean (mobile entry points should not pull desktop-only libs); also add `mobile` chunk name pattern

### M2 — Roadmap + items

**New:**
- `src/mobile/tabs/RoadmapTab.jsx` (replace M1 placeholder) — list, filter UI, search
- `src/mobile/components/ItemCard.jsx` — card primitive: title, status pill, group, optional description trim
- `src/mobile/components/ItemDetailSheet.jsx` — full-screen overlay or bottom sheet: title, description, status/group/confidence editors, Save
- `src/mobile/components/FilterBar.jsx` — chip row for status filter, group filter, search input
- `src/mobile/hooks/useRoadmapItems.js` — fetches `GET /api/vision/items`, subscribes to `WebSocket /ws/vision`, applies optimistic mutations on PATCH
- `test/ui/mobile-roadmap.test.jsx` — list renders, filter works, edit persists

**Modified:**
- `src/lib/wsReconnect.js` (new — extracted from `useVisionStore.js`) — exponential backoff hook
- `src/components/vision/useVisionStore.js` — refactor to use `wsReconnect` (no behavior change)

### M3 — Ideabox

**New:**
- `src/mobile/tabs/IdeasTab.jsx` (replace placeholder) — list, capture form, swipe gestures
- `src/mobile/components/IdeaCard.jsx` — card with priority badge, swipe handlers
- `src/mobile/components/CaptureSheet.jsx` — bottom sheet form: title (required), description, tags, cluster (optional)
- `src/mobile/components/PrioritySelector.jsx` — P0/P1/P2/Untriaged chips
- `src/mobile/hooks/useIdeas.js` — `GET /api/ideabox`, optimistic POST/PATCH/promote/kill, WS `ideaboxUpdated` listener
- `src/mobile/lib/swipe.js` — pointer-event-based swipe detection (no library)
- `test/ui/mobile-ideabox.test.jsx`

### M4 — Agents + gates + (interactive-session) chat

**Scope correction:** the codebase has two distinct agent surfaces:
- **Spawned agents** (background, multiple): `GET /api/agents/tree`, `GET /api/agent/:id`, `POST /api/agent/:id/stop`. Output viewable, killable. **No per-agent chat/interrupt today.**
- **Interactive session** (single, exclusive): `agent-server.js` chat/interrupt at line 142. One at a time, used by the cockpit terminal.

M4 mobile delivers the **achievable** subset:
- For each spawned agent: list, status, output tail (filtered from the global SSE stream), kill button. **No chat message** to spawned agents — that surface doesn't exist server-side.
- For the interactive session: status indicator, "Switch to mobile" message-send → goes through existing `agent-server.js` chat path. Active session only (one at a time).
- For pending gates: list, approve/revise/kill via `POST /api/vision/gates/:id/resolve`.

**Out of scope for M4:** chat-with-spawned-agent. If we want that, file `COMP-AGENT-CHAT-PER-ID` as a separate ticket (server-side messaging API needed first).

**New:**
- `src/mobile/tabs/AgentsTab.jsx` (replace placeholder) — three sections: spawned agents list, interactive-session card, pending gates list
- `src/mobile/components/AgentCard.jsx` — id, status, last activity, kill button (no chat)
- `src/mobile/components/AgentDetailView.jsx` — output log tail (SSE-driven, filtered to this agent id), kill button
- `src/mobile/components/InteractiveSessionCard.jsx` — status, "send message" input (only when an interactive session is active)
- `src/mobile/components/GateCard.jsx` — pending gate summary
- `src/mobile/components/GatePromptSheet.jsx` — bottom sheet: outcome buttons (approve / revise / kill), reason input, summary
- `src/mobile/hooks/useLiveAgents.js` — `GET /api/agents/tree`, refresh on WS notification
- `src/mobile/hooks/usePendingGates.js` — `GET /api/vision/gates`, refresh on WS
- `src/lib/agentStream.js` (new — extracted from `AgentStream.jsx`) — SSE consumer that emits typed events with agent-id keying so subscribers can filter
- `src/hooks/useAgentStream.js` (new) — hook wrapping `agentStream.js` for components
- `test/ui/mobile-agents.test.jsx`

**Modified:**
- `src/components/AgentStream.jsx` — refactor to use `useAgentStream` hook (no behavior change for desktop)

### M5 — Builds (server + client)

**Reality check on the build abstraction:** the runner is already an importable JS function. `bin/compose.js:1904` delegates to `runBuild` in `lib/build.js:532`. **No extraction needed** — just import and call.

**Concurrency semantics (verified):** `runBuild` only blocks a *second build for the same feature*; different features can run concurrently. `active-build.json` is last-writer-wins, so it reflects whichever build wrote most recently — not a complete list. Abort writes `status: 'aborted'` + `completedAt` to the file rather than clearing it; same for completed/failed terminal states.

**Scope corrections:**
- `POST /api/build/start` body: `{ featureCode, mode, description? }` where `mode ∈ {'feature', 'bug'}`. The `mode='bug'` path also passes `template: 'bug-fix'` internally (handled by `runBuild`). No `through` option — that's not in the runner contract.
- `POST /api/build/abort` body: `{ featureCode }` — required; identifies which build to abort. Returns the abort result with the post-write `active-build.json` snapshot.
- M5 client shows: the **most-recent active-build.json contents** (with the explicit caveat that other concurrent builds may exist but aren't surfaced — consistent with desktop's current behavior). Start sheet when no live build for the picked feature; abort button when status is non-terminal.
- "Recent builds" history doesn't exist in the codebase. **Drop from M5.** If wanted, file `COMP-BUILD-HISTORY` (needs a new persistent log).

**New (server):**
- `server/build-routes.js` — `POST /api/build/start`, `POST /api/build/abort`. Both `requireSensitiveToken`. Imports `runBuild` from `lib/build.js` (already exported), `abortBuild` (currently a local function at `lib/build.js:3718` — needs `export` added; no behavior change), and `getDataDir` from `server/project-root.js`. **Note:** `abortBuild` signature is `(dataDir, featureCode)`, NOT `(featureCode)` — the route threads `getDataDir()` through.
- `test/build-routes.test.js` — POST start launches build → active-build.json updates with status='in_progress'; POST abort writes status='aborted' to the file and terminates the process; sensitive-token enforced; starting the same featureCode while it's active returns 409 (different featureCode is allowed by the runner and should succeed).

**New (client):**
- `src/mobile/tabs/BuildsTab.jsx` (replace placeholder) — single-build view: card if active, start sheet if not
- `src/mobile/components/BuildCard.jsx` — featureCode, mode, status, log tail preview, abort button
- `src/mobile/components/BuildDetailView.jsx` — full log tail (SSE-filtered), abort button
- `src/mobile/components/StartBuildSheet.jsx` — feature picker (autocomplete from `/api/vision/items`), mode selector (`feature` / `bug`). No through-phase selector — `runBuild` doesn't accept that option today.
- `src/mobile/hooks/useActiveBuild.js` — `GET /api/build/state`, refresh on WS (single, not a list)
- `test/ui/mobile-builds.test.jsx`

**Modified (server):**
- `server/vision-server.js` (line 75 area, where existing routes attach) — mount `attachBuildRoutes(app)`. Note: most route attachment lives here, not in `server/index.js`.
- `lib/build.js` — add `export` keyword to the existing `abortBuild` function (line 3718). One-character change.

**No CLI refactor.** `bin/compose.js build` already uses the importable `runBuild`; the new HTTP route imports the same. CLI behavior unchanged.

## Architecture details

### M1: routing + token pairing

**Pathname branching alone is not enough** — static imports pull both apps into every chunk. Use `React.lazy()` so mobile path doesn't load the desktop bundle and vice versa.

```js
// src/main.jsx
import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import './index.css';

const isMobile = window.location.pathname.startsWith('/m');
const Root = isMobile
  ? React.lazy(() => import('./mobile/MobileApp'))
  : React.lazy(() => import('./App'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <WorkspaceProvider>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </WorkspaceProvider>
);
```

Combined with the `manualChunks` config below, the mobile entry only loads `mobile-*.js` (plus `WorkspaceContext` shared infrastructure); the desktop heavy chunks (Cytoscape, agent terminal, design canvas, etc.) never enter the mobile bundle.

```js
// src/lib/compose-api.js — extended
export const COMPOSE_API_TOKEN = import.meta.env.VITE_COMPOSE_API_TOKEN || '';
let _runtimeToken = null;
export function setSensitiveToken(t) { _runtimeToken = t || null; }
export function getSensitiveToken() { return _runtimeToken || COMPOSE_API_TOKEN || ''; }
export function withComposeToken(headers = {}) {
  const tok = getSensitiveToken();
  if (!tok) return headers;
  return { ...headers, 'x-compose-token': tok };
}
```

```js
// src/mobile/MobileApp.jsx — token pairing
useEffect(() => {
  const u = new URL(window.location.href);
  const fromQs = u.searchParams.get('token');
  if (fromQs) {
    localStorage.setItem('compose:mobile:sensitiveToken', fromQs);
    setSensitiveToken(fromQs);
    u.searchParams.delete('token');
    window.history.replaceState({}, '', u.pathname + (u.search ? u.search : '') + u.hash);
  } else {
    const stored = localStorage.getItem('compose:mobile:sensitiveToken');
    if (stored) setSensitiveToken(stored);
  }
}, []);
```

### M1: SW + manifest scoping

```html
<!-- index.html -->
<script>
  if ('serviceWorker' in navigator && !window.location.pathname.startsWith('/m')) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => { r.unregister(); console.log('[compose] Unregistered stale service worker'); });
    });
  }
</script>
```

`MobileApp` registers its own SW conditionally:

```js
useEffect(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/m-sw.js').catch(err => {
      console.warn('[compose-mobile] SW registration failed:', err);
    });
  }
}, []);
```

### M1: vite manual chunks

```js
// vite.config.js
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        // Mobile app gets its own chunk
        if (id.includes('/src/mobile/')) return 'mobile';
        // Cytoscape and graph stuff stays in 'graph' (desktop only)
        if (id.includes('cytoscape')) return 'graph';
        // Existing diagram libs already auto-chunked; let Vite continue handling them
      },
    },
  },
},
```

### M2: WS reconnect extraction

```js
// src/lib/wsReconnect.js (new)
export function createReconnectingWS({ url, onMessage, onOpen, onClose, maxBackoffMs = 30_000 }) {
  let ws = null;
  let attempt = 0;
  let stopped = false;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => { attempt = 0; onOpen?.(); };
    ws.onmessage = (ev) => onMessage?.(ev);
    ws.onclose = () => {
      onClose?.();
      if (stopped) return;
      const backoff = Math.min(maxBackoffMs, 1000 * Math.pow(2, attempt++));
      setTimeout(connect, backoff);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  connect();
  return {
    close() { stopped = true; try { ws?.close(); } catch {} },
    send(data) { ws?.readyState === 1 && ws.send(data); },
  };
}
```

`useVisionStore.js:97-206` block refactors to call `createReconnectingWS({ url: visionWsUrl(), onMessage: handleEvent })`. No behavior change for desktop (still 1s initial → backs off only on repeated failures, same as today's "fixed 2s" but adaptive).

### M5: build route shape

No extraction. `lib/build.js` already exports `runBuild` and (per audit) has a local `abortBuild` that may need a thin export wrapper. Sketch:

```js
// server/build-routes.js (new)
import { runBuild, abortBuild } from '../lib/build.js';
import { requireSensitiveToken } from './security.js';

export function attachBuildRoutes(app) {
  app.post('/api/build/start', requireSensitiveToken, async (req, res) => {
    const { featureCode, mode = 'feature', description = '' } = req.body || {};
    if (!featureCode) return res.status(400).json({ error: 'featureCode required' });
    if (mode !== 'feature' && mode !== 'bug') {
      return res.status(400).json({ error: "mode must be 'feature' or 'bug'" });
    }
    try {
      // runBuild rejects if a build is already active for this featureCode;
      // different featureCode is allowed and runs concurrently.
      const opts = mode === 'bug' ? { mode, template: 'bug-fix', description } : { mode, description };
      const result = await runBuild(featureCode, opts);
      res.json(result);
    } catch (err) {
      const code = /already active/i.test(err.message) ? 409 : 500;
      res.status(code).json({ error: err.message });
    }
  });

  app.post('/api/build/abort', requireSensitiveToken, async (req, res) => {
    const { featureCode } = req.body || {};
    if (!featureCode) return res.status(400).json({ error: 'featureCode required' });
    try {
      // abortBuild signature is (dataDir, featureCode); we get the dataDir
      // from project-root so it's workspace-correct.
      const result = await abortBuild(getDataDir(), featureCode);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
```

**One small prerequisite:** `abortBuild` is currently a local function in `lib/build.js:3718`. M5 first PR step adds `export` to it (one-character change). No behavior change to the CLI.

## Verification gates

### Per-phase exit criteria

| Phase | Verification |
|---|---|
| M1 | Open `/m` on iPhone Safari → shell renders, 4 tabs reachable, no horizontal scroll, no console errors. PWA install prompt appears. `?token=ABC` URL persists in localStorage and is sent on subsequent fetches. Bundle size: mobile chunk under 200KB gzipped. Existing desktop unaffected (full test suite passes). |
| M2 | List 100+ items without lag. Filter by status/group/keyword. Open item, edit group, see it change in cockpit live (WS broadcast). Edit persists across refresh. |
| M3 | Capture an idea from `/m` → appears in cockpit ideabox immediately. Swipe-to-promote sets priority and persists. Swipe-to-kill works. WS `ideaboxUpdated` triggers re-fetch. |
| M4 | Approve a real pending gate from phone → agent advances. Kill an agent → cockpit shows it gone. Send a chat message → agent receives. Live SSE log tail keeps up. |
| M5 | Start a build from phone → cockpit shows new active build (active-build.json status='in_progress'). Watch log tail update. Abort → status flips to 'aborted', child process terminates. (active-build.json is intentionally retained — terminal status is part of the contract.) |

### Cross-cutting

- `npm run build` succeeds at every phase
- `find test -maxdepth 2 -name "*.test.js" -exec node --test {} +` passes (excluding the 2 pre-existing STRAT-DEDUP failures)
- `npm run test:ui` (vitest UI tests) passes
- No new bundle warnings beyond the pre-existing ~2MB main chunk
- `grep -n "'/api/ideas/'\|'/approve\\\\|/reject'" src/` returns empty (no legacy route references)

## Risks

- **WebSocket on cellular networks.** Mitigated by exponential backoff + visible offline pill in mobile header.
- **Bundle leakage.** Manual Vite chunks + import audit during M1. The `useVisionStore` reconnect extraction (M2 prep) reduces transitive desktop weight.
- **Token leak via shareable URL.** `?token=…` is single-use, stripped on first load via `replaceState`. Pairing URL guidance lives in `COMP-MOBILE-REMOTE`'s docs.
- **PWA + iOS Safari quirks.** iOS doesn't support full PWA standalone; installation goes through Add to Home Screen. Manifest still works for theme color and icon. v1 documents this in the README.
- **Build concurrency mismatch with mobile UX.** `runBuild` allows different-feature builds concurrently and `active-build.json` is last-writer-wins, so the mobile "current build" view may flicker between concurrent builds in pathological cases. Acceptable for v1 (matches desktop behavior); follow-up `COMP-BUILD-HISTORY` adds a per-feature log if this becomes a real problem.
- **Optimistic mutations + WS race.** Edit status → optimistic local update → WS broadcast confirms. If the broadcast contradicts, the WS value wins (server authoritative). Documented in M2 hook.

## Phase 5 verification (post-blueprint)

Re-grep verified file:line refs before kicking off implementation. Specifically:
- `src/main.jsx` line 9 still has `<App />` to replace
- `src/lib/compose-api.js` still 7-line file with `withComposeToken`
- `index.html` lines 11-16 still the SW unregister block
- `vision-store.js:208` still has the editable fields list (no `priority`)
- `useVisionStore.js:97-206` still the WS connect block
- `AgentStream.jsx:261` still the SSE connect call

If any drift > 5 lines, update blueprint before implementing.
