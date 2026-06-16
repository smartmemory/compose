# COMP-PARITY-1 — CLI gate resolution

**Status:** DESIGN
**Date:** 2026-06-16
**Phase:** COMP-PARITY: UI↔CLI Parity (ships first — unblocks headless/CI)

## Problem

Gate resolution is **UI-only** today. The cockpit's `GateView.jsx` POSTs to
`POST /api/vision/gates/:id/resolve`, but there is no CLI equivalent — so a headless or
CI-driven build **cannot clear a gate**, making the cockpit a hard dependency for any gated
pipeline. The existing `compose gates report` reads the local audit log; it does not list
*pending* gates or resolve them.

## Goal

Two CLI verbs wrapping existing server endpoints (no new server code, no new lifecycle model):

- `compose gate list [--item <id>] [--status pending|all|resolved] [--format text|json]`
  → `GET /api/vision/gates` (`?status=`, `?itemId=`).
- `compose gate resolve <gateId> (--approve | --revise | --kill) [--comment <text>] [--reason <text>]`
  → `POST /api/vision/gates/:id/resolve` with `{ outcome, comment, resolvedBy: 'cli' }`.

## Approach (verified against current code)

**Extend the existing `gates` block** in `bin/compose.js` (currently only `report`), rather
than add a separate command. Accept **both `gate` and `gates`** as the command verb (alias) —
the roadmap row specifies the singular `gate list` / `gate resolve`, while the shipped command
is plural `gates report`; aliasing honors both and avoids a confusing `gate` vs `gates` split.
After this, all of these work: `gate list`, `gates list`, `gate resolve …`, `gates resolve …`,
`gates report` (unchanged).

**HTTP:** reuse the `compose loops` pattern (`bin/compose.js:2954+`) — `httpGet`/`httpPost`
against `baseUrl = COMPOSE_URL || http://127.0.0.1:${resolvePort()}`, attaching
`X-Compose-Workspace-Id` when resolvable. The resolve endpoint is wrapped in `guardAuth`, which
is a **no-op unless `capabilities.guardAuth === true`** (opt-in, COMP-MCP-ENFORCE Slice 4); send
the sensitive-token header when `COMPOSE_API_TOKEN` is set so the command also works on
guard-enabled installs, and degrade with a clear 401/403 message otherwise.

**Server contract (already exists — `server/vision-routes.js`):**
- `GET /api/vision/gates` → `{ gates: [...] }`; `?status=all|resolved`, else pending; `?itemId=`.
- `POST /api/vision/gates/:id/resolve` → body `{ outcome, comment, resolvedBy }`;
  `outcome ∈ {approve, revise, kill}` (normalizes legacy approved/killed/revised);
  400 missing/invalid outcome, 404 gate-not-found, lazy-expiry on stale pending gates.

## Decisions

1. **`gate` ≡ `gates` alias; `list`/`resolve` added beside `report`.** Strictly additive;
   `gates report` untouched.
2. **`--approve|--revise|--kill` → `outcome`.** Exactly one required; error if zero or multiple.
3. **`--comment` and `--reason` are synonyms** → the endpoint's single `comment` field
   (the row writes both; the server has only `comment`). If both given, `--comment` wins.
4. **`resolvedBy: 'cli'`** so audit entries distinguish CLI from cockpit resolutions.
5. **`list` default status = pending** (the "what needs clearing" case); `--status all|resolved`
   for the rest. `--format text` (table) default, `--format json` for scripting/CI.
6. **No server changes.** Pure client wrapper over endpoints the cockpit already uses.

## Errors (degrade clearly)
- Server down → `ECONNREFUSED` → "compose server not reachable on :PORT — start it with `npm run dev:server`".
- `resolve` missing/duplicate outcome flag → usage error, exit 1.
- 404 gate not found / 400 invalid outcome / 401-403 (guardAuth on, no token) → surface server message, exit 1.

## Out of scope
- Listing/resolving Stratum flow-step gates (`/api/stratum/gates/...`) — separate surface.
- Interactive TUI gate panel (COMP-TUI-2, already shipped for the build-loop path).
- Creating gates from the CLI (`POST /api/vision/gates` exists for dual-dispatch; not exposed here).

## Test plan
- `test/cli-gate.test.js`: spin a minimal Express stub exposing `GET /api/vision/gates` +
  `POST /api/vision/gates/:id/resolve`, point `COMPOSE_URL` at it, and assert:
  list (pending/all/json), resolve approve/revise/kill (correct body + outcome), exactly-one-outcome
  enforcement, gate-not-found (404) surfaced, server-down (ECONNREFUSED) message.
