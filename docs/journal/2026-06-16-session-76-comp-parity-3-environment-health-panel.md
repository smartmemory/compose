---
date: 2026-06-16
session_number: 76
slug: comp-parity-3-environment-health-panel
summary: "COMP-PARITY-3: cockpit environment-health panel (read-only /api/environment-health + header dot) surfacing compose doctor + hooks status; CLI logic extracted to a shared single-source module."
feature_code: COMP-PARITY-3
closing_line: The dot is small; the discipline that put it there — gate-review every artifact, prove the CLI byte-identical, and don't let a flaky suite write a false bug report — is the point.
---

# Session 76 — COMP-PARITY-3

**Date:** 2026-06-16
**Feature:** `COMP-PARITY-3`

## What happened

We ran COMP-PARITY-3 through the full /compose build lifecycle to close the last operational-health UI↔CLI parity gap: `compose doctor` (dep + version drift) and `compose hooks status` (git-hook drift) were CLI-only, so cockpit-first devs saw silent drift only as a mystery build failure. We chose a header health-dot + popover (user pick) backed by a thin read-only endpoint. Three Codex gate passes did real work: the design gate caught that `/api/health` is allowlist *prefix*-matched (auth-middleware.js:180-189), so a nested `/api/health/environment` would bypass remote auth and leak local dep inventory — we moved to a non-allowlisted `/api/environment-health`. It also caught a null/fallback workspace-id masking stale hooks as 'current', and an in-app project-switch refetch gap. The blueprint gate caught that our proposed test paths (`lib/*.test.js`, `test/e2e/*.spec.js`, Playwright) were dead under the repo's actual runners (no Playwright exists). The implementation gate caught a `scannedPaths` host-path leak and an unguarded async race. Every finding was fixed before moving on.

## What we built

`lib/hooks-status.js` (new) — extracted the inline `statusOne` into a pure `computeHooksStatus()` + `HOOK_MARKERS` + `formatHookStatusLines()`, the single source consumed by both the CLI and the API. `bin/compose.js` — `hooks status` now delegates; output is byte-identical (proved against a captured baseline + a CLI golden test). `server/health-routes.js` (new) — `GET /api/environment-health` with `rollupSummary` + `hookRawToApi`; degrade-never-500, strips scannedPaths, reads deps/version off PACKAGE_ROOT and hooks off req.workspace. `server/vision-server.js` — wired `attachHealthRoutes`. `src/components/cockpit/EnvironmentHealthPanel.jsx` (new) — header dot + popover, fetch on workspace resolve + on {id,root} change + manual ↻, monotonic request guard. `src/App.jsx` — mounted it. Tests: hooks-status unit, CLI golden, health-routes unit, real-endpoint integration, UI panel.

## What we learned

1. Allowlist semantics are a security contract: a new route's *path prefix* can silently inherit auth-exempt status — check the matcher, not just the literal collision. 2. To keep a CLI byte-identical while a new consumer needs richer data, return *raw facts* from the shared function and let each consumer format/derive (CLI prints lenient 'current'; API derives 'workspace-unverified' from the same `wsVerified` flag). 3. A proposed test is a dead deliverable unless it lands where the repo's runners actually look — verify `package.json`/vitest include globs before writing test paths. 4. A flaky parallel suite can manufacture a false regression: a full Vitest run reported 79 failures in mobile/remote-auth tests; isolating the variables (same files pass in isolation with AND without the change; clean full run is green; re-run with the change is green) proved it a pre-existing parallel-execution flake, not our bug — don't accept the first red run as truth.

## Open threads

- [ ] Not pushed yet — on main locally (commits 70725ba..7d72b25); push needs the :4001 server stopped first (pre-push npm test port conflict).
- [ ] No stratum flow bound (lifecycle run manually; no flow_id for stratum_audit/bind).
- [ ] Follow-up candidates (deliberate non-goals): UI remediation actions (install dep / re-run hooks install) and a mobile-surface health indicator.
- [ ] The mobile/remote-auth Vitest flake under full-suite parallelism is worth a separate hardening ticket.

---

*The dot is small; the discipline that put it there — gate-review every artifact, prove the CLI byte-identical, and don't let a flaky suite write a false bug report — is the point.*
