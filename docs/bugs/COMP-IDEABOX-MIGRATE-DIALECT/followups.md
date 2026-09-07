# COMP-IDEABOX-MIGRATE-DIALECT — deferred findings

From the Codex (gpt-6-astra/high) adversarial review, 2026-09-06. Each is real and reproduced by the
reviewer; each is deferred because it needs its own design, and none is a regression introduced by this
fix. Fixing them inside this bug would have turned a data-loss stop into an open-ended refactor.

## FU-1 (P1) — the resume policy cannot resume an ordinary interrupted migration

**RESOLVED 2026-09-06.** `lib/fluid/ideabox-manifest.js` (new): `importIdeabox` declares the source
path, a hash of the markdown it parsed, and every planned handle BEFORE its first `createRecord`, and
removes the record on success. It lives in `.compose/data/` beside the provider's lock — gitignored,
so nothing strays into the tracked ideabox directory — and a missing manifest degrades to refuse. The
gate's resumable set is now `(issued and not deleted) or manifest.planned`, with the manifest half
counting only while it is open AND its hash matches the file being read now; a mismatch refuses as
`IDEABOX_MANIFEST_STALE`, naming a mid-migration edit. The protection is unweakened: a completed
import closes its manifest, so a hand-added idea still refuses. The "crashed partway" test named below
was replaced by one that makes the store fail on the second idea, so the unattempted tail is the thing
under test.

**Amended after the round-2 review (2026-09-06).** Two gaps in the above, both accepted:

- The manifest was consulted only when a handle was missing. Editing an idea that ALREADY has a record
  changes no id, so nothing was missing, and the projection replaced the edit with the body imported
  from the version read at the start of the migration. An open manifest is a fact about the DOCUMENT,
  not about its ids, so it is now consulted unconditionally: a hash mismatch refuses, and a match with
  nothing missing resumes, which is what closes the manifest. `importIdeabox` also re-reads its source
  after its last write and raises `IDEABOX_SOURCE_CHANGED_DURING_IMPORT` on a mismatch, leaving the
  manifest OPEN. The scope distinction is the point: during a migration the file is the user's source
  document, after one it is generated output, and `render` still discards hand edits to output.
- `openManifest` truncated in place, so a crash mid-write destroyed the only record of the plan being
  recovered. It is now temp + rename, and an identical retry leaves the existing manifest untouched.

**Amended again 2026-09-07 — the stranding escape hatch is closed.** The amendment above left one:
while `IDEABOX_MANIFEST_STALE` held, every ideabox command refused and the only exit needing no
tooling was to delete the manifest, which makes the partially migrated store canon so the next render
destroys the edit. That is this finding's own shape with a worse way out. Two commands now supply a
supported one — `compose ideabox adopt-file` (the file is right) and `compose ideabox discard-edits`
(the migration is right, and a copy of the current file is saved first) — implemented in
`lib/fluid/ideabox-recover.js`. Both refuse unless an open manifest's hash actually mismatches the
file, so neither is a general route to making a hand-edited file canon; that refusal is pinned by its
own tests because it is the constraint most likely to be argued away later. The manifest is now v2 and
stores the source text, which is what makes discarding lossless rather than destructive; a v1 manifest
can still be adopted but not discarded, and says so.

Both commands reconcile RECORDS as well as the file, which review found twice over: `adopt-file` left
an already-imported umbrella's theme untouched (`findOrCreateRecord` returns a known cluster as-is and
the import skips it too, so an edited theme reached no writer), and `discard-edits` restored the
markdown while leaving records an interrupted `adopt-file` had already patched, which the very next
projection wrote straight back into the file. RULING, so it is not re-litigated: `discard-edits`
cannot take back a discussion entry appended to a record or an umbrella the adoption created. Deleting
them was rejected because never deleting is this feature's one invariant and the renderer emits an
empty umbrella deliberately; refusing was rejected because refusing is the stranding this whole
follow-up exists to end. It keeps them and NAMES them, exactly as `adopt-file` names a handle the file
no longer mentions.

`importIdeabox` creates records sequentially (`lib/fluid/import-ideabox.js:110`). If it writes idea 1
and crashes on idea 2, ideas 3..N were never issued, so the gate classifies them as hand-added strays
and refuses (`lib/fluid/ideabox-migrate.js`). The recovery the error names is circular: it recommends
`compose ideabox add`, which runs the same gate, and the comments recommend `render`, which runs it too
(`lib/ideabox-cli.js:301` — and now the projection boundary as well).

The existing "crashed partway" test completes the migration and deletes records afterwards
(`test/fluid-cutover.test.js:281`), so it exercises a resumable prefix and never the unattempted tail.

