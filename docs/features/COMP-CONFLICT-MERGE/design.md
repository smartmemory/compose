# COMP-CONFLICT-MERGE — Design

**Status:** COMPLETE (2026-08-09) | **Promoted from:** IDEA-27
**Source:** Semantica teardown (semantica-agi/semantica), 2026-08-08

## Related Documents

- Plan stub: [plan.md](plan.md) (superseded in part — see "Correction to the promoted framing")
- Ideabox origin: `docs/product/ideabox.md` (IDEA-27)
- Touches: `lib/roadmap-gen.js`, `lib/roadmap-preservers.js`, `lib/roadmap-roundtrip.js`, `bin/compose.js` (`roadmap generate`)

## Correction to the promoted framing

The ideabox entry and `plan.md` describe the fix as **field ownership**: declare
which fields a generator owns, diff the incoming value against stored values on
the fields it does not own. That framing assumes the target is a record with
typed fields.

`ROADMAP.md` is not a record. It is a **text document** that is part generated
(feature rows) and part hand-authored (phase prose, exit criteria, curated
tables, narrative). "Which fields does the writer own" has no clean answer here.
The right question is **"what content existed before that is not in the output,
and can the writer account for it?"**

The acceptance criteria in `plan.md` that name field ownership are superseded by
this document. The stance from IDEA-27 is unchanged: **a merge that cannot
detect contradiction is a merge that loses data quietly.**

## Current behaviour (verified, not assumed)

`compose roadmap generate` (`bin/compose.js:1236-1263`):

1. `writeRoadmap(cwd)` regenerates and **writes the file unconditionally**.
2. `checkRoundtrip(...)` runs **after** the write.
3. If not a fixed point, it writes a second time with the canonical text.
4. Prints "Generated ROADMAP.md from feature.json files".

`generateRoadmapFromBase` (`lib/roadmap-gen.js:56-67`) preserves base content
through exactly six readers in `lib/roadmap-preservers.js`:

| Preserver | Preserves |
|---|---|
| `readPhaseOverrides` | explicit phase status overrides |
| `readAnonymousRows` | rows with no feature.json backing |
| `readPreservedSections` | content inside `<!-- preserved-section: id -->` markers |
| `readPreservedSectionAnchors` | where those sections re-attach |
| `readPhaseOrder` | phase ordering |
| `readPhaseBlocks` | whole phase blocks **only for phases with no feature.json features** |

This is a **whitelist**. Content that matches none of the six is dropped.

### Why the existing losslessness guarantee does not catch it

`checkRoundtrip` reports `lossless: true` when every feature.json entry has a
matching row and no row lacks a backing feature. Its diff kinds
(`LOSSLESS_MISSING`, `LOSSLESS_EXTRA`, `LOSSLESS_CHANGED`) are all **row-level**.
Prose is outside its model entirely, so `roadmap check` can print
"fixed point, lossless" on a file that just lost a curated block.

That is the actual defect: **the guarantee that exists is narrower than the
guarantee the message implies.**

### CORRECTION (2026-08-08, design gate round 1)

The first draft of this document claimed that prose in a phase with feature.json
features falls to a table-rebuild path and survives only if wrapped in
`preserved-section` markers. **That is false and the claim is withdrawn.**

`generateRoadmapFromBase` routes typed phases through `spliceTableIntoBlock`
(`lib/roadmap-gen.js:159`), which emits prose before the table, regenerates only
the table, and re-emits everything after it (`lib/roadmap-gen.js:337-345`).
`test/roadmap-roundtrip.test.js:83` asserts curated intro prose survives
regeneration. The misread came from the doc comment on `readPhaseBlocks`, which
describes it as a fallback "for phases that have no feature.json features" —
stale, since the call site consults it for typed phases too.

**General prose preservation works.** This feature is therefore much narrower
than filed: two specific, verified loss paths, not a systemic clobber.

### The two verified loss paths

