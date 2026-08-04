# COMP-PLAN-IDEA-UNIFY — Implementation Blueprint (S3b-1: CLI cutover)

**Slice:** S3b-1 — lossless import + handle-allocation lock + CLI cutover + projection
**Status:** BLUEPRINT
**Date:** 2026-08-05
**Predecessor:** S3a (durable tracked record store) — [s3-progress.md](s3-progress.md)

## Related Documents

- Feature design: [design.md](design.md) · Ledgers: [s1](s1-progress.md) · [s2](s2-progress.md) · [s3](s3-progress.md)
- Sibling storage provider: [COMP-FOH blueprint](../COMP-FOH/blueprint.md), [FOH-2 recall](../COMP-FOH/blueprint-foh-2.md)
- Substrate ruling: [`PROVIDER-SEAM`, what-to-build §8k](../../product/2026-07-20-what-to-build-vision.md#substrate-ruling-2026-07-21--where-the-fluid-layer-lives)

## What this slice is, and what it is not

S3a left the fluid layer **complete and entirely unreachable**. `fluidProviderFor`
(`lib/fluid/factory.js:85`) has exactly one caller — `factory.js` itself. Nothing under
`bin/`, `server/`, `src/` or `ui/` imports `lib/fluid/*`. `writeIdeaboxProjection`
(`lib/fluid/render-ideabox.js:150`) has zero callers including tests. `docs/product/fluid/`
does not exist on disk. This slice makes the CLI the first production consumer.

**In scope:** lossless import, the allocation lock, the `compose ideabox` cutover, the
first projection write, and every *external writer* that would otherwise shred the
generated file.

**Out of scope, deliberately (D14):** `server/ideabox-routes.js`, `useIdeaboxStore.js`,
`src/mobile/hooks/useIdeas.js`, `IdeaboxMatrixView`, and the `effort`/`impact` contract
fields those need. That is S3b-2.

## Measured baseline — this slice's blast radius is known, not estimated

The import→render was run end to end against the real `docs/product/ideabox.md` before
this blueprint was written. 26 records import (20 ideas + 6 clusters), `nextId` stays 21,
and all 20 `IDEA-N` handles survive verbatim.

**The complete diff between the real file and its projection is 19 lines, four changes:**

| # | Change | Verdict |
|---|---|---|
| 1 | +5-line GENERATED banner | intended |
| 2 | Tags convention bullet: `` `#ux` `#core` … `` → `bare words, space-separated` | **accept (D17)** — the on-disk line has never matched the file's actual bare-word tags |
| 3 | IDEA-17 reorders within Umbrella C (renderer sorts members by handle number) | cosmetic, no content change |
| 4 | IDEA-20's `**Idea (original):**` + `**Re-aim (2026-07-21):**` **deleted — 1,273 bytes** | **DEFECT. Must be fixed before any projection write.** |

**The critical de-risk, verified not predicted:** `test/ideabox.test.js`'s
`real-ideabox fidelity` suite **passes unmodified against the generated projection** —
all six assertions plus handle preservation, including
`serializeIdeabox(parseIdeabox(rendered)) === rendered`. `parseIdeabox` captures
everything before `## Ideas` as preamble (`lib/ideabox.js:77`), so the banner round-trips
inside it. The strictest safety net in the repo survives the cutover untouched, and must
**not** be relaxed to accommodate this slice.

## Decisions

### D13 — IDEA-20's extra blocks become `discussion` entries (owner ruling 2026-08-05)

`lib/fluid/import-ideabox.js` has no `_extraLines` handling and
`lib/fluid/render-ideabox.js` has no emit, so the two blocks are destroyed on import.
They record the `PROVIDER-SEAM` re-ruling that *created this epic*; after a committed
projection they survive only in git history.

Rejected: adding `extras: string[]` to `contracts/fluid-record.schema.json` (re-imports a
markdown blob into a deliberately structured `additionalProperties: false` contract — the
exact thing this epic exists to eliminate) and folding both into `body` (destroys the
original/re-aim structure into one ~1,900-word paragraph).

Chosen: migrate them into `discussion`, which is already a first-class contract field
carried by the importer (`import-ideabox.js:141`) and emitted by the renderer
(`render-ideabox.js:77-79`). **The migration is an edit to the source markdown while it is
still hand-editable canon**, not a special case in the importer — an importer branch for
one record is a permanent cost for a one-time problem.

Constraint from the parser: `DISCUSSION_ENTRY_RE` (`lib/ideabox.js:53`) requires a single
line `- [YYYY-MM-DD] author: text` with a `\w+` author. Both blocks are single lines and
fit. The bold label is preserved inside the entry text, so no words are lost — only the
heading's position changes.

### D13a — the markdown/record date mismatch, found while executing D13

Migrating IDEA-20 into `discussion` was the first thing in the project's history to put a
discussion entry on an idea. It immediately threw:
`fluid: invalid record — /discussion/0/at must match format "date-time"`.

Three sites shared one defect — the contract types every event date as `date-time`, the
markdown has only ever carried a bare `YYYY-MM-DD`:

| Site | Was | Effect |
|---|---|---|
| `import-ideabox.js:142` discussion `at` | passed the bare markdown date into the contract | **import throws** on any idea with a discussion entry |
| `import-ideabox.js:137` `killed.at` | same | **import throws** on any killed idea with a date |
| `render-ideabox.js:80` discussion emit | wrote the full ISO timestamp into the markdown | `DISCUSSION_ENTRY_RE` cannot match it, so the entry degrades to an unparsed extra line and **the discussion is silently lost on the next read** |
| `render-ideabox.js:85` killed emit | same | renders a timestamp into a field documented as a date |

None was caught because **no idea on disk had ever carried a discussion entry and the
Killed Ideas section is empty** — both paths were dead code under passing tests. The
render-side defect is the dangerous one: it would have surfaced only *after* cutover, on
the first `compose ideabox discuss`, as silent loss.

Fixed by `lib/fluid/ideabox-dates.js` — `toRecordTimestamp` (widen) and `toMarkdownDate`
(narrow), consumed by both sides. **They live in one module deliberately:** the two
conversions are a single round-trip contract and their drifting apart is exactly the bug;
splitting them across the importer and the renderer is what allowed it. Precision is
asymmetric on purpose — the record keeps the full timestamp, the projection is a view and
shows the day.

Verified: the original and re-aim texts (1,435 chars) both survive into the projection, a
provider-written discussion entry now round-trips, and the real-file diff is down to the
three accepted changes with **zero content loss**.

### D14 — S3b splits; this is the CLI half (owner ruling 2026-08-05)

The API/UI half is ~5 files including `src/mobile/hooks/useIdeas.js`, a second and fully
independent client (own state, own WebSocket) that nothing on the desktop imports and no
test covers. Splitting halves the blast radius and reaches the reversible checkpoint
sooner.

**Accepted cost, and it must be stated plainly:** for the duration of the split, the
banner's claim that "`compose ideabox …` or the cockpit; both write to the store"
(`render-ideabox.js:26-27`) is **false for the cockpit**. The routes still write markdown
that the next CLI render overwrites. This slice therefore **softens the banner text** to
claim only what is true, and S3b-2 restores the full claim. Shipping a banner that lies is
not acceptable even for one slice.

### D15 — canon-guard registration stays deferred (owner ruling 2026-08-05)

`lib/canon-registry.js` forbids registering a path for `hook` until every legal mutation
has a tool, and there are **zero** fluid MCP tools against 20 judgment ones
(`server/compose-mcp.js`). Building `fluid_idea_*` here roughly doubles the slice.
`docs/product/fluid/**` therefore ships as tracked canon with **no write-time protection**;
the mitigation is S3a's filename↔handle identity check (F2), which refuses a record file
whose name and contents disagree. Filed as an explicit follow-up.

### D16 — the lock lives under `.compose/data/`, correcting `record-store.js:325`

That comment names `.compose/locks/`. Verified with `git check-ignore`:
`.compose/locks/` is **not ignored**, `.compose/data/` is (`.gitignore:3`). The hardened
lock this slice needs writes an `owner` token file *inside* the lock dir, so siting it at
`.compose/locks/` commits untracked noise on every idea write. `lib/judgment-writer.js:93`
already uses `.compose/data/judgment.lock`. The comment is corrected, not the convention.

### D17 — one shared lock primitive, not a seventh copy

There are six independent copy-pasted mkdir-advisory locks in `lib/`. This slice extracts
`lib/dir-lock.js` with the hardened semantics of `lib/judgment-writer.js:96-149` — owner
token, `utimesSync` heartbeat, 20s stale reclaim, ABA-safe release that only removes a lock
still provably ours — and consumes it from the fluid layer.

**`lib/judgment-writer.js` is NOT refactored onto it in this slice.** It is canon-guarded
code and rewriting its locking during an unrelated cutover couples two risks for no gain.
Migrating the other six is a follow-up. Explicitly rejected: copying
`lib/followup-writer.js:156-184` (Variant A), whose stale threshold equals its acquire
timeout, so contention is indistinguishable from staleness.

### D18 — the `ideabox` command is extracted, not edited in place

`bin/compose.js:3132-3430` is a ~300-line inline `else if` block with no named symbol, in a
3,400-line file. Rewriting it in place would leave the cutover testable only by spawning a
subprocess, and it violates the standing "refactor large files" standard. The block moves
to `lib/ideabox-cli.js` as `runIdeaboxCommand(cwd, args)` and `bin/compose.js` dispatches
to it. This is the same shape `test/fluid-cutover.test.js` needs to drive the golden flow
in-process.

Scope discipline: the extraction is a **move plus the provider repoint**, not a redesign of
the subcommands' behaviour. Behaviour parity is the gate.

## The critical section the lock must cover

Verified in `lib/fluid/local-provider.js`:

```
createRecord                     :211
  _nextHandle(kind)              :218  → _issuedHandles()        :141
                                          store.liveHandles()    (reads the records dir)
                                          store.issuedHandlesFromLog()  (reads events.jsonl)
  _handleWasIssued(handle)       :226  → _issuedHandles()        :173
  appendEvent(created tombstone) :285
  store.write(persisted)         :296
```

**The lock must cover the events log, not just the record file.** `_issuedHandles()` reads
`liveHandles()` *and* `issuedHandlesFromLog()`, so a lock that guards only the record
directory still lets two creates agree on the same next handle via a stale log read.

## File Plan

| File | Action | Change |
|---|---|---|
| docs/product/ideabox.md | edit | **Data prep, lands first. DONE.** IDEA-20's re-aim becomes `**Idea:**` (it had none — the record imported with `body: ""`), the original becomes a dated `**Discussion:**` entry (D13). Still hand-editable canon at this point. `test/ideabox.test.js` stays green. |
| lib/fluid/ideabox-dates.js | new | **DONE.** `toRecordTimestamp` / `toMarkdownDate` — the markdown↔record date conversion, fixing three live defects (D13a). |
| lib/fluid/import-ideabox.js | edit | **DONE.** Route `killed.at` and `discussion[].at` through `toRecordTimestamp` (D13a). |
| lib/dir-lock.js | new | `withDirLock(lockPath, fn)` — hardened mkdir advisory lock extracted from the judgment implementation (D17). Owner token, heartbeat, stale reclaim, ABA-safe release, typed timeout error. |
| lib/fluid/local-provider.js | edit | Wrap `createRecord`'s allocation critical section (`:218`→`:296`) in `withDirLock`. No other seam method changes. |
| lib/fluid/record-store.js | edit | Correct the stale `.compose/locks/` comment at `:323-327` to the real lock path (D16). Comment only. |
| lib/fluid/render-ideabox.js | edit | Emit dates via `toMarkdownDate` (D13a — **DONE**). Soften the banner's cockpit claim (`:26-27`) to what is true during the split (D14). |
| lib/ideabox-cli.js | new | `runIdeaboxCommand(cwd, args)` — the `ideabox` subcommand extracted out of `bin/compose.js` (D18) and repointed onto the provider: `add`/`promote`/`kill`/`pri`/`discuss`/`triage` via `fluidProviderFor` + `writeIdeaboxProjection`. |
| bin/compose.js | edit | Replace the inline `ideabox` block (`:3132-3430`) with a dispatch to `runIdeaboxCommand`. Delete the dead `_parseIdeabox`/`_serializeIdeabox` destructures (`:3153-3154`) and the second `IDEABOX_TEMPLATE` minting site (`:3203-3207`) with it. Repoint `--from-idea` (`:944-967`), the only reader that re-parses `compose.json` by hand. Update `runInit` (`:507-515`) to seed records + projection rather than the template. |
| pipelines/plan.stratum.yaml | edit | `:67` instructs agents to "append to `docs/product/ideabox.md`". Post-cutover that is a shredder. Must become `compose ideabox add` only. |
| docs/cli.md | edit | `:9,33,170-184` document the markdown-write contract. |
| docs/product/fluid/records/*.json, docs/product/fluid/events.jsonl | new | 26 tracked records from the import. `git check-ignore` exits 1 — asserted as a test, not assumed. |
| test/fluid-cutover.test.js | new | CLI golden flow against a real provider; concurrent-create test the lock must pass; a render-diff assertion pinning the blast radius to the three accepted changes. |
| test/fluid-ideabox-migration.test.js | edit | Cover the IDEA-20 discussion migration end to end. |

`test/ideabox.test.js` is **deliberately absent from this plan**. It is proven to survive
the cutover unmodified; any pressure to edit it is a signal the cutover is wrong, not the
test.

## Boundary Map

Only intra-blueprint wiring appears here. `fluidProviderFor`, `writeIdeaboxProjection` and
the record store already exist and are consumed as-is.

### S10: lossless source data
Produces: nothing (data-only — an edit to `docs/product/ideabox.md` while it is still canon)

Consumes: nothing (leaf node)

### S11: the shared lock primitive
Produces:
  lib/dir-lock.js → withDirLock (function)

Consumes: nothing (leaf node)

### S12: serialized handle allocation
Produces:
  lib/fluid/local-provider.js → createRecord (function)

Consumes:
  from S11: lib/dir-lock.js → withDirLock

### S13: the CLI cutover and the projection
Produces:
  lib/ideabox-cli.js → runIdeaboxCommand (function)

Consumes:
  from S12: lib/fluid/local-provider.js → createRecord

## Order, and the reversible checkpoint

1. **S10 — IDEA-20 migration.** Prove `test/ideabox.test.js` still byte-round-trips, then
   re-run the import→render probe and prove the diff is now exactly the three accepted
   changes. Nothing is cut over. **Zero risk.**
2. **S11 + S12 — the lock.** Still no production caller. **Zero risk.**
3. **Run the import, commit the records.** `docs/product/fluid/` becomes tracked canon
   while `ideabox.md` is still authoritative. **This commit is the rollback point.**
4. **S13 — CLI cutover + first projection write**, in the same commit as the
   `plan.stratum.yaml` and `docs/cli.md` fixes.

**Step 3 must not be left standing.** Between 3 and 4, two allocators are live and blind
to each other: `bin/compose.js:3210` via `parsedData.nextId` (`lib/ideabox.js:253-255`)
and `local-provider.js:147` via max-over-live-∪-log. Both would mint `IDEA-21`. Either
keep the window to a single session or fold 3 and 4 into one commit.

## Test strategy

- **Concurrency is the lock's only real gate.** N concurrent `createRecord` calls must
  yield N distinct handles. Without the lock this test must fail — assert that by running
  it against the unlocked code before wiring the lock, not by assuming.
- **Render-diff pin.** A test that renders the projection from the committed records and
  asserts the diff against `docs/product/ideabox.md` is exactly the accepted set. This is
  what turns "the cutover is lossless" from a claim into a gate.
- **Mutation-test before trusting green** (house rule). Break each load-bearing behaviour
  — the lock, the discussion carry-through, handle preservation, the projection write —
  and confirm a test fails for each.
- Targeted suites first; one full-suite run at the end.

## Traps (verified, file:line)

1. **`pipelines/plan.stratum.yaml:67`** tells agents to append to the generated file. Fix
   lands no later than the cutover commit or the shredder is live.
2. **`~/.claude/skills/ideabox/SKILL.md`** is a writer outside this repo that hand-edits
   markdown with grep-based ID arithmetic (`:33`) and in-file status edits (`:91,96,112`).
   It is hardcoded to a *different project's* path (`:13`) so it is likely inert here, but
   its ID arithmetic is blind to `events.jsonl`, the only record of retired handles.
3. **A dangling `cluster` handle silently deletes an idea from the projection.**
   `local-provider.js:243` copies `input.cluster` with no existence check;
   `render-ideabox.js:114` matches members by handle and `:127` builds `unclustered` from
   `!i.cluster`. A bad handle puts an idea in neither bucket — gone from the file, still on
   disk.
4. **`writeIdeaboxProjection` litters on crash.** `render-ideabox.js:152-155` writes
   `.ideabox.md.tmp.${process.pid}` with no cleanup on failure, unlike
   `record-store.js:158-163`. A crashed render leaves a tmp file in tracked territory.
5. **One corrupt record file blanks the whole ideabox.** `record-store.js:222-239` fails
   the entire `list()` on one unreadable file — deliberate — but `writeIdeaboxProjection`
   has no guard, so a short `list()` writes a truncated, committed `ideabox.md`.
6. **`.compose/data/ideabox-cache.json` is already stale on disk** (19 ideas vs 20), saved
   only by mtime invalidation. It belongs to S3b-2, but if the routes ever move while the
   cache stays instantiated (`server/ideabox-routes.js:46`) the result is a split brain the
   UI cannot detect.

## Review round 1 (Codex sol/xhigh, against this blueprint + the S10/D13a code)

Verdict: **not ready to implement — six design defects, two P0.** All six upheld; both
P0s independently re-verified before acceptance. Unusual hit rate, so each is recorded
with the evidence that carried it.

**F1 [P0] — the split ships two blind writers, and softening the banner does not fix it.**
`server/ideabox-routes.js` add (`:75`), patch (`:96`) and discuss (`:255`) rewrite the
markdown and **return success**. Once the CLI makes records canon, those writes are
overwritten by the next projection, and an API `add` mints `IDEA-21` from
`parsedData.nextId` while the record store mints its own. D14 booked this as "a banner
that lies"; it is not a lie, it is silent data loss. **UPHELD — D14 is amended below.**

**F2 [P0] — the plan migrates THIS repo and strands every other installation.**
`@smartmemory/compose` is published (`package.json` — `0.3.7`, not private) and `runInit`
scaffolds `ideabox.md` only when **absent** (`bin/compose.js:507-515`); nothing imports an
existing one. A consumer that upgrades with a populated `ideabox.md` and no records runs
`compose ideabox add`, the empty store allocates `IDEA-1`, and the projection **replaces
their entire ideabox with that single idea**. Their ideas survive only in their git
history. The blueprint missed this by framing the import as a one-time operation on this
repo. **UPHELD — the most serious finding in the review.**

**F3 [P1] — `--cluster` can create a successful but invisible idea.** The CLI takes a
free-form cluster name (`bin/compose.js:3195`), the provider stores it unresolved
(`local-provider.js:244`), and the renderer matches only exact handles (`:114`) or
null-cluster ideas (`:127`). An idea with an unresolved name lands in neither bucket: gone
from the projection, still on disk. The blueprint named this trap and then left it live.
**UPHELD.**

**F4 [P1] — the lock covered allocation only.** Concurrent `pri` and `discuss` both
succeed while the discussion write restores the old priority, and the event log claims both
happened. **UPHELD — already fixed before the review landed** (all six mutating methods now
serialize; see the Mutation section in `local-provider.js`).

**F5 [P1] — the one-time import is not restartable.** Import skips only live records
(`import-ideabox.js:68`), creation burns the handle before writing it
(`local-provider.js:277`), and the explicit-handle guard reads the log (`:226`). A crash
between them leaves a handle issued-but-absent, and the rerun is rejected. **UPHELD.**

**F6 [P1] — no committed-but-failed recovery contract.** The record is written before its
event (`local-provider.js:335`, `:363`) and the projection is a later failure point again
(`render-ideabox.js:151`), so a command can report failure after canon changed; retrying
duplicates. There is no render-only repair path. **UPHELD.**

### What the review changes

| Finding | Change to this slice |
|---|---|
| F1 | The 7 mutating ideabox routes **fail closed** (409 + a message naming the CLI) for the duration of the split. Not a rewrite onto the provider — that is still S3b-2. GET keeps working: it reads the projection, which is now faithful. |
| F2 | **New: a first-use migration gate.** Any ideabox mutation on a store with no records and a populated `ideabox.md` imports first. An ambiguous state (some records AND markdown entries absent from them) **refuses** rather than projecting over it. Model on the existing `lib/state-migrations.js` / COMP-MIGRATE-ON-UPGRADE machinery rather than inventing a second upgrade path. |
| F3 | The CLI resolves a cluster name to a handle, creating the cluster deliberately or rejecting; the renderer fails loudly on an orphan cluster reference instead of dropping the member. |
| F4 | Done. |
| F5 | An aborted allocation is reclaimable: a handle whose log shows `created`/`imported`, with **no record file and no `deleted` event**, was never live, so no citation can exist to it. That is distinguishable from a retired handle and safe to re-issue — narrowly, on the import path. |
| F6 | Add `compose ideabox render` — idempotent, records→projection only. It is the repair path for a failed projection, for trap 5's truncated write, and for trap 4's shredder. Plus an explicit committed-vs-uncommitted error contract on each subcommand. |

**D14 is amended:** the split stands, but "the banner tells a small lie" was the wrong
framing and is withdrawn. The routes fail closed, so nothing writes markdown behind the
CLI's back, and the banner can state what is true without qualification.

## Review round 2 (Codex sol/xhigh, against the shipped code at `20c3557`)

Verdict: changes requested — **no P0, five P1, two P2.** Aimed at the round-1 fixes, per
the standing rule that round N+1 mostly finds what round N's fixes introduced. It did: four
of the five P1s are defects in the fixes, not in the original plan.

**F2-1 [P1] — the concurrency test did not test concurrency. FIXED.**
`Array.from({length: N}, () => execFileSync(...))` runs each child to completion before
starting the next, so the processes never overlapped. Measured: 4 × 300ms took 1,312ms.
**That test passed against completely unlocked code**, which is worse than no test — it
certified a guarantee it never exercised, and the "8 handles, 8 collisions" result quoted
in the previous commit came from an ad-hoc shell probe, not from it. Now `execFile` under
`Promise.all`; removing the lock fails 2 tests.

**F1-1 [P1] — a partial first-use import stranded the installation. FIXED.**
A crash partway through the corpus leaves records present, so the next run took the
"records exist" branch and threw `IDEABOX_MIGRATION_CONFLICT` for every remaining handle.
The error named `compose ideabox add`, and `add` runs the same gate — so every command
failed with no way out, and the `reclaimAborted` path built for exactly this was
unreachable. The gate now classifies each missing handle from the events log:

| Evidence | Meaning | Action |
|---|---|---|
| issued, no `deleted` | a create that crashed | **resume** the import |
| issued, `deleted` | deliberately retired, file is stale output | refuse |
| never issued | hand-typed into generated output | refuse |

The evidence must be **per handle**. A global "did an import ever run" check degrades the
moment the first import succeeds, because the log keeps `imported` events forever — it
would then quietly import anything later hand-added, losing the protection F2 exists for.
The third row was found by a test failing after the first attempt at this fix.

**F4-1 [P1] — retrying `kill` destroyed the original evidence. FIXED.**
`findIdea` returns killed records, and `kill` rewrote `killed.at`/`killed.reason`
unconditionally. Since every command writes its record before re-rendering,
"record committed, render failed" invites exactly that retry — replacing the real reason
with `(no reason given)`. Now a no-op that still re-renders, matching the legacy helper.

**F2-2 [P1] — stale-lock reclaim was ABA-unsafe. FIXED.**
Two contenders could both judge the same lock stale; the loser's blind `rmSync` then
deleted the winner's fresh lock and both entered the critical section. The owner token was
checked on release but not on reclaim. Reclaim is now compare-and-delete on mtime + token.
(Inherited from `judgment-writer.js`, which still has it — see Deferred.)

**F5-1 [P1] — `_isAbortedAllocation` overclaimed. DOC FIXED, behaviour kept.**
It cannot prove a handle was never live: a record whose file vanished out-of-band has the
same shape, and the test itself deletes a live record's file. Upheld as a documentation
defect. The behaviour stands because safety comes from the **caller** — only the import
passes the flag, and it supplies handles from the markdown, so a reclaim can only restore
a handle to the content the file already says belongs to it. The comment now says that
instead of claiming a proof it does not have.

**Deferred to follow-ups (2, both P2, plus one P1 that is unreachable in this config):**

- **F3-1 [P1] — import restartability is local-provider-only.** `smartmemory-provider.js`
  appends its tombstone before `createItem` and ignores `reclaimAborted`, so a network
  failure mid-import burns the handle permanently. Unreachable here — `.compose/compose.json`
  has no `fluid` block, so the floor is used — but it is real for anyone who configures
  SmartMemory. `reclaimAborted` should become part of the seam contract.
- **F6-1 [P2] — concurrent `add --cluster "X"` can create duplicate clusters.** Lookup and
  create are separate operations and the lock covers only each individual mutation. Needs a
  find-or-create inside one critical section, which needs a non-locking inner create
  (`withDirLock` is not reentrant).
- **F7-1 [P2] — the markdown loses discussion authors containing spaces.** The contract
  accepts any string, the parser's grammar is `\w+`, and the renderer emits verbatim, so
  `author: "Jane Doe"` round-trips to zero discussion entries. Unreachable from the CLI
  (which always writes `human`) but reachable from the provider and from S3b-2's API.

## Deferred / flagged

- **S3b-2:** API routes, desktop store, mobile client, and the `effort`/`impact` contract
  fields. Note `server/ideabox-routes.js:121,127-132` already whitelists and validates
  both, and `IdeaboxMatrixView` is live (`IdeaboxView.jsx:688`), but **no idea on disk
  carries either field** — so this is a dormant feature regression, not data loss.
- **Canon-guard registration + `fluid_idea_*` MCP tools** (D15).
- **Migrating the other six ad-hoc locks onto `lib/dir-lock.js`** (D17).
- **`promoted_to` is unstructured after import.** IDEA-18 is `PROMOTED (→ COMP-BUILD-QUICK)`
  on disk; `import-ideabox.js:38-41` puts the whole string in `status_label` and leaves
  `links` empty, so `render-ideabox.js:74`'s `promoted_to` branch never fires. Round-trips
  correctly, but the promote edge S4 needs exists only as prose. S4's problem unless a
  fluid-path `promote` should write the real link now.
- **`server/vision-store.js:282` `setFluidExt` is dead** — zero callers repo-wide. Left in
  place per S3a's reasoning.
