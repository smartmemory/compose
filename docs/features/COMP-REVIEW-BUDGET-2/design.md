# COMP-REVIEW-BUDGET-2: COMP-REVIEW-BUDGET-1 wired its prompt budget to consumer review items only (lib/build.js:1923-1928, gated on reviewOpts.reviewMode); ordinary review and build steps (lib/build.js:5350-5372) pass no promptBudget, so the unbudgeted-prompt failure that feature was filed to prevent can still kill a run on the more common path. Pass a budget at the ordinary dispatch site with an ambient-free requiredPrompt built the same way the consumer path builds it. Sized S.

**Status:** PLANNED
**Created:** 2026-09-19

---

## Intent

COMP-REVIEW-BUDGET-1 wired its prompt budget to consumer review items only (lib/build.js:1923-1928, gated on reviewOpts.reviewMode); ordinary review and build steps (lib/build.js:5350-5372) pass no promptBudget, so the unbudgeted-prompt failure that feature was filed to prevent can still kill a run on the more common path. Pass a budget at the ordinary dispatch site with an ambient-free requiredPrompt built the same way the consumer path builds it. Sized S.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

---

## Related Documents

- `docs/features/COMP-REVIEW-BUDGET-1/` — the feature this completes; commit `7e637db`
- `lib/build.js:1923-1928` — the consumer review call site that DOES pass a budget
- `lib/build.js:5350-5372` — the ordinary dispatch site that does not
- `lib/result-normalizer.js:420-442` — where the budget is consumed
- `docs/features/COMP-PROMPT-SECRETS-1/design.md` — the egress sweep that surfaced this

## The problem

`COMP-REVIEW-BUDGET-1` was filed because an unbudgeted review prompt killed a run: two
`require: all` lenses had their prompts rejected as too long, the automatic retries hit a rate
limit, and the run died after $14.04 and 208,080 tokens of completed work. It shipped a size
budget that measures the assembled prompt after schema injection, drops ambient `docs/context`
material first, and refuses locally when required content alone still exceeds the cap.

That budget is wired to exactly one of the two dispatch sites.

| Site | Passes `promptBudget`? |
|---|---|
| Consumer review items, `lib/build.js:1923-1928` | Yes, gated on `reviewOpts.reviewMode` |
| Ordinary step / review dispatch, `lib/build.js:5350-5372` | **No** |

So the failure mode the feature exists to prevent remains reachable on the ordinary path, which
is the more common one. Both sites were confirmed by direct read, not inferred.

This is the same shape as the `COMP-GATE-HEADLESS-1` arm-3 regression: a control that exists,
reads as complete, and covers a subset of its paths. The danger is not the missing coverage by
itself — it is that the feature is marked shipped, so nobody looks again.

## Fix

Pass a budget at the ordinary site, built the same way the consumer site builds it, so there is
one budget semantic rather than two.

The ambient-free `requiredPrompt` has an exact precedent at `lib/build.js:1791-1794`: re-call
`buildStepPrompt` with `contextDir: null` and prefix the same review scaffold. The ordinary site
has the matching pieces already — `basePrompt` at `:5311` and the optional scaffold at
`:5329-5340`. Reuse `reviewPromptBudgetChars(context)` (`:1607-1613`) rather than re-reading the
environment variable, so `COMPOSE_REVIEW_PROMPT_MAX_CHARS` keeps one meaning.

## Decision to record at implementation

Whether the ordinary site takes the budget on **every** step or **only review steps**. For a
non-review step there is no scaffold, so `requiredPrompt` degenerates to "the prompt without
`docs/context`" — still meaningful, since ambient context is exactly what the budget drops
first. The implementer must argue the choice and make the code match the argument rather than
widening scope silently. Recorded in the implementation commit.

## Non-goals

- No change to the default (120,000 chars), to `COMPOSE_REVIEW_PROMPT_MAX_CHARS`, or to the
  refusal error shape.
- No change to provider failure classification or retry backoff.
- Not secret scanning. That is `COMP-PROMPT-SECRETS-1`; this seam is where it will likely live,
  but budget and redaction stay separate concerns.

## Origin

Found 2026-09-19 during the `COMP-PROMPT-SECRETS-1` egress sweep (Codex run `8aab975267e0`),
while inventorying what already inspects prompt content. Not the object of that investigation —
a side finding, verified independently before filing.
