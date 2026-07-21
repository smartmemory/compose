## What a smoke test can prove

A smoke test can show that a defined audience will take a defined action for a defined promise at a stated price. It cannot prove product–market fit, retention, implementation feasibility, or scalable acquisition.

Treat evidence as a ladder:

| Test | What it measures | Positive threshold |
|---|---|---|
| Ad impression / CTR | Message attention | Never sufficient alone. |
| Landing-page email | Low-cost curiosity | Only a lead; require qualified ICP identity and price visibility. |
| “Request access at $X” | Conditional purchase intent | Positive only if its 95% lower confidence bound clears your predeclared viability floor. |
| Calendar booking / technical-discovery commitment | Time cost | Useful only if the prospect is ICP and attends. |
| Refundable deposit / paid design partner | Actual money commitment | Strongest pre-build signal. Three independent ICP firms paying or depositing is enough to justify a concierge pilot; it is not enough to forecast a market. |
| Paid, retained use | Actual demand | The first metric that can support a business claim. |

For a zero-audience founder, use a truthful external smoke page, not an in-product fake door—there are no existing users whose contextual behavior you can observe. A fake door is more useful later, for choosing among features for an already-active product.

## Mechanics: a credible developer-tool smoke test

1. Write one falsifiable hypothesis: “Platform engineers at companies with 20–500 engineers will pay $99/user/month to reduce _specific painful job_ from _current method_ to _claimed result_.”

2. Make one page for one ICP, one job, one integration surface. Show the actual price/range, the required permissions/install model, and a believable artifact: CLI output, API request/response, before/after workflow, or architecture diagram. Do not use invented logos, testimonials, benchmarks, or screenshots implying a working product.

3. Use a costly CTA, in ascending order: “request early access at $99/mo,” then a refundable reservation or paid pilot. After click, disclose immediately: “This is an early-access validation; the product is not yet available.” Collect work email, role, company size, stack, current workaround, and price acceptance. Do not ask for source code, repository access, API keys, or production data.

4. Buy or recruit only traffic that plausibly has the problem. Separate every source, keyword/ad, device, geography, and returning visitor. Search traffic aimed at a named problem is much more interpretable than broad “AI developer tools” traffic.

5. Pre-register the stopping rule before launch: visitor count, exclusion rules, primary event, minimum qualified rate, and what action each outcome causes. Do not change copy, price, audience, and CTA mid-test and pool the results.

6. Check qualification before celebrating. A “conversion” from a student, consultant, competitor, bot, or a company below your price floor is not the event you wanted. Verify emails and deduplicate by company.

7. Follow up with every qualified converter within 24–48 hours: offer the stated paid pilot or deposit, ask what they expected, and ask them to name their current workaround. This converts an ambiguous click into evidence about the job, buyer, and willingness to switch.

8. Report the full funnel, not the best percentage: unique qualified visitors → CTA clicks → completed qualified requests → attended calls → deposits/paid pilots.

## Benchmarks that have real underlying data