Needs a durable migration manifest tied to the source document, not an inference from the event log.

## FU-2 (P2) — other parser callers still read failure as absence

**RESOLVED 2026-09-06.** The check is now `assertIdeaboxReadable` in `lib/fluid/ideabox-readable.js`
(new), lifted verbatim from the gate and re-exported by `ideabox-migrate.js` so existing importers are
unaffected. It is a leaf module because `lib/ideabox.js` has to import it while `ideabox-migrate.js`
imports `parseIdeabox` from `lib/ideabox.js` — keeping it in the gate would close an import cycle.
Called by `ensureIdeaboxMigrated` (unchanged behaviour), `importIdeabox`, and `readIdeabox`. On the
live surface, `compose new --from-idea` now exits non-zero naming the readability error instead of
warning "idea not found" and building the feature without the content it was asked for.

The readability check lives in the migration gate only. Two callers parse independently and treat a
failed parse as an empty one:

- `lib/fluid/import-ideabox.js:61` — a direct import can silently import only the subset it recognised.
- `readIdeabox` (`lib/ideabox.js`) → `compose new --from-idea` (`bin/compose.js:957`) reports
  "idea not found" and proceeds without the requested content.

The diagnostics belong in a shared parse result that every caller receives, rather than in one caller.
This is the same shape as the original bug, one level up: the fix so far guards the destructive path,
not the parse.

## FU-3 (P1) — no source fingerprint between the check and the replacement

**RESOLVED 2026-09-06 — but NOT as a fingerprint.** The gate is split into a pure `assessIdeabox`
(reads `listRecords`, `readEvents` and the markdown; writes nothing; returns refusals rather than
throwing them) and an executor, `ensureIdeaboxMigrated`, whose external behaviour is unchanged.
`publishProjection` re-runs the assessment INSIDE the write lock and refuses on anything other than
`action: 'none'`. The gate itself stays outside the lock, as it must.

The fingerprint described below was implemented and rejected: a hash captured at gate time cannot
distinguish a hand edit from a second legitimate render, so two concurrent writers (CLI and REST) would
have the second one refuse for no reason. Re-assessing asks the question that actually matters — is
this file still consistent with the store? — so a concurrent render assesses as `none` and proceeds
while a hand-added idea assesses as a stray and stops the write. Both cases are pinned by tests in
`test/fluid-cutover.test.js`.

**Amended after the round-2 review (2026-09-06).** The assessment closed the window between the gate
and the lock, not the one inside it: reading the records and rendering them takes time, and a person
saving a new idea never acquires this lock, so a whole new idea was still lost one step later.
`publishProjection` now captures the destination's bytes at assessment time and re-reads them
immediately before `renameSync`, refusing as `IDEABOX_CHANGED_UNDER_LOCK` on any difference. This is
not the rejected fingerprint: it compares the destination against ITSELF across milliseconds with the
lock held, and the lock serializes every render Compose performs, so no legitimate concurrent render
can trip it. A test pins that two concurrent renders both complete.

The gate reads the markdown (`lib/fluid/ideabox-migrate.js`); the projection acquires its lock and
replaces the file later (`lib/fluid/render-ideabox.js:236`). Nothing verifies the file is still the one
that was checked.

Failure: migration reads the legacy file, an editor saves a new idea into it while the import runs, and
the projection then replaces that newer file from records built out of the older version. The added
idea never reaches the store and is destroyed.

Wants the source hash captured at gate time and re-verified inside the projection lock, refusing on a
mismatch. Narrow, but it is a genuine lost-update window on a file the user may have open.

## FU-4 (P2) — a project's own title and introduction are replaced by the template on migration

**RESOLVED 2026-09-07 — a tracked sidecar file, chosen by the owner.** The preamble is captured at
migration into `<ideabox>.preamble.md`, a plain markdown TRACKED SIBLING of the document it describes
(`lib/fluid/ideabox-preamble.js`). `importIdeabox` writes it from the parser's own `preamble` output;
`renderIdeaboxFrom` reads it and supplies the `preamble` argument `renderIdeabox` already accepted. No
sidecar means the standard template, exactly as before.

**Why NOT the gitignored `.compose/data/` location it was first built in.** Putting it beside the
migration manifest made a TRACKED projection depend on UNTRACKED input, so the heading survived only on
the machine that ran the migration: every other clone found no sidecar, rendered the template over the
custom heading and committed that, and the migrating machine restored it on its next render — this very
defect recurring per clone, plus git churn on a tracked file. The owner had already ruled on exactly
this shape in the S3 entry-gate ruling of 2026-08-04 (recorded in the header of
`lib/fluid/local-provider.js`): records were moved OUT of gitignored `vision-state.json` because canon
that a tracked file is generated from cannot itself be ignored. The manifest is not a comparable
neighbour — it is TRANSIENT, alive only between the start and the end of one import, while the preamble
is durable content with the same lifecycle as the records. Keying the path off the ideabox rather than
off `provider.lockPath` additionally means SmartMemory, which has no lock, gets a sidecar; under the
first design it silently got none, which was the provider whose existence justified a file-side sidecar
over a record kind. Pinned by a test that renders on a clone carrying only the tracked files.

