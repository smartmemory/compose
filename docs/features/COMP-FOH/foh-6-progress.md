# FOH-6 COLLEAGUE-PANEL — progress ledger

**Feature:** COMP-FOH FOH-6 — Maya (existing SmartMemory assistant) layered into the Compose
cockpit as a summonable colleague slide-over. Her core is never modified.
**Status:** IMPLEMENT COMPLETE (2026-08-12) — S1–S4 shipped, impl Codex REVIEW CLEAN r3,
full suite green, upstream issues filed. REMAINING before slice close: dogfood config +
live-fire (owner-started stack), then journal (deferred to the live-fire session). S5
streaming remains the named stretch follow-up.

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
- **Full suite GREEN** (pre-review run: node + 599 UI + 100 tracker; final post-fix run:
  5694 node + 601 UI + 100 tracker — one non-reproducible node flake in the first post-fix
  run, identity lost to `| tail` truncation, clean on re-run; known flake class per FOH-4).
  Zero tracked diffs under `SmartMemory/maya/` (acceptance criterion holds; untracked avatar
  PNGs pre-date FOH-6).
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
- **Codex r3 (terra/high, scoped to r2 fixes): REVIEW CLEAN.** Review loop closed at 3 rounds.
- **Phase 9/10 (2026-08-12):** README gains the Maya colleague section (config + modes + no-degraded
  contract); CHANGELOG complete (grown per slice + both review rounds); COMP-FOH feature.json stays
  IN_PROGRESS (epic; this is a slice). Stratum flow ee814ae9 audit: 4 steps, all first-attempt,
  trace in the ship commit. Journal entry deferred to the live-fire session (borderline-milestone
  rule: fold into the completion chapter).
- Deferred (need the owner-started stack): dogfood config in `.compose/compose.json`, live-fire
  (inject contradicting idea → findings reflected in reply → write-back lands → teardown; also
  the VERIFY-3 leftover — inspect her workspace via the client lib's listItems).

## LIVE-FIRE (2026-08-12, owner-started stack, throwaway everything, torn down) — colleague loop PASSED; one upstream P1 surfaced

Setup: throwaway fluid tenant via `POST /test/provision-user` (`team_fce68e35699b`), NDA, all 7
`fluid_*` record types declared (`X-Workspace-Id` header REQUIRED on `/memory/ontology/types` —
new since FOH-4's recipe; and the ideabox migration imports CLUSTERS, so `fluid_cluster` etc.
must be declared too, not just idea/event/decision). Dogfood config written to
`.compose/compose.json` (maya + smartmemory + fluid blocks), own server instance on scratch
ports 4801/4802 with `SM_FLUID_KEY`, seeded IDEA-53 ("Postgres") ⊃contradicts⊃ IDEA-54
("Redis", decayed 1.0→0.5 via `resolveIdeaChallenge`). Afterwards: both tenants deleted
(colleague identity through the shipped `reprovision` action — it live-fired too), server
stopped, `compose.json` + `ideabox.md` restored byte-for-byte (shasum-verified), tree clean.

**PASSED (design acceptance):**
- `GET /api/maya/status` → `ready`, capability strip correct (calibration `false`, visible-unavailable).
- `POST /api/maya/message {focusId: IDEA-54}` → lazy provision of the colleague identity
  (separate workspace `team_994740c42d42`), context blocks sent = idea + conviction +
  contradiction + challenge, zero omissions; **her reply named IDEA-53 and the Postgres
  contradiction** — the injected findings, reflected.
- Write-back durable as `author:'maya'` + `<!-- maya:msg_<id> -->` marker (verified via direct
  `GET /memory/{item_id}` — NOT via list; see the finding).
- VERIFY-3 leftover CLOSED: her colleague workspace listed via the client lib =
  4 items, all her own turn-ingestion (semantic/episodic/latent_intent), **zero
  `compose.fluid.*` items**. Isolation holds end-to-end.

**UPSTREAM P1 SURFACED — `/memory/list` serves ingest-time metadata forever after `updateItem`:**
- Repro: append discussion (updateItem rewrites `fluid_record_json`) → direct GET shows the
  entry; `/memory/list` (incl. metadata-filtered) still returns the PRE-update blob 7+ minutes
  later. Not a lag — it never converged during the session.
- Consequence 1: write-back idempotency defeated. `writeback-retry` reconcile-scan reads via
  list → misses the marker → re-appends from the stale base. Masked here (identical content,
  entry count stayed 1) but the `at` timestamp proved the original entry was OVERWRITTEN, not
  deduped (`deduped:true` never fired).
- Consequence 2 (decisive probe): a SECOND `addDiscussion` on IDEA-54 rebuilt the blob from the
  creation-time base and **silently dropped Maya's entry** — on this backend the append-only
  discussion trail keeps only the last write. Every provider read-modify-write
  (`_resolveForWrite` → `_resolveItems` → `_listAllItems` → `/memory/list`) shares the exposure.
- Attribution: FOH-6 code behaves per contract; the provider's FOH-1-era read-your-writes
  assumption is what the substrate violates. Same defect family as the 2026-08-05 recall
  live-fire ("storage GOOD, reads stale").
- Filed upstream: smart-memory/smart-memory-service#7 (list staleness after updateItem). Compose-side hardening
  option (owner decision, not taken unilaterally): list-for-discovery, direct-GET-for-truth in
  `_resolveItems` + the write-back reconcile scan — one extra round-trip per write.

## Scope fences (blueprint must honor)
- Ideas only (no clusters — seam refuses; no decisions — no producer exists).
- CALIBRATION visibly unavailable, never faked. No resolve affordance in the panel (CLI-only).
- `src/components/vision/ChallengeModal.jsx` is a FALSE FRIEND (vision-item flow) — do not wire.
- Truncation priority: contradictions > conviction > challenge > record body > discussion;
  omissions named in the per-turn context note.
- Pin `MAYA_PROACTIVE_CHECK_INTERVAL_S=0` in relay ops notes.
- New capability consumers: `challengeIdea`, `convictionOf` (existing wrappers, first production
  callers) + new `contradictions` ideabox-ops wrapper.
