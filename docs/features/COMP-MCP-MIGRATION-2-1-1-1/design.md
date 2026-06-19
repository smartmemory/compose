# COMP-MCP-MIGRATION-2-1-1-1: `/compose migrate-anon` interactive flow — Design

**Status:** COMPLETE (shipped 2026-06-19; 3-round Codex design review + 2-round impl review, all CLEAN; 15 tests)
**Date:** 2026-06-19
**Build path:** `/compose build --quick`
**Revised:** 2026-06-19 — Codex design review r1 (transaction safety, `force` semantics, status normalization, duplicate-row targeting, position-with-string-peers)

## Related Documents

- Parent: [`COMP-MCP-MIGRATION-2-1-1`](../COMP-MCP-MIGRATION-2-1-1/design.md) — lossless ROADMAP round-trip; **Decision 3** filed this follow-up and stated the (incorrect) promotion contract corrected below
- Roadmap row: `COMP-MCP-MIGRATION-2-1-1-1` (Phase 7: MCP Writers)

---

## Why

`COMP-MCP-MIGRATION-2-1-1` settles historical *anonymous-numbered* ROADMAP rows
(the `| — | Item | Status |` Phase 0–4.5 form) by preserving them **verbatim** —
they round-trip losslessly without becoming typed features. That's the right
default for ~10 shipped-work rows. This ticket adds the UX for the occasional
case where one such row earns promotion to a typed feature (to flip its status,
link it, or query it via the typed-tool surface).

## Goal

`compose migrate-anon` — an interactive CLI flow that walks anonymous rows one at
a time and, per row, offers: **(a)** assign a feature code (promote), **(b)**
leave anonymous (skip), or **(c)** abort (apply nothing, resume later).

## ⚠️ Spec correction (load-bearing — found during exploration)

The parent's Decision 3 and this ticket's text claim:

> "the human creates a `feature.json` whose **phase + position** matches the row,
> and the writer replaces the anonymous row on next regen."

**This is false against the shipped code.** Verified mechanics:

- Anonymous rows are re-emitted on regen by **`predecessorCode` anchoring**, not
  position (`lib/roadmap-gen.js` `emitAnonAfter`). `lib/roadmap-preservers.js`
  `readAnonymousRows()` returns `Map<phaseId, [{ rawLine, predecessorCode }]>`.
- A row stops being anonymous **only when its raw Feature-column cell becomes a
  valid `FEATURE_CODE_RE_STRICT` code** (`roadmap-preservers.js:163-173`).
- Therefore scaffolding a `feature.json` **alone** does not replace the row — the
  `—` row still passes through verbatim and you get a **duplicate** (new typed
  row *plus* the surviving anonymous row).

**Consequence for this design:** there is no position-keyed replacement
primitive to reuse. `migrate-anon` must itself **strip the source anonymous
`rawLine` from `ROADMAP.md`** before scaffolding + regen. This is the one genuinely
new piece of logic; everything else is reuse.

---

## Decision 1: Reuse `readAnonymousRows` for the row model; parse cells from `rawLine`

**`readAnonymousRows` is the canonical source for *which* rows are anon and how
they anchor** — drive classification, the `rawLine` to strip, and `predecessorCode`
off it (`lib/roadmap-preservers.js:82`), **not** `parseRoadmap`'s `_anon_<n>`
entries (those carry no raw text). This guarantees the row we strip is exactly the
one regen's `emitAnonAfter` treats as anon — no classifier divergence.

