# Implementation report — FOH-7 PORTFOLIO

**Related documents:** [design-foh-7.md](design-foh-7.md) · [blueprint-foh-7.md](blueprint-foh-7.md) ·
[foh-7-progress.md](foh-7-progress.md)

**Status: SHIPPED** 2026-09-06 @ce1b740; **LIVE-FIRE PASSED** the same day, evidence in
[livefire-foh7/RESULTS.md](livefire-foh7/RESULTS.md). Full suite green.

## Summary

One colleague turn can now span several declared products and answer with findings grouped by source,
naming every product it could not reach. Read-only. Membership is an explicit list; nothing is discovered.

## Delivered vs planned

All five blueprint slices landed as specified. Two things were built that the blueprint named but the
first implementation pass skipped — `assertMemberWorkspacesDistinct` and the flat Maya projection — and
both were caught by review rather than by me.

| Slice | Delivered |
|---|---|
| S0 | `parsePortfolioConfig` in `lib/fluid/factory.js` — the authoritative validating reader, never the lenient one |
| S1 | `lib/fluid/portfolio.js` — concurrent open, per-member deadline, named omissions, all-failed raises |
| S2 | `composePortfolioContext` + `toMayaContext` in `lib/colleague/context.js` |
| S3 | Closed `scope` enum, three refusals, member workspace check, both projections |
| S4 | Grouped findings, key-collision fixes, deduped `sent`, disabled writeback, connected funnels |

## Key implementation decisions

**The portfolio composer is separate, not a widened one.** `composeColleagueContext` is untouched and
byte-identical, verified against HEAD by the reviewer. A portfolio bug therefore cannot degrade the
ordinary turn.

**The migration guard's own lesson, applied.** `portfolio` is parsed in `factory.js` and nowhere else.
`lib/maya-config.js` reads the same file leniently and would have turned a typo into "no portfolio
declared" — a silent downgrade to a one-product answer. This is the same two-readers shape that produced
COMP-IDEABOX-MIGRATE-DIALECT earlier the same day.

**Budget split evenly, not first-come.** Maya caps the context section at 1,600 tokens and keeps a
*prefix*, so an unbudgeted portfolio silently loses its later products while the panel still reports
every source as sent. A first-come budget would have done the same thing one layer down, privileging
whichever product sorts first for a reason no reader could infer.

**The 403 diagnosis travels in the error message.** Ugly, and deliberate. The SmartMemory SDK wraps
whatever the `fetchFn` throws and keeps only its text — no `cause`, no status, no custom fields
(verified empirically: the wrapper arrives with status 0 and every property lost). Since we author both
the throw and the parse, and the marker is our own text rather than user data, encoding it is
deterministic; reconstructing it downstream from an object that no longer exists is not.

**Member-vs-member workspace distinctness is deliberately NOT enforced.** Two declared products may
legitimately share a workspace. The first blueprint draft added that rule; the gate correctly identified
it as our policy rather than a required invariant, and it was removed.

## Review history — 4 rounds, 20 findings, all accepted

Two blueprint rounds (11) and two implementation rounds (9 so far). **Every finding was real.** The
pattern across all four rounds is worth recording, because it is one pattern:

**Round 1 (blueprint)** reversed two of my own calls. I had proposed classifying 403s vaguely to avoid
plumbing headers through a shared error type — but the headers were already at the transport boundary,
so the cost I was avoiding did not exist. I had also called the refusal funnels "wiring that exists"
when their copy was specific to a different problem entirely.

**Round 2 (blueprint)** found that three round-1 fixes were *intentions rather than executable
contracts*: D1 named no field, no mapping and no test; the two-projection requirement had no assertion
that would fail if source were dropped; the declaring-root rule had no production error path.

**Round 3 (implementation)** found the flat projection did not exist in production. The route sent
`context.blocks` straight to Maya with the nested `source`, and **the test that was supposed to catch
this built the projection itself and asserted on its own construction.** The blueprint contains a
paragraph warning about exactly this, in my own words. Writing the warning did not prevent the failure.

**Round 4 (implementation)** is in flight; the fixes it prompted include a defect I introduced by
connecting the funnels — the funnel view *replaces* the chat, and my turn-opened funnels had no way
back, so a bad turn became a dead end until reload. Worse than the inline error it replaced.

## Lessons

**A test that constructs the thing it is testing proves nothing.** Two separate instances here: the flat
projection test built the projection, and the fixed-point test rendered twice from an unchanged store
(identical by construction for a deterministic renderer). Both were green. Both were worthless. The
question to ask of any assertion is *what would have to change in production for this to go red* — and
if the answer is "nothing", the test is decoration.

**Asserting an absence is not asserting a property.** "No nested `source` reaches Maya" passes when
source is simply dropped. The property was that the identity SURVIVED. An assertion about what is gone
should almost always be paired with one about what remains.

**Writing the warning is not the control.** The blueprint's most emphatic paragraph described the exact
failure the implementation then committed. This is the third recorded instance of that shape in this
repo ([[feedback_review_loops_catch_unwired]], [[reference_dead_paths_under_green_suites]]). The control
that worked was an independent reader with a mandate to look at the production path — not the note.

**Connecting an existing surface is rarely free.** "The funnel views already exist, they just need
wiring" was true and useless: their copy diagnosed a different problem, and they had no exit because
nothing had ever entered them from a recoverable state.

## Known gaps

Recorded in [blueprint-foh-7.md](blueprint-foh-7.md) and unchanged by implementation:

- ~~The live cross-product turn and the mixed-provider portfolio are not yet exercised.~~ **Both passed
  live 2026-09-06** ([livefire-foh7/](livefire-foh7/RESULTS.md)). The first real turn found two defects
  the green suite could not reach: `has('recall')` against a provider declaring `'RECALL'` (every
  member listed, never searched — the stubs had replaced `has()` outright), and a hardcoded NDA `v1`
  after upstream moved to `v2` (every fresh colleague identity failed its first turn). Both fixed and
  pinned by tests that are red without the fix. A fifth review round would not have found either;
  the live turn found both in under a minute.
- **The local floor has no `recall` capability at all**, so a portfolio of local-floor products is
  entirely listed-not-searched. Honest, named per member, and a real constraint on what the feature can
  demonstrate before SmartMemory is standing.
- FU-1..FU-5 from COMP-IDEABOX-MIGRATE-DIALECT are unrelated and still open.
