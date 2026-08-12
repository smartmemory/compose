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
- **S2 COMPLETE:** `lib/colleague/context.js` (composeColleagueContext: capability-derived
  sections, concurrent fetch + per-capability deadline, priority truncation with named
  omissions, corpus fallback) + `contradictionsOf` export in ideabox-ops; wired as the relay's
  default composeContext. First production callers of challengeIdea/convictionOf/contradictions
  now exist (acceptance criterion). 142 tests green across colleague/maya/ideabox/provider suites.
- **S3 COMPLETE:** ColleaguePanel slide-over (5 funnel states, capability strip w/ calibration
  visibly unavailable, focus picker following Ideabox selection, context notes, write-back chips),
  useMayaStatus (workspace-keyed memo + refresh), ViewTabs summon button (chrome, not a tab),
  App mount. **Blueprint addition:** `POST /api/maya/identity` (reprovision/static) — the auth
  funnel's explicit actions needed server wiring the blueprint didn't enumerate; refuses
  fluid-workspace tokens like every other entry point. Panel's repair affordance posts
  `/api/ideabox/render` — endpoint lands in S4. 20 route tests + 10 UI tests green; vite build OK.
- **S4 COMPLETE:** `lib/colleague/writeback.js` (reconcile-then-append keyed on `message_id`
  marker `<!-- maya:msg_<id> -->`; outcomes ok/landed-unrendered/failed, never throws), wired
  into `/message` (chat authoritative, toggleable default-on) + `POST /api/maya/writeback-retry`
  (append-only) + `POST /api/ideabox/render` repair endpoint + panel toggle. **Contract change:**
  provenance origin enum gains `ui:colleague` (new door; write-backs distinguishable for the
  record's lifetime). Golden write-back suite runs the REAL local provider incl. the
  landed-unrendered path (read-only projection dir) and reconcile-to-ok retry.
- **Full suite GREEN** (node + 599 UI + 100 tracker, exit 0). Zero tracked diffs under
  `SmartMemory/maya/` (acceptance criterion holds; untracked avatar PNGs pre-date FOH-6).
- **Upstream issues FILED** (2026-08-12, as smartmem-dev; re-auth probe answered statically —
  `test_provisioning.py` has exactly POST+DELETE, no login path):
  - smart-memory/maya#2 — supported per-turn context-injection field (channel_context is
    comment-convention only; Discord framing + undocumented cap noted).
  - smart-memory/smart-memory-service#6 — `POST /test/login {email}` same-identity re-auth
    (24h TTL + 409 on re-provision = daily loss of the standing thread without it).
- **Codex review r1 (sol/high): 9 findings (2 P1), ALL accepted + fixed** — static-token
  fail-closed verification via `GET /auth/me` (JWT-claim check was vacuous — real tokens carry no
  claims); panel keyed on projectRoot (stale cross-project write-back killed); identity file
  0600+atomic; ensureIdentity single-flight; write-back serialization per (root,focus,msg);
  401-retry token captured once; misconfigured + static-no-token funnel states; findings
  accordion (relay returns blocks); `ui:colleague` enum reverted (dead until a create op exists).
  94 targeted tests green (83 node + 11 UI) after fixes. r2 dispatched scoped to the fixes.
- **Codex r2 (sol/high, scoped to fixes): 3 findings (2 P1), ALL accepted + fixed** — legacy
  claimless static identities verify-and-migrate on first use (verify→validate→persist order
  matters: persisting first pinned a colliding claim); project switch clears the global Ideabox
  selection (same-handle cross-project write-back); paste refusals always render. 96 targeted
  tests green (84 node + 12 UI). r3 scoped to these three fixes.
- Deferred (need the owner-started stack): dogfood config in `.compose/compose.json`, live-fire
  (inject contradicting idea → findings reflected in reply → write-back lands → teardown).

## Scope fences (blueprint must honor)
- Ideas only (no clusters — seam refuses; no decisions — no producer exists).
- CALIBRATION visibly unavailable, never faked. No resolve affordance in the panel (CLI-only).
- `src/components/vision/ChallengeModal.jsx` is a FALSE FRIEND (vision-item flow) — do not wire.
- Truncation priority: contradictions > conviction > challenge > record body > discussion;
  omissions named in the per-turn context note.
- Pin `MAYA_PROACTIVE_CHECK_INTERVAL_S=0` in relay ops notes.
- New capability consumers: `challengeIdea`, `convictionOf` (existing wrappers, first production
  callers) + new `contradictions` ideabox-ops wrapper.
