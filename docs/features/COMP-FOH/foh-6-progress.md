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

## Blueprint entry-gates (need the local stack UP — owner starts it, never unasked)
- VERIFY-1: provision-user token accepted by Maya middleware end-to-end; measure token TTL.
- VERIFY-2: `channel_context` accepted + reflected on live `/api/chat` (static pydantic check only so far).
- VERIFY-3: her turn-ingestion lands in the colleague workspace, not fluid; configure-time
  validation refuses a fluid-workspace token (the invariant, not the happy path).

## Scope fences (blueprint must honor)
- Ideas only (no clusters — seam refuses; no decisions — no producer exists).
- CALIBRATION visibly unavailable, never faked. No resolve affordance in the panel (CLI-only).
- `src/components/vision/ChallengeModal.jsx` is a FALSE FRIEND (vision-item flow) — do not wire.
- Truncation priority: contradictions > conviction > challenge > record body > discussion;
  omissions named in the per-turn context note.
- Pin `MAYA_PROACTIVE_CHECK_INTERVAL_S=0` in relay ops notes.
- New capability consumers: `challengeIdea`, `convictionOf` (existing wrappers, first production
  callers) + new `contradictions` ideabox-ops wrapper.