**1. Unbalanced preserved-section marker** (`lib/roadmap-preservers.js:233`).
An open marker with no matching close is **silently discarded**, with the comment
"could log, but tests expect empty/missing". A typo'd close marker therefore
deletes exactly the content it was meant to protect.

**2. Duplicate phase-heading collision** (`lib/roadmap-preservers.js:268`).
`readPhaseBlocks` stores blocks in a `Map` keyed by phase id (`out.set(currentPhaseId, block)`).
Two `##` headings with the same text collapse to the last one and the earlier
curated block is dropped. This is reachable in practice: an unmarked curated
`## Key Documents` block survives pass one, `buildKeyDocs` appends another
(`lib/roadmap-gen.js:187`), and pass two keeps only the appended one.

Path 2 is only reachable because the CLI can write the result of a **later**
generation pass, which drives the requirement below.

## Approach: a residue check before the write

Rather than model ownership, compute what the regeneration failed to carry over.

**Residue** = a line present in the base text, non-trivial, that is absent from
the generated output and is not explained by a legitimate regeneration.

```
base ──→ fixed-point generate (all passes) ──→ FINAL canonical bytes
     └──→ residue(base, FINAL) ──→ [] ? write once : ProseLossConflict
```

**Compare against the final canonical bytes, never the first pass.** The CLI
today writes `rt.canonical` after additional generation passes
(`bin/compose.js:1256`), and loss path 2 above only manifests on pass two.
Checking the first candidate would pass cleanly and then write the lossy result.
Compute the fixed point first, compare base against exactly what will be written,
then write once.

### Computing residue without false positives

Naive line-diff is unusable: rows legitimately change when a status flips.
Classify each base line first, and only prose is eligible to be residue.

**Membership is not enough — use an occurrence-aware multiset.** Asking "does
this base line appear anywhere in the output" cannot detect losing one of two
identical lines, which is precisely the duplicate-block case. Key the multiset by
`(line text, containing block)` and compare counts, so losing one occurrence of a
repeated heading or row is still residue.

Excluded from the residue set:

1. **Blank and structural lines** (`---`, table rules, fence markers).
2. **Feature-row lines** — anything `parseRoadmap` resolves to a feature code.
   These are the generator's to rewrite. Row loss is already covered by
   `checkRoundtrip`, and duplicating it here would double-report.
3. **Table header lines**, which are regenerated verbatim per phase.
4. **Heading lines whose phase still exists** in the output.

What remains is hand-authored prose, curated non-feature tables, and headings for
phases that vanished. If any of that is present in base and absent from
candidate, the write is a **conflict**, not a merge.

### Failure mode

Emit a typed error rather than a warning, and do not write:

```js
class RoadmapProseLossError extends Error {
  code = 'ROADMAP_PROSE_LOSS';
  // lines: [{ lineNo, text, nearestHeading }]
  // remediation: wrap in <!-- preserved-section: <id> --> … or pass --accept-loss
}
```

This is the typed-error shape IDEA-2 asks for, scoped to one writer. It carries
`field_path` equivalent (`nearestHeading` + `lineNo`), `source_of_truth`
(`ROADMAP.md`), and a remediation string naming the exact marker to add.

### Operator resolution

`compose roadmap generate` gains three outcomes instead of one:

- **default** — halt on residue, print the lost lines with their headings and the
  marker syntax to protect them. Exit non-zero. Nothing written.
- `--accept-loss` — write anyway, after printing what was dropped. The escape
  hatch has to exist (some prose really is stale) but it must be explicit and
  named for what it does.
- `--protect` — rewrite the base in place, wrapping each residue block in
  `preserved-section` markers with generated ids, then regenerate. Turns the
  error into a one-command fix.

`--protect` is the piece that makes this humane rather than merely correct. Halting
without an automated remedy trains people to reach straight for `--accept-loss`.

## Scope

**In:**
- Residue computation + typed error
- Wiring into `roadmap generate` (pre-write, replacing the unconditional write)
- The three operator outcomes
- Fixing the unbalanced-marker silent drop at `roadmap-preservers.js:235` to
  raise rather than discard

