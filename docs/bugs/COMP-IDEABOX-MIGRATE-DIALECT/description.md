# COMP-IDEABOX-MIGRATE-DIALECT — the migration gate no-ops on the dialect it exists to protect

**Severity: CRITICAL (silent data loss, shipped in a published package).**
Found 2026-09-06 while populating a second product for COMP-FOH FOH-7.

## Symptom

`ensureIdeaboxMigrated` (`lib/fluid/ideabox-migrate.js`) returns `{migrated: false, imported: 0}` for a
pre-cluster ("flat") `ideabox.md`. The gate then permits the mutation, `addIdea` allocates `IDEA-1`
against an empty store, and `writeIdeaboxProjection` overwrites the markdown with a projection
containing only the newly-typed idea.

The module's own header states this is the exact failure it was written to prevent:

> without this gate, the first `compose ideabox add` in an upgraded project allocates IDEA-1 against an
> empty store and the projection replaces that project's entire ideabox with the one idea they just
> typed. Their ideas would survive only in their git history.

The gate fires only for ideaboxes **already in the new dialect** — that is, projects that do not need
protecting. Every project that actually needs the upgrade path is invisible to it.

## Root cause (identified, not yet fixed)

`parseIdeabox` (`lib/ideabox.js`) accepts exactly one dialect:

```
## Ideas
### Umbrella A — <name>          <- cluster level
#### IDEA-N — <title>            <- FOUR hashes
```

The pre-cluster vintage, which is what an upgrading installation has, is:

```
## <Topic heading>
### IDEA-N — <title>             <- THREE hashes, no umbrella level
```

`parseIdeabox` returns `ideas: []` for the latter. `ensureIdeaboxMigrated` reads that empty list as
"markdown adds nothing → already migrated, proceed" — the second of its three documented states. The
third state (refuse) is unreachable for this input, because the refusal is computed from ids the parser
never produced.

The bug is a **silent parse failure being read as a semantic answer.** An empty parse of a non-empty
file is indistinguishable, at the call site, from a genuinely empty file.

## Reproduction (empirical, run 2026-09-06)

Fixture: a copy of forge-top's real `docs/product/ideabox.md` (162 lines, 18 ideas) in a throwaway
project, then a single `addIdea`.

```
add ok -> {"handle":"IDEA-1", "title":"CANARY — a brand new idea typed by an upgrading user"}
ideabox lines: before=162 after=28
IDEA- headings remaining: 3   (all of them the canary + conventions text)
```

18 ideas destroyed by one command. The new idea was additionally allocated **`IDEA-1`, colliding with
the original `IDEA-1`** — so even a git-history recovery has an id collision to reconcile.

Harness retained at `repro/` so the verdict outlives the session.

## Blast radius

- `@smartmemory/compose` is published (0.4.1). Any installation upgrading with a flat-dialect ideabox
  loses it on first `ideabox add|pri|kill|discuss|promote`.
- **forge-top is one such installation, and forge root is not git-tracked**
  (`feedback_forge_root_not_git`) — so there the loss would have been *unrecoverable*, not merely
  inconvenient. The docstring's "survive only in their git history" consolation does not hold here.
- Known flat-dialect ideaboxes on this machine: forge-top (18), books (9), ScaleMate (2),
  couples-team (1), trustflow (1).

## Expected

A flat-dialect ideabox is either imported (preferred — it is the upgrade path this module exists to
serve) or refused loudly. It must never parse to silence and be treated as consent.

## Fix approach (proposed, for the gate to review)

1. **Make the parse failure loud.** `ensureIdeaboxMigrated` must distinguish "file parsed to zero ideas"
   from "file has no idea-shaped content at all". A file with `IDEA-` tokens that parses to zero ideas
   is an unrecognized dialect and must refuse, never proceed. This is the safety fix and is independent
   of dialect support.
2. **Support the flat dialect in `parseIdeabox`** (3-hash ideas, no umbrella level) so the upgrade path
   actually works, mapping every flat idea into the `Unclustered` cluster.
3. Regression test per dialect, and a test asserting that an unparseable-but-non-empty ideabox refuses.

Step 1 is the P0. Step 2 is what makes the feature work.

---

## Fix — 2026-09-06

Five defects, not the two the first diagnosis named. Items 4 and 5 were found by the Codex
(gpt-6-astra/high) adversarial review; item 3 by a round-trip probe run while that review was in flight.

1. **The parser could not read the legacy dialect** — `lib/ideabox.js`. Legacy mode is detected only
   when the document has no `## Ideas` section and does carry H3 idea headings, so a modern file can
   never enter it. Legacy topic headings (`## Topic`) now map to **clusters**, which is what that
   dialect used them for, so the author's grouping survives the upgrade instead of flattening.

2. **The gate read an unreadable file as an empty one** — `lib/fluid/ideabox-migrate.js`. It now
   compares what the markdown *declares* against what the parser *produced* and refuses on any gap
   (`IdeaboxUnreadable`, HTTP 409). The declaration detector is deliberately punctuation-tolerant: the
   first version required the same ` — ` separator the parser requires, so it failed in the same
   direction as the thing it was checking and agreed the file was empty. Duplicate declarations — the
   half-converted document — refuse too.

3. **Migration was lossy even when it succeeded.** Custom hand-authored fields (`_extraLines`) were
   dropped, deleting IDEA-16's `**Triage (2026-07-24):**` paragraph from the very fixture that motivated
   this bug. Carried now as `extra_fields`. The record's fields turned out to be enumerated in **four**
   places — `contracts/fluid-record.schema.json`, `lib/fluid/record-shape.js`, and both providers — and a
   field missing from any one of them is silently dropped on write. The document's title and preamble
   were being dropped too, and are now preserved.

