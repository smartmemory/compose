# COMP-JUDGMENT-BITEMPORAL — KILLED

**KILLED (2026-08-08):** the premise was disproved on verification. The feature
was filed, prioritized P1, and committed before anyone read the judgment store.

**Killed at phase:** planned (never designed, never built)

## What it claimed

> Amending a judgment position overwrites the belief. The ledger is the only
> history, so answering "what did we believe when we made that call?" means
> replaying the ledger rather than querying. Two timestamps are near free now
> while the store schema is young.

## What is actually true

| Claim | Verdict | Evidence |
|---|---|---|
| Amendment overwrites the belief | **FALSE** | `judgment_position_amend` copies the latest revision, drops `rev`, and writes a **new** revision (`lib/judgment-writer.js:2931+`) |
| The ledger is the only history | **FALSE** | `position_revision` carries `rev`; supersession runs through `supersedes: <slug>#r<N>`; retraction writes a tombstone rather than deleting |
| Amendment needs to become non-destructive | **FALSE** | it already is, by construction |
| The schema is young, so this is cheap | **MISLEADING** | the revision model is already load-bearing; adding a second temporal axis is a change to a working design, not a free field |

## The one true residual

`position_revision` carries only `provenance.written_at` — transaction time.
There is no valid-time axis on positions.

But the codebase already has the concept where it decided it mattered: `fact_at`
is a `date` field on facts. So valid time was considered and deliberately not
applied to positions.

That makes the residual a **design question** ("should a position record when a
belief was true of the world, separately from when it was written?"), not a
defect. Re-filed in the ideabox rather than carried as a feature, because a
feature asserts there is something to fix and there is not.

## Why this is recorded rather than deleted

The feature reached ROADMAP.md with a false justification. Deleting the row
would hide that it was ever there and make the same mistake repeatable. The
mistake was writing four features from a README teardown plus memory of this
codebase, without reading the code first. The design gate caught the first
instance; this one was caught only because that failure prompted a verification
pass.

**Reversal:** if the valid-time question is answered "yes", file a fresh feature
from the ideabox entry. Do not resurrect this record — its framing is wrong even
where its conclusion might land.
