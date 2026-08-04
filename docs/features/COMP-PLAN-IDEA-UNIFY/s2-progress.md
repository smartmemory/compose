# COMP-PLAN-IDEA-UNIFY — S2 progress ledger

**Slice:** S2 — one-time import + `ideabox.md` as a projection
**Status:** COMPLETE (machinery). **Cutover deferred to S3 by owner ruling, 2026-08-04.**
**Date:** 2026-08-04

## Related Documents

- Feature design: [design.md](design.md) · S1 ledger: [s1-progress.md](s1-progress.md)
- Ruling: [`PROVIDER-SEAM`, what-to-build §8k](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)

## The blocker (why the cutover did not run)

`docs/product/ideabox.md` is **tracked**; `.compose/data/vision-state.json` — where
the floor provider stores records — is **gitignored** (`.gitignore:3 data/`).

Cutting over therefore moves idea canon from tracked to untracked and commits a
file stamped GENERATED whose source of truth exists on one machine. Any other
clone or CI sees the generated file with no store behind it.

This is arguably what the ruling intends (fluid lives in the provider; only
committed work is git canon; under SmartMemory ideas live in a database). But the
ruling **parked "backup cadence for a SmartMemory-backed judgment corpus"**, and
that parked rider is now load-bearing: git is currently the backup, and the
cutover ends that. Deleting hand-authored content from a tracked file is an owner
call.

Options put to the owner: (1) cut over anyway, accepting local-only; (2) make the
floor's records tracked first; (3) defer the cutover to S3.

> **OWNER RULING 2026-08-04 — option 3. The cutover moves to S3.**
>
> `ideabox.md` stays canon and stays hand-editable until S3 lands. Nothing in
> this repo becomes a projection yet, and the GENERATED banner in
> `render-ideabox.js` is not yet true of any file on disk.
>
> **This makes the durability question S3's entry gate, not a footnote.** S3
> wires the CLI, the API and the UI onto the provider — the moment that lands,
> writes go to the store whether or not the store is durable. So S3 must open by
> answering where the floor's records live and whether they are tracked, before
> any caller is moved. Deciding it then, with the CLI in hand, is the point of
> deferring; letting it be discovered again mid-slice is not.

## Pre-existing data-loss bug found and fixed (not introduced by this slice)

Every `compose ideabox add/kill/pri/promote/discuss` writes via
`parseIdeabox → serializeIdeabox`. That round-trip was destroying:

1. **Every tag on every idea.** `applyField` used `/#\w+/g`, but the real file
   writes bare words (`stratum integrity research-influence`). All 20 ideas
   parsed with `tags: []`.
2. **Every umbrella `**Theme:**` paragraph** (5 of them). The line sits between
   the H3 and the first H4, where the parse loop had no `currentIdea` and hit
   `continue`.
3. **The hand-authored preamble**, regenerated from `IDEABOX_TEMPLATE`, dropping
   the project's own `**Umbrella:**` convention bullet.

Also fixed: `---` separators were captured onto the *preceding* idea's extra
lines and re-emitted, duplicating on every write; and unrecognized field lines
serialized after `**Maps to:**` instead of before, reordering IDEA-20 on write.

**The real `docs/product/ideabox.md` now round-trips byte-identical through
parse → serialize**, asserted directly in `test/ideabox.test.js`. That assertion
is the honest statement of "a write loses nothing"; it was false before.

## Decisions

**D7 — `cluster` is a record kind, not a string label.** An umbrella carries a
hand-authored multi-sentence Theme paragraph. That is cluster-scoped content with
nowhere to live on a member idea except duplicated onto every one of them, which
is a drift generator. Handle prefix `CLUS`, hosted on the vision store's existing
`track` type. A record's `cluster` field now holds the cluster **handle**, so
renaming an umbrella cannot orphan its members. Purely additive to S1.

**D8 — `status_label` preserves what the closed enum cannot.** IDEA-20's status
is `RE-AIMED (2026-07-21)`. Canonical `status` still drives behavior; the label
only stops the enum flattening the author's words to `NEW`.

**D9 — the projection never reads the markdown.** Records are the only input.
Reading the previous file to decide what to write is what turns a projection back
into a second source, and it preserves stale content nobody can trace to an owner.

**D10 — re-import leaves an existing handle alone.** Idempotence by skipping, not
overwriting, so a re-run cannot act as a reverse sync from markdown — the two-way
bridge this epic exists to eliminate.

## Verification

- `test/fluid-ideabox-migration.test.js` — 16/16, against the **real** ideabox,
  not a fixture. A synthetic fixture would pass while the real file lost content.
- **Mutation-verified:** removing theme rendering fails 3 tests; removing handle
  preservation fails 4. The gate is not passing vacuously.
- `test/ideabox.test.js` + store — 98/98 (+6 fidelity regressions).
- Full suite: 5244 + 581 + 100 = **5925, zero failures**.
- Stratum run `3e9eae76-a1e4-4f1e-a59d-184bf72eefcb` — 5/5 steps, no retries.

## Next

- **S3 opens with the durability question** (see the ruling above), answered
  before any caller is wired — because wiring the callers is what makes the
  store the write target. Then: `compose ideabox …`, `/api/ideabox`,
  `useIdeaboxStore` onto the provider, and the cutover itself.
- S4 — promotion as a `promoted_to` edge.

Until S3 lands, `ideabox.md` remains canon and hand-editable, and the parser
fixes in this slice are what keep the CLI from eating it.
