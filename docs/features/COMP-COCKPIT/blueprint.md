# COMP-COCKPIT Slice A — Implementation Blueprint

**Scope:** Slice A = {COCKPIT-2, COCKPIT-1, COCKPIT-6}. Slice B {4,5,3} deferred.
**Status:** BLUEPRINT (Phase 4) — feeds Phase 5 verification + Phase 6 plan.
**Design:** `docs/features/COMP-COCKPIT/design.md` (gate-approved 2026-06-07).

All file:line references below were read directly from source on 2026-06-07.

## Corrections table (design assumption vs. verified reality)

| # | Design said | Reality | Resolution |
|---|---|---|---|
| C1 | 4001 = "the API"; 4002 = "the agent/terminal server" | **Both ports carry agent traffic.** `/api/agent/spawn` + `/api/agent/{id}` are on **4001** (`ChallengeModal:227/:196`, via `wsFetch`); `/api/terminal/inject` + `/api/agent/stream` are on **4002** (`ChallengeModal:36` raw `fetch`; `agentStream.js:183`). | COCKPIT-2: 4001 calls → relative `wsFetch('/api/agent/...')`; 4002 call → shared `agentServerUrl()` helper (hostname + `VITE_AGENT_PORT`). |
| C2 | Replace `window.confirm`/`prompt` with "in-app modals" (implied drop-in) | Native dialogs are **synchronous + inline** (`if (window.confirm(x)) act()`). A React modal cannot be a synchronous drop-in. | Build a **promise-based imperative API**: `useConfirm()`/`usePrompt()` returning `Promise`, backed by a single app-root `<DialogProvider>`. Call sites become `if (await confirm({...})) act()`. Minimal edits; no JSX added to oversized files. |
| C3 | `ItemDetailPanel` "kill (:772)" silent | `:772/:775` = lifecycle-**kill** `console.error` (silent, COCKPIT-1 target). `:791` = a separate **delete** `window.confirm` (native-dialog target). Two distinct sites. | Handle both: notify() on kill failure; ConfirmDialog for delete. |
| C4 | `notify(message, level, ttl)` exists | Confirmed `NotificationBar.jsx:81`, fires `compose:notify`; singleton mounted `App.jsx:1272`. | Use as-is. No new toast infra. |
| C5 | Radix `Dialog` reusable | Confirmed `ui/dialog.jsx`; usage pattern `<Dialog open onOpenChange><DialogContent><DialogHeader><DialogTitle>` (`ItemFormDialog.jsx:113`). | ConfirmDialog/PromptDialog build on it. |

No corrections invalidate the design; C1/C2 sharpen the approach.

---

## New shared code (authored in COCKPIT-1, consumed by COCKPIT-6)

### `src/lib/agentServer.js` (new) — COCKPIT-2
Extract the host convention from `agentStream.js:181` so it isn't duplicated:
```js
export function agentServerUrl(path) {
  const port = (import.meta?.env?.VITE_AGENT_PORT) || '4002';
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`;
}
```
Refactor `defaultAgentStreamUrl()` to `return agentServerUrl('/api/agent/stream')`.

### `src/components/ui/DialogProvider.jsx` (new) — COCKPIT-1
App-root provider mounting one `ConfirmDialog` + one `PromptDialog` instance, exposing context. Pattern: a ref-held `resolve` fn + open state; `confirm(opts)`/`prompt(opts)` set state and return a Promise that resolves on confirm/cancel.
- `useConfirm()` → `(opts:{title, body?, confirmLabel?, destructive?}) => Promise<boolean>`
- `usePrompt()` → `(opts:{title, label?, defaultValue?, required?, validate?}) => Promise<string|null>` (null = cancelled)
- `ConfirmDialog`/`PromptDialog` are thin Radix `Dialog` bodies; reason field in ConfirmDialog when `requireReason`.
Mount `<DialogProvider>` wrapping the app tree in `App.jsx` (alongside existing providers).

> Reason-collecting kill (COCKPIT-6) is a `confirm({destructive:true, requireReason:true})` variant returning the entered reason instead of a bare boolean — expose `confirmWithReason(opts) => Promise<string|null>`.

---

## COCKPIT-2 — ChallengeModal hostname portability (S)
File: `src/components/vision/ChallengeModal.jsx`
- `:36` `fetch('http://localhost:4002/api/terminal/inject', …)` → `wsFetch(agentServerUrl('/api/terminal/inject'), …)` (also gains the workspace header). Import `agentServerUrl` + `wsFetch`.
- `:196` `wsFetch('http://localhost:4001/api/agent/${agentId}')` → `wsFetch(`/api/agent/${agentId}`)`.
- `:227` `wsFetch('http://localhost:4001/api/agent/spawn', …)` → `wsFetch('/api/agent/spawn', …)`.
- Add `notify('Pressure-test failed: '+err.message, 'error')` in the three `catch` blocks (currently `/* ignore */` / silent).
- Remove the `// TODO COMP-WORKSPACE-AGENT-SVR` at `:35` (now resolved).

