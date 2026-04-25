# Session 26 — COMP-OBS-GATELOG + COMP-OBS-LOOPS

**Date:** 2026-04-25
**Previous:** [Session 25 — COMP-OBS-STATUS](2026-04-25-session-25-comp-obs-status.md)

## What happened

The ask was to ship COMP-OBS-GATELOG and COMP-OBS-LOOPS together in one combined commit because they share modifications to `status-snapshot.js`. Both features were REVIEW CLEAN with verified blueprints, so this was a straight execute session.

We worked through both features in order: GATELOG server + CLI + tests, then LOOPS server + UI panel + CLI + tests, then updated the shared `status-snapshot.js`, then extended the wave-6 compliance and integration suites.

The main interesting problem was that `gate-log-store.js` initially used a module-level constant `GATE_LOG_PATH` that couldn't be overridden by tests without a module cache bust. We fixed this by making `getGateLogPath()` read `process.env.COMPOSE_GATE_LOG` dynamically at call time, so tests can set the env var in `beforeEach` and get an isolated log file.

The CLI `loops` command initially used `spawnSync` in tests, which blocks Node's event loop and caused 15-second timeouts for every test. Switched to async `spawn` with a Promise wrapper — tests dropped from ~90s to ~500ms.

The `open_loops_count` semantic fix was the most contract-significant change: prior code counted all entries including resolved ones, which meant the count grew forever on an append-only log. After LOOPS ships, only `filter(l => l.resolution == null).length` is correct. Two tests in `status-snapshot.test.js` and one in `status-route.test.js` asserted the old "always 0" behavior for `gate_load_24h` and needed updating.

## What we built

**COMP-OBS-GATELOG:**
- `compose/server/gate-log-store.js` (new, 96 lines) — `appendGateLogEntry`, `readGateLog`, `mapResolveOutcomeToSchema`. Dynamic path via `COMPOSE_GATE_LOG` env for test isolation.
- `compose/server/decision-event-id.js` (extended, +18 lines) — `gateDecisionEventId` uuidv5 over feature namespace.
- `compose/server/decision-event-emit.js` (extended, +28 lines) — `buildGateEvent`.
- `compose/server/vision-routes.js` (modified) — emit-first-then-append at gateResolved site; featureless gate skip; `randomUUID` top-level import; 3 LOOPS routes.
- `compose/bin/compose.js` (extended) — `gates report` subcommand + `buildGateStats` helper; `loops add|list|resolve` subcommand.
- `compose/test/gate-log-store.test.js` (new, 15 tests)
- `compose/test/gate-log-emit.test.js` (new, 6 tests)
- `compose/test/gates-report-cli.test.js` (new, 6 tests)

**COMP-OBS-LOOPS:**
- `compose/server/open-loops-store.js` (new, 102 lines) — `addOpenLoop`, `resolveOpenLoop`, `listOpenLoops`, `isStaleLoop`.
- `compose/src/components/vision/OpenLoopsPanel.jsx` (new, 218 lines) — 320px right panel, collapsible to 40px, per-feature scope.
- `compose/src/components/vision/openLoopsPanelLogic.js` (new, 50 lines) — pure helpers mirroring server predicates.
- `compose/src/components/vision/visionMessageHandler.js` (modified) — handle `openLoopsUpdate`.
- `compose/src/App.jsx` (modified) — mount `<OpenLoopsPanel>` next to ContextPanel.
- `compose/test/open-loops-store.test.js` (new, 22 tests)
- `compose/test/open-loops-routes.test.js` (new, 11 tests)
- `compose/test/loops-cli.test.js` (new, 9 tests)
- `compose/test/ui/open-loops-panel.test.jsx` (new, 14 UI tests)

**Shared `status-snapshot.js` changes:**
- `open_loops_count` = `filter(l => l.resolution == null).length` (semantic fix)
- Inline TTL math replaced with `import { isStaleLoop } from './open-loops-store.js'`
- `gate_load_24h` = `readGateLog({ since: nowMs - 86400000 }).length`

**Test suite updates:**
- `compose/test/wave-6-contract-compliance.test.js` — un-skipped GATELOG + LOOPS placeholders with real assertions
- `compose/test/wave-6-integration.test.js` — added GATELOG and LOOPS integration slices
- `compose/test/status-snapshot.test.js` — updated `open_loops_count` test + `gate_load_24h` test
- `compose/test/status-route.test.js` — updated `gate_load_24h` test

## What we learned

1. **Dynamic env-var injection beats module-level constants for test isolation.** Reading `process.env.X` at call time rather than at module load time lets tests inject test-specific paths without cache busting.

2. **`spawnSync` blocks the event loop in async test suites.** Node's test runner uses the event loop; blocking it with `spawnSync` prevents test timeouts from firing and causes every spawned test to hit the max wait. Use async `spawn` with a Promise wrapper.

3. **Emit-first-then-append is the right order for event joins.** The contract says `DecisionEvent.metadata.gate_log_entry_id` is schema-required. Building the entry ID deterministically (uuidv5) before emitting means we can always set the join key on the DecisionEvent, and the back-pointer on the log entry is populated only when emission actually succeeded.

4. **Check all test files before claiming a semantic change is complete.** The `gate_load_24h` stub test existed in both `status-snapshot.test.js` AND `status-route.test.js`. The second copy caused one failing test in the full suite even after we fixed the first.

5. **`openLoopsPanelLogic.js` as a purity boundary.** Extracting `isStaleLoop` to both `open-loops-store.js` (server) and `openLoopsPanelLogic.js` (client) keeps both implementations inline-comparable in the contract compliance test — a cross-layer consistency check with zero runtime overhead.

## Open threads

- [ ] Journal index update (README.md in journal folder)
- [ ] User review + commit
- [ ] COMP-OBS-DRIFT (next Wave 6 feature, last `test.skip` remaining)
- [ ] `OpenLoopsPanel` onAddLoop/onResolveLoop props wiring in App.jsx (left as no-op in v1 — panel reads from WS updates)
- [ ] Gate log rotation (unbounded growth, deferred per design Decision 2)

The session's character: two clean blueprints, one shared patch point, one env-var isolation trick, one event loop gotcha.
