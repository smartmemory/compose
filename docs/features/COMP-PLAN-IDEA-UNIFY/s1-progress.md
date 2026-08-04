# COMP-PLAN-IDEA-UNIFY — S1 progress ledger

**Slice:** S1 — cut the fluid-store provider seam (floor only, no callers wired)
**Status:** COMPLETE (pending commit)
**Date:** 2026-08-04

## Related Documents

- Feature design: [design.md](design.md)
- Ruling: [`PROVIDER-SEAM`, what-to-build §8k](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)
- Epic anchor: [Front-of-Funnel Rigor + Parity](../../design/2026-07-20-front-funnel-rigor-design.md) (WS-A)
- Contract: `contracts/fluid-record.schema.json`

## Scope of this slice

Seam only. No caller is wired, the ideabox is untouched, and `ideabox.md` is
still the read/write substrate for `compose ideabox …`. Acceptance criteria 2
(mutation via the provider interface) is satisfied at the interface level; the
criteria that require callers to move are S3.

## What shipped

| File | Role |
|---|---|
| `contracts/fluid-record.schema.json` (new) | Kind-generic record + lifecycle event + capability contract |
| `lib/fluid/provider.js` (new) | The seam: record CRUD, events, capability discovery, typed errors |
| `lib/fluid/local-provider.js` (new) | Zero-install floor over the vision store |
| `lib/fluid/factory.js` (new) | Config-driven selection, fail-loud |
| `test/fluid-provider.test.js` (new) | 30 tests, real backends |
| `server/vision-store.js` (existing) | `setFluidExt(id, ext, {touch})` — one additive slot |

## Decisions taken during the build

**D1 — the record rides in an additive `fluid_ext` namespace, not in the generic
allowlist.** The vision store's `updateItem` has a fixed field allowlist with no
slot for `handle`, `cluster`, `tags`, `source`, or `links`, and it serves eleven
item types. Adding record-specific fields to that allowlist would leak one
type's shape into a generic store. The store already has this exact pattern for
lifecycle (`updateLifecycleExt`, the Wave 6 additive slot), so the fluid seam
mirrors it. Consequence: no second store, per the ruling.

**D2 — the handle watermark is derived over records ∪ events, not records
alone.** Handles are external citations (`IDEA-20` is quoted in the substrate
ruling itself). Computing "next" from live records would reissue a deleted
record's handle and silently repoint every citation. The `created`/`imported`
event is a permanent tombstone. *Known limit:* if `fluid-events.jsonl` is
deleted while `vision-state.json` survives, the watermark falls back to live
records. Accepted for the floor — a dedicated watermark file would be the second
store the ruling forbids.

**D3 — `cluster` and `cluster_order` are record fields.** Hand-authored umbrella
headings and their ordering are information. If the store could not return them
verbatim, the S2 projection would clobber them on first regeneration — the
failure mode `roadmap generate` already has.

**D4 — canonical status is fluid-native; the vision item's `status` is a
one-way projection.** `new/discussing/promoted/killed` are canonical in
`fluid_ext`; the item's own status exists so the graph and dashboard render
sensibly. `promoted → superseded` is deliberate: a promoted idea was replaced by
a committed feature, and the `promoted_to` edge carries the provenance.

**D5 — no `withFallback` proxy.** The tracker factory wraps its provider so a
missing entity falls through to local. Correct there (the substitute is equally
true), wrong here (the substitute would be fabricated). Documented inline in
`lib/fluid/factory.js` so the divergence from the precedent is not read as an
oversight.

**D6 — a configured-but-unimplemented `smartmemory` provider hard-fails.** It
does not silently downgrade to the floor: a user who configured it did so for
the capabilities the floor lacks.

## Review loop

**Round 1 — Codex `gpt-5.6-sol/xhigh`, 7 findings, all real, all fixed.** Four
were reproduced with a direct probe before any fix was written; none were
argued away.

| # | Finding | Fix |
|---|---|---|
| 1 | Concurrent provider instances erase each other's records — `VisionStore` rewrites the whole state file from a snapshot loaded once at construction, so the CLI and a running server clobber each other | `_sync()` reloads before every operation, but only for a store this provider owns; an injected store belongs to its caller. Matches the tracker's read-per-operation discipline |
| 2 | A retired handle could be reused via the caller-supplied path — the duplicate check consulted live records only, so the import could resurrect a citation onto a different record | Caller-supplied handles are checked against every handle ever issued. **Membership, not a watermark** — a `n <= highest` test would have rejected `IDEA-3` once `IDEA-20` was imported and broken S2's import outright |
| 3 | A corrupt event line silently freed the handle it tombstoned, because the watermark read the log through `JSON.parse` | Handle durability now comes from a raw-text scan independent of parseability. Tolerant history reading and durable retirement are separate mechanisms |
| 4 | `discussion` is append-only in the contract but wholesale-patchable in code; `discussion: null` destroyed evidence and *then* threw, so the caller saw a failure after the data was gone | Identity, provenance and discussion are unpatchable and rejected loudly (not silently dropped — silence looks like a successful erase). `appendDiscussion()` is the only growth path. All validation moved ahead of the first write |
| 5 | Multi-write mutations are not atomic, and `_save()` swallowed every I/O error so `setFluidExt` reported success on a write that never landed | `_save()` returns a status; `setFluidExt` rolls back its in-memory change and throws. **Residual accepted:** the three-write sequence is still not atomic — see below |
| 6 | Contract unenforced at runtime (`DEC-0` accepted as an idea handle, `{type:"bogus"}` links accepted) and the schema root validated `{}` | Handle format and kind-prefix agreement validated; link types validated against the contract enum; root closed with `additionalProperties: false` and a note that callers validate against a named definition |
| 7 | `getRecord()` returned `killed` by reference, so a caller could mutate canonical in-memory state with no write, no event and no save | Cloned like every other structured field |

