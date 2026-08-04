# COMP-FOH — Status

**Paused after:** Phase 3 (Architecture), gate approved and committed (`b0ada1a`, 2026-08-04).
**Resume at:** Phase 4 (Blueprint) — targeted `compose-explorer` research + `blueprint.md` for the first slice, **FOH-1** (storage-only `SmartMemoryFluidProvider`, filling the `lib/fluid/factory.js:91` stub).

## Why paused

`architecture.md` sequences FOH-1 to sit **behind** `COMP-PLAN-IDEA-UNIFY` S3/S4 (not parallel, not duplicating it). At gate time, S3 durability work was found **live and uncommitted** in the exact files FOH-1 would extend:

- New file `lib/fluid/record-store.js` (292 lines, untracked) — per-record git-tracked persistence, replacing S1's vision-store-hosted approach (owner-ruled "S3 entry-gate", dated 2026-08-04).
- Heavy uncommitted rewrites of `lib/fluid/local-provider.js` (~267 insertions / 299 deletions) and a small `lib/fluid/factory.js` diff.
- Last real commit touching `lib/fluid/`: `2b9cb0a` (2026-08-04, "fix(ideabox): stop the CLI silently deleting tags and umbrella themes").

This work was **not touched or committed** by the COMP-FOH session — left exactly as found.

## Resume condition

Wait until `COMP-PLAN-IDEA-UNIFY` S3 (the record-store durability work) is committed, then re-verify `architecture.md`'s file:line references against the landed shape of `lib/fluid/local-provider.js` and `lib/fluid/factory.js` before starting Phase 4 — the stub location (`factory.js:91`) and the provider interface (`provider.js`) are expected to survive, but exact line numbers cited in `architecture.md` may drift.

## Also still open (from architecture.md, not blocking, but relevant at blueprint time)

- `position`/`joint` record kinds defaulted to FULL (recallable) — not explicitly confirmed by any of the 3 architect proposals, worth a second look.
- `decision` record kind set to INDEXED (2 of 3 proposals disagreed, said FULL) — deliberate call, but flagged as the one item worth revisiting.
- Pre-existing minor duplication: CLI (`bin/compose.js:3260`) and HTTP (`server/ideabox-routes.js:152`) both independently implement the promotion call — unrelated to COMP-FOH, filed as a follow-up, not fixed.
