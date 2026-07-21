## The actual minimum

A meaningful paid-demand test is not “spend $50 and see if anyone clicks.” For a single, pre-specified offer, use **500 measured landing-page sessions** as the minimum serious read. Treat **300 sessions** as a cheaper screen only.

At 500 sessions:

- 25 conversions = 5.0%; **95% Wilson CI ≈ 3.4%–7.3%**. If your precommitted viability floor is 3%, that is a genuine positive signal.
- 10 conversions = 2.0%; CI ≈ 1.1%–3.6%. Ambiguous if the floor is 3%.
- 0 conversions in 300 sessions means the 95% upper bound is about **1.0%**. That is evidence against an offer needing even a 1% response rate.
- 15/300 = 5.0%; CI ≈ **3.1%–8.1%**: a good directional positive, but not a precise estimate.

That 3% floor is an example, not a universal rule. Set the floor from economics before launch: qualified-action rate × activation rate × gross profit must plausibly support the channel.

For a binomial conversion rate, the planning approximation is:

\[
n = \frac{1.96^2p(1-p)}{E^2}
\]

where \(p\) is expected conversion rate and \(E\) is desired absolute margin of error. Use Wilson or exact binomial intervals when reporting results; normal intervals behave badly with few conversions. [NIST sample-size guidance](https://www.itl.nist.gov/div898/handbook/prc/section2/prc242.htm) and [NIST’s warning about small-count intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).

| Expected CVR | Desired 95% precision | Clicks/sessions needed |
|---|---:|---:|
| 2% | ±1 percentage point | 753 |
| 3% | ±2 points | 280 |
| 5% | ±3 points | 203 |
| 5% | ±2 points | 456 |
| 5% | ±1 point | 1,825 |
| 10% | ±3 points | 384 |

Do not split a 500-session experiment across five messages, audiences, and landing pages. That produces five underpowered anecdotes. A real two-variant comparison is much more expensive: detecting **3% versus 6%** with 80% power and 5% significance needs roughly **750 sessions per arm**—about **1,500 total**.

## Cost of one demand experiment

The table prices **550 paid clicks** to allow a modest buffer before obtaining 500 measured sessions. Use actual landing events, not platform-reported clicks, as \(n\). These are planning ranges, not promises; auction price, geography, offer, and targeting can move them dramatically.

| Channel | Evidence-backed cost reference | 500-session experiment cost | What it can legitimately tell you |
|---|---|---:|---|
| Google Search | $5.48 average CPC in a 2025 B2B SaaS portfolio; observed vertical range $2.45–$18.34. General “Business Services” benchmark: $5.58 CPC, 5.14% CVR. [TripleDart’s 84-account / $60m portfolio](https://www.globenewswire.com/news-release/2026/04/13/3272700/0/en/TripleDart-Releases-2026-State-of-SaaS-PPC-Benchmark-Report-Based-on-60M-in-Managed-Ad-Spend.html); [WordStream benchmark](https://www.wordstream.com/blog/2025-google-ads-benchmarks). | **~$3,000–$9,900** at $5.48–$18/CPC. | Best available paid test of existing problem/solution demand, because the user chose a query. |
| Reddit | Published compilations put ordinary campaign CPC around $0.50–$2.50 and CPM around $3–$10; the platform minimum is $5/day. The underlying evidence is much weaker than for Google/LinkedIn. [Cost compilation](https://www.wordstream.com/blog/reddit-advertising-cost). | **~$275–$1,375**. | Response from people in a particular community to a particular framing—not proof of buyer demand. |
| LinkedIn | A 70+ B2B SaaS-company, $28m-spend dataset reported CPC of $10.48 in Q1 and $15.72 in Q3, with CTR 0.82%–0.96%; that implies an effective CPM of roughly $86–$151. [HockeyStack methodology and results](https://www.hockeystack.com/lab-blog-posts/linkedin-ads-benchmarks). | **~$5,760–$8,650**. | The cleanest paid test of whether a defined technical job-title/company segment raises its hand. |
| Meta | 2025 “Business Services” traffic campaigns: $0.75 CPC, 1.38% CTR, implying ~$10.35 eCPM—but this is cheap traffic, not a B2B SaaS lead benchmark. A B2B SaaS portfolio reported 3.1% CVR and $94 CPL, implying ~$2.91 CPC. [Traffic benchmark](https://localiq.com/blog/facebook-advertising-benchmarks/); [B2B SaaS portfolio](https://www.globenewswire.com/news-release/2026/04/13/3272700/0/en/TripleDart-Releases-2026-State-of-SaaS-PPC-Benchmark-Report-Based-on-60M-in-Managed-Ad-Spend.html). | **~$410** at generic traffic CPC; **~$1,600** using the B2B SaaS implied CPC. | Whether interruption-based creative can create enough curiosity among a broad audience. Weak evidence of pre-existing developer-tool demand. |

For Google Search, CPM is mostly a derived metric rather than the buying unit: Business Services’ 5.65% CTR × $5.58 CPC implies roughly **$315 effective CPM**. Search costs more per impression because the impression is an active query, not feed inventory.

The expensive numbers are not a mistake. If your success criterion is “a defensible estimate of a 3–5% qualified-action rate,” then LinkedIn is usually a **$6k–$9k** experiment. If you only have $100, you can test whether ads deliver and whether the message is legible; you cannot credibly estimate demand.

## Platform-by-platform interpretation

### Google Search: the only first-choice channel for existing demand

Use exact/high-intent queries: problem + solution, alternative/competitor, workflow, integration, compliance failure, or explicit buying language. Do not buy broad “AI developer tools” traffic and call it validation.

A reasonable planning baseline is **$6–$18 CPC**, with the lower end supported by broad B2B SaaS data and the upper end consistent with competitive, high-value software auctions. Google’s public benchmark is not developer/AI-tool-specific; exact CPC must be forecast in your own Keyword Planner/account.

Threshold:

- **Positive:** at least 15 qualified actions in 300 sessions, or preferably 25 in 500, with the lower 95% bound above your predeclared floor.
- **Negative:** zero qualified actions after 300 relevant sessions when your floor is ≥1%.
- **Inconclusive:** low conversion count, low search volume, or traffic dominated by broad-match queries that do not express the intended pain.

Google does not require a huge budget to serve Search ads, but a small budget may simply take too long—or fail to spend because there is insufficient query volume. Google explicitly notes that low spend may reflect limited available traffic, not campaign quality. [Google budget guidance](https://support.google.com/google-ads/answer/13630812?hl=en). For smoke tests, use manual CPC or Maximize Clicks and judge the observed funnel; Google says Smart Bidding learning does not apply to Manual CPC, and automated strategies can take up to three weeks or one to two conversion cycles to calibrate. [Google learning-period documentation](https://support.google.com/google-ads/answer/13020501?hl=en-A).

### Reddit: cheap contextual reach, weak validation evidence

Reddit’s cheap CPC is real enough to make message testing affordable. It is not evidence that it supplies cheap B2B buyers. Published Reddit benchmarks are mostly agency posts, platform marketing, and unattributable case studies—not transparent cross-advertiser datasets. The repeated “$0.50–$2.50 CPC” range is usable only as a budget range.

Use one tightly relevant community cluster and one native-looking, specific claim. Test an explicitly priced or effortful next step, not an “AI tool waitlist” email field.

Threshold:

- **Positive:** the same 15/300 or 25/500 qualified-action rule, plus manual review showing converters match the intended role/problem.
- **Not positive:** low CPC, high CTR, or email captures without qualified follow-through.
- **Likely self-deception:** declaring success because a clever Reddit post received votes, comments, or curiosity clicks.

The $5/day platform floor is not a meaningful experiment. At $1.50 CPC it buys roughly three clicks/day. A $50/day budget can gather traffic; it does not magically create conversion-learning data.

### LinkedIn: expensive, but title/company fit is measurable

For a technical B2B buyer, LinkedIn is not “better” because it is B2B; it is better only when job function, seniority, company type, and geography are central to the hypothesis. The strongest available published dataset is still biased toward established companies: HockeyStack’s sample spans firms with $5m–$1bn ARR, not zero-audience founders. Its CPC results are nevertheless more credible than generic listicles because it describes sample size and spend. [Dataset details](https://www.hockeystack.com/lab-blog-posts/linkedin-ads-benchmarks).

Threshold:

- **Positive:** 25 qualified, role-matching actions from 500 sessions; validate company/job-title match, not merely form completion.
- **False positive:** LinkedIn Lead Gen Form fills that do not accept a follow-up, book, pay, or meet qualification.
- **Practical decision:** if the test needs an enterprise technical buyer and you cannot spend roughly $6k, do a smaller qualitative outreach test instead. Do not pretend $100 produces a statistically meaningful result.

LinkedIn’s actual launch floor is **$10/day** and **$100 lifetime** for a new inactive campaign, while LinkedIn itself suggests $25/day for new advertisers. [LinkedIn budget minimums](https://business.linkedin.com/advertise/ads/best-practices/maximize-your-budget). Those are UI constraints, not evidence thresholds; at $10–$16 CPC, $10/day is approximately one click/day.

### Meta: cheapest click, poorest direct proxy for active B2B demand

Meta is useful for testing pain language, visual/demo creative, and perhaps SMB-founder segments. It is a poor primary test of whether developers are already seeking a tool. The low $0.75 Business Services CPC is specifically for a **traffic objective**, so using it to forecast qualified developer-tool demand is category error.

Threshold:

- **Positive:** not merely a low CPM/CPC; reach the 15/300 or 25/500 qualified-action threshold and verify role/company fit.
- **False positive:** a high click-through rate with weak post-click behavior. Meta is extremely good at finding people who click.
- **Use it when:** your thesis is “this interruption creates a new desire” or your buyer is an SMB founder. Prefer Search when the thesis is “this problem is already urgent.”

Meta recommends a budget that runs for at least seven days; its documented learning convention is roughly **50 optimization events per ad set in seven days**. [Meta budget guidance](https://www.facebook.com/business/ads/pricing). At the B2B portfolio’s $94 CPL, that is about **$4,700/week**—a reason not to use conversion optimization as the gate for a founder-scale smoke test. Optimize for clicks/landing views; use your own predeclared statistical stopping rule.

## Learning phase versus enough data

These are different requirements.

- **Enough data for you to estimate conversion rate:** 300–500 post-click sessions for a directional single-offer read; more for precision or comparisons.
- **Enough data for the platform’s conversion optimizer:** often tens of optimization events. Meta’s published convention is ~50/week; Google provides no universal current conversion-count threshold and says duration depends on conversion volume, lag, and strategy.
- **Enough data to establish a scalable acquisition channel:** far more. You need repeatability across dates, creatives, audiences, and downstream activation/retention.

A small budget can work if it buys the pre-specified number of sessions. It does not need to “exit learning” when the experiment’s purpose is measurement rather than automated acquisition. Conversely, a $5/day campaign that remains live for a month is still not a valid test if it only delivered 100 sessions.

## Is paid traffic a legitimate substitute for an audience?

**Yes, for a narrow question:** “When a defined population sees this specific problem, promise, price, and call to action, what fraction takes an effortful next step?” It is often the fastest way for a zero-audience founder to buy a controlled sample.

**No, as a substitute for market proof:** it does not establish retention, repeat use, referral, willingness to pay at scale, sales-cycle viability, or organic demand. Paid feed traffic also does not measure the same thing as search traffic. A Google searcher for a named problem and a Meta scroller are different populations with different intent.

The cleanest smoke-test ladder is:

1. Search or tightly targeted LinkedIn traffic.
2. A landing page that names the painful job, target user, constraints, and price.
3. An action with real cost: payment/deposit, calendar commitment, domain-verified work email plus qualification, or a request to connect real data.
4. Personally follow every conversion within 24–48 hours.
5. Count only verified qualified actions as conversions.

An email-only waitlist measures tolerance for giving an email. A refundable deposit or a scheduled implementation conversation measures something closer to demand. If you cannot deliver yet, disclose that it is an early-access/preorder test; deception can inflate the metric and makes the test worse, not better.

## WHAT I COULD NOT FIND

- A transparent, independent 2025–2026 benchmark dataset specifically for **developer tools or AI tooling** with CPC, CPM, landing-page CVR, and downstream paid conversion by platform. Public sources collapse radically different products into “B2B SaaS,” “software,” or “business services.”
- A reliable published Reddit B2B/developer benchmark with disclosed raw sample size, spend, targeting, attribution, and downstream qualification. Most Reddit numbers are agency content, vendor material, or unverifiable practitioner anecdotes.
- A reliable universal “minimum spend for validation” figure. The popular $100/$500/$1,000 recommendations are mostly advice, not research; required spend is mathematically driven by CPC, conversion threshold, and desired precision.
- Evidence that any particular number of smoke-test signups predicts retention, revenue, or venture-scale demand. The Lean Startup literature supplies useful tactics, but the often-repeated validation anecdotes are not a general predictive study.
- A current, official universal conversion-event threshold for Google Smart Bidding, or published equivalent thresholds for standard Reddit and LinkedIn campaigns. Meta’s ~50-events-in-seven-days convention is documented; treating “50 conversions” as a universal law for every platform is unsupported.
- A trustworthy conversion-rate comparison between Meta traffic-objective campaigns, Meta B2B lead campaigns, Reddit community campaigns, and Google Search. The source definitions differ too much for direct comparison; cheap traffic metrics and qualified-lead metrics are routinely mixed in listicles.