**Verify (Phase 5):** Vite dev proxy forwards `/api/agent/*` to 4001 and prod serves the cockpit from the 4001 origin (A1). Check `vite.config.*` proxy table.

---

## COCKPIT-1 — Action feedback + native-dialog replacement (M)

**A. Silent `catch` → `notify(..., 'error')`** (+ success notify where outcome is otherwise invisible):
| Site | Line | Change |
|---|---|---|
| PipelineView approve | `:49` | notify error; notify('Draft approved','info') on success |
| PipelineView reject | `:64` | notify error |
| TemplateSelector draft create | `:40` | notify error |
| DocsView save | `:273` (empty catch) | notify error; the `if(res.ok)` else-branch → notify error too |
| OpenLoopsPanel resolve | `:211` | notify error |
| ItemDetailPanel kill | `:772/:775` | notify error (response-not-ok + throw paths) |
| App stop-agent | `:702` | notify error |

**B. Native dialogs → promise-based API:**
| Site | Line | Change |
|---|---|---|
| DesignView feature-code | `:93` | `const code = await prompt({title:'Feature code', required:true}); if (code) startSession('feature', code)` |
| OpenLoopsPanel resolve note | `:209` | `const note = await prompt({title:'Resolve note', label:'(optional)'}); if (note===null) return;` |
| ItemDetailPanel delete | `:791` | `if (await confirm({title:'Delete permanently?', body:`"${item.title}" cannot be undone.`, destructive:true})) onDelete(item.id)` |
| SettingsPanel reset | `:89` | `if (await confirm({title:'Reset all settings to defaults?', destructive:true})) onReset()` |

Call sites become `async`; each component calls `useConfirm()`/`usePrompt()` at top. No modal JSX added to the oversized files (edits are ~1–2 lines each).

---

## COCKPIT-6 — Gate-kill guardrail consistency (S)
File: `src/components/vision/DashboardView.jsx`
- `:203` `onClick={() => onResolveGate(gate.id, 'killed')}` → `onClick={async () => { const reason = await confirmWithReason({title:'Kill this gate?', destructive:true, requireReason:true}); if (reason) onResolveGate(gate.id, 'killed', reason); }}`.
- `onResolveGate` already forwards `comment` → `resolveGate(gateId, outcome, comment)` → POST body `{outcome, comment}` (`useVisionStore.js:348`). No store/endpoint change.
- GateView (`:126`) + ItemDetailPanel gate-kill already require a reason — unchanged; behavior now uniform across all three surfaces.

---

## Boundary Map

