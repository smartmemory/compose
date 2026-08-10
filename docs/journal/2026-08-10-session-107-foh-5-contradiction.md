# Session 107 — FOH-5 CONTRADICTION, and the blocker that wasn't

**Date:** 2026-08-10
**Slice:** COMP-FOH FOH-5 (`CAP.CONTRADICTION`)
**Ships:** compose main `7731043`
**Companion:** [session 106](2026-08-10-session-106-foh-4-conviction.md) (FOH-4 CONVICTION)

## What happened

We picked up right after FOH-4 shipped, with the owner asking to continue the epic. The two
remaining undeclared capabilities were CALIBRATION and CONTRADICTION, both deferred in the
architecture doc "pending SmartMemory-side ontology work not yet scoped, or a real consumer."

So we started with an investigation, not a build. And the investigation's first verdict was
wrong — twice — in a way worth remembering.

**Reversal one: "both are blocked."** CALIBRATION genuinely is: its read surface
(`GET /agents/{id}/evaluation`) keys off an AGENT-type user row, and Compose registers no
agents and writes no evaluations. There is nothing to calibrate. Fine. But we also concluded
CONTRADICTION was blocked, because its apparent substrate — `GET /reasoning/conflicts` —
reports `needs_review`/`has_conflict` markers whose *only* writers in all of core
(`challenger.py:386-397`) are the `KEEP_BOTH` and `DEFER` strategies that FOH-4's allowlist
deliberately bans. So `/conflicts` returns empty for any Compose-written workspace, forever, by
construction. That part was true, and it corrected a shipped ruling: FOH-4's ledger had called
those markers "dead paths nothing reads," when in fact `/conflicts` is their one reader. We
fixed that at the origin.

**Reversal two: "actually, it's buildable now."** We drafted an upstream SmartMemory feature
(`CORE-CONTRADICT-LINK-1`) to add the missing link, wrote its contract and design, and ran it
through a Codex design review per the owner's bracket protocol. Codex killed the premise: the
`CONTRADICTS` edge was *never gated* — `POST /memory/edge` writes an arbitrary edge with tenant
validation today, and `GET /memory/{id}/neighbors` reads it back with direction preserved. We
had been looking only at the *contradiction-resolution* routes and never checked the *generic
graph-edge* routes. The upstream feature was unnecessary. We marked it scope-collapsed and
built the whole thing in Compose instead.

The build then went clean: a blueprint, a Codex pre-impl review (7 findings, all folded in
before a line of code), the implementation, a Codex post-impl review of the diff (1 Medium,
fixed), and a live-fire against the real smart-memory-service that passed on the first honest
run.

## What we built

- `lib/fluid/smartmemory-provider.js` — `CAP.CONTRADICTION`; `contradictions(handle)` (incoming
  `CONTRADICTS` edges → canonicalized, schema-validated, resolvable records; best-effort lower
  bound); `resolveConflict` refactored to a `{result, link}` post-success epilogue outside the
  lease that links on both landed exits; `_linkContradiction` (best-effort, idempotent, warns
  and never throws).
- `lib/smartmemory-client.js` — `addEdge` (requires `result.edge_created===true` — the route
  returns `200 status:success` even on a swallowed write) and `neighbors` (throws on 404).
- `lib/fluid/provider.js` — `ContradictionHit` typedef + the base-class contract.
- `test/helpers/smartmemory-stub.js` + two suites — a deduped edge store, the two new routes,
  failure knobs, and coverage of every branch the reviews named.
- `docs/features/COMP-FOH/` — `foh-5-substrate-findings.md` (the investigation and both
  reversals), `blueprint-foh-5.md`, `foh-5-progress.md`.
- `smart-memory-docs/docs/features/CORE-CONTRADICT-LINK-1/` — the collapsed upstream feature,
  retained as the record of *why* it was unnecessary and what (if anything) survives on its own
  merit (atomic decay-plus-link; a property-carrying link read).

## What we learned

1. **"Blocked upstream" is a claim to verify, not a place to stop.** Our first two verdicts were
   both confident and both wrong about CONTRADICTION. The block was real for the substrate we
   looked at and false for the one we hadn't. When a capability looks blocked, enumerate *every*
   route that could serve it before concluding — especially the generic primitives, which are
   easy to skip past while staring at the domain-specific ones.

2. **The bracket reviews earned their cost, loudly.** The pre-impl review caught three real bugs
   we would have shipped: trusting a `200 status:success` that created no edge, linking only one
   of two "landed" exits, and returning a record that disagreed with its own handle. The
   post-impl review caught a fourth (a schema-invalid blob slipping past `_fromItem`'s JSON-only
   guard, which recall is accidentally shielded from and `contradictions()` was not). None of
   these were visible from the design alone.

3. **A correct-looking design ruling can carry a false premise.** FOH-4's "those markers are
   dead paths nothing reads" was the right *conclusion* (exclude those strategies) built on a
   *false* reason (nothing reads them). The false reason is exactly what made this slice look
   blocked. Kill the premise at the origin, not just the conclusion.

4. **Best-effort must be honest about what it gives up.** We wanted "durable linkage," but the
   edge write can fail and a resolve must never be re-run to repair it (that decays again). So
   `contradictions()` is documented as a *lower bound*, not a complete set — the conviction
   history stays the authoritative record. Overstating durability would have been a lie the
   contract couldn't back.

5. **Live-fire finds script bugs before it finds product bugs — and that's still signal.** Two
   failures on the way to green were both in the harness: we forgot to declare `fluid_event`
   (records write a lifecycle event under a second type), and `/list` by handle returns the
   record *and* its event item, so `items[0]` was sometimes the event. The provider's own read
   filters `fluid_ns===RECORD_NS` and never had either problem. The precondition we most feared —
   that strict relation validation would reject a `CONTRADICTS` edge between two `fluid_<kind>`
   nodes — simply didn't fire: undeclared relations pass, and SmartMemory doesn't yet validate
   edge writes against domain/range at all (P3).

## Open threads

- [ ] Push compose main (owner call — outward-facing).
- [ ] File the surviving upstream SmartMemory items as `smartmem-dev`: (a) the owed server-side
      idempotency-ID on `/resolve` (covers non-Compose callers the workspace lease can't reach);
      (b) atomic decay-plus-link; (c) a property-carrying link read (so edge `origin`/`detected_at`
      become readable). None block Compose.
- [ ] CALIBRATION remains genuinely blocked (no subject). COMP-FOH stays IN_PROGRESS.
- [ ] `contradictions()` "outgoing" direction (records `handle` itself contradicts) is a trivial
      later flip if a consumer wants it.

The blocker we were handed turned out to be a door we hadn't tried — twice.
