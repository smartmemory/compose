# COMP-PLAN-IDEA-UNIFY — S3 progress ledger

**Slice:** S3 — wire callers + cutover
**Status:** S3a COMPLETE (durable tracked record store). **S3b-1 COMPLETE** (CLI cutover,
import, allocation lock — `72d79f5`, `3ae6a65`). S3b-2 OPEN (API + cockpit + mobile).
**Date:** 2026-08-04, S3b-1 appended 2026-08-05

> **S3b split into two slices** (owner ruling 2026-08-05). S3b-1 is the CLI half and it
> has shipped; see [blueprint-s3b-1.md](blueprint-s3b-1.md) for its decisions, its Codex
> round-1 review and the measured cutover diff. Summary of what changed against the plan
> written here:
>
> - **The cutover ran.** 26 records under `docs/product/fluid/`, every `IDEA-N` handle
>   verbatim, `nextId` still 21. `docs/product/ideabox.md` is now generated and differs
>   from the hand-written file in exactly three intended ways.
> - **"Serializing allocation is S3b's job" was too narrow.** Allocation was not the only
>   race: `updateRecord`, `appendDiscussion`, `addLink` and `removeLink` are all
>   read-modify-write on one file. All six mutating methods now serialize on
>   `lib/dir-lock.js`. Measured, not argued: 8 concurrent creates collide on IDEA-1
>   without the lock, destroying 7 ideas.
> - **`.compose/locks/` was the wrong home** and `record-store.js`'s comment saying so is
>   corrected. It is not gitignored, and the lock writes an owner token inside itself.
> - **Five defects were latent in shipped S2/S3a code**, each on a path no idea on disk
>   had taken: the importer threw on any discussion entry or kill date, the renderer
>   silently destroyed provider-written discussion entries, it emitted a priority on
>   killed ideas (breaking the round-trip fixed point), it omitted the grouping
>   placeholder for a file with no headings, and IDEA-20 imported with an empty body.
> - **The migration is an upgrade path, not a one-off.** This was the review's most
>   serious finding and the plan here missed it entirely — see F2 in the blueprint.

## Related Documents

- Feature design: [design.md](design.md) · S1 ledger: [s1-progress.md](s1-progress.md) · S2 ledger: [s2-progress.md](s2-progress.md)
- Ruling refined here: [`PROVIDER-SEAM`, what-to-build §8k](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)

## The entry gate, answered

S2 deferred the cutover and made one question S3's entry gate: **where do the
floor provider's records live, and are they tracked by git?**

The state it left behind:

| | Tracked? | |
|---|---|---|
| `docs/product/ideabox.md` | yes | about to become a GENERATED projection |
| `.compose/data/vision-state.json` | **no** (`.gitignore:3` → `data/`) | where S1 put the records |

Wiring the CLI, the API and the UI onto the provider makes the store the write
target. So at the moment of cutover, idea canon moves from a tracked file to an
ignored one on a single machine, and the repo carries a file stamped GENERATED
with no source of truth behind it on any other clone or in CI.

Three options were put to the owner: (a) accept local-only, (b) make the floor's
records tracked, (c) defer again.

> **OWNER RULING 2026-08-04 — option (b). Track the records, split them out of
> vision-state.**

Un-ignoring `vision-state.json` was considered and rejected without being put to
the owner: it is ~540KB of runtime state (465 items, gates, connections)
rewritten on every save. Tracking it would produce an unreadable diff and a
merge conflict per parallel session. That is committing a database, not making
records durable.

## Decisions

### D10 — canon inverts; the vision store stops being the substrate

§8k reads "the vision store is not a competing canon — its existing typed items
are the expected implementation substrate of the local floor provider." That
clause cannot hold together with the ruling above, because the vision store's
file is exactly the thing that cannot be tracked. So it is superseded, narrowly:

```
BEFORE   vision item = canon,   nothing tracked
AFTER    record file = canon,   vision item = optional derived projection
```

**A1 stands in substance.** One canonical store, `ideabox.md` as a generated
view, the provider interface as the port, semantics never abstracted — all
unchanged. Only the substrate under the floor moved. The seam, its capability
model, and every handle invariant are untouched.

**Cost of the change: zero migration.** The import never ran, so the store held
465 vision items, 0 of type `idea`, and 0 carrying `fluid_ext`. Verified before
touching anything. This was the cheapest moment this decision would ever have.

**What made it safe to move:** `fluid_ext` had exactly one consumer outside
`lib/fluid/` — `VisionStore.setFluidExt` itself. No route, no UI, no graph code
read it. The hosting was pure substrate, not a consumed projection.

**S4 is not blocked.** Promotion-as-edge wants an `idea → feature` edge in the
graph. A vision item can still be projected from a record when S4 needs one;
that is a projection concern, and deriving it from canon is more honest than the
S1 arrangement where the graph node WAS the canon.

### D11 — layout mirrors `docs/judgment/`, deliberately

The judgment layer already solved "tool-owned canon plus a generated markdown
projection" and is the house convention. A third pattern here would be drift for
its own sake.

| | Judgment (shipped) | Fluid (this slice) |
|---|---|---|
| Records | `docs/judgment/records/joints/*.json` | `docs/product/fluid/records/<HANDLE>.json` |
| Append-only log | `docs/judgment/records/ledger.jsonl` | `docs/product/fluid/events.jsonl` |
| Generated projection | `docs/judgment/REGISTER.md` | `docs/product/ideabox.md` |

**One file per record, not one array file.** A whole-array rewrite makes every
`ideabox add` a diff against all records and a merge conflict between two clones
that each added an idea. Per-record files make an add a pure file creation. The
handle is the filename: unique, never reused, already constrained to a
filesystem-safe grammar by the contract — and re-validated in the store before
it is interpolated into a path.

