## The hard boundary

Public artifacts can establish that a market exists, how products are positioned, whether suppliers are investing, and whether some usage/attention is occurring. They usually cannot establish revenue, retention, willingness to pay, CAC, or “people will buy *your* version.”

Treat each artifact as evidence of one narrow proposition:

| Artifact | It can support | It cannot support |
|---|---|---|
| Pricing page | Monetization design and buyer segmentation | Customers actually pay those prices |
| Funding/hiring | Capacity and strategic intent | Revenue or product-market fit |
| Job posts | Planned capabilities and stack adoption | A feature is shipping, or a role was filled |
| Changelog | Public shipping activity | Usage, retention, or revenue |
| Reviews | Some customers/users exist | Customer count, ACV, or net revenue |
| Package downloads | Distribution events / some developer usage | Unique developers, production usage, revenue |
| GitHub stars | Attention/bookmarking | Adoption or commercial value |
| Traffic estimate | Relative web attention, sometimes directionally | Exact visits, conversion, revenue |

A useful operating rule: call something a **market signal** only when it appears in at least two independent artifact classes and persists across three monthly observations. “Three competitors added an integration” plus “three are hiring for that ecosystem” is evidence. “One competitor has 20,000 stars” is not.

The thresholds below are conservative operating rules, not published revenue cutoffs.

## 1. Competitor pricing pages and pricing-page archaeology

**What you can learn**

- Whether the category is self-serve, sales-led, usage-based, seat-based, outcome-based, or a hybrid.
- The buyer segmentation the vendor thinks is real: plans, gates, compliance, support/SLA, usage units, team size.
- Which capabilities have become table stakes: features moved downward into cheaper plans are usually commoditizing; newly introduced paid gates show where a vendor believes it can charge.
- Relative price bands, switching friction, free-trial behavior, and whether the apparent market is small-business or enterprise-led.

