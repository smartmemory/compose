## The click collapse is real, but narrowly measured

Google’s AI Overviews materially reduce outbound clicks on the queries where they appear.

- The strongest independent behavioral dataset is [Pew’s study of 900 US adults and 68,879 Google searches in March 2025](https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/). On searches with an AI summary, users clicked a traditional result on **8%** of visits, versus **15%** without one. They clicked a source inside the AI summary on only **1%** of visits. Sessions ended after the results page **26%** of the time with an AI summary, versus **16%** without.
- [Ahrefs’ 300,000-keyword / aggregated Search Console study](https://ahrefs.com/blog/ai-overviews-reduce-clicks-update/) estimates that, by December 2025, position-one CTR on informational AIO queries was **1.6%**, versus a counterfactual **3.7%**: a **58%** reduction. This is an observational estimate, not a clean causal experiment.
- [Seer’s larger first-party study](https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-2026-update) covers **53 brands, 5.47m tracked queries, and 2.43bn organic impressions**. For 2025 AIO queries where the tracked brand was *not* cited, organic CTR fell **67%** across **311m impressions**—about **13,000 fewer clicks per 1m impressions**. Being cited correlated with **2–5×** the organic CTR of uncited brands.
- This is not “every Google query is dead.” [Semrush/Datos’ 200,000-keyword analysis](https://www.semrush.com/blog/semrush-ai-overviews-study/) found higher zero-click rates on AIO queries but did **not** find that zero-click rate itself rose over 2025; query mix and intent confound simple before/after stories. Treat universal “AI reduced all SEO traffic by X%” claims as unsupported.

For technical products, assume informational explainers, comparisons, and “how do I…” pages lose most of their historical click yield. Seer found AIOs on **95.4%** of informational `X vs Y` queries in its sample. That does not mean comparison pages are useless; it means an uncited #1 ranking is no longer a reliable traffic asset.

Chat/answer-engine referrals are growing fast but remain tiny relative to search. [Similarweb estimates](https://www.similarweb.com/blog/insights/ai-news/ai-referral-traffic-winners/) AI platforms sent **1.13bn** referrals in June 2025, up **357% YoY**, versus **191bn** Google-search referrals—roughly **0.6%** of Google’s volume. It is premature to replace traffic goals with “AI visibility” goals.

## Is SEO viable from a new domain?

Yes, but it is an asset-building channel, not a zero-to-signal channel.

The relevant historical baseline is grim even before AIOs: [Ahrefs’ 1.3m-keyword study](https://ahrefs.com/blog/how-long-does-it-take-to-rank-in-google-and-how-old-are-top-ranking-pages/) found **72.9%** of top-10 pages were over three years old; only **13.7%** were under a year; just **1.74%** of newly published pages reached the top 10 within a year. High-volume terms were particularly unlikely: **94%** of pages never ranked for them.

A realistic zero-domain timeline:

| Stage | Realistic timing | What it means |
|---|---:|---|
| Indexing / first impressions | Days to weeks | Technical setup works; not demand validation. |
| Long-tail ranking tests | 2–4 months | Possible for narrowly scoped, genuinely useful artifacts. |
| Repeatable qualified organic traffic | 6–12+ months | Requires a corpus, links/mentions, and a topic where search still produces clicks. |
| Competitive category terms | 12–24+ months, often never | Do not make this your initial distribution bet. |

There is no credible 2025–26 published cohort study that gives a precise “new technical SaaS domain reaches N qualified visits in M months” answer. The common “SEO takes six months” slogan is a heuristic, not a measured law.

**SEO threshold:** do not call it a channel until, for a rolling 28 days, it produces either:

- **100+ ICP-relevant organic sessions and 3+ high-intent actions** (trial, demo, install, or a problem-specific reply), or
- a page/category repeatedly producing **10+ qualified actions per month**.

Search impressions, indexed pages, keyword movement, and “domain authority” are diagnostic signals—not customer signals. Use SEO only for things with non-commodity utility: an open-source integration, benchmark dataset, calculator, migration tool, compatibility matrix, reproducible experiment, or unusually specific implementation guide.

## GEO/AEO: real but oversold

“GEO” is mostly a new measurement label wrapped around old fundamentals: create source-worthy original material, be crawlable, be mentioned by credible third parties, and make claims easy to verify.

Google is unusually explicit. Its [official guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) says AI search is grounded in the core Search index; standard SEO remains relevant. It specifically says Google does **not** reward `llms.txt`, special AI markup, artificial “chunking,” rewriting solely for AI, or inauthentic mentions. [Its original AI-features documentation](https://developers.google.com/search/docs/appearance/ai-features) likewise says there are no special technical requirements beyond being indexed and snippet-eligible.

There is some evidence that content treatment can change answer-engine visibility:

- The peer-reviewed [KDD 2024 GEO paper](https://doi.org/10.1145/3637528.3671900) reported up to **40%** higher visibility in its controlled benchmark. Important caveat: this was benchmark “visibility,” not real-world traffic, leads, or durable live-engine citation share.
- A 2026 field study using one high-traffic domain’s first-party logs found an AEO intervention associated with a **1.82×** increase in ChatGPT referrals (95% CI 1.31–2.54), versus untreated pages. But its conservative placebo test was not significant (**p=0.16**), and the study is one domain with a short/noisy pre-period. Its own conclusion should be read as suggestive, not proof. [Study](https://arxiv.org/abs/2606.04362).
- There is real mechanical visibility value in being cited inside Google AIOs: Seer’s data above finds cited brands receive materially higher CTR. That proves the *outcome* matters, not that any particular “GEO hack” causes it.

Practical AEO for a developer-tool founder:

1. Publish evidence that cannot be cheaply paraphrased: benchmark methodology/data, versioned compatibility results, incident postmortems, real code, before/after traces, pricing/limits, and precise product claims.
2. Make every important fact independently checkable; link primary sources and show dates, versions, and methodology.
3. Ensure public HTML is crawlable, stable, internally linked, and not hidden behind a JS/login wall.
4. Maintain your canonical product facts—what it does, integrations, constraints, pricing, security model—on one clear page.
5. Earn genuine third-party references: docs integrations, GitHub, developer-community answers, independent reviews, podcasts/newsletters only where they are actually relevant.
6. Allow the relevant crawler. OpenAI says publishers permitting `OAI-SearchBot` can track ChatGPT referrals through `utm_source=chatgpt.com`; [documentation](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq).

**GEO threshold:** test 20 high-intent prompts across ChatGPT, Perplexity, and Google AI search weekly for six weeks, with three fresh runs per prompt. A “citation” is not a win. Call it a signal only when you see both:

- repeatable presence on at least **20% of the prompt-runs** for a defined ICP problem set; and
- **20+ attributable answer-engine sessions** plus at least **2 high-intent actions**.

Below that, you have an interesting observation, not a channel. Do not buy GEO software or agencies because they can display a “visibility score.”

## Building in public: useful instrumentation, weak acquisition engine

The direct evidence is much weaker than the SEO evidence.

The closest targeted dataset I found is [Distribution Base’s database of 68 bootstrapped apps](https://www.distributionbase.com/blog/channels/x-twitter/build-in-public-results). **43/68** used building in public; **23/43** reported reaching $100k+ ARR. But it is a selected, retrospective database—not a representative sample, and it cannot show that public posting caused revenue. Its most useful negative result: every build-in-public company above $1m ARR also had another acquisition channel; it classifies meaningful traction as typically **6–12 months** of consistent posting. The famous Chatbase case—$1m ARR in 117 days from a tweet to 16 followers—is explicitly an outlier, not a forecast.

So use public work to test messages and recruit design partners, not to “build an audience.”

### X

X can produce fast reach, but it is volatile and buyer-quality is unproven. [Buffer’s 52m-post analysis](https://buffer.com/resources/state-of-social-media-engagement-2026/) puts 2025 median X engagement at about **2.8%**; text posts were **3.56%**, links **2.25%**. It also found a sharp 2025 performance split between Premium and ordinary accounts. These are platform-wide publishing benchmarks, not technical-founder conversion benchmarks.

**X threshold:** over four weeks, use posts/replies about one narrowly defined pain. Continue only if it yields **3+ unsolicited ICP conversations** or **5+ visits to a single problem-specific CTA with at least one activation**. Follows, likes, and broad impressions do not qualify.

### LinkedIn

For B2B technical buyers, LinkedIn is more plausibly useful than X, especially for buyer conversations rather than founder-audience applause.

- [Socialinsider’s 1.3m-post / 16,645-business-page analysis](https://cdn.socialinsider.io/documents/linkedin_benchmarks_2026.pdf) puts average 2025 engagement around **5.2%** and reports **24.5%** average audience growth for small pages—but these are business pages, not zero-follower personal founder profiles.
- [Oktopost’s B2B company-page dataset](https://www.oktopost.com/linkedin-benchmark-report/) reports median engagement **5.10%**, with the top quartile at **8.61%**. Again: company pages only, not founders. Its technology/201–500-employee example had **927 median impressions/post**, but it is irrelevant as a forecast for a solo founder.

**LinkedIn threshold:** in four to six weeks, require **5+ ICP conversations**, **2+ people describing the same painful workflow in their own words**, and **one request to try, review, or introduce the product**. A carousel’s engagement rate is not validation.

### YouTube

YouTube has the best long-tail discovery potential of the social platforms, but is the highest production cost and slowest feedback loop.

[vidIQ’s 10.2m-channel analysis](https://vidiq.com/es/research/youtube-upload-frequency-study/) found that channels with 1,000+ subscribers posting 4–7 times/month had median **1.32% monthly view growth** and **0.39% subscriber growth**; even 12+/month channels had only **0.91% subscriber growth**. This does not forecast a zero-subscriber technical channel—the sample excludes it. In a separate large dataset, [65m channels with at least one subscriber](https://vidiq.com/blog/post/youtube-subscriber-growth-statistics/) showed that merely reaching 100 subscribers exceeds about 37% of channels.

**YouTube threshold:** publish four narrowly useful screen-recorded problem-solving videos over six weeks. Continue only if one gets **100+ relevant views plus 2+ qualified downstream actions**—repo stars, docs visits, waitlist installs, or buyer questions. Subscriber count alone is not a business signal.

### dev.to

Use it as syndication, community discovery, and a potential backlink/citation surface—not a reliable acquisition engine. I found no credible, platform-wide 2025–26 data on median dev.to views, follower growth, external click-through, or developer-tool conversion from a zero-author account.

**dev.to threshold:** one post should produce **one identifiable external outcome**—a relevant GitHub issue/star, product signup, ICP reply, or quality inbound link—within 30 days. Otherwise syndicate less and spend time on the source artifact.

## What produces signal in weeks?

1. **A sharp technical artifact distributed through X + LinkedIn + relevant developer communities:** fastest. The artifact is the test; posts are instrumentation. A benchmark, free CLI, integration template, “we measured X” report, or public compatibility matrix can yield conversations in days.
2. **Founder posts/replies on LinkedIn and X:** fast enough to test a problem/message in 2–6 weeks; unreliable for compounding acquisition. Optimize for conversations, not reach.
3. **A narrow YouTube demo:** can produce weeks-scale signal if it solves an urgent searchable problem, but video production makes it expensive in founder time.
4. **AEO/GEO measurement:** citations may appear in weeks, but referral volume rarely validates anything that quickly. Treat it as a distribution overlay on strong material.
5. **SEO:** not suitable for initial instrumentation. Start it now only because useful artifacts compound, not because you expect a verdict this quarter.

For a no-budget founder, the rational stack is: build one instrumented, genuinely useful technical artifact every 2–3 weeks; publish the underlying result on your site; turn it into one X post, one LinkedIn post, one short demo, and one dev.to/community contribution; tag every CTA by artifact and channel. Kill a theme after 4–6 weeks without qualified conversations. Double down on the *problem framing* that makes qualified people ask for access or describe their current workaround.

## WHAT I COULD NOT FIND

- A reliable published estimate of zero-to-N followers, impressions, trials, or revenue for a solo technical founder on X, LinkedIn, YouTube, or dev.to. Available social datasets mostly measure established business pages or all creators, not founders starting at zero.
- A credible, general conversion rate from social followers or impressions to B2B developer-tool trials, paid users, or pipeline. Claims such as “1,000 followers equals X customers” are survivorship anecdotes.
- A representative 2025–26 cohort study giving a precise time from a brand-new technical-product domain to meaningful qualified organic traffic. The standard “3–6 months” and “six-month sandbox” advice is not robust causal evidence.
- A causal study showing how much ChatGPT, Claude, or Perplexity specifically reduced a given site’s Google organic clicks. The best click-loss evidence is for Google AIOs; answer-engine referral data shows growth, not displacement causality.
- Reliable evidence that `llms.txt`, special schema, content chunking, “fan-out page” farms, or paid “AI mentions” increase citations in major live answer engines. Google explicitly says these are unnecessary or ineffective for its AI search.
- A reliable published benchmark for Claude referral volume, citation share, or conversion. Public AI-referral reports generally aggregate platforms or are dominated by ChatGPT.

