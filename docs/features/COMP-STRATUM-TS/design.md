# COMP-STRATUM-TS — Flag-gated cutover to the TS stratum engine

**Status:** DESIGN → IN_PROGRESS
**Date:** 2026-07-10
**Owner feature:** STRAT-TS-PORT P7 (stratum repo)

## Related Documents

- Upstream design: `/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-TS-PORT/design.md` (P7 section + acceptance record)
- Compose seam under change: `server/stratum-client.js`, `server/stratum-api.js`, `server/stratum-sync.js`, `server/lifecycle-guard.js`
- ROADMAP row: COMP-STRATUM-TS (Phase 7: Stratum TS Cutover)

---

## Problem

STRAT-TS-PORT shipped a complete standalone TS engine (P0–P6 + live
acceptance passed, stratum 1109bda / 0.2.88). Compose still integrates
exclusively with the Python `stratum-mcp`, which forces every compose user to
carry a Python 3.11+ runtime — the packaging problem the port exists to
solve. P7 is the compose-side cutover, flag-gated with a soak week before the
default flips.

## Goal

Compose can run its stratum integration against either engine, selected by a
capability flag, with zero behavior change for existing workspaces
(default stays python). Non-goals for v1: porting STRAT-GUARD, migrating
agent-side spec authoring (v0 → v1), cross-engine state migration.

## Scoping results (2026-07-10, grep-verified)

The upstream design's P7 risk note required discovering compose's *used*
stratum subset before starting. Findings:

1. **`server/stratum-client.js` is the ONLY module that spawns stratum** (its
   own contract line, verified by grep). Everything server-side flows through
   it:
   - Query CLI: `stratum-mcp query flows | flow <id> | gates`
   - Gate CLI: `stratum-mcp gate approve|reject|revise <flowId> <stepId>
     [--note] [--resolved-by]`
   - Guard CLI (STRAT-GUARD, used by `lifecycle-guard.js`):
     `stratum-mcp guard register|transition|override|history` with JSON
     kwargs on stdin
   - Exit-code contract: 0 → JSON result; 2 → conflict (idempotency);
     nonzero → error; stderr never forwarded
2. **In-session execution model**: agents call the Python stratum MCP
   server's tools (`stratum_plan`/`stratum_step_done`/`stratum_audit`/
   `stratum_agent_run`/`stratum_gate_resolve`, plus `stratum_guard_override`
   referenced in vision-routes prose). Registered via Claude Code mcp.json —
   config, not compose server code.
3. **`capabilities.stratum`** already exists in `.compose/compose.json`
   (stratum optional; flat prompt chains when absent).
4. `server/agent-mcp.js` is a retirement shim (fail-fast pointer) — no
   cutover work.

---

## Decision 1: v1 scope — monitor seam only (ship-narrow-first)

**Cut over (flag-gated):** the flow/gate monitor seam. `stratum-client.js`
gains engine-selectable dispatch — Python `stratum-mcp` CLI (today's
behavior, default) or the TS engine's `stratum` CLI.

**Engine-repo prerequisite (stratum repo):** the TS CLI has no `query`/`gate`
commands yet. Add `stratum query flows|flow|gates` and `stratum gate
approve|reject|revise` matching the exit-code contract above. `reject` maps
to the TS engine's `kill` decision.

**Keep on Python (explicitly out of v1):**
- The guard subsystem. STRAT-GUARD was never part of the TS port; `guard*`
  functions in stratum-client continue to spawn Python `stratum-mcp`
  regardless of the engine flag. `lifecycle-guard.js` is untouched.
- The in-session execution model registration. Agents authoring v0 specs
  against the Python MCP server keep working; switching agent-side authoring
  to v1 specs + the TS stdio server is the post-soak follow-up
  (COMP-STRATUM-TS-2), because it changes what agents write, not just what
  compose spawns.

## Decision 2: flag shape

`.compose/compose.json`:

```json
{ "capabilities": { "stratum": true, "stratumEngine": "python" } }
```

- `stratumEngine: "python" | "ts"`, default `"python"` when absent (zero
  behavior change for existing workspaces).
- Env override `COMPOSE_STRATUM_ENGINE` wins over config (matches the
  COMPOSE_STRATUM_POLL_MS precedent) — lets the soak run flip a single dev
  environment without editing config.
