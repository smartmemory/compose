## Bottom line for a zero-audience technical founder

Treat launch platforms as instrumentation, not distribution.

- The only platform here with a published recent outcome distribution is Show HN, and it is brutal: across 41,301 Show HNs (18 Jun 2025–18 Jun 2026), median result was 2 points and 0 comments; 61.7% received no comments and 78.9% received one or none. Fewer than 2% cleared 100 points. [Reproducible analysis and data](https://jonno.nz/posts/your-show-hn-dies-in-7-hours/)
- Product Hunt is not demonstrably “dead,” but no credible public longitudinal traffic/conversion dataset proves it is or is not declining versus its peak. It is now an uneven, rank-dependent one-day event—not a default acquisition channel.
- Reddit can create the best early signal only when you are answering an existing, specific pain in a niche community. Its giant platform audience is irrelevant; the relevant reach is the handful of people in the exact thread who have the problem.
- Discord/Slack, Indie Hackers, dev.to, and Lobsters have no credible published launch-conversion benchmark. Use them as qualitative-research surfaces. Do not make numerical forecasts from recycled founder anecdotes.

A “real signal” is not traffic, upvotes, stars, or waitlist emails. For a B2B/dev-tool experiment, count it only when at least one of these happens from a clearly in-ICP stranger:

1. They complete the core job in the product.
2. They ask for a follow-up, integration, security review, or team access.
3. They agree to a paid pilot or state a price-specific willingness to pay.
4. Three independent people describe the same painful workflow before seeing your solution.

Everything else is weak evidence. One stranger activating is a lead; three independent activated strangers is a signal; a paid or scheduled pilot is evidence.

## Hacker News / Show HN

This is the most measurable high-upside option for a developer/AI tool—and also the clearest lottery ticket.

### Current base rates

A reproducible analysis of every Show HN indexed by the Algolia HN API over a 12-month period found:

| Outcome | Result |
|---|---:|
| Sample | 41,301 Show HNs |
| Median score | 2 points |
| Median comments | 0 |
| No comments | 61.7% |
| One or no comments | 78.9% |
| 90th-percentile score | 8 points |
| Posts over 100 points | <2% |
| Half of eventual comments arrive by | 7.2 hours |

Source, methodology, raw data, and caveats: [“Your Show HN dies in 7 hours”](https://jonno.nz/posts/your-show-hn-dies-in-7-hours/). This is the best published answer I found to “what fraction produces nothing?” It likely understates failure because flagged/dead posts are absent from the API.

Volume got dramatically worse: one public analysis reports Show HNs rising from roughly 900/month in 2016–19 to 3,315 in December 2025. [Dataset summary on HN](https://news.ycombinator.com/item?id=46573831)

### What a front-page hit can do

Published 2025 founder example: #2 on HN produced 5,800 unique visitors and 320 signups, a reported 6.8% visitor-to-signup rate. That is a success case, not a benchmark. [Postmortem](https://www.reddit.com/r/EntrepreneurRideAlong/comments/1ir01xh)

For open-source AI tools, a 138-launch 2024–25 study found an average of 121 GitHub stars within 24 hours, 189 within 48 hours, and 289 within a week after HN exposure. It does not establish causal effects for all Show HNs and its sample is not the median launch. [Study](https://arxiv.org/abs/2511.04453)

### Etiquette / removal risk

Follow the actual [Show HN guidelines](https://news.ycombinator.com/showhn.html): title begins `Show HN:`, show something people can use, make it clear you built it, and engage substantively in comments. The bigger hidden rule is HN’s general [guidelines](https://news.ycombinator.com/newsguidelines.html): do not use HN primarily for promotion. Promotional accounts, spam rings, and repeatedly low-quality promotional domains do get killed/banned. [Moderator explanation with examples](https://news.ycombinator.com/item?id=43278249)

Good framing:

- “Show HN: X — a CLI/API that does Y; here is the technical tradeoff.”
- A usable demo, GitHub repo, docs, pricing, and honest limitations.
- Answer hostile technical questions promptly and concretely.

Bad framing:

- “Introducing the revolutionary AI-powered…”
- An email gate before anyone can see the thing.
- Asking friends to brigade votes.
- Posting a generic wrapper with no technical substance.

### Threshold

- **No signal:** ≤1 comment or no stranger attempts the product. This is the base case.
- **Weak signal:** 3–10 substantive comments, including one user describing a real use case.
- **Genuine signal:** 3+ strangers activate, or one asks to deploy/pilot/pay.
- **Do not infer lack of demand from one miss.** The median post gets no conversation because of distribution mechanics, not necessarily because the product is bad.

Use it when the artifact is technically interesting on its own: a tool, benchmark, protocol, local-first workflow, open-source component, or contrarian engineering result. Do not use it as the first test of a generic B2B workflow app.

## Product Hunt

### Is it in decline?

**Not proven from reliable public data.** I found lots of “Product Hunt is dead” opinions and no credible public time series showing Product Hunt’s referral traffic, visitor-to-signup conversion, or median launch outcomes from its peak through 2026.

The available public evidence says:

- The platform still has substantial activity: a public scrape of Q1 2026 reported 1,309 launches and roughly 245,000 upvotes. It did not publish referral traffic or conversion outcomes. [Source](https://www.reddit.com/r/ProductHunters/comments/1rwy352/i_scraped_1309_product_hunt_launches_from_q1_here/)
- The large academic PHBench dataset contains 67,292 *featured* PH posts from 2019–25. Only 528 matched a verified Series A within 18 months (0.78%). That is not a product-quality or conversion metric, but it strongly warns against treating a PH badge as business validation. [PHBench](https://arxiv.org/abs/2605.02974)
- A claimed “50 launches” study is not usable as independent evidence: it sells upvote packages, includes only 50 selected launches, omits product identities, and reports correlations, not causal outcomes. [Study and disclosures](https://uprowshub.com/blog/product-hunt-50-launches-study)

So: it matters as a dated public page, potential backlink, one-day curiosity spike, and perhaps a few conversations. It is not a reliable zero-audience customer-acquisition machine.

### Real 2026 launch numbers

Case-level data, not population benchmarks:

| Outcome | Observed result | Caveat |
|---|---|---|
| #20 product | 280 total site visitors, ~90 upvotes, 62 waitlist signups; author says only about half the visitor spike was PH | Free Chrome extension; same-day email campaign confounds attribution. [Full dashboard write-up](https://hirekai.ai/blog/how-we-grow/003-what-a-product-hunt-launch-buys-you) |
| #2 product | 1,196 visitors over two days, 34 signups, 0 paid customers at reporting time | Self-report; total site traffic, not clean PH attribution. [Postmortem](https://www.reddit.com/r/ProductHuntLaunches/comments/1upmr2s/we_hit_2_on_product_hunt_yesterday_here_is_what/) |
| One PH community reply | ~1,500 unique visitors and ~120 signups in 48 hours | Self-report, no rank/category disclosed. [Discussion](https://www.producthunt.com/p/general/what-s-your-real-conversion-outcome-from-a-product-hunt-launch) |
| 2024 exceptional success story | 500k+ impressions, 16k signups, 850 paid users | Existing product and launch machinery; explicitly not representative. [PH story](https://www.producthunt.com/stories/initially-failed-ph-launch-turned-around-to-get-us-850-paid-subscribers) |

Claims such as “top 3 gets 5k–15k visitors” and “B2B converts at 1–2%” are circulating in current vendor content, but I found no disclosed dataset supporting them. Treat them as planning folklore, not benchmarks.

### Etiquette and cost

A launch is free in cash, but commonly consumes one focused day plus prep. With zero audience, do not spend weeks manufacturing a launch list: that turns the experiment into a popularity contest before you have evidence.

Use a direct product page, no fake scarcity, no vote-buying, no coordinated vote asks, and answer every legitimate comment. A PH launch with a self-serve demo is more useful than a “book a demo” page because it lets you measure activation.

### Threshold

- **No signal:** upvotes, badge, press-like impressions, or waitlist signups with no activation.
- **Weak signal:** 10+ activated accounts from PH-tagged traffic.
- **Genuine signal:** 3+ retained active users at day 14, or one buyer-quality conversation that progresses to a pilot.
- **Do not launch first.** Run it after you can identify the user, show a real result in under five minutes, and instrument `source → signup → activation → day-14 return → paid/pilot`.

## Reddit

Reddit is enormous—126.8 million daily active uniques in Q1 2026—but that does not mean a post has meaningful reach. [Reddit’s Q1 2026 results](https://investor.redditinc.com/news-events/news-releases/news-details/2026/Reddit-Reports-First-Quarter-2026-Results/default.aspx)

There is no credible public study of organic Reddit-launch visitor-to-signup conversion, removal rate, or ban rate by subreddit. Be suspicious of the many “1–8%” claims: they mostly come from Reddit-marketing vendors with undisclosed client samples.

### What gets removed or banned

Reddit-wide spam and disruption rules were clarified in October 2025, but individual moderators make the practical rules. [Transparency report](https://redditinc.com/policies/transparency-report-july-to-december-2025-reddit)

Reddit’s own 2025 organic-engagement guidance says to:

- ask mods via ModMail before posting, especially in communities about your business;
- spend time commenting before your first post;
- read each community’s rules;
- communicate like an individual;
- comment frequently and post sparingly;
- avoid outright recommending your own brand and avoid link-spam. [Official playbook](https://redditinc.com/hubfs/Reddit%20Inc/Content/Reddit%20Pros%20organic%20playbook.pdf)

The same playbook’s business-content target is a 75%+ upvote rate, but that is a content-resonance metric, not a buyer/conversion metric.

Practical removal triggers:

- link-only launch drop;
- post that is substantially an ad, including “feedback” phrased as an acquisition CTA;
- no history in the subreddit;
- breaking a recurring promo day/weekly thread/required flair rule;
- using alts, astroturfing, vote manipulation, or unsolicited DMs;
- replying to unrelated threads with your link.

### Which subreddits tolerate what

Do not use a static 2026 “best subreddits” list. Rules and mod enforcement vary and change. The useful distinction is:

| Community type | What may be tolerated | Buyer value |
|---|---|---|
| Exact ICP/problem subreddit | Helpful answer to an existing request; explicit disclosure; link only if rules/mod allow | Highest |
| Project-builder communities, e.g. r/SideProject | A project/feedback post, build log | Usually low; many founders, few buyers |
| Founder communities, e.g. r/SaaS / r/indiehackers | Specific metrics, teardown, lessons | Mostly peer feedback, not customer demand |
| Large technical communities | Technical write-up, open-source release, benchmark | Potentially high, but direct commercial launch is often removed |
| Promo thread / promo day | Clearly labelled project listing | Low intent; useful only for logistics testing |

Even builder communities are tightening. r/SaaS announced a stricter anti-self-promotion rule in 2026, despite older guidance mentioning limited self-promotion. [Moderator announcement](https://www.reddit.com/r/SaaS/comments/1slno92/new_rule_against_selfpromo/) This is exactly why “I read a Reddit marketing guide” is not a defense—read the live sidebar, pinned posts, and recent moderator announcements immediately before posting.

### How to use it without getting banned

1. Find 20 threads where a person describes the job-to-be-done in their own words.
2. Spend 1–2 weeks giving useful, non-link answers. Do not manufacture questions.
3. For 3–5 highly relevant threads, answer the question directly. Disclose: “I’m building X; it may fit this; happy to share access if mods/users are okay with it.”
4. Ask ModMail before a standalone post. State exactly what you want to post, disclose affiliation, and ask what format/timing they prefer.
5. Never mass-DM commenters. Reddit’s platform and community norms treat that as spammy even if a moderator cannot remove it.

### Threshold

- **No signal:** karma, impressions, founder praise, or generic “cool tool” comments.
- **Weak signal:** 3 unsolicited “can I try this?” requests from people with the exact problem.
- **Genuine signal:** 3 users complete the job; one offers a data set, integration, intro to their team, or payment.
- **Stop condition:** 20 high-quality, genuinely helpful interactions with no one asking for access or describing pain in your words. Reposition the problem/ICP rather than increasing posting volume.

## Discord and Slack communities

Discord has 200m+ monthly active users, but this says nothing about access to a particular server or a launch’s reach. [Discord’s 2025 announcement](https://discord.com/press-releases/announcing-discords-social-sdk-helping-power-your-games-social-experiences)

There is no useful platform-wide “Discord/Slack launch conversion rate.” These are private, heterogeneous spaces; administrators can delete you silently, restrict channels, or ban you. Averages would be nonsense.

### Current etiquette

- Join because you can contribute to the community’s work, not to conduct a launch.
- Read rules and channel descriptions; post in `#introductions`, `#showcase`, `#feedback`, or `#jobs` only if explicitly allowed.
- Ask an admin privately before a product announcement.
- Offer a bounded research ask: “I will set up this workflow for three teams and report the results,” rather than “try my SaaS.”
- Disclose your affiliation and do not DM members unsolicited.
- Do not scrape member lists or automate outreach.

Discord’s platform policy applies to content, accounts, servers, and apps, while each server adds local rules. [Discord Community Guidelines](https://discord.com/guidelines) For Slack apps specifically, commercial distribution outside the Marketplace has tighter API limits since May 2025—`conversations.history` and replies are limited to one request/minute and 15 objects per request for new unlisted commercial apps. [Slack policy change](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)

### Threshold

- **No signal:** reactions, “welcome!” replies, or people joining your server.
- **Weak signal:** 2–3 relevant members agree to a research call or trial.
- **Genuine signal:** one community member champions the tool, brings in a teammate, or asks to use it in a real production workflow.
- **Timebox:** 2–4 weeks of contribution before proposing anything; abandon a community if your contribution produces no relevant conversations. Do not keep “networking” indefinitely.

## Indie Hackers

Indie Hackers is useful for founder process feedback and accountability; it is weak evidence of B2B buyer demand because its audience is disproportionately builders and aspiring builders.

I found no reliable current traffic, launch conversion, or “fraction of posts that get zero attention” dataset. Current public launch posts often explicitly report quiet traffic and no signup flood; that is anecdote, not a denominator. [Example](https://www.indiehackers.com/post/day-3-after-launch-quiet-traffic-but-strong-signal-c26f8b7bd6)

Use it for:

- publishing a precise experiment result;
- recruiting peer reviewers;
- finding founders who have the same operational problem;
- documenting a build/measure iteration.

Do not use it to answer “will our actual buyer pay?”

**Threshold:** an IH post is useful only if it produces 2+ conversations with founders who fit the real ICP, or exposes a recurring objection you can test. Otherwise it is content for other founders.

## dev.to

dev.to is a search/content surface, not a launch platform. A product announcement is generally weak; a genuinely useful technical article can compound slowly through search and can attract developers who need the underlying capability.

The [DEV Code of Conduct](https://dev.to/code-of-conduct) is not a promotion policy, and I could not find a current published platform-wide organic conversion or referral-traffic benchmark. Therefore do not forecast one.

Use it only when you can write something independently valuable:

- a reproducible benchmark;
- an implementation guide;
- an open-source reference project;
- a postmortem with exact technical tradeoffs.

Put the product link in a disclosed author note or relevant final section; do not make the article a disguised landing page.

**Threshold:** 100 readers is not a signal. One qualified inbound implementation question is weak signal; 3 qualified inbound conversations or 1 production trial is real signal. Expect weeks to months, not launch-day feedback.

## Lobsters

Lobsters is small, technical, and unusually explicit about anti-promotion rules. It is appropriate only if what you made will improve a reader’s next program or deepen understanding of their last one.

Its rules state:

- self-promotion should be under one quarter of a user’s stories and comments;
- commercial-service promotion can be flagged as spam;
- new users are restricted for 70 days and cannot submit a previously unseen domain;
- entrepreneurship, management, and company news are off-topic. [Lobsters rules](https://lobste.rs/about)

The moderation log shows actual deletions for “Ad,” “Slop,” and off-topic management/business posts. [Live moderation log](https://lobste.rs/moderations)

That means a brand-new founder cannot credibly use Lobsters as a launch target for a commercial B2B product. An established participant can submit a technical artifact, release, deep write-up, or open-source component—not a sales page.

**Threshold:** any substantive technical discussion from practitioners is useful. A signup count is not the point. If the discussion is only about your marketing or never reaches technical use, it failed.

## Minimal experiment sequence

For a no-budget developer/AI founder:

1. Pick one narrow ICP and one expensive/repeated technical workflow.
2. Instrument a self-serve proof: source URL, landing-page view, signup, first value, return, “invite teammate,” and paid/pilot intent.
3. Spend two weeks in 2–3 exact-problem communities, answering existing questions and inviting only clearly relevant people.
4. Run Show HN only when the thing is technically demonstrable and robust enough for hostile scrutiny.
5. Run Product Hunt later as a tagged one-day awareness/activation test, not as proof of demand.
6. Publish one dev.to-style technical asset only if it answers a search-worthy question; treat it as a 30–90-day experiment.
7. For every channel, record `qualified visitor → activation → day-14 retained → pilot/payment`. Kill channels with views but no activation.

## WHAT I COULD NOT FIND

- A reliable, public, current organic Reddit dataset showing visitor-to-signup conversion, removal rate, ban rate, or launch outcome distribution by subreddit. Vendor claims of “typical Reddit conversion” are mostly unsupported or use undisclosed client samples.
- A reliable Product Hunt time series comparing current median referral traffic, conversion, or signup outcomes with 2015–2021 peak-era launches. The claim that PH is “in decline” is widespread but not demonstrated by an accessible, methodologically sound dataset.
- A representative Product Hunt distribution for 2025–26: median visitors, median signups, percent with zero signups, conversion by rank, and retention by category. Public numbers are selected founder postmortems; rank and attribution are often missing.
- A platform-wide Discord or Slack launch-conversion rate. This cannot be sensibly generalized because reach is server-specific, private, and controlled by local admins.
- Current, reliable traffic/conversion/zero-attention distributions for Indie Hackers, dev.to, or Lobsters launches.
- A defensible universal B2B “good conversion rate” for these surfaces. Traffic source, self-serve versus demo flow, price, buyer role, and activation definition change the denominator too much.
- Evidence that a particular posting day/time reliably improves outcomes across Reddit or Product Hunt. These recommendations are often copied from old guides; HN’s rapidly increasing submission volume makes historical timing advice especially fragile.