**Cell display/seed is header-aware (Codex r1, finding 2).** `readAnonymousRows`
returns only `{ rawLine, predecessorCode }`; the corpus contains **both** 3-col
`| # | Item | Status |` and 4-col `| # | Feature | Item | Status |` anon tables
(`test/roadmap-preservers.test.js`), so a data row cannot be parsed in isolation —
the title/status columns differ by table. `collectAnonRows` therefore captures, per
anon row, the **governing table header** (nearest preceding header row in the same
phase), runs `detectColumnLayout(headerCells)` on it (returns `{codeCol, descCol,
statusCol}`; exported — currently private at `:195`, this flow's only non-test
source-visibility change), and reads cells via `splitRoadmapCells(rawLine)` indexed
by that layout. **This layout is used only for display + the status seed — never
for classification or stripping** (those use `readAnonymousRows`' `rawLine` directly),
so a display misread can never corrupt the strip/anchor.

Each presented row: `{ phaseId, occurrenceIndex, num, title, status, rawLine,
predecessorCode }`. `phaseId` is the bare heading **title** (the form
`readAnonymousRows` keys on); `occurrenceIndex` is the row's 0-based position among
anon rows **within its phase** (needed for safe removal — Decision 2).

**Status normalization (Codex r1, finding 3):** the raw Status cell can be
`**IN_PROGRESS**`, `PARKED — reason`, or blank, none of which are the canonical
enum `addRoadmapEntry` requires. Normalize it with `parseStatusToken()` (exported,
`lib/roadmap-heading.js:30`) — the same leading-token matcher the parser uses — to
seed a canonical `status`. A blank/unparseable cell seeds `PLANNED`. The seed is
only a *default*: the interactive walk shows it and lets the user confirm or pick
from `STATUS_TOKENS` (Decision 4), so the committed `feature.json` status is always
canonical and human-confirmed.

## Decision 2: Promotion = strip rawLine (phase-scoped), then scaffold via `addRoadmapEntry`

`promoteAnonRow(cwd, row, code, status)`:

1. Uppercase + `isFeatureCode()`-validate `code`; refuse if a feature with that
   code already exists (mirrors `server/feature-scaffold-routes.js:27,33`).
2. **Strip** the row's `rawLine` from `ROADMAP.md` — **phase-scoped and
   occurrence-specific** (Codex r1, finding 4): locate the row's phase block and
   remove the `occurrenceIndex`-th anon line within it, **not** a global string
   replace (two historical rows can share identical text, e.g. repeated
   `| — | … | COMPLETE |`; a global replace would delete the wrong one or all
   copies). Write the stripped text to disk.
3. Call `addRoadmapEntry(cwd, { code, description: row.title, phase: row.phaseId,
   status, complexity: 'S', position })` (`lib/feature-writer.js:99`) — writes
   `feature.json` and regenerates `ROADMAP.md`. Reused (same path the cockpit
   scaffold route uses), so code-format/exists/narrative-owned checks come for free.

**No `force` (Codex r1, finding 2 — corrected).** `roundtripGuard` blocks *only* on
fixed-point divergence, **not** on losslessness (`lib/feature-writer.js:234-236`),
so the earlier "strip would trip the guard as lossy" rationale was wrong. Default
`force:false` is correct: after a strip the regen *should* be a fixed point (anon
row gone from base, typed row rendered from `feature.json`); if it somehow isn't,
that divergence is a real signal to surface, not to force through.

Ordering matters: the strip is written to disk **before** `addRoadmapEntry`,
because the guard and regen both read `ROADMAP.md` **fresh** from disk
(`roundtripGuard` → `readRoadmapBase`; `renderRoadmap` → `generateRoadmapFromBase`).
Strip-first is what prevents the duplicate.

**Transaction model (Codex r1, findings 1 — corrected, then refined r2).** Apply
promotions **one at a time**, never strip-all-up-front (which could leave later rows
deleted with no replacement if a mid-batch scaffold fails). Per promotion: snapshot
the current `ROADMAP.md`, strip the one row, write, `addRoadmapEntry`. Failure
handling **keys on the error code**, because `addRoadmapEntry` commits `feature.json`
*before* regenerating `ROADMAP.md` (`lib/feature-writer.js:151,154`):

- **Pre-commit failures** (code-exists, validation, `ROUNDTRIP_NOT_FIXED_POINT` — all
  thrown by `roundtripGuard`/validation *before* `feature.json` is written):
  **restore the snapshot** (re-write the un-stripped `ROADMAP.md`) and stop. Nothing
  was committed; the anon row is back.
- **`ROADMAP_PARTIAL_WRITE`** (`feature.json` already committed, regen failed): **do
  NOT restore** — restoring would re-add the anon row *alongside* the now-committed
  typed feature, recreating the exact duplicate this flow avoids (Codex r2). Surface
  the typed envelope as-is and stop; re-running regenerates `ROADMAP.md` from the
  complete feature set (typed row, no anon row, no dup).

Guarantee: no anon row is ever left stripped **with neither** a typed replacement
**nor** its original row. Earlier promotions stay committed; remaining ones are
untouched. **Abort** at the prompt writes nothing.

## Decision 3: Position — best-effort end-of-phase via a string-aware max (documented limitation)

The promoted feature gets an explicit `position` = `max(positionSortKey(peer.position))
+ 1` over its phase peers. We compute this ourselves with `positionSortKey`
(`lib/feature-json.js:108`) rather than relying on `nextPositionInPhase`, which
coerces any non-number position to `0` (`lib/feature-writer.js:187-190`) and would
therefore return `1` — *not* end-of-phase — in a phase that already uses
string/ranged positions (Codex r1, finding 5).

Strict intra-phase order-preservation is still **not** attempted in v1: `position`
is typed `integer | string` (`contracts/feature-json.schema.json`), so there is no
fractional key to slot a row *between* two integer positions, and renumbering
siblings is out of scope. Anonymous rows are historical/shipped and the promotion's
value is queryability/mutability, not visual order. **Known limitation, surfaced in
the flow's output:** a promoted row sorts to the end of its phase table.
Predecessor-anchored renumbering is a possible later enhancement.

## Decision 4: Thin CLI dispatch; engine in `lib/migrate-anon.js` with injectable streams

`bin/compose.js` gets a `migrate-anon` block (after the `migrate-state` sibling,
~`:778`): resolve workspace via `resolveCwdWithWorkspace(args)`, parse `--dry-run`
/ `--non-interactive`, delegate to `await import('../lib/migrate-anon.js')`, then
`process.exit(0)`. Add a help line (`bin/compose.js:110-143`).

The engine `runMigrateAnon(cwd, { input, output, nonInteractive, dryRun })` takes
**injectable streams** (mirrors `lib/gate-prompt.js` / `lib/questionnaire.js`) so the
prompt loop is testable without spawning. Prompt idiom = promisified
`rl.question` (the `ideabox triage` walk at `bin/compose.js:2707`).

Per-row prompt sequence: show the row (`#`, title, inferred status, phase) →
**(a)** enter a feature code, **(b)** Enter to skip (leave anonymous), **(c)** `q`
to abort. On (a): validate the code; then **confirm or override the status** (the
`parseStatusToken` seed is offered as the default, override picks from
`STATUS_TOKENS`) so the committed status is canonical and human-confirmed.

**Non-TTY / non-interactive guard:** if `!process.stdin.isTTY`, or `--dry-run`, or
`--non-interactive` → **list** the anonymous rows and exit without prompting (the
existing `ideabox triage` loop lacks this guard and would hang on piped stdin;
`lib/build.js:171` is the guard idiom). This listing path doubles as the
spawn-testable non-interactive surface. No anonymous rows → print "none" and exit 0.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/migrate-anon.js` | new | Engine: `collectAnonRows(cwd)`, `promoteAnonRow(cwd, row, code)`, `runMigrateAnon(cwd, {input,output,nonInteractive,dryRun})`. Reuses `readAnonymousRows`, `splitRoadmapCells`, `addRoadmapEntry`. |
| `bin/compose.js` | existing | Thin `migrate-anon` dispatch block + help line. |
| `test/migrate-anon.test.js` | new | See test plan below. |
| `CHANGELOG.md` | existing | Entry. |

## Test plan

- **`promoteAnonRow` golden (the spec-correction guard):** fixture `ROADMAP.md`
  with an anonymous row → promote → assert (a) `feature.json` exists with the
  right code/phase/status/description, (b) regenerated `ROADMAP.md` contains the
  typed row and **no `—` duplicate** of it, (c) other anonymous rows untouched.
- **Duplicate-text rows (finding 4):** two identical `| — | … | COMPLETE |` rows in
  one phase → promoting the second leaves the first intact (occurrence-specific
  removal, not global replace).
- **Status normalization (finding 3):** rows with `**IN_PROGRESS**` / `PARKED — reason`
  / blank cells → seeded status is the canonical enum; committed `feature.json`
  status is valid.
- **Transaction safety (finding 1):** force a scaffold failure on the 2nd of 2
  promotions (e.g. duplicate code) → assert the 1st stays committed and the 2nd's
  anon row is **restored** in `ROADMAP.md` (not left stripped).
- **Interactive walk (Pattern A, injected `PassThrough` streams):** script
  answers (promote one, skip one) → assert the promoted one is gone + scaffolded,
  the skipped one round-trips verbatim.
- **Abort** applies nothing.
- **Validation:** invalid code rejected; already-existing code rejected.
- **Non-interactive / non-TTY:** lists rows, writes nothing, exits 0 (no hang).
- **No anonymous rows:** clean "none" message.

## Out of scope (unchanged from stub)

Bulk auto-migration; code-synthesis from row text (the human types the code);
non-anonymous ROADMAP structure; intra-phase order preservation (Decision 3).

## Open Questions

None blocking. Escalation check: single new lib module + thin CLI block + tests —
cohesive single-flow, fits `--quick`. No architecture/PRD-level concerns.