Use the current page plus dated captures. The Internet Archive’s CDX API supports querying and filtering historical captures; a capture proves the page was publicly served at that time, not that it was complete or representative of all customers. [Internet Archive CDX documentation](https://philharris.co.uk/AllSystems/archive.org/help/wayback_api.html)

**Procedure**

1. Record the exact URL, capture timestamp, currency, billing period, plan names, included quantity, overage, free-trial terms, and “contact sales” boundary.
2. Normalize prices to monthly equivalent, but keep annual prepayment separate from a true monthly price cut.
3. Diff at least quarterly snapshots. Include `/pricing`, checkout, docs, and enterprise/security pages; vendors often move real limits out of the pricing table.
4. Distinguish a copy refresh from a packaging change: a packaging change alters price, included quantity, gating, contract terms, or target segment.

**Genuine signal threshold**

- **One company changing price:** a hypothesis, not a market move.
- **Three direct competitors making the same packaging/price direction within 6–12 months:** credible evidence of a segment or unit-economics shift.
- **A change confirmed on pricing page + changelog/docs + sales/hiring language:** strong strategic signal.
- No archived capture is **missing-data evidence**, not evidence that the old price did not exist; dynamic checkout, robots rules, and unarchived paths create false history.

**Revenue correlation**

There is no general published conversion from public price to revenue. Price is an excellent measure of a vendor’s *offer*, a poor measure of its realized price: enterprise discounts, grandfathering, services, usage overages, and channel contracts are invisible.

For context on the scale of the missing funnel: HockeyStack reports an average **1.1% website-form conversion** across **31 million unique visitors at 80 B2B SaaS companies**—a vendor benchmark, not a universal law. [Method and result](https://www.hockeystack.com/lab-blog-posts/state-of-pricing-demo-case-study-pages) Unbounce’s benchmark reports **3.3%** conversion for SaaS data/infrastructure landing pages and **4.1%** for hardware pages. [SaaS benchmark](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/) Neither tells you a competitor’s revenue from its public pricing.

## 2. Funding, hiring, and job postings

**Funding**

A funding announcement proves access to capital at a point in time. It is a strong signal of **ability to spend**, weak evidence of demand. Capital may be financing burn, a land-grab, research, or a failed thesis. Crunchbase itself separates funding rounds from revenue ranges and milestones; do not collapse those fields into “traction.” [Data definitions](https://about.crunchbase.com/data)

**Genuine signal threshold**

- Funding alone: **zero demand inference**.
- Funding plus a sustained hiring cohort in one product area, a new GTM motion, and product releases over the next two quarters: credible evidence of strategic commitment.
- “Raised $X” with no subsequent hires/releases: treat as capital availability only.

**Job postings**

Job ads are unusually useful roadmap leaks because they expose a firm’s intended capability, customer environment, deployment constraints, and buying center. A recent study of U.S. public firms finds R&D job postings carry predictive power for R&D activity, especially where postings ask for disruptive technology skills or advanced education. [Study summary](https://papers.ssrn.com/sol3/Delivery.cfm/4707171.pdf?abstractid=4707171&mirid=1) That validates job ads as an innovation/R&D proxy—not a revenue proxy.

Read for:

- Repeated customer nouns: “regulated,” “air-gapped,” “SOC 2,” “data residency,” “platform team,” “Fortune 500.”
- Architecture and integration commitments: specific clouds, model providers, IDPs, warehouses, CI systems.
- The role’s success metric: “build evaluations,” “enterprise deployment,” “usage-based billing,” “customer solutions.”
- Geography and seniority: a first enterprise AE is different from ten support engineers.

Online ads have coverage bias and are not a census of vacancies; EU validation work specifically assesses their representativeness against labour-force and vacancy surveys. [Methodology and limits](https://op.europa.eu/en/publication-detail/-/publication/4e3beac2-8be3-11ed-999b-01aa75ed71a1/language-en)

**Genuine signal threshold**

- One listing: no roadmap conclusion.
- Three net-new, similarly scoped roles over two monthly captures, or the same capability appearing at three competitors: credible roadmap/market-direction signal.
- A posting that survives >60 days may mean hard-to-fill, frozen headcount, or low applicant supply—not necessarily urgent demand.
- Never infer revenue from employee count or hiring velocity without an independent customer/usage signal.

## 3. Changelogs, release velocity, docs, and integrations

**What you can learn**

- Where vendors are placing engineering attention.
- Whether the market is consolidating around integrations, security controls, governance, deployment models, or a particular workflow.
- Whether a product is maintained enough to be a plausible incumbent.

A release can be real but strategically meaningless: UI polish, bug fixes, dependency updates, and security patches all count. Conversely, quiet vendors can ship behind feature flags or to enterprise accounts.

DORA research links internal delivery performance metrics—including deployment frequency—with organizational performance. [DORA’s 2021 research](https://dora.dev/research/2021/dora-report/) That does **not** validate public changelog frequency as a revenue proxy; public release notes are a selected and lossy view of deployment.

**Genuine signal threshold**

- Count only releases that alter a buyer’s capability, deployment cost, compliance posture, integration surface, or pricing unit.
- Require at least **three such releases in six months**, then compare the distribution across competitors—not raw release count.
- Stronger than release count: the same theme appears in changelogs, docs navigation, job ads, and pricing gates.
- A repository’s commit count, GitHub release count, or “ships daily” claim alone is vanity for market analysis.

## 4. Reviews and rating velocity

Reviews are one of the better public indications that some real users exist, but they are not a clean revenue series.

There is genuine empirical support for reviews affecting sales in consumer markets. Chevalier and Mayzlin examined more than **6,000** book titles, with **2,387** retained after filtering, and found positive reviews associated with sales increases while negative reviews had a larger adverse effect. [Study summary and sample](https://culturecase.kdl.kcl.ac.uk/research/2014/04/positive-online-reviews-increase-book-sales/) A meta-analysis covers **28 studies** of reviews and sales, while also noting the literature lacks a unified conclusion across products and contexts. [Meta-analysis](https://www.sciencedirect.com/science/article/abs/pii/S0969698919304011)

That is evidence for reviews as demand/social-proof mechanisms, not evidence that a G2 review count maps to SaaS ARR.

For B2B software, G2’s own methodology confirms its Market Presence score combines reviews, web/social presence, employees, and third-party data; it is a relative marketplace score, not independent revenue measurement. [G2 scoring methodology](https://documentation.g2.com/docs/research-scoring-methodologies) G2 requires at least **10 category reviews** for a product to qualify for Grid inclusion; a Grid needs at least **six products** and **150 reviews** overall. [Eligibility rules](https://documentation.g2.com/docs/research-scoring-methodologies)

**Genuine signal threshold**

- **<10 category reviews:** weak evidence; do not infer a stable installed base.
- **10+ reviews with at least 3 fresh reviews/month for three months**, from recognizably different roles/company sizes: genuine evidence of ongoing reviewable customer activity.
- **Rating without volume or recency:** ignore. A 5.0 from six reviews is not category validation.
- Separate review velocity caused by a vendor’s incentive campaign from organic demand. Sudden clustered reviews with repetitive language are a warning, not growth.
- Use review text—not the average rating—to extract switching triggers, implementation burdens, and “would pay for” language.

**Revenue correlation**

No reliable published B2B SaaS rule such as “one G2 review equals $X ARR” was found. This is especially unsound because review propensity varies by contract size, vendor review programs, and buyer type.

## 5. App-store and marketplace rank

Public rank tells you the product has marketplace visibility in a specific country/category/time window. It is not revenue.

Apple exposes developers’ own downloads, paying users, sales, and proceeds in App Store Connect. [Metric definitions](https://developer.apple.com/help/app-store-connect-analytics/reference/metrics-definitions/) Apple does **not** publicly disclose per-app downloads or revenue; public rank trackers explicitly rely on Apple’s ranking feeds and metadata, not direct sales data. [Public-data methodology](https://www.appstoretracker.com/methodology)

**Genuine signal threshold**

- A single top-chart observation: discard.
- Sustained top-10 or top-25 category rank for **four weekly observations** in the same country/category: real marketplace visibility/installation demand.
- The same sustained rank across multiple countries, plus fresh reviews and release activity: stronger demand signal.
- It remains non-revenue evidence. Free apps, trials, enterprise procurement, external payments, category size, and promotions break any rank-to-revenue conversion.

For developer marketplaces, count active listings, recent reviews, supported platform versions, and visible install/adoption indicators separately. A large marketplace rank can reflect a free utility or a promotion rather than a paid workflow.

## 6. npm and PyPI download counts

These are distribution-event metrics, not users, accounts, production deployments, or buyers.

PyPI’s official packaging guidance explicitly calls counts “highly inaccurate”: cache behavior lowers them; internal/unofficial mirrors can raise or lower them; packages outside PyPI are omitted; and scripts can inflate them. [PyPI’s stated limitations](https://packaging.python.org/en/latest/guides/analyzing-pypi-package-downloads/) PyPI Stats filters known mirrors but includes CI/CD downloads and says unknown mirrors create uncertainty that is difficult to quantify. [PyPI Stats FAQ](https://pypistats.org/faqs)

**Genuine signal threshold**

- Never use an absolute download total as “users.”
- Require **three months of stable/growing non-mirror downloads** *and* an independent usage signal: rising dependent packages/repos, recurring contributors/issues, public deployment references, or ecosystem integrations.
- A large post-release spike that immediately reverts is likely release automation, CI, mirrors, scanners, or dependency resolution—not adoption.
- For a developer tool sold commercially, downloads can establish top-of-funnel reach only; they say nothing reliable about paid conversion.

There is no credible public conversion factor from npm/PyPI downloads to developer-tool revenue.

## 7. GitHub stars and star velocity

Stars are attention. They are not an importance, deployment, revenue, or user metric.

A 2024 empirical study found GitHub-star/download correlations only **0.14 for JavaScript** to **0.47 for PHP**. It found detected deployments correlated **0.61 with stars** and **0.63 with downloads**—moderate relationships, not substitutes. [“The Fault in Our Stars”](https://www.ndss-symposium.org/ndss-paper/auto-draft-490/) Fake-star research further reports millions of suspected fake stars and finds short-term promotional effects can become a long-term burden. [StarScout study](https://arxiv.org/abs/2412.13459)

**Genuine signal threshold**

- Stars alone: vanity.
- Star velocity plus increased forks/contributors/dependents, working releases, and package/download movement across **three months**: a credible developer-attention/adoption signal.
- High stars with low issue activity, low release activity, no downstream usage, or a sharp one-week burst: do not count as adoption.
- Even the strong composite is still not commercial validation. Many high-star repositories are educational, infrastructure, or free substitutes.

## 8. Similarweb, Hypestat, and traffic estimates

Use traffic estimators for relative comparisons and trends, not absolute traffic or revenue models.

The best independent-looking evidence here is a peer-reviewed comparison of **86 websites** over a year: versus Google Analytics, Similarweb averages were **19.4% lower for visits**, **38.7% lower for unique visitors**, and **25.2% higher for bounce rate**. Rankings were significantly correlated, particularly for visits and unique visitors. [Jansen, Jung, and Salminen, *ACM Transactions on the Web*](https://researchportal.hbku.edu.qa/en/publications/data-quality-in-website-traffic-metrics-a-comparison-of-86-websit)

That supports **relative ordering and directional comparison**, with calibration—not the monthly visit number on a dashboard. An older 25-site benchmark found Similarweb estimated 15.7m total visits against 13.4m actual (+17%), while individual-site errors were much larger. [Screaming Frog benchmark](https://www.screamingfrog.co.uk/blog/how-accurate-are-website-traffic-estimators/) Another small sample found severe overestimation; conflicting results are exactly why precise visit-to-revenue math is unjustified. [Ahrefs’ 24-site visible-estimate sample](https://ahrefs.com/blog/website-traffic/)

Similarweb states it may show no data below **5,000 monthly visits** in relevant contexts, and says small sites have more limited coverage. [Its small-site guidance](https://support.similarweb.com/hc/en-us/articles/32914267250077-Similarweb-s-Data-Accuracy)

**Genuine signal threshold**

- Below the tool’s reporting floor: no conclusion.
- For visible sites: compare the *same tool*, country/device scope, and at least **three monthly observations**.
- A persistent 2x traffic gap versus a direct competitor, accompanied by stronger search visibility/reviews/package signals, is credible reach evidence.
- Do not multiply estimated visits by a generic conversion rate to claim revenue. The error bars compound: traffic-estimate error × unknown channel mix × unknown conversion × unknown ACV.
- Hypestat specifically: treat it as an unvalidated secondary estimate; do not use it to break ties or calculate market size.

## What is actually closest to revenue?

| Proxy | Relationship to real revenue | Use it for |
|---|---|---|
| Publicly reported revenue, ARR, customer count, SEC filings | Direct, if scoped and dated | Revenue and growth |
| Verified paid marketplace sales/proceeds, if disclosed | Direct but channel-limited | Channel revenue |
| Recent, substantive B2B reviews | Indirect; evidence customers exist | Adoption and pain language |
| Paid-app price + sustained paid-chart rank | Indirect, directionally plausible | Visibility in a paid channel |
| Price/packaging changes | No demonstrated general revenue mapping | Segmentation and monetization hypotheses |
| Job postings and funding | No demonstrated revenue mapping | Strategic intent and capacity |
| Package downloads | No demonstrated revenue mapping | Developer distribution/usage hypothesis |
| Changelog velocity | No public revenue validation | Supplier activity and roadmap |
| Stars, followers, total traffic estimate | Weak or unreliable | Attention only |

For a zero-audience founder, the payoff from public research is a **ranked hypothesis ledger**, not confidence theater: “regulated teams need local deployment; three vendors are hiring for it; two added it to enterprise tiers; review text says implementation is painful.” That is enough to choose what to test. It is not enough to conclude there is a purchasable market.

## WHAT I COULD NOT FIND

- A reliable, published conversion from public SaaS pricing—list price, annual discount, plan count, or pricing-page design—to competitor ARR or revenue.
- A validated “one G2/Capterra review equals X customers or Y ARR” rule, or a SaaS review-velocity-to-revenue model that survives differences in vendor review incentives and ACV.
- A validated conversion from npm or PyPI downloads to unique developers, production deployments, paid seats, or revenue.
- A validated conversion from GitHub stars or star velocity to commercial revenue. The available empirical evidence is about popularity, downloads, and deployments, and those relationships are only weak-to-moderate.
- A reliable public formula converting App Store/marketplace rank to downloads or revenue. Apple does not publish the required per-app public data.
- An independent, peer-reviewed accuracy benchmark for Hypestat specifically.
- A defensible traffic-estimate-to-revenue formula for small B2B SaaS sites; estimator error, channel mix, enterprise sales, and conversion variance make it unusable.
- A published result validating public changelog/release frequency as a predictor of vendor revenue or product-market fit. DORA validates internal delivery-performance relationships, not public changelog archaeology.
- A general causal result that funding amount predicts startup revenue. Funding is selection by investors and capacity to spend, not realized demand.
- A general causal result that a public job post means a role was filled, a roadmap item shipped, or customers requested that feature.
- Reliable universal outbound-response, interview-response, waitlist-to-paid, or landing-page-to-revenue thresholds for a founder with zero audience. The widely repeated figures are usually vendor benchmarks, self-selected founder anecdotes, or context-free Lean Startup lore—not transportable experimental baselines.
