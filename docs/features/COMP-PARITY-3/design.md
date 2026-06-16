# COMP-PARITY-3 — Cockpit Environment-Health Panel

**Status:** Phase 1 (Design) — gate pending
**Feature:** COMP-PARITY-3 (umbrella: COMP-PARITY — UI↔CLI Parity)
**Type:** Internal / cockpit UI + thin read-only API
**Date:** 2026-06-16

## Related Documents
- Parity initiative: `/Users/ruze/reg/my/forge/compose/docs/ui-cli-parity.md` (rows 22, 68, 74, 243)
- Umbrella feature: COMP-PARITY
- Sibling shipped: COMP-PARITY-1 (gate resolution CLI parity, COMPLETE)

## Problem

`compose doctor` (external-dep presence + version drift) and `compose hooks status` (git-hook drift: absent / foreign / stale) are **CLI-only operational-health signals**. A UI-first developer driving Compose from the cockpit gets **zero signal** when:

- A required external skill/binary dependency is missing or a Compose version is behind.
- A git hook is absent, foreign (overwritten by another tool), or stale (baked `COMPOSE_NODE`/`COMPOSE_BIN`/`COMPOSE_WORKSPACE_ID` no longer match the environment).

Silent hook and version drift currently surfaces only as **mystery build failures** — the build breaks, and nothing in the cockpit explains why. The parity doc filed this as the highest-value remaining operational-health gap (`docs/ui-cli-parity.md` §Recommendations #3).

## Goal

Surface the existing `doctor` + `hooks status` data in the cockpit as a **read-only** panel, so drift is visible *before* it causes a failed build — without duplicating any logic. Concretely:

- A thin `GET /api/environment-health` endpoint that wraps the **existing** dep/version/hook logic and returns structured JSON.
- A header **health dot** (green / amber / red) that is always visible and reflects worst-case status, directly killing the "zero UI signal" problem.
- A click-to-open **popover** showing dependency status (skills + binaries), version drift, and per-hook status with the same states the CLI reports.

### Non-Goals
- No remediation actions from the UI (no "install dep" / "re-run hooks install" buttons). Read-only only — mutations stay in the CLI. (A future fast-follow could add actions; explicitly out of scope here.)
- No mobile surface (`src/mobile/`). Environment health is a cockpit-operator concern; mobile is for field status checks. Out of scope, notable for a future ticket.
- No change to CLI behavior or output. The CLI remains the source of truth; the panel is a second consumer of the same logic.

## What Exists Today (reuse map)

Confirmed by codebase reconnaissance:

| Concern | Source | Reuse |
|---|---|---|
| Load dep manifest | `lib/deps.js` `loadDeps(packageRoot)` | Import directly (pure) |
| Skill dep presence | `lib/deps.js` `checkExternalSkills(deps)` → `buildDepReport(result)` | Import directly (pure data-builder) |
| Binary presence | `lib/deps.js` `checkExternalBinaries(deps)` → `buildBinaryReport(result)` | Import directly (probe uses `spawnSync`, 3s cap) |
| Version drift | `lib/version-check.js` `checkLatestVersion(current, {force})` | Import directly (async, 24h disk cache, 3s network timeout, never throws → null) |
| Hook status | **inline** in `bin/compose.js` `statusOne(type)` (~L1697–1734) + `HOOK_TYPES` table | **Needs extraction** into a pure `computeHooksStatus(...)` returning data, consumed by both CLI and API |

The dep/version helpers are already pure and return JSON-serializable shapes. The **only** new shared logic is extracting the hook-status computation out of the CLI's print-and-exit closure into a reusable function — the CLI printer then consumes the same function (no behavior change, no logic fork).

## Key Decisions

1. **Endpoint path `/api/environment-health` — deliberately NOT under `/api/health/*`.** A liveness probe already lives at `GET /api/health` (`server/index.js:150`, returns `{ok, remote}`). It is in the **remote auth allowlist** (`server/index.js:98`), and the gate registers every allowlist entry as both an exact path **and a prefix** (`auth-middleware.js:180-189`: `path.startsWith(p + '/')`). So a nested `/api/health/environment` would be **publicly reachable in remote mode** — exposing the local dependency/plugin inventory and git-hook state, and permitting unauthenticated `?refresh=1` npm-registry fetches. That is unacceptable for this data. The endpoint therefore lives at a **non-allowlisted** path (`/api/environment-health`), so in remote mode it falls under default-deny and requires a sensitive token or paired-device JWT (same posture as vision read routes); in localhost mode the gate is off and it's open like everything else. Registered via a new `server/health-routes.js` (`attachHealthRoutes(app, deps)`), wired in `vision-server.js` alongside the other route factories. The existing `/api/health` probe is left untouched.

2. **Reuse, don't reimplement — extract the one non-pure piece.** `computeHooksStatus({projectRoot, expectedWsId, composeNode, composeBin})` is extracted to a shared module (likely `lib/hooks-status.js`). The CLI `statusOne` printer is refactored to call it and print, so CLI output is byte-identical. This is the project rule "writers don't fork detection logic" applied here.

3. **Workspace identity comes from `req.workspace`, not a re-resolve (hard constraint).** Because the route is non-exempt, the workspace middleware (`server/workspace-middleware.js`) attaches a resolved per-request workspace (or an explicit fallback) to every request. The endpoint consumes `req.workspace.id` (the `expectedWsId` for hook comparison) and `req.workspace.root` (the `.git` location for hook files). It must **not** call `resolveWorkspace({cwd})` again from a derived project root — re-resolving would reintroduce project-switch ambiguity and could report hook status for the wrong workspace. This is settled, not an open question.

   **Null-id must NOT masquerade as "current."** When no workspace header is sent, the middleware falls back to `{id: null, root: getTargetRoot()}` (`workspace-middleware.js:54`). The CLI's current hook logic treats a null `expectedWsId` leniently — it sets `wsMatch = true` and can report a stale hook as "current" (`bin/compose.js:1718-1720`). For the panel that would silently hide drift — the exact failure this feature exists to prevent. So `computeHooksStatus` must distinguish the two: when `expectedWsId` is null, the workspace dimension of an installed hook is reported as **`workspace-unverified`** (rendered "workspace check unavailable"), never "current". The node/bin path checks still run. Belt-and-suspenders on the client side: the panel delays its initial fetch until `WorkspaceContext` has resolved (it already gates other fetches this way), so in steady state `req.workspace.id` is populated and the unverified path is only hit transiently. To keep the extracted function a true single source of truth, the CLI consumes the same `workspace-unverified` signal (it can keep printing the legacy lenient line, but the returned datum is honest).

4. **Header dot + popover** (user-selected). The dot is the passive signal; the popover is the detail. Severity rollup (worst-wins), aligned with current CLI semantics:
   - **red (error):** any *required* dep/binary missing, OR any hook `foreign` (a non-Compose hook is installed — something hijacked it).
   - **amber (warn):** Compose version `behind`, OR any hook `stale` for *any* reason — including `MISSING_WORKSPACE_ID`. The CLI treats a legacy raw-token hook as degraded back-compat (it warns and proceeds, `bin/compose.js`), so `MISSING_WORKSPACE_ID` is install-drift, not a hard failure — it rolls up amber, not red. Also amber: an *optional* dep/binary missing.
   - **neutral/info:** hook `absent`. Not having Compose hooks installed is a legitimate state (many repos don't use them) and must not force the dot red.
   - **green:** everything present, current, up to date.

   **Full state → summary mapping (every state pinned, worst-wins):**

   | Signal | State | Contributes |
   |---|---|---|
   | dep/binary | missing & required | `error` |
   | dep/binary | missing & optional | `warn` |
   | dep/binary | present | `ok` |
   | dep/binary section | `unavailable` (manifest unreadable) | `warn` (render "unavailable"; never `error` — it's endpoint degradation, not drift) |
   | version | `behind` | `warn` |
   | version | up to date | `ok` |
   | version | `null`/`unavailable` (registry/offline) | `ok` (neutral — render "unavailable"; offline is not ill health) |
   | hook | `foreign` | `error` |
   | hook | `installed-stale` (any reason incl. `MISSING_WORKSPACE_ID`) | `warn` |
   | hook | `workspace-unverified` | `warn` (we cannot confirm correctness → honest amber, not false green) |
   | hook | `absent` | `ok` (neutral) |
   | hook | `installed-current` | `ok` |

   The endpoint computes `summary = error if any error else warn if any warn else ok`, and returns it alongside the per-section detail so the client never re-derives it. The dot maps `error→red`, `warn→amber`, `ok→green`.

5. **Fetch on load + on workspace change + manual refresh** (user-selected cadence; "on load" extended to cover in-app switching). One `wsFetch('/api/environment-health')` after `WorkspaceContext` has resolved (see Decision 3 — avoids the transient null-id window). The cockpit switches projects **in place** without a reload (`handleProjectSwitch`, `src/App.jsx:550`; the header persists across the switch, `src/App.jsx:1076`), and hook status is workspace-root-specific — so the panel must **re-fetch whenever the resolved workspace/project id changes**, keyed on that id, or it would keep showing the previous project's hook state. A ↻ button re-fetches with `?refresh=1` to force a fresh version check. No background polling beyond the workspace-change trigger. Version drift is cache-backed (24h), so each fetch is cheap and the network call is bounded/non-blocking (returns `null` offline).

6. **Non-blocking, degrade-never-fail endpoint.** Each sub-check is independently wrapped; a failure in one (e.g. version registry unreachable) returns a `null`/`unavailable` marker for that section, never a 500. The panel renders "unavailable" for that section and stays useful.

## Approaches Considered

- **A — Shell out to `compose doctor --json` + `compose hooks status` from the endpoint.** Rejected: spawns a Node subprocess per request, slower, brittle (PATH/cwd), and `hooks status` has no `--json` mode so we'd parse human text. The pure-import path is faster and contract-stable.
- **B — Import pure helpers + extract `computeHooksStatus` (chosen).** Endpoint imports `lib/deps.js`, `lib/version-check.js`, and the extracted hook-status module. No subprocess, structured data, CLI and API share one code path. Small refactor cost (extracting one inline function) buys a single source of truth.
- **C — Compute everything client-side.** Rejected: the browser can't read the filesystem / `.git/hooks` / npm registry. Must be server-side.

Approach **B** is the design.

## Shape of the API response (illustrative — finalized in blueprint)

```jsonc
{
  "ok": true,
  "summary": "warn",            // "ok" | "warn" | "error" — drives the header dot
  "dependencies": {             // from buildDepReport(checkExternalSkills(deps))
    "present": [ { "id": "superpowers:test-driven-development", "optional": false } ],
    "missing": [ { "id": "refactor", "optional": false, "install": "...", "fallback": "..." } ]
  },
  "binaries": {                 // from buildBinaryReport(checkExternalBinaries(deps))
    "present": [ { "id": "rtk", "optional": true } ],
    "missing": []
  },
  "version": {                  // from checkLatestVersion(current); null if unavailable
    "current": "0.2.1", "latest": "0.3.0", "behind": true, "source": "cache"
  },
  "hooks": {                    // from computeHooksStatus(...)
    "post-commit": { "state": "installed-current", "workspace": "ws_abc" },
    "pre-push":    { "state": "installed-stale", "reason": "STALE_WORKSPACE_ID", "expected": { "workspaceId": "ws_abc" } }
  }
}
```

## Roots — which check keys off which root (settled)

The two root concepts must not be conflated (this is about the *compose install* vs *the workspace*):

- **Deps + version → `PACKAGE_ROOT` / homedir.** `loadDeps(PACKAGE_ROOT)` reads the installed compose package's `.compose-deps.json`; `checkExternalSkills` scans `~/.claude/...`; `checkLatestVersion` reads `PACKAGE_ROOT/package.json` and a homedir version cache + npm registry (`bin/compose.js:304`, `lib/version-check.js`). **None of these depend on the workspace root** — the endpoint must not couple version/dep state to `req.workspace.root`.
- **Hooks → the workspace root.** `computeHooksStatus` reads `<req.workspace.root>/.git/hooks/*` and compares baked values against `req.workspace.id`, `process.execPath`, and the resolved `compose.js` path.

## Gate Checkpoint — Unproven Assumptions (carry to Phase 4/5)

- **`checkLatestVersion` server-safety.** Async + 3s network timeout + 24h cache + never-throws is reported; blueprint confirms it won't block the event loop unacceptably and that the offline `null` path renders cleanly. Default to cache-only on the on-load fetch; only `?refresh=1` may force network.
- **`req.workspace` shape on a non-exempt GET.** Confirm the middleware attaches `{id, root}` for `/api/environment-health` (a non-allowlisted, non-exempt path) and what the `id` is when no workspace header is sent (fallback/boot). Blueprint pins the exact field reads.
- **`composeBin` resolution server-side.** The CLI derives `composeBin` from `import.meta.url` of `bin/compose.js`. The server is a different entrypoint; blueprint pins how the endpoint resolves the canonical `compose.js` path so the hook-staleness comparison matches what `compose hooks install` bakes.

No external spikes required — all dependencies are in-repo and already shipping.

## Acceptance Criteria (carried into plan)

- [ ] `GET /api/environment-health` returns the structured shape above; never 500s on a sub-check failure (degrades to `null`/`unavailable`).
- [ ] The endpoint is NOT in the remote auth allowlist (requires sensitive token / paired JWT in remote mode); the `/api/health` liveness probe is unchanged.
- [ ] Hook-status logic extracted to a shared module; CLI `compose hooks status` output is byte-identical to before.
- [ ] Header health dot renders green/amber/red from `summary`; visible without opening anything.
- [ ] Popover lists missing/present deps + binaries, version drift, and per-hook state with reasons.
- [ ] A null/fallback `req.workspace.id` yields `workspace-unverified` for installed hooks (never a false "current"); the panel delays its initial fetch until `WorkspaceContext` resolves.
- [ ] Fetch on load + on resolved-workspace-id change + manual ↻ refresh (forces fresh version check); no background polling.
- [ ] Summary rollup matches the pinned state→summary table (e.g. offline version → green, `workspace-unverified` → amber, `absent` hook → green, missing required dep → red).
- [ ] `data-testid`s: `env-health-dot`, `env-health-panel`, `env-health-dependency-<id>`, `env-health-version`, `env-health-hook-<type>`, `env-health-refresh`.
- [ ] Mobile surface untouched.