4. **The HTTP render bypassed the gate entirely** — `server/ideabox-routes.js`. The CLI twin gated and
   the HTTP one did not, so the cockpit's repair button could erase what the equivalent command refused
   to touch.

5. **…and guarding the callers was the wrong shape.** The guard now sits inside
   `writeIdeaboxProjection` (`lib/fluid/render-ideabox.js`) — the one boundary every projection write
   passes through. Guarding each caller is a list that must stay complete forever; guarding the
   boundary is a fact.

Three further findings are real, reproduced, and deferred with rationale in [followups.md](followups.md).

### The lesson worth keeping

The original diagnosis was correct and incomplete, and it was incomplete in a specific, repeatable way:
**it enumerated the failures on the path it had already looked at.** The parser bug was found by
following the symptom; the four others were found only by asking a different reader to look for what
the symptom did not point at. Notably, the module's own header comment describes this exact failure
class, and `import-ideabox.js:131` describes the dropped-field class and then fixes two instances of it
by name while leaving the general case — so the knowledge was present, written down, adjacent to the
code, and did not prevent any of it.

A comment explaining a hazard is not a control. The control here is the single write boundary, and the
tests that fail if it is removed.

## Round-2 review — four more defects, all introduced by the round-1 fixes

A second Codex pass targeting the fixes rather than the bug. Every finding below was created by the
repair, not by the original defect, which is the case for reviewing fixes as their own artifact.

**A. Fenced examples were content to the parser.** Round 1 taught the dialect detector and the
declaration scanner to skip ```` ``` ```` blocks; the parse loop itself still read them. So a
documentation example was imported as a real idea — and, worse, a fenced `#### IDEA-1` **satisfied the
readability guard on behalf of a genuine `IDEA-1` the parser could not read**, letting the destructive
write through the guard built to stop it. All three readers now agree on what counts as content.

**B. A legacy topic heading inherited the killed section.** The new `## Topic` → cluster branch set the
cluster but left `inKilledSection` and `inIdeasSection` untouched, so ideas under any topic heading
following `## Killed Ideas` were imported as KILLED — or, once the killed section had closed the ideas
section, vanished entirely.

**C. Killed ideas put custom fields in a different slot.** `serializeIdea` emits unrecognised fields
before the trailing known fields; `serializeKilledIdea` emits them after `**Killed:**`. The projection
used the live slot for both, so a killed idea carrying a custom field reordered the file on every write
and the projection stopped being a fixed point of the serializer.

*The test that should have caught C did not.* It rendered an unchanged store twice and asserted the two
were identical — which is true by construction for a deterministic renderer and proves nothing. The
real property is `serialize(parse(projection)) === projection`, and the test now asserts that. **A
fixed-point test that never runs the parser is not a fixed-point test.**

**D. A cluster may legitimately be named after an idea.** `compose ideabox` will create an umbrella
called `IDEA-9 — Cache research`. Treating every H3 that opens with an id as an idea meant the tool
could not round-trip its own output: the add succeeded and the next command refused, because the guard
saw a declared id with no record behind it. Resolved structurally — a document containing any
`#### IDEA-` heading has been written by the tools and is modern, so its H3s are umbrellas whatever
they are called. The hybrid dialect exists only in documents the tools have never written.

### What round 2 says about round 1

Round 1's fixes were correct in intent and four of them were wrong in a detail that only a reader
looking at the FIX could see. Three of the four are the same mistake in different clothes: **a rule
applied to some of the readers but not all of them** — fences skipped in two places out of three,
sections reset in one branch but not the sibling, custom fields placed for one serializer but not its
twin. The original bug was itself an instance of that shape (a guard that knew one dialect), which
suggests the shape is a property of this module's design and not of any one change: it has several
parallel readers of the same document and no single place that says what the document means.

### Round-2 follow-ons — four more, and the structural change that ends the class

Fixing A–D produced four further defects, each the same shape yet again:

- **Fence delimiters were dropped while their contents were kept**, so a fenced example inside an
  idea's body was written back unfenced, became a real heading, and the next render refused the file
  it had itself just written.
- **The section branches still prefix-matched** (`## Ideas`, `## Killed Ideas`) while dialect detection
  had been tightened to complete headings. `## Ideas for Later` lost its grouping; `## Killed Ideas for
  Later` filed explicitly `NEW` ideas as killed.
- **The guard still refused an umbrella named after an idea**, because only the parser had been taught
  that `### IDEA-9 — Cache research` is an umbrella. The tool could not read back its own output.
- **A reference bullet counted as a declaration**, so `- IDEA-1 needs research` inside IDEA-1's body
  made the gate refuse a perfectly readable file.

**Three of those four are one defect: the document had two readers, and only one of them was taught.**
The parser knew about fences and the declaration scanner did not, then the reverse; detection knew
about complete headings and the branches did not; the parser knew about idea-named umbrellas and the
guard did not.

So the last change is structural rather than another patch. **`parseIdeabox` now reports what it could
not read** — `unconsumed` (idea-shaped headings no branch consumed, counted rather than set-tested, so
a second copy of an already-parsed id is caught) and `collisions` (umbrellas named after ids that are
also real ideas here). `declaredIdeaIds` is gone, and the migration gate consumes the parser's own
view. There is now one reader of the document, and "I could not read this" is something it says about
itself instead of something a second scanner infers about it.

That is the actual fix for the original bug too. Everything before it was necessary; none of it
addressed why the failure kept regenerating.