- Unknown values fail loudly at resolution time, never silently fall back.
- The TS binary resolves as `stratum` on PATH, overridable via
  `COMPOSE_STRATUM_TS_BIN` (the TS bins are source-only Node >=22.7; a path
  override avoids PATH juggling during soak).

## Decision 3: response-shape mapping lives in the TS CLI

Python `query flow` returns FlowState; the TS engine persists a different
run-state shape. The TS `query`/`gate` CLI emits the Python-compatible
projection (flow id, status, pending gates with step ids) so
`stratum-api.js` and `stratum-sync.js` need no shape branches — the mapping
lives in ONE place (the TS CLI), not scattered through compose. Divergences
that cannot map are omitted, never fabricated.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `stratum/ts/src/cli/stratum.ts` (existing, stratum repo) | modify | add `query` + `gate` subcommands with Python-compatible output/exit codes |
| `stratum/ts/tests/cli/query_gate.test.ts` (new, stratum repo) | add | contract tests for both subcommands incl. exit 2 conflict |
| `server/stratum-client.js` (existing) | modify | engine resolution (capability + env), TS arg/bin dispatch, guard pinned to python |
| `server/stratum-client.test.js` or existing suite (existing) | modify | table-driven engine coverage |
| `.compose/compose.json` (existing) | modify | `stratumEngine` capability (forge workspace flips during soak only) |
| `docs/features/COMP-STRATUM-TS/design.md` (this file) | modify | record live-flow verification + soak outcome |

## Acceptance criteria

- [x] TS CLI: `stratum query flows|flow|gates` + `stratum gate
      approve|reject|revise` shipped in the stratum repo, exit-code contract
      identical to Python (0/2/nonzero), covered by tests
      — stratum `32a36b4` (0.2.90), 5-round adversarial review → CLEAN
- [x] `stratum-client.js`: engine selection via capability + env override;
      default python; unknown engine fails loudly; guard* always python
      — plus spawn-failure surfacing (SPAWN → 503) and an
      engine-aware startup probe in server/index.js; 4-round review → CLEAN
- [x] Both engines pass the stratum-client/stratum-api test suites
      (python: existing suite; ts: engine-selection + SPAWN + config
      precedence cases, 21 client tests; full suite 4620+ green)
- [x] Monitor UI drives a live TS-engine flow end to end (bind → poll → gate
      approve from the UI) at least once, recorded in this doc
      — **Recorded 2026-07-11** (twice, second run against the committed
      stratum CLI 32a36b4): compose server started with
      `COMPOSE_STRATUM_ENGINE=ts` + `COMPOSE_STRATUM_TS_BIN` → GET
      `/api/stratum/flows` returned the TS-engine flow as `awaiting_gate`
      with `current_step_id: review`; POST
      `/api/stratum/gates/<id>/review/approve` → `ok:true, result:
      "execute_step"`; double-approve → `{conflict:true, detail:"Expected
      gate step 'finish', got 'review'"}` at HTTP 409; `/gates` emptied and
      the flow advanced to `finish`. These routes are exactly what the
      monitor UI calls.
- [ ] Soak: default stays `python`; flip condition = one week of TS-engine
      use in the forge workspace with no client-visible defects
- [x] Post-flip follow-ups filed: COMP-STRATUM-TS-2 (execution-model/agent
      authoring cutover to v1 specs + TS stdio server), PyPI deprecation
      notes (stratum repo, after BOTH cutovers)
      — COMP-STRATUM-TS-2 filed PLANNED 2026-07-11 (PyPI notes carried in
      its description; they land after both cutovers)

## Open Questions

- None blocking v1. The `stratum-mcp` bin-name collision (TS package ships a
  `stratum-mcp` bin too) never bites v1 because the client only invokes the
  TS engine via the `stratum` bin / COMPOSE_STRATUM_TS_BIN — but
  COMP-STRATUM-TS-2's `compose init` registration must confront it.

## Honest caveats

- Python and TS state stores are separate (`~/.stratum/flows/` vs the TS
  stateRoot). During soak, flows started on one engine are invisible to the
  other — the monitor shows the selected engine's flows only. By design
  (clean break, no cross-engine state migration).
