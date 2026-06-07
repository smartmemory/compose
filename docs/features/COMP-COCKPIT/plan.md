# COMP-COCKPIT Slice A — Implementation Plan

**Scope:** {COCKPIT-2, COCKPIT-1, COCKPIT-6}. **Blueprint:** `blueprint.md` (Phase-5 PASS).
**Execution:** sequential — Task 0 (shared primitives) gates Tasks 1–3, which are then independent.
**TDD throughout:** test first → watch fail → implement → watch pass.

> **Codex plan-review corrections (2026-06-07):**
> - **F1 — non-ok responses don't throw.** `wsFetch` (`wsFetch.js:23`) returns `fetch()` verbatim, and `useVisionStore.apiCall` (`:85`) / `resolveGate` (`:348`) return `{error}` instead of throwing. So `notify` in a `catch` alone stays silent on 4xx/5xx and store-error returns. **Every feedback site must handle both paths:** `catch` (transport) **and** `if (!res.ok)` / `if (data?.error)` (server). Encoded per-site below.
> - **F2 — no toast spam in poll loops.** Only **user-initiated** calls toast. The ChallengeModal GET poll (1.5s, `:192/:203`) must be one-shot: on failure clear the interval + set a failed state + emit ≤1 notification — never per-tick.
> - **F3 — correct test runner.** Component/jsdom tests run under **Vitest** (`vitest.config.js` include `test/ui/**/*.test.{js,jsx}`), not `node --test`. **All new tests below live in `test/ui/`.** Exit criterion is `npm test` (chains `node --test` → `test:ui` → `test:tracker`) or at least `npm run test:ui`.

---

## Task 0 — Shared primitives (foundation; blocks 1–3)

### 0a. `src/lib/agentServer.js` (new)
- [ ] `agentServerUrl(path)` → `${protocol}//${hostname}:${VITE_AGENT_PORT||4002}${path}` (pattern: `agentStream.js:181`).
- [ ] Refactor `defaultAgentStreamUrl()` (`agentStream.js:179`) to `return agentServerUrl('/api/agent/stream')` — no behavior change.
- [ ] **Test** (`test/ui/agent-server.test.jsx`, new — Vitest/jsdom for `window.location`): builds `proto//host:port/path`; defaults to 4002; honors `VITE_AGENT_PORT`.

### 0b. `src/components/ui/DialogProvider.jsx` (new)
- [ ] `<DialogProvider>` mounts one `ConfirmDialog` + one `PromptDialog` (Radix `Dialog`, pattern `ItemFormDialog.jsx:113`).
- [ ] `useConfirm()` → `({title, body?, confirmLabel?, destructive?}) => Promise<boolean>`.
- [ ] `usePrompt()` → `({title, label?, defaultValue?, required?}) => Promise<string|null>` (null = cancel).
- [ ] `confirmWithReason()` → `({title, destructive?}) => Promise<string|null>` (returns reason; null = cancel; empty reason blocked).
- [ ] Mount `<DialogProvider>` in `App.jsx` wrapping the app tree (alongside existing providers).
- [ ] **Test** (`test/ui/dialog-provider.test.jsx`, new): confirm resolves true/false; prompt resolves value/null; required blocks confirm; confirmWithReason blocks empty.

---

## Task 1 — COCKPIT-2: ChallengeModal portability *(needs 0a)*
File: `src/components/vision/ChallengeModal.jsx` (existing)
- [ ] `:36` raw `fetch('http://localhost:4002/api/terminal/inject')` → `wsFetch(agentServerUrl('/api/terminal/inject'), …)`; drop `// TODO COMP-WORKSPACE-AGENT-SVR`. **(user-initiated)** toast on `catch` **and** `!res.ok`.
- [ ] `:227` handleRun spawn → `wsFetch('/api/agent/spawn', …)` (relative). **(user-initiated)** toast on `catch` **and** `!res.ok`; on failure also reset `setAgentStatus` so the UI isn't stuck "running".
- [ ] `:196` poll GET → `wsFetch(`/api/agent/${agentId}`)` (relative). **(poll — F2 one-shot):** on failure clear `pollRef` interval + set a failed status; **≤1** notification, never per-tick.
- [ ] **Test** (`test/ui/challenge-modal-host.test.jsx`, new): with `window.location.hostname='example.com'`, terminal-inject targets `example.com:4002` (not localhost) and agent calls use relative paths (assert via mocked `wsFetch`/`fetch`); a spawn `!res.ok` fires one error toast; a repeated poll failure fires **at most one** toast.

