# POSITION — Product boundary: separate product, or a layer in Compose?

**Status:** OPEN — deliberately unresolved
**Conviction:** low and *contested*. Recorded as settled 2026-07-20, **reopened by
the owner the same day.** That error is itself in the ledger (`open: product-boundary`).

## The question

Is the judgment layer a layer inside Compose, a separate product that interoperates,
or one repo with separate packages?

## Three candidates

| Option | For | Against |
|---|---|---|
| **Layer inside Compose** | The differentiator (construction-as-resolution) spans the boundary; dependency is already one-way; COMP-FOH set this precedent for Maya | "Extract later" is a promise codebases rarely keep — **verified: no extraction has ever happened in this repo** |
| **Two interoperating products** | Domain hands you the seam; packaging is independent of architecture, so it can still be sold as one thing | Boundary tax paid forever if the seam is wrong; premature |
| **One repo, separate packages** | **Evidenced to work here** — `compose-mcp` is published as `@smartmemory/compose-mcp` from inside this repo. Born separate, no extraction needed | Untested for a component this size |

## The joint that decides it

**`CONSTRUCTABILITY-LINE`** — the boundary follows whether a joint's
experiment can be built, not product-vs-non-product:

- **Pricing** — experiment *is* software. Full differentiator. Sweet spot.
- **Market entry** — landing pages, ad tests, segment waitlists. Sweet spot.
- **Hiring** — cannot build the experiment. Ledger works; differentiator doesn't. Commodity.

Pricing and market entry are **software decisions that are not product decisions**,
which widens the judgment layer's domain past Compose's build lifecycle — and
correspondingly weakens the inside-Compose argument. The construction arm starts to
look like a pluggable resolver rather than an inseparable core.

## Evidence gathered

- `[EXT]` No extraction precedent in this repo — only function-level refactors.
- `[EXT]` `compose-mcp` demonstrates born-separate packaging inside one repo works.
- `[ASSERT]` Owner: harder to split a monolith; packaging ≠ architecture.

## Branches

- **If constructability is the real line** → judgment engine as its own package,
  construction resolver as a swappable adapter, one repo.
- **If the judgment layer only ever serves software-product decisions** → the
  inside-Compose argument recovers and the seam is unnecessary.

## Open joints

`commercial-intent` (a product to sell vs an instrument for own building changes
this outright) · `straddle-reaches-trunk` · `differentiated`

## Note

This is the clearest instance in the corpus of a position whose conviction is
genuinely low and whose branches are live. Useful as a test case for whether the
format handles disagreement rather than just accumulation.