**Out (explicitly):**
- The build-stream / active-build last-writer-wins race. Same stance, different
  writer, and it wants the Umbrella B concurrency primitives first. Filed
  separately, not smuggled in here.
- Generalizing residue checking to other writers. Prove it on the one that has
  already bitten.
- **The provider render paths.** The first draft claimed the MCP writers "call
  the same generate path, so they inherit the check". **False, withdrawn.**
  `lib/tracker/local-provider.js:101` calls `writeRoadmap` directly and
  `lib/tracker/github-provider.js:524` calls `generateRoadmapFromBase` directly,
  neither through the CLI branch. Worse, `addRoadmapEntry` persists the feature
  **before** rendering (`lib/feature-writer.js:259`), so halting at render time
  leaves a partial write rather than "nothing written".

  This feature therefore ships a **CLI-scoped guarantee**, stated as such. Moving
  the check into every provider render path (and making the persist+render pair
  atomic) is a separate, larger piece of work. Do not imply coverage that does
  not exist — that is the same class of error as the row-level losslessness
  message this feature exists to fix.

## Alternatives considered

**Block-level offset tracking** — thread byte offsets through all six preservers
and flag unconsumed ranges. More precise than line classification and would catch
partial-line loss. Rejected for v1: it means touching every preserver, and the
line-level check catches the failure that actually happened. Revisit if residue
produces false negatives in practice.

**Make everything a preserved-section by default** — invert the whitelist so
prose survives unless marked generated. Rejected: it changes the file format for
every existing consumer and makes the generator's output non-deterministic with
respect to hand edits. The residue check gets the same protection without
redefining the format.

**Warn instead of halt** — rejected outright. A warning on a command whose whole
job is to rewrite the file is a warning nobody reads, and the failure is silent
data loss. IDEA-3 (no-silent-fallback) argues the same way.

## Open questions

- [ ] Should `--protect` generate section ids from the nearest heading slug, or
      require the operator to name them? Slug is friendlier, collision handling
      needed.
- [ ] Does `roadmap check` also grow a prose-residue verdict, so drift is visible
      without running generate? Leaning yes, cheap, but it needs a base to
      compare against and check only has one file.

## Acceptance criteria

- [x] `residue(base, candidate)` returns hand-authored lines lost in regeneration
- [x] Feature rows, structural lines, and table headers are never reported
- [x] `RoadmapProseLossError` carries lineNo, text, nearestHeading, remediation
- [x] `roadmap generate` computes residue **before** writing; nothing is written
      on conflict
- [x] `--accept-loss` writes and prints what was dropped
- [x] `--protect` wraps residue in `preserved-section` markers and regenerates
- [x] Unbalanced `preserved-section` open marker raises instead of silently
      dropping (and duplicate section ids, discovered in review)
- [x] Regression test: the exact historical failure — hand-authored prose inside
      a phase that has feature.json features survives a generate, or the generate
      refuses
- [x] Regression test: a normal status flip produces zero residue (no false
      positive)
- [x] `roadmap generate` on the live compose ROADMAP.md is residue-clean

## Implementation notes (2026-08-09)

Four Codex review rounds hardened the residue classifier. Two lessons worth recording:

- **Key Documents is generator-owned by identity, not shape.** buildKeyDocs emits
  `| `<path>` | <CODE> design |` rows; a curated row can look identical. Excluding
  by shape either silently dropped a curated look-alike or false-flagged a stale
  generated row on a designDoc change. The classifier keys on the actual feature
  set instead: a Key Documents row is the generator's only when its code is a
  current feature. Curated rows referencing a non-feature code stay eligible
  (path-2 preserved).
- **Occurrence counting must flag the FIRST of N duplicates**, because the
  collapse mechanism (readPhaseBlocks Map) keeps the LAST — otherwise the reported
  line and `--protect` target the surviving copy.

`--protect` id generation now slugs the nearest heading and dedupes against ids
already in the file (open question resolved: slug, not operator-named).
