# Demand Signal + Distribution — Research Corpus (2026-07-21)

**Status:** RAW SOURCES. Kept per `KEEP-THE-RAW` ([what-to-build §7](../../product/2026-07-20-what-to-build-vision.md)).
**Commissioned by:** the substrate/head correction of 2026-07-21 — see `DEMAND-HAS-KNOWN-SIGNALS` and `TESTING-IS-ASYMMETRIC` in [what-to-build §1](../../product/2026-07-20-what-to-build-vision.md).

## Why this exists

The judgment-layer corpus declared candidate valuation impossible (`NO-VALUATION`) and never went looking for what is already known about why products sell or how demand is measured. That claim turned out to be a mislabelled AI assertion. This corpus is the first pass at the missing material.

Ten parallel research jobs, web-grounded, run 2026-07-21. Each was instructed to prefer real datasets over listicles, state the threshold separating signal from self-deception, and **end with an explicit "WHAT I COULD NOT FIND" section**. Those gap sections are the most valuable part and all ten converge.

## Contents

| File | Question |
|---|---|
| `smoke-tests.md` | Landing-page / fake-door demand tests: statistics, thresholds, the stated-interest-vs-payment gap |
| `paid-as-instrument.md` | Paid ads as a measurement instrument: what one credible demand experiment actually costs |
| `preorders-lois.md` | Pre-orders, deposits, paid pilots, LOIs, selling before building |
| `interviews.md` | Customer discovery done properly; how many interviews; converting a conversation into a commitment |
| `demand-mining.md` | Mining existing public demand signal — the automatable half, and its legal constraints |
| `competitor-reading.md` | What public artifacts can and cannot tell you about a market you have no access to |
| `cold-outreach.md` | Cold email/LinkedIn in 2026: benchmarks, deliverability rules, developer-specific hostility |
| `communities-launch.md` | Reddit, Hacker News, Product Hunt, Discord, Indie Hackers, dev.to, Lobsters — current base rates |
| `oss-devtools.md` | Open source, registries, and marketplaces as distribution for developer tooling |
| `content-seo-public.md` | Content/SEO in the AI-answer era, GEO/AEO, building in public |

## The four findings that changed the plan

1. **Testing is asymmetric.** Disproof is roughly an order of magnitude cheaper than confirmation (300 qualified visitors to bound a rate under 1%; ~500 plus $3k–$10k to confirm one). → `TESTING-IS-ASYMMETRIC`.
2. **Launching is a lottery with published odds.** 41,301 Show HN posts: median 0 comments, 61.7% get none. Median cold-email sender books meetings from 0.3% of sends, so a 100-contact test has a 74% chance of returning nothing regardless of the idea.
3. **The automatable corpus is legally boxed in.** GitHub, Hacker News, Stack Exchange and some job boards are usable. Review sites are gated or explicitly prohibited. The leading Reddit pain-mining tool shut down in Nov 2025 when its data access vanished.
4. **The field is unmeasured.** All ten gap sections converge: no validated threshold for anything, no developer-tool-specific benchmark, no study of zero-audience founders, no proven conversion from any public proxy to revenue. → the basis of `LEDGER-IS-THE-EVIDENCE-BASE`.

## Reading caution

These are agent-generated research reports with inline sources. They are `[AGENT]` in the grounding vocabulary: the citations are real and checkable, the synthesis around them is not independently verified. **Check a claim's source before making it load-bearing.** The provenance failure this corpus was commissioned to correct began exactly this way.
