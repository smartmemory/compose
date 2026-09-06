# COMP-IDEABOX-MIGRATE-DIALECT — deferred findings

From the Codex (gpt-6-astra/high) adversarial review, 2026-09-06. Each is real and reproduced by the
reviewer; each is deferred because it needs its own design, and none is a regression introduced by this
fix. Fixing them inside this bug would have turned a data-loss stop into an open-ended refactor.

## FU-1 (P1) — the resume policy cannot resume an ordinary interrupted migration

`importIdeabox` creates records sequentially (`lib/fluid/import-ideabox.js:110`). If it writes idea 1
and crashes on idea 2, ideas 3..N were never issued, so the gate classifies them as hand-added strays
and refuses (`lib/fluid/ideabox-migrate.js`). The recovery the error names is circular: it recommends
`compose ideabox add`, which runs the same gate, and the comments recommend `render`, which runs it too
(`lib/ideabox-cli.js:301` — and now the projection boundary as well).

The existing "crashed partway" test completes the migration and deletes records afterwards
(`test/fluid-cutover.test.js:281`), so it exercises a resumable prefix and never the unattempted tail.

Needs a durable migration manifest tied to the source document, not an inference from the event log.

## FU-2 (P2) — other parser callers still read failure as absence

The readability check lives in the migration gate only. Two callers parse independently and treat a
failed parse as an empty one:

- `lib/fluid/import-ideabox.js:61` — a direct import can silently import only the subset it recognised.
- `readIdeabox` (`lib/ideabox.js`) → `compose new --from-idea` (`bin/compose.js:957`) reports
  "idea not found" and proceeds without the requested content.

The diagnostics belong in a shared parse result that every caller receives, rather than in one caller.
This is the same shape as the original bug, one level up: the fix so far guards the destructive path,
not the parse.

## FU-3 (P1) — no source fingerprint between the check and the replacement

The gate reads the markdown (`lib/fluid/ideabox-migrate.js`); the projection acquires its lock and
replaces the file later (`lib/fluid/render-ideabox.js:236`). Nothing verifies the file is still the one
that was checked.

Failure: migration reads the legacy file, an editor saves a new idea into it while the import runs, and
the projection then replaces that newer file from records built out of the older version. The added
idea never reaches the store and is destroyed.

Wants the source hash captured at gate time and re-verified inside the projection lock, refusing on a
mismatch. Narrow, but it is a genuine lost-update window on a file the user may have open.

## FU-4 (P2) — a project's own title and introduction are replaced by the template on migration

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
