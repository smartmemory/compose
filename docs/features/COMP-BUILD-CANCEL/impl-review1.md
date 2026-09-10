# Implementation review round 1 (gpt-6-astra/high, runId 6a32d19b0f76, 2026-09-10) — commits 052345a..9a9ebb2
70 targeted tests passed; findings 1-4 REPRODUCED by probes the suite lacks. All accepted; fix after S04 lands.

1. must-fix SIGINT during codex preflight bypasses cancellation: build.js:2987 awaits the probe before the handlers
   install at :3088. Repro: sleeping fake codex + SIGINT → compose dies, active-build.json `running`, agent alive.
   FIX: install the handlers before the probe; CLI-signal-path test.
2. must-fix CLI can exit through a pending teardown: build-cancel.js:177 awaits killVision() outside any deadline;
   on outer-join expiry build.js:5134 swallows the timeout and unregisters → pendingTeardown() null → exit 1,
   record `running`. FIX: bound the vision op; keep pendingTeardown visible until settlement.
3. must-fix ownership claimed AFTER the first mutation: build.js:3066 unconditional vision kill; claimActiveBuild only
   inside the terminal write (§3.7 violated). Repro: replacement record for the same feature → its vision item killed.
   FIX: one claim before either mutation; skip both on ownership_lost.
4. must-fix normal completion overrides the handler's ownership: build.js:4693 sets buildStatus='complete'
   unconditionally; only the exception path checks buildCancel.teardown. Repro: SIGINT just before the final
   stepDone → history `complete`, active `aborted`, exit 130. FIX: success path respects §3.6 before recording.
5. should-fix listener-leak test measures undefined===undefined (build-cancel-signal-chain.test.js:112:
   AbortSignal has no listenerCount). FIX: getEventListeners(signal,'abort').length from node:events.
6. should-fix untagged codex dispatch records transport_derived 'sdk' even when STRATUM_CODEX_TRANSPORT=exec
   (stratum-mcp-client.js:178). FIX: 'unknown' unless the server's selection is known.