**Why not the record-kind option described below.** Making the preamble canon in the record model
means adding an ontology type to every SmartMemory tenant and deciding what a remote store does with
per-document text. The preamble is not a property of the idea corpus at all — it belongs to the
projection FILE, and that file is local whichever provider holds the records. A local sidecar is the
honest home for it, and it is the smaller change.

**The contract below is intact.** The projection remains a function of the records plus the sidecar and
never of its own output, so `render` is still the way back from any hand edit; a vandalised heading is
discarded and the captured one restored. Pinned by tests in `test/fluid-cutover.test.js`, and the
rejected destination-reading design is distinguishable by test — implementing it turns the contract
test red along with two pre-existing ones.

**What an already-migrated project gets.** No sidecar, therefore the standard template, which is what
its file already holds — nothing changes, no record is touched and nothing further is lost. The
original heading survives in that project's git history; recovering it means writing
`<ideabox>.preamble.md` by hand, which is a sibling of the document rather than a hashed name under a
hidden directory. There is no command for that yet. A project that migrated during the brief life of
the gitignored location keeps that file on disk, orphaned and never read: verified that the render
falls back to the template and destroys nothing, and the same hand-written sibling is the recovery.

The parser now preserves the legacy document's preamble, but `renderIdeabox`
(`lib/fluid/render-ideabox.js`) emits a hardcoded `PREAMBLE`, so the first projection after migration
replaces the project's own heading and introductory prose with the standard template. Ideas, clusters,
custom fields and bodies all survive; the document *around* them does not.

Measured on forge-top's ideabox: `# Forge Ideabox` and its two-line introduction are replaced.

**Why it is not fixed here.** The obvious fix — carry the preamble forward from the file being replaced
— was implemented, and it broke `test/fluid-cutover.test.js:636`: `render` is documented as "the way
back from any hand edit" (`lib/ideabox-cli.js`), which requires the projection to be independent of its
destination. Reading the preamble from the destination means a hand-corrupted heading survives the
repair that exists to remove it. Both behaviours are legitimate and they are mutually exclusive while
the preamble lives only in the markdown.

The fix is to make the preamble **canon** — captured into the store at import and rendered from there,
like every other part of the projection. That needs a home in the record model (and a decision about
what a remote SmartMemory-backed store does with a per-document preamble), which is a design change
rather than a bug fix.

`renderIdeabox` already accepts an optional `preamble`; nothing supplies one. That is the seam.

## FU-5 (P2) — the `books` ideabox uses a hand-authored section the model has no place for

**RESOLVED 2026-09-07 — the owner chose the hand conversion, not a dialect change.** `books`
@434c6bc ("convert to the supported structure so the 9 ideas are readable") moved the nine ideas
back under `## Ideas` with `**Status:** PROMOTED (→ ORGANIZER-UI Phase 3)` on each and H3 umbrellas
for the grouping; the `## Promoted Ideas` section is gone. Checked 2026-09-07: `parseIdeabox` on
`my/books/docs/product/ideabox.md` returns 9 ideas, 0 killed, all `PROMOTED`. The dialect is
unchanged. What remains is not a format problem: `books` has no `.compose/compose.json`, so its
ideabox commands still need `compose init` before they run.

`my/books/docs/product/ideabox.md` declares 9 ideas that the parser still cannot read, so the gate
refuses it (correctly — nothing is destroyed, and the refusal names every id).

Its `## Ideas` section is deliberately empty — *"(none currently — all filed ideas have been promoted;
see below)"* — and the ideas live under a hand-made `## Promoted Ideas` heading, grouped by H3 umbrellas.

**Refusing is the right behaviour and this is not a bug in the gate.** The document's structure carries
a claim the record model has no representation for: not "these ideas are promoted" (there is a status
for that) but "this section is the promoted archive". Importing them under an invented heading would
be a guess about intent, which is the class of thing this gate exists to refuse.

The fix is a decision, not a parse: either that section becomes part of the dialect, or the project
converts by hand (set each idea's status to PROMOTED and let the projection group them). Until then
`books` cannot use the ideabox commands — a real cost, and the reason this is filed rather than closed.