Unbounce analysed 464 million visits, 41,000 pages, and 57 million conversion actions in Q4 2024. Its definition of “conversion” varies by page, so it is a sanity check—not a visitor-to-customer benchmark. SaaS landing pages had a 3.8% median conversion rate; data/infrastructure pages 3.3%; SaaS Google-search traffic 5.1%. [Unbounce methodology](https://unbounce.com/average-conversion-rates-landing-pages/) and [SaaS cuts](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/).

ChartMogul/ProductLed’s January 2026 survey covers 200 established B2B software products, typically $1m–$10m ARR. It defines free-to-paid as conversion within six months, so it is downstream of a smoke test and vulnerable to survey/self-selection bias—but it is far better than recycled listicle numbers. [Methodology](https://chartmogul.com/reports/saas-conversion-report/).

| Funnel | Observed benchmark | Interpretation |
|---|---:|---|
| Website → free signup, freemium | 9% | Existing freemium products; low-friction signup. |
| Free signup → paid, freemium | 5.5% | Six-month conversion. |
| Website → free signup, no-card trial | 4.5% | Similar to a serious landing-page ask. |
| Free signup → paid, no-card trial | 8% | Six-month conversion. |
| Website → free signup, card-required trial | 3.5% | Higher friction filters signups. |
| Free signup → paid, card-required trial | 30% | Selection effect; do not treat this as a card-form tactic. |

The implied website-to-paid rates are roughly 0.50% freemium, 0.36% no-card trial, and 1.05% card-required trial. These are not forecasts for an unbuilt tool; they show why email signup is weak evidence and why funnel definitions matter.

Older OpenView data reports 5% freemium and 17% free-trial conversion, materially different from ChartMogul’s newer 5.5% and 8%. [OpenView](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/). Do not average them: samples, years, definitions, and product mixes differ.

## Thresholds and sample size

For a single-page smoke test, estimate one rate; do not run an A/B test unless you can fund it.

- At a true 5% conversion rate, 500 qualified visitors yields about 25 conversions and an approximate 95% interval of 3.4%–7.3%.
- At 1,000 visitors and 50 conversions, that narrows to roughly 3.8%–6.5%.
- To estimate a 5% rate to within ±2 percentage points at 95% confidence requires about 456 qualified visitors.
- Zero conversions is informative: after 300 qualified visitors, the approximate one-sided 95% upper bound is 1%; after 500 it is 0.6%.
- A conventional two-variant test needs roughly 4,000 visitors per arm to distinguish 3.8% from 5.1% with 80% power and 5% two-sided significance. That is usually a bad first experiment.

A practical precommitment for a price-visible, ICP-filtered developer-tool page:

- **Negative:** 0 qualified commitments in 300 visitors, or the upper 95% bound remains below the acquisition rate your economics require.
- **Inconclusive:** fewer than 20–30 qualified commitments, or a confidence interval spanning both “not viable” and “interesting.”
- **Proceed to concierge/pilot:** at least 30 qualified commitments in 500+ visitors and a lower 95% bound above your viability floor. With 500 visitors, 30 commitments is 6.0% observed and about 4.3% at the lower bound.
- **Proceed to building only after money:** at least three distinct ICP companies accept the actual price and pay/deposit, or one pays enough for a tightly scoped paid pilot. This is an operational guardrail, not a published universal law.

The commonly repeated practitioner rules are not robust benchmarks. One published practitioner heuristic suggests “100 clicks and 5 completions,” while also reporting a test that looked good at 200 clicks but failed at 1,500; that is a useful warning, not empirical validation. [Example](https://www.launchingnext.com/blog/fake-door-test/)

## Traffic, money, and timeline

Your spend is simply `qualified visitors × actual CPC`. Do not use an Internet-average developer-tool CPC: I could not find a trustworthy published benchmark that transfers to a specific developer-tool problem. Use Google Keyword Planner for the exact country, keywords, and match types, then set a hard ceiling.

| Goal | Qualified visits | Cost at $3 / $8 / $15 CPC |
|---|---:|---:|
| Directional disproof | 300 | $900 / $2,400 / $4,500 |
| Reasonable single-rate read | 500 | $1,500 / $4,000 / $7,500 |
| Narrower read | 1,000 | $3,000 / $8,000 / $15,000 |
| Proper A/B test, 4,000 per arm | 8,000 total | $24,000 / $64,000 / $120,000 |

At $100/day and $8 CPC, 500 visits take about 40 days. At $400/day, about 10 days. This is why “run a $100 ad test” is usually instrumentation theater: it can expose catastrophic non-demand, but cannot reliably distinguish a 2% page from a 5% page.

For no-budget work, do not falsely call organic posts a controlled demand test. Use them to obtain the first 10–20 qualified conversations or deposits. The result is qualitative and selection-biased, but it can cheaply disprove bad assumptions and give you terms for a paid-search test.

## The stated-interest versus payment gap

There is a gap, but no defensible universal multiplier such as “only 10% of waitlist signups pay.”

- A broad intention–behavior meta-analysis found an average correlation of **0.53**, with a huge 95% range of **0.15–0.92** across settings. The authors explicitly note substantial variation. [Morwitz, 2007](https://www.sciencedirect.com/science/article/abs/pii/S0169207007000799)
- In a meta-analysis of 47 experiments, moving stated behavioral intention by a medium-to-large **d=0.66** moved subsequent behavior only **d=0.36**. [Webb & Sheeran, 2006](https://pubmed.ncbi.nlm.nih.gov/16536643/)
- Asking intention can itself alter subsequent behavior: a controlled consumer-research study found that asking once increased later purchase rates, while repeated questioning polarized low-intent respondents. [Morwitz, Johnson & Schmittlein](https://business.columbia.edu/faculty/research/does-measuring-intent-change-behavior)

Those studies establish direction and instability, not a SaaS conversion formula. The gap will be especially large where the smoke page omits implementation effort, security review, procurement, switching costs, team consensus, or the absence of a working product. A refundable deposit at stated price is therefore much stronger than a “would you use this?” checkbox, but still weaker than retained usage.

## Does it work for developer tools?

Yes, as a **message/problem/channel test**, not as proof that developers will adopt or that companies will buy.

Developer buyers do use low-friction evaluation: in Stack Overflow’s 2023 survey of 83,009 respondents, 73.74% selected “start a free trial” when researching a new tool; 71.02% asked developers they know, and 64.11% visited developer communities. Only 14.86% selected researching companies that advertise on sites they visit. [Results](https://survey.stackoverflow.co/2023/). That supports a self-serve, technically credible smoke test, but also says peer/community distribution matters more than generic ads.

For developer tools, a genuine positive signal requires all of:

- the visitor matches the technical user and, if different, the economic buyer;
- the page states the integration/permission burden;
- the CTA is for the real evaluation path, not generic newsletter signup;
- the prospect identifies a live workaround or active project;
- the prospect accepts the price or paid-pilot terms.

A fake “Install” button that attracts 8% clicks says developers are curious about the promise. It does not say they will grant OAuth, run an agent in CI, clear security review, convince procurement, or keep paying. Test those obligations explicitly in the next cheapest experiment.

## Failure modes and controls

- **Unqualified traffic:** broad AI, student, competitor, and job-seeker traffic makes lead rate meaningless. Use pain-specific search terms, strict exclusions, work-email verification, and report results by segment.
- **Priming and demand effects:** surveys and repeated “would you buy?” prompts can change behavior. Measure revealed actions first; keep the follow-up neutral.
- **Click novelty:** a new button or provocative claim attracts exploration. Require a second costly action: identity, detailed use case, attended call, or money.
- **Price omission:** hiding price measures desire for an imaginary bargain. Show the intended price before the primary commitment.
- **False negatives from a bad representation:** a complex developer workflow may be impossible to evaluate from copy. Upgrade to an interactive prototype or manual concierge before killing the underlying problem.
- **False positives from a false representation:** imaginary integrations, performance claims, customer logos, or availability create demand for something you may not be able to deliver. In the US, advertising must be truthful, non-misleading, and substantiated; material omissions can also be deceptive. [FTC guidance](https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business)
- **Trust backlash:** disclose the experiment immediately after the click, do not take credentials, do not pretend the user completed an action, offer a real waitlist/interview/pilot, and close the loop with every respondent. Avoid fake doors in billing, security, deletion, compliance, health, employment, or other reliance-heavy flows.
- **Blended iterations:** changing audience, price, offer, and page simultaneously means you learn nothing causal. One hypothesis per run.
- **Treating benchmarks as targets:** Unbounce’s 3.8% includes heterogeneous “conversion” events; ChartMogul’s rates are from existing companies with real products. Neither is a pass/fail line for a new devtool.

## WHAT I COULD NOT FIND

- A reliable published dataset of fake-door/smoke-test outcomes specifically for developer tools, including click → qualified lead → paid conversion.
- A defensible universal conversion threshold for a fake door. The often-cited percentages are practitioner heuristics, not replicated empirical standards.
- A reliable universal multiplier from waitlist signup, “payment intent,” or stated purchase interest to actual SaaS payment. The empirical literature shows wide variation rather than a stable gap.
- Credible published developer-tool CPC, CPA, or test-budget benchmarks applicable to a specific problem, geography, buyer, and keyword set. Exact Keyword Planner estimates are more useful.
- Controlled evidence comparing fake doors with landing pages, prototypes, concierge pilots, and interviews on predictive accuracy for new B2B software.
- Published incidence rates for fake-door ethics backlash, trust loss, or regulatory enforcement. The ethical/legal risks are real in principle; their frequency is not well measured.