**The events log is tracked too.** Losing it does not lose history, it loses the
guarantee that a retired handle stays retired. Handles are external citations
(§8k cites IDEA-20), so reuse silently repoints a citation at a different idea.

### D12 — `position` and `joint` stay refused, for a better reason

S1 refused them because the vision store had no item type to host them. Records
are their own files now, so that constraint is gone — and the refusal nearly
went with it. It stays because **the judgment layer already owns those kinds**
(`docs/judgment/records/positions/`, `.../joints/`, written by
`judgment_position_create` / `judgment_joint_add`). Accepting them here would
give one kind two stores and two canons, which is the fragmentation this epic
exists to end. `supportedKinds()` is now `idea, decision, thread, question,
cluster`, and the stated reason matches the real one.

> **Cross-check for COMP-FOH.** Its architecture gate (@b0ada1a) defaulted
> `position`/`joint` to FULL on the SmartMemory provider and disclosed that as
> "without strong grounding". D12 supplies grounding that cuts the other way:
> those kinds already have an owner and a store. Worth resolving at COMP-FOH's
> blueprint rather than shipping two canons for a position.

## What the rework bought beyond durability

Both were S1 hazards that dissolved rather than being fixed:

- **The two-write compensation dance is gone.** S1 wrote a vision item and then
  its `fluid_ext` namespace, with a compensating delete on create and a native-
  field rollback on update. A record is one file now, written through an atomic
  tmp+rename, so it appears whole or not at all.
- **The `_sync()` stale-snapshot hazard is gone.** `VisionStore` loaded once and
  rewrote the whole state file from its in-memory snapshot, so a stale writer
  erased records it had never read. There is no cached state now — every read
  hits the directory.

## Known gap, carried forward

**Still no lock.** Two processes writing the same handle concurrently can
interleave read-modify-write, and handle allocation can race two creates onto
the same next handle (the pre-write tombstone narrows that window, it does not
close it).

What changed is the blast radius: with a shared state file, a concurrent write
could destroy *unrelated* records. With per-record files it can only lose an
update to the one contended record. `.compose/locks/` already exists for this.
**Serializing allocation is S3b's job**, when the CLI, the API and the UI are
all actually writing.

## Not done here, deliberately

- **Canon-guard registration.** `docs/product/fluid/**` is tool-owned canon and
  belongs in `lib/canon-registry.js`, and `lib/append-integrity.js` is the ready-
  made verifier for the events log. But the registry's own rule is to register a
  path for `hook` ONLY once every legal mutation has a tool or an override, and
  the fluid layer has no MCP tools yet. Registering now would lock out legal
  writes. Follow-up, gated on S3b.
- **The cutover itself.** `ideabox.md` is still hand-editable canon. Nothing in
  the repo is a projection yet, and the GENERATED banner in `render-ideabox.js`
  is still not true of any file on disk.

## Files

| Role | Path |
|---|---|
| **New** — durable storage | `lib/fluid/record-store.js` |
| Reworked onto it | `lib/fluid/local-provider.js` |
| Doc-comment only | `lib/fluid/factory.js` (`dataDir` → `recordsRoot`) |
| Tests | `test/fluid-provider.test.js` (58), `test/fluid-ideabox-migration.test.js` (16) |

`server/vision-store.js` is **unchanged**. `setFluidExt` is now unused by the
fluid layer; it was left in place rather than removed in the same commit as the
storage move — S4 may want it for the promotion-edge projection, and deleting a
tested method to prove a point is not worth coupling two changes.

## Review round 1 (Codex sol/xhigh, against @1a502cb)

Three findings, **all three upheld** and fixed in the follow-up commit. None
were the accepted limits (the allocation race and the deferred canon-guard
registration were correctly left alone).

**F1 [P1] — `updateRecord` normalized before validating. A REGRESSION THIS SLICE
INTRODUCED.** S1 validated the raw merge; S3a inserted `_normalize()` into the
merge path, so the schema only ever saw already-sanitized data. Two silent
failures lived in that gap, both reporting success: `{links: null}` was coerced
to `[]`, erasing every link, and `{titel: 'x'}` was dropped, so a misspelled
field wrote nothing and said it worked. Silent, successful-looking data loss is
the precise failure this whole slice exists to prevent, so this was the worst
possible place to introduce it. Fixed by ordering: validate the raw merge, then
normalize. No new field list was added — the contract already rejects both
(`links` is typed, the record definition is `additionalProperties: false`); it
simply was not being shown the input.

**F2 [P1] — no filename↔handle identity check.** Every write picks its
destination from `record.handle`, so reading `IDEA-1.json` containing
`"handle": "IDEA-2"` and saving it destroys IDEA-2 while leaving the malformed
file intact. This is a hazard D11 *created*: records are now tracked,
hand-editable files, and the canon guard is deliberately not registered yet.
`read()` now refuses a file whose name and contents disagree.

**F3 [P2] — absolute `recordsRoot` was documented but broken.** `join(cwd, root)`
turned `/tmp/fluid` into `<cwd>/tmp/fluid`. Now `resolve(cwd, root)`.

Two of the three (F1, F2) are defects a passing test suite did not catch, which
is the argument for the review round rather than against it. Four regression
tests added, one per failure mode plus the cross-record clobber.

## Verification

- Targeted: 74 tests across the two fluid suites, zero failures (was 63).
- Full suite: **5251 node + 581 ui + 100 tracker = 5932, zero failures**
  (baseline 5925; +7 is exactly the net new fluid tests).
- `git check-ignore docs/product/fluid/records/IDEA-1.json` exits 1 — not
  ignored. This is asserted as a **test** against the real repo and the real
  `.gitignore`, so moving the records back under an ignored path fails the
  build rather than being discovered at the next cutover.
