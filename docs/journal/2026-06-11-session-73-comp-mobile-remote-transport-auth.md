---
date: 2026-06-11
session_number: 73
slug: comp-mobile-remote-transport-auth
summary: COMP-MOBILE-REMOTE shipped — BYO-tunnel remote access w/ QR pairing, 3-tier tokens, credential-only gate; loopback-trust blocker caught at design gate; self-adversary + nit-triage rules adopted mid-build
feature_code: COMP-MOBILE-REMOTE
closing_line: The house now has a front door with a lock — the phone just has to knock once.
---

# Session 73 — COMP-MOBILE-REMOTE

**Date:** 2026-06-11
**Feature:** `COMP-MOBILE-REMOTE`

## What happened

Straight off COMP-MOBILE-1's ship, the human asked what COMP-MOBILE-REMOTE does, then "will this work in China?", then /compose build. The month-old design needed a reality refresh first: research found the API server doesn't serve the SPA at all (Vite does — a tunnel exposing 4001 would never load the PWA), the 4002 surface was smaller than designed, and mobile agent-kill had been silently 404ing since COMP-MOBILE (wrong port, invisible to fetch-mocked tests).

The design gate earned its keep again — 7 rounds, 10 findings — headlined by a genuine blocker: the design trusted loopback as the cockpit's identity, but every BYO tunnel daemon (cloudflared, tailscaled, ssh -L) connects from 127.0.0.1, so tunneled remote traffic would have sailed through unauthenticated. The trust model became credential-only in remote mode, gate unmounted entirely otherwise. Also from the gates: JWT clients were incompatible with exact-match sensitive-token routes (composite middleware + server-side token injection by the proxy), refresh reuse-detection was unimplementable as written (device-id-prefixed tokens + history ring), EventSource can't set headers (query-token scoped to explicit stream paths).

Mid-build the human pushed back on process: "adversary yourself when drafting" and "ignore pure nits" — both now standing memory rules. The implementation went out as 5 Sonnet slices (S03+S04 in parallel), the impl review found 4 real issues (the nastiest: query-token auth keyed on a spoofable Accept header), and round 2's finding turned out to be a PRE-EXISTING dead endpoint (ChallengeModal → /api/terminal/inject exists on no server) — dispositioned to its own ticket COMP-COCKPIT-11 rather than absorbed, and Codex verified the disposition from git history before going CLEAN.

## What we built

NEW: server/auth-store.js (HS256 on node:crypto, device store, pairing codes, rotation+reuse-revoke, audit log), server/auth-middleware.js (gate, composite, rate limiter, wsUpgradeTokenOk), server/auth-routes.js, server/remote-utils.js (resolveComposeHost, attachAgentProxy w/ SSE pass-through + token injection), lib/cli-remote.js (pair/list/revoke/status/rotate-secret), src/lib/wsUrl.js, src/components/cockpit/PairDeviceModal.jsx, src/mobile/pages/PairPage.jsx; 9 new test files/suites (~250 new tests; node 3344→3677, vitest 342→421).
MODIFIED: server/index.js (host config, gate mount, WS-upgrade auth, dist/ static + SPA fallback, proxy, health {remote}), security.js (composite shim), supervisor.js (env threading), build/vision routes+server (guard swaps), bin/compose.js (remote verbs, start --host), wsFetch (auth modes + 401 ladder), compose-api (token storage/refresh single-flight), wsReconnect (function URLs), agentStream, AgentStream.jsx + ChallengeModal-adjacent desktop WS/SSE sites, MobileApp (dual-mode boot, /m/pair), WorkspaceContext (remote detection), AgentCard/AgentDetailView (404 fix). Commits d1cd5bd, 9d1f0ea, 8ee0a46, 4cbb0b4, 54e39f2, 6da2066, 83d1386.

## What we learned

1. Loopback source IP is meaningless as a trust boundary the moment a tunnel daemon is the deployment model — the daemon IS a localhost client. Credential-only with a mount-nothing-when-off escape hatch is both safer and simpler than IP heuristics.
2. Query-param auth must be scoped to an explicit path allowlist, never to request headers — Accept is client-controlled, and 'SSE-looking' is not an auth property (caught at impl review, locked with a spoof test).
3. A clean design gate doesn't transfer to implementation: the gated design SAID stream-path-only, the implementer translated it to an Accept-header check anyway. Verbatim-implementation instructions need the WHY attached to the contract, not just the WHAT.
4. Fetch-mocked UI tests cannot see wrong-port/dead-endpoint bugs (mobile agent-stop 404, ChallengeModal inject) — two found this feature, both pre-existing. Only contract-checking against the real route table catches this class.
5. Disposition beats absorption: round-2's finding was real-but-pre-existing; filing COMP-COCKPIT-11 and having Codex verify the git-history disposition kept the feature scoped and the gate honest.
6. Process rules adopted mid-build (human feedback): self-adversary every draft before its gate (trust boundaries, pseudocode-vs-prose drift, implementable-from-text), and triage gate findings — fix behavior/contract/security, dismiss pure nits with one line.

## Open threads

- [ ] HUMAN VERIFICATION REQUIRED: real-phone pairing (QR scan via tunnel), 16-min refresh (ACCESS_TOKEN_TTL=60 shortcut), revoke-while-paired, refresh-reuse defense, bind-safety refusal — the design's acceptance gates only a human with a phone can run
- [ ] COMP-COCKPIT-11: ChallengeModal Discuss posts to /api/terminal/inject which exists on no server (pre-existing; wire-or-remove)
- [ ] cli-remote defaultHeadCheck https path has no integration test (self-signed-cert harness judged not worth it; protocol-branch is 3 lines)
- [ ] WS connections opened before a token refresh keep streaming with the old token until reconnect (accepted v1 tradeoff per design)
- [ ] COMP-MOBILE-PUSH (Web Push) remains the unfiled next step for away-from-phone alerting

---

*The house now has a front door with a lock — the phone just has to knock once.*
