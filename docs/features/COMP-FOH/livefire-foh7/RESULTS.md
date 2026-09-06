# FOH-7 live-fire harness + retained evidence (2026-09-06)

Scripts and verbatim outputs from the FOH-7 PORTFOLIO live-fire. Narrative lives in
[`../report-foh-7.md`](../report-foh-7.md); this folder exists so the verdicts are reproducible and
the evidence outlives the session (same convention as [`../livefire-foh6/`](../livefire-foh6/)).

All tenants were throwaway and are deleted (`DELETE /test/provision-user` returned 200 for all three;
a deleted bearer answers 401 on `/auth/me`). No token is retained anywhere. Scratch paths are
scrubbed to `<scratch>` in the captures.

## Setup

- Local stack: smart-memory-service `:9001`, Maya `:9005` (v0.4.30, Docker), both already up.
- Two throwaway SmartMemory tenants (`provision-fluid.mjs a|b`): NDA **v2** (v1 is gone upstream),
  all eight `fluid_*` record types declared with `X-Workspace-Id`.
- Two scratch Compose projects, `harbor` (declaring root, portfolio of three) and `lantern`, each
  `fluid.provider: smartmemory` on its own tenant — see `compose.json.example`. Third member `forge`
  = `/Users/ruze/reg/my/forge` on the local floor (18 migrated ideas + 10 clusters).
- Seeded through the real provider (`seed.mjs` → `ideaboxContext` → `addIdea`): two ideas per
  SmartMemory product, one of each on a deliberately shared topic (gate-retry persistence:
  Postgres in harbor, Redis streams in lantern).
- Compose API server started directly (`node server/index.js`, `COMPOSE_TARGET=<scratch>/product-a`),
  never the supervisor (it kills listeners on its ports). Compose's own tracked config untouched.
- One `POST /api/maya/message` with `scope: "portfolio"`, no `focusId`:
  *"Across our products, what has been proposed for persisting gate retries, and do the proposals agree?"*

## Files

- `provision-fluid.mjs` — throwaway tenant + NDA v2 + type declares (writes `identity-<tag>.json`, deleted)
- `seed.mjs` — seeds both products through the shipped provider path
- `compose.json.example` — the declaring root's config, workspace id scrubbed
- `turn0-prefix.json` — the turn **before** the recall-capability fix: all three members
  `listed, not searched`, three omissions. Retained because it is the defect, verbatim.
- `turn1.json` — the turn **after** both fixes: harbor and lantern `matching this question`,
  forge `listed, not searched` with its omission named, `sent: ["compose:portfolio"]`.
  Maya's reply opens "I've already mentioned this" because her provisioned identity and thread
  persisted from turn0 (the server restart does not reset them). The evidence for the recall fix is
  therefore the **context blocks compose produced**, not the reply, which Maya could have written from
  memory of turn0. The tenants are deleted, so this cannot be rerun on a fresh thread; noted rather
  than hidden.

## Verdicts

| Acceptance criterion | Result |
|---|---|
| One real colleague turn returns cross-product findings (D-FOH-7-8) | **PASS** — findings grouped under `harbor` and `lantern`; Maya's reply names Postgres vs Redis streams and says the proposals disagree (`turn1.json`) |
| Mixed-provider portfolio: SmartMemory declaring root + local-floor member, local intelligence omitted **by name** | **PASS** — `forge` contributes its listed records and the single omission is `forge cannot search (no recall capability) — listed its records instead` |
| Maya receives the flat projection | pinned by test, **not independently verified live** — `sent` proves what the panel was told, not what Maya received |

## Defects found by the live-fire (both fixed in the same commit, both pinned by a test that is red without the fix)

1. **Every portfolio member was listed, never searched — SmartMemory included.**
   `lib/fluid/portfolio.js` checked `provider.has('recall')`; every provider declares
   `SEMANTIC_CAP.RECALL` = `'RECALL'`, and `has()` is a plain Set lookup. The suite was green because
   its stubs replaced `has()` with `() => true`, so no test could tell the two strings apart — the
   prior session even recorded "must set `provider.has = () => true`" as a landmine, which was the
   symptom. On a two-idea corpus the listing happens to contain the answer (`turn0-prefix.json` reads
   correctly), which is exactly how it would have hidden in production until a product outgrew the
   listing limit. Fix: the declared constant; tests now grant recall by declaring it in
   `capabilities()` and leave `has()` real; a new test pins that a declaring member is searched.
2. **Every freshly provisioned colleague identity failed its first turn: `NDA accept failed (HTTP 409)`.**
   `lib/maya-identity.js` hardcoded NDA `v1`; upstream is on `v2`. Fix: on `409 version_mismatch`,
   accept the `current_version` the server names. The stub (`test/helpers/maya-stub.js`) now models
   the mismatch behind `__ndaVersion`; a new routes test drives v1 → 409 → v2.

Neither defect was reachable by the unit suite as written. Both were found by the first real turn.