Every fix carries a regression test. One pre-existing test was **changed rather
than preserved**: it asserted that identity fields passed to `updateRecord` were
silently ignored, and the fix rejects them instead — the design says identity is
not patchable, and refusing states that where dropping it does not.

**Round 2 — Codex `gpt-5.6-sol/xhigh`, 11 findings. Ten fixed, one already-disclosed limit whose *claim* was corrected.**

Round 2 confirmed the semantic-capability invariant holds (floor declares no
semantic capability, inherited calls throw, factory installs no fallback) and
then found that three of round 1's fixes were incomplete in ways round 1 had not
reached.

| # | Finding | Resolution |
|---|---|---|
| 1 | Concurrent writers can still collide on a handle — nothing is locked | **Not fixed; disclosure corrected.** Already recorded as an accepted limit, but the CHANGELOG stated the guarantee absolutely and the regression test was named "concurrent" while performing two sequential awaited writes. Test renamed to what it proves (stale snapshots); CHANGELOG now states the gap explicitly. A lock lands with S3 |
| 2 | A failed event append left a discoverable record whose handle was never tombstoned — delete it and the handle returns | **Ordering inverted: the tombstone is now written BEFORE the record.** A failure now wastes a handle instead of freeing one, and a wasted handle is free while a reissued one is unrecoverable |
| 3 | Round 1's `setFluidExt` rollback restored only the namespace, leaving the already-saved native fields committed | Both restored, or neither |
| 4 | `deleteRecord` destroyed append-only discussion evidence, leaving content-free `discussed` events | Deletion emits a `deleted` event carrying the discussion. Append-only now holds on the path that erases, not just the ones that do not |
| 5 | An imported handle past the exact-integer range made `max + 1 === max`, so the allocator reissued it forever | Suffix bounded to 9 digits in contract and code, plus a membership check on the automatic path |
| 6 | Round 1 cloned `killed` on the way out but not on the way in — mutable on the injected-store path | Cloned both directions |
| 7 | `deleteItem` ignored the new `_save()` status, so deletion reported success on a failed write | Restores the item, connections and gates, then throws |
| 8 | "Validate the whole shape" was false — `title: ""` and `priority: "P9"` persisted; events unvalidated | **Replaced hand-rolled checks with real validation against the published contract** (`lib/fluid/schema.js`, mirroring `lib/judgment/schema.js`). Records and events both validate |
| 9 | Schema root still accepted `{}`; the `_validation` prose had no machine effect | `oneOf` added — the constraint is now enforced, not requested |
| 10 | Valid JSON that is not an object (`[]`, `"x"`, `42`) silently selected the floor; `null` leaked a TypeError | Rejected as a config error |
| 11 | The corrupt-tombstone test appended an unrelated bad line, leaving the real tombstone intact — the old implementation would have passed it | Test now truncates the tombstone itself and asserts it is unparseable before testing the allocator |

**Lesson worth keeping:** every one of findings 2, 3 and 6 was introduced *by a
round-1 fix*. Fixes are where new defects live, and a second round on the fixes
was worth more than a second round on the original code would have been.

## Accepted limits (not defects — recorded so they are not rediscovered)

- **The three-write sequence is not atomic.** A record's native fields, its
  `fluid_ext` namespace and its event are separate writes; a crash between them
  can leave a stale vision-item status or a record without its event. Reads take
  status from `fluid_ext`, so the *record* stays correct and only graph rendering
  goes stale. This is the ACID gap the substrate ruling already names — the floor
  cannot close it, and faking a transaction would be worse than documenting one.
- **`_sync()` closes the stale-snapshot window, not the interleaving one.** Two
  processes can still read-modify-write across each other, and that includes
  allocating the same handle. Sequential writers (CLI and a running server) are
  safe; simultaneous ones are not. Serializing needs a lock; deferred to S3,
  when concurrent callers actually exist. **The guarantee is "handles are not
  reused", not "handles cannot collide under concurrency"** — round 2 was right
  that the stronger phrasing was unearned.
- **Handle retirement depends on the event log surviving.** If
  `fluid-events.jsonl` is deleted while `vision-state.json` lives, the watermark
  falls back to live records. A dedicated watermark file would be the second
  store the ruling forbids.

## Verification

- `test/fluid-provider.test.js` — 40/40 pass, real `VisionStore` over temp dirs, no mocks.
- Vision-store and ideabox consumer suites — 170/170 pass (the `setFluidExt` and `_save` changes disturb no existing caller).
- **Full suite green: 5215 (node) + 581 (ui) + 100 (tracker) = 5896, zero failures.**
- Stratum run `b7f88379-adea-4732-9326-5c538578cb9b` — 5/5 steps, one attempt each, no postcondition retries.

*Flake note:* the first full run reported 5215 tests with 1 failure. The failing
test's identity was lost to a truncated capture (operator error, not a suite
property); re-running the identical set gave 5215/5215. Non-deterministic,
consistent with the repo's known flakes, but not positively identified — recorded
rather than asserted to be one of them.

## Next slices

- **S2** — one-time `ideabox.md` → records import (import-once, never a round-trip) + `ideabox.md` as a generated projection. Must preserve cluster headings and ordering (D3) and the hand-authored Purpose/Conventions prose.
- **S3** — wire `compose ideabox …` CLI, `/api/ideabox`, and `useIdeaboxStore` onto the provider. Behavior preserved, backing store swapped.
- **S4** — promotion as a graph transition (`promoted_to` edge), superseding the read-only `mapsTo` overlay.