- **`agentServerUrl(path)`** — `function`, in `src/lib/agentServer.js`. Produced by COCKPIT-2. Consumed by ChallengeModal + (refactored) `defaultAgentStreamUrl`.
- **`useConfirm` / `usePrompt` / `confirmWithReason`** — `hook`s, in `src/components/ui/DialogProvider.jsx`. Produced by COCKPIT-1. Consumed by COCKPIT-1 call sites and **COCKPIT-6** (`from COCKPIT-1`).
- **`DialogProvider`** — `component`, in `src/components/ui/DialogProvider.jsx`. Produced by COCKPIT-1. Consumed by `App.jsx` (mount).
- **`notify`** — `function` (existing, `NotificationBar.jsx`). Consumed by COCKPIT-1 + COCKPIT-2. (Untouched dependency.)
- **`resolveGate(gateId, outcome, comment)`** — `function` (existing, `useVisionStore.js`). Consumed by COCKPIT-6. (Untouched — already accepts comment.)

Topology: COCKPIT-2 and COCKPIT-1 introduce independent symbols; COCKPIT-6 consumes COCKPIT-1's hooks (earlier work unit). No forward references.

## Test plan
- **COCKPIT-2 unit:** `agentServerUrl('/x')` builds `proto//host:VITE_AGENT_PORT/x`; defaults to 4002. (jsdom `window.location`.)
- **COCKPIT-1 error harness (table-driven):** for each silent site, mock the fetch/handler to reject → assert a `compose:notify` event with `level:'error'` fired (listen on window). Assert the user-visible outcome, not console.
- **COCKPIT-1 dialog:** `useConfirm` resolves `true` on confirm click, `false` on cancel/overlay; `usePrompt` resolves entered value / `null` on cancel; required-field blocks confirm.
- **COCKPIT-6 component:** dashboard Kill opens the reason modal; confirming with empty reason is blocked; confirming with reason calls `onResolveGate(id,'killed',reason)`.
- **E2E smoke (Phase 7):** kill a gate from the dashboard → reason modal → resolve; trigger a pressure-test failure → error toast appears.

## Risks
- **A1 (load-bearing):** relative `/api/agent/*` resolves to 4001 in dev (Vite proxy) and prod (same-origin). Must verify the proxy table in Phase 5 — if `/api/agent` isn't proxied, dev breaks. Fallback: keep `agentServerUrl` for 4001 too via a second port const.
- Making call sites `async` must not change render order / drop the `setX(false)` finally blocks — preserve existing `finally`/state resets.

## Phase 5 — Verification Table (verified 2026-06-07)

| Check | Result |
|---|---|
| `vite.config.js` proxy `/api` → 4001 | ✅ `vite.config.js:15` `'/api': 'http://localhost:4001'`. Relative `/api/agent/*` resolves to 4001 in dev. |
| `/api/agent/spawn` + `/api/agent/:id` on 4001 | ✅ `agent-spawn.js:41/176`, mounted via `vision-server.js:210` `attachAgentSpawnRoutes` → `index.js:109` `visionServer.attach` (PORT 4001). **A1 confirmed** — relative wsFetch correct for `:196`/`:227`. |
| `/api/agent/stream` on 4002 | ✅ `agent-server.js:94` (AGENT_PORT 4002). Stays absolute via `agentServerUrl()` — not proxied (vite.config comment `:16`). Consistent. |
| `/api/terminal/inject` (`:36`, 4002) | ⚠️ **No handler in repo `server/`** (grep empty). Separate workspace-agent server (`// TODO COMP-WORKSPACE-AGENT-SVR`). COCKPIT-2 scope = hostname portability only; endpoint liveness pre-existing & out of scope. `agentServerUrl()` is still the correct portable target. |
| `notify` export `NotificationBar.jsx:81` | ✅ verified. |
| Radix `Dialog` + usage pattern | ✅ `ui/dialog.jsx`; `ItemFormDialog.jsx:113`. |
| `resolveGate(gateId, outcome, comment)` forwards comment | ✅ `useVisionStore.js:348` POST `{outcome, comment}`. COCKPIT-6 needs no store/endpoint change. |
| All COCKPIT-1 silent + native-dialog sites | ✅ all line refs read fresh & confirmed (incl. C3 split: ItemDetailPanel `:772/:775` kill vs `:791` delete). |

**Gate:** All references verified; zero stale entries; one informational ⚠️ (out-of-scope endpoint liveness). Boundary Map satisfiable. **Phase 5 PASS.**