## Task 2 — COCKPIT-1: feedback + native-dialog replacement *(needs 0b)*
Existing files. Each call site becomes `async`; preserve existing `finally`/`setX(false)`.
- [ ] `notify(...,'error')` into the silent sites — **each on BOTH transport (`catch`) AND non-ok/error-return (F1)**:
  - `PipelineView.jsx:49`/`:64` — `wsFetch` → check `!res.ok` + `catch`; success `notify('Draft approved','info')` on approve.
  - `TemplateSelector.jsx:40` — `!res.ok` + `catch`.
  - `DocsView.jsx:273` — currently empty `catch`; add `catch` notify **and** the existing `if(res.ok){…}` gets an `else` notify.
  - `OpenLoopsPanel.jsx:211` — resolve handler `catch` + (if the callback returns an error shape) error-return.
  - `ItemDetailPanel.jsx:772/:775` — kill: `data.error` (non-ok) + `catch` both notify (already branches on `response.ok`).
  - `App.jsx:702` — stop-agent `catch`; check `!res.ok` too.
- [ ] Native → hooks: `DesignView.jsx:93` (prompt, required), `OpenLoopsPanel.jsx:209` (prompt, optional — keep "null = cancel" semantics), `ItemDetailPanel.jsx:791` (confirm, destructive), `SettingsPanel.jsx:89` (confirm, destructive).
- [ ] **Test** (`test/ui/cockpit-feedback.test.jsx`, new, table-driven): for each site, **both** a rejected fetch (transport) **and** a `{ok:false}`/`{error}` response fire a `compose:notify` `level:'error'` window event (assert the user-visible event, not console). Dialog sites: confirm/prompt resolution drives the action; cancel is a no-op.

## Task 3 — COCKPIT-6: gate-kill guardrail *(needs 0b)*
File: `src/components/vision/DashboardView.jsx` (existing)
- [ ] `:203` Kill `onClick` → `async () => { const reason = await confirmWithReason({title:'Kill this gate?', destructive:true}); if (reason) onResolveGate(gate.id,'killed',reason); }`.
- [ ] No store/endpoint change (`resolveGate` already accepts comment).
- [ ] **Test** (`test/ui/dashboard-kill-guardrail.test.jsx`, new): dashboard Kill opens reason modal; empty reason blocked; reason → `onResolveGate(id,'killed',reason)`.

---

## Phase 7 exit criteria (all four)
- [ ] **Tasks executed** — all new tests pass under **`npm test`** (chains `node --test` → `vitest run` (`test:ui`) → `test:tracker`); no regressions. New `test/ui/*.test.jsx` confirmed picked up by Vitest (not silently skipped).
- [ ] **E2E smoke** — dev server up; Playwright: dashboard gate-kill-with-reason flow; pressure-test failure → error toast.
- [ ] **Review loop** — Codex review of the diff → REVIEW CLEAN.
- [ ] **Coverage sweep** — edge/error/integration tests → TESTS PASSING.

## Notes / constraints
- Do **not** grow `App.jsx` (1331), `ItemDetailPanel.jsx` (805), `DocsView.jsx` (558) — the promise-based hook API keeps edits to ~1–2 lines; no modal JSX into these files.
- No contract/schema changes (UI-only + one new lib helper). No server changes.
- Slice B {COCKPIT-4,5,3} is a separate build (deferred per gate decision).
