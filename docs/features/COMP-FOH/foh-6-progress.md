# FOH-6 COLLEAGUE-PANEL — progress ledger

**Feature:** COMP-FOH FOH-6 — Maya (existing SmartMemory assistant) layered into the Compose
cockpit as a summonable colleague slide-over. Her core is never modified.
**Status:** DESIGN COMPLETE (Codex REVIEW CLEAN r3, owner pre-approved continue-on-clean
2026-08-11). Next: Phase 4 blueprint.

## Owner decisions (do not re-litigate)
- FOH-6 = colleague slice (over exhaust-loop / portfolio / pause).
- Layer over the existing Maya at `/Users/ruze/reg/my/SmartMemory/maya/` — zero Maya core changes.
- Surface: **slide-over panel** summoned from cockpit chrome (owner: "popup alongside the other
  content"), NOT a main-area tab.
- Token source pluggable, local-first: `provision` (smart-memory-service `POST /test/provision-user`,
  the FOH-4/5 live-fire path) now, `static` pasted token later. Dev-bypass ruled out (FOH-4: 500s on
  mutating routes).
- Shallow binding v1: Compose computes findings via its API-key client and injects per-turn
  `channel_context`; Maya's JWT stays on her own dedicated colleague workspace. Deep binding
  deferred.

## Design gate history
- design-foh-6.md drafted 2026-08-11 after 2 explorer passes (Maya surfaces, Compose hooks) +
  advisor review (shallow-vs-deep reframe; channel_context flagged at-risk).
- Codex r1 (sol/high): 10 findings (5 must-fix) — all accepted. Key: auth-allowlist inversion
  (allowlist BYPASSES auth — Maya routes stay authenticated), COLLEAGUE-ALL-IN alignment (no
  degraded plain-chat mode), 401 never silently re-provisions (identity owns the standing thread),
  write-back partial-failure contract, static-token workspace validation.
- Owner mid-review direction: panel-not-tab (dissolved the DEFAULT_MAIN_TABS finding).
- Codex r2 (sol/high): 8/10 fixes verified; 5 findings IN the fixes — all accepted. Key: write-back
  retry must be idempotent (keyed on Maya `message_id`, reconcile-then-append); context-path loss →
  funnel, never plain chat.
- Codex r3 (terra/high, scoped to the 5 r2 fixes): **REVIEW CLEAN**.

## Artifacts
- `design-foh-6.md` — the design (gate-approved).
- `mockups/colleague-pane.html` — interactive mockup: slide-over over the Ideabox, findings
  accordion, write-back chips (incl. partial-failure retry), all four funnel states.
  Published: https://claude.ai/code/artifact/2c50cb1a-cc8a-4f22-8e86-443efed3bc12

## Blueprint PHASE 4+5 COMPLETE (2026-08-11)
- `blueprint-foh-6.md` written; Boundary Map validated (0 violations, 0 warnings); 34-ref file:line
  sweep: 27 exact, 5 off-by-lines + 1 dead anchor (`tab-spacer` doesn't exist — unnamed
  `flex-1` div at `ViewTabs.jsx:73`) — ALL corrected inline.

## VERIFY-1/2/3 — LIVE-FIRE PASSED (2026-08-11, owner-started stack, throwaway identity torn down)
- **VERIFY-1 PASSED:** `POST /test/provision-user` → identity + token; NDA accepted; Maya
  `/api/chat` round-trip `success:true`, `message_id` returned, `memory_available:true`.
  **Token TTL = 1440 min (24 h).** JWT payload carries NO workspace claims — Maya resolves
  workspace server-side from the verified user record (default team), which worked.
- **VERIFY-2 PASSED:** `channel_context` accepted on the live endpoint and REFLECTED — injected
  "Redis streams" fact came back verbatim in her reply. The at-risk dependency is real and works.
- **VERIFY-3 PARTIAL:** structural isolation holds (colleague token never had the fluid workspace);
  her workspace list couldn't be inspected (`GET /memory/list` 400 — wrong shape; use the client
  lib's listItems during implementation). The refusal-of-fluid-token check is a compose-side unit
  test in S1. Finish both during implement.
- **NEW FINDING (design updated):** same-email re-provision → **409 "Email already registered"**.
  No token-refresh path exists on the test surface. Daily expiry recovery = teardown + new identity
  = loses her accumulated colleague-workspace memory. S1 probes for a same-identity re-auth path;
  if absent, file upstream ask (`POST /test/login {email}`) with the channel_context issue.
- Script: scratchpad `livefire-foh6-verify.mjs` (this session).

## Next: implement (S1 relay+token → S2 context builder → S3 panel → S4 write-back; S5 stretch)
Blueprint is the plan (FOH-4/5 slice pattern — no separate plan.md). TDD per task, review loop,
coverage sweep per Phase 7.

## Implement progress (2026-08-12)
- **S1 COMPLETE:** `lib/maya-config.js`, `lib/maya-identity.js`, `lib/maya-client.js`,
  `server/maya-routes.js` (+ vision-server attach), `test/helpers/maya-stub.js`, 29 tests green
  (client contract incl. 401-retry-once/deadline/2xx-trust-gate; routes funnel machine,
  lazy provision+NDA, no-silent-reprovision, workspace-collision refusal before side effects,
  static mode, allowlist-posture assertion). Message route uses an injectable `composeContext`
  (S1 default: empty blocks) — S2 wires the real builder.
- Deferred to end-of-build (stack-dependent): dogfood config, live-fire, same-identity re-auth
  probe + upstream issues (channel_context supported field; POST /test/login ask).

## Scope fences (blueprint must honor)
- Ideas only (no clusters — seam refuses; no decisions — no producer exists).
- CALIBRATION visibly unavailable, never faked. No resolve affordance in the panel (CLI-only).
- `src/components/vision/ChallengeModal.jsx` is a FALSE FRIEND (vision-item flow) — do not wire.
- Truncation priority: contradictions > conviction > challenge > record body > discussion;
  omissions named in the per-turn context note.
- Pin `MAYA_PROACTIVE_CHECK_INTERVAL_S=0` in relay ops notes.
- New capability consumers: `challengeIdea`, `convictionOf` (existing wrappers, first production
  callers) + new `contradictions` ideabox-ops wrapper.
