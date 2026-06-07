# COMP-COCKPIT Slice A — Implementation Report

**Scope shipped:** Slice A = {COCKPIT-2, COCKPIT-1, COCKPIT-6}. Slice B {COCKPIT-4, COCKPIT-5, COCKPIT-3} deferred to a follow-up build.
**Date:** 2026-06-07
**Branch/commits:** on `main` (`0371121`, `2472758`, plus reentrancy fix).

## 1. Summary
Closed the three correctness/foundation gaps from the 2026-06-07 cockpit UX sweep: hostname portability for the pressure-test feature, visible feedback on previously-silent actions (plus replacing blocking native dialogs), and a consistent gate-kill guardrail. Built the two shared primitives the rest of the umbrella reuses.

## 2. Delivered vs Planned
| Planned | Status |
|---|---|
| Task 0a `agentServerUrl` helper + `defaultAgentStreamUrl` refactor | ✅ |
| Task 0b `DialogProvider` (promise-based `useConfirm`/`usePrompt`/`useConfirmWithReason`) + app-root mount | ✅ |
| COCKPIT-2 ChallengeModal portability (relative 4001, agentServerUrl 4002, error toasts) | ✅ |
| COCKPIT-1 notify on 6 silent sites (both transport + non-ok) + success echoes | ✅ |
| COCKPIT-1 replace 4 native dialogs with hooks | ✅ |
| COCKPIT-6 dashboard kill → confirm-with-reason | ✅ |

## 3. Key Implementation Decisions
1. **Promise-based imperative dialog API** (`await confirm({...})`) rather than per-site modal JSX — keeps call sites ~1 line and avoids growing the oversized files (`App.jsx` 1331, `ItemDetailPanel` 805, `DocsView` 558).
2. **Both transport and server failures notify** (Codex plan finding F1): `wsFetch` returns non-ok without throwing, so each site checks `!res.ok` in addition to `catch`.
3. **Poll loops stay one-shot/quiet** (F2): only user-initiated calls toast; the ChallengeModal 1.5s status poll does not.
4. **`agentServerUrl` reuses the existing convention** (`VITE_AGENT_PORT`, page hostname) instead of inventing a config source; 4001 calls became relative because Vite proxies `/api`→4001 and prod is same-origin (verified Phase 5).
5. **DialogProvider degrades to native dialogs when unmounted** — keeps consumer tests decoupled from the provider; production always mounts it (`main.jsx`).
6. **Reentrancy guard** (Codex impl finding): a second `open()` settles the prior caller with its cancel value before replacing the resolver — no stranded promises.

## 4. Architecture Deviations
- The sweep assumed "no general toast system on desktop" — **stale**: `NotificationBar.notify()` already exists and is the target. No new toast infra built.
- COCKPIT-2 found `/api/terminal/inject` (4002) has **no handler in this repo's `server/`** (separate workspace-agent server, `// TODO COMP-WORKSPACE-AGENT-SVR`). Portability fix applied regardless; endpoint liveness is pre-existing and out of scope.

## 5. Test Coverage (16 new tests, all Vitest `test/ui/`)
- `agent-server.test.jsx` (3) — URL build, no-localhost, `VITE_AGENT_PORT`.
- `dialog-provider.test.jsx` (5) — confirm/prompt/required/confirmWithReason/reentrancy.
- `challenge-modal-host.test.jsx` (2) — relative spawn URL, error toast on non-ok.
- `cockpit-feedback.test.jsx` (3) — notify on non-ok + transport + success.
- `dashboard-kill-guardrail.test.jsx` (2) — reason required/blocked, cancel is a no-op.
Full suite: **UI 161 passed, tracker 100 passed**; `npm run build` OK; Codex review **CLEAN**.

## 6. Files Changed
New: `src/lib/agentServer.js`, `src/components/ui/DialogProvider.jsx`, 5 `test/ui/*.test.jsx`.
Modified: `src/lib/agentStream.js`, `src/main.jsx`, `src/App.jsx`, `src/components/vision/{ChallengeModal,DashboardView,DesignView,DocsView,ItemDetailPanel,OpenLoopsPanel,PipelineView,SettingsPanel}.jsx`.

## 7. Known Issues & Tech Debt
- **E2E smoke not run** — Phase 7 step 2 (Playwright against a live dev server) was not executed to avoid auto-starting servers; component tests + build cover the behavior. Recommend a manual E2E pass before relying on the gate-kill / pressure-test flows in production.
- `/api/terminal/inject` (4002) endpoint liveness unresolved (pre-existing) — tracked by `COMP-WORKSPACE-AGENT-SVR`.
- Touched files `App.jsx`/`ItemDetailPanel.jsx`/`DocsView.jsx` remain >400 lines (not grown by this work; refactor is separate).

## 8. Lessons Learned
- Verify-before-build caught a sibling stale row (`COMP-ROADMAP-GRAPH-1`) and a phantom agent dependency (`COMP-AGENT-VENDOR-1`) this session — the sweep's line refs were accurate but two of its *assumptions* (toast system absent, create-feature path exists) were not; the Codex design+plan passes caught both before code.
- A promise-based dialog context is the clean bridge from synchronous `window.confirm`/`prompt` to React modals.
