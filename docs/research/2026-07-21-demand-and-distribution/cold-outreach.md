## Current benchmarks: use as ranges, not promises

| Channel | Best current evidence | Realistic technical-B2B baseline | Interpretation |
|---|---|---:|---|
| Cold email | Hunter’s 2026 report: **31m emails sent in 2025** | **4.5% total sequence reply**, but sales outreach averages **3.0%** | Total replies include rejections and opt-outs; do not call this “interest.” |
| Cold email | Gong/30MPC: **85m emails** | Average rep: **2% reply**, **0.3% meetings booked**; top 10%: **8% reply**, **2.3% meetings** | Strong evidence of huge execution/targeting variance, but Gong’s data is from sales users—not a representative sample of founders. |
| LinkedIn outbound | Expandi: **13.2m connection requests**, 6.7m outbound messages, May 2025–Apr 2026 | **28.5% acceptance**, **10.4% message reply** overall; “Computer Software”: **27.5% acceptance**, **8.8% message reply** | Platform-owned but methodology/sample are published. It measures replies, not qualified demand or meetings. |
| LinkedIn InMail | LinkedIn’s official policy | No public B2B benchmark; Recruiter users must sustain **13% response across 100+ InMails / 14 days** | This is a recruiter-quality policy, not a SaaS-sales conversion benchmark. |

Sources: [Hunter State of Email Outreach](https://hunter.io/the-state-of-cold-email), [Gong’s 85m-email report](https://www.gong.io/files/gong-guide-how-to-master-cold-email-get-the-data-backed-guide-based-on-85-million-emails.pdf), [Expandi 13.2m-attempt methodology](https://expandi.io/blog/linkedin-outreach-benchmarks-2026/), [LinkedIn InMail policy](https://www.linkedin.com/help/linkedin/answer/a414226/finding-your-inmail-response-rate).

The honest planning number for a new technical product is **~3% total email replies and 0–1% meetings booked** until your own data proves otherwise. A reply rate is not validation. Track:

`delivered → human reply → positive problem reply → meeting held → trial/install → repeated use`

Open rates are not decision-grade: Apple privacy protection and security scanners distort them; Hunter also found campaigns with tracking disabled reported higher replies, but that is observational rather than proof of causation. [Hunter](https://hunter.io/the-state-of-cold-email)

## What changed in 2024–2026

### Deliverability is now a real operating constraint

Google classifies a sender as bulk at roughly **5,000 messages to personal Gmail accounts in 24 hours**, counts subdomains under the same primary domain, and makes that classification permanent. Bulk senders need authentication, DMARC alignment, TLS, one-click unsubscribe for promotional mail, and must honor unsubscribes within 48 hours. Since November 2025, Google has been ramping enforcement to temporary and permanent rejection. [Gmail sender FAQ](https://support.google.com/mail/answer/14229414)

Google’s operational threshold is stricter than its enforcement cliff:

- Target user-reported spam below **0.1%**.
- Never reach **0.3%**; above that, delivery worsens and mitigation is unavailable until the rate stays below 0.3% for seven consecutive days. [Gmail](https://support.google.com/mail/answer/14229414)
- Yahoo also requires authentication and its List-Unsubscribe header for promotional bulk mail, but deliberately does **not** publish a volume threshold; noncompliant mail may be spam-foldered or rejected. [Yahoo Sender Hub](https://senders.yahooinc.com/faqs/)

These rules do not mean 4,999/day is safe. They mean that 5,000/day triggers explicit requirements. At founder-scale, your risk is bad data, complaints, and abrupt send-pattern changes—not the bulk-sender threshold.

A broad deliverability benchmark—not a cold-email study—found 2024 Gmail inbox placement fell from 89.8% to 84.2% by Q4, while Microsoft averaged only 75.6% inbox placement. It supports the claim that inbox conditions tightened; it does **not** prove that a particular cold-email campaign will lose that percentage of delivery. [Validity 2025 Deliverability Benchmark](https://www.validity.com/wp-content/uploads/2025/03/2025-Benchmark-Report-FINAL-1.pdf)

### AI has raised the “looks like spam” bar; it has not been cleanly shown to cause a specific reply-rate decline

There is evidence of recipient fatigue:

- In Hunter’s decision-maker survey, **69%** said AI use bothers them when the result does not feel genuinely human; **65%** named overly sales-focused messaging and **61%** irrelevance as reasons cold email fails. [Hunter](https://hunter.io/the-state-of-cold-email)
- Validity reports increased AI-generated spam and declining trust, but supplies no causal estimate for cold-outreach reply rates. [Validity](https://www.validity.com/wp-content/uploads/2025/03/2025-Benchmark-Report-FINAL-1.pdf)
- Expandi measured LinkedIn connection-note replies dropping from **3.5% to 2.2%** from May 2025 to April 2026, while post-connection message reply held at 10.4%. It offers plausible explanations, not causal proof. [Expandi](https://expandi.io/blog/linkedin-outreach-benchmarks-2026/)

So: “AI flooded inboxes and cut reply rates by X%” is a widely repeated claim with **no reliable published causal estimate** I found.

## What still works

### 1. Narrow, signal-based targeting—not superficial personalization

The strongest published pattern is relevance tied to a current business/technical condition:

- Hunter: two custom attributes in the body: **5.6% reply** versus **3.6%** with none; manually edited emails: **5.2%** versus **4.4%** fully automated. [Hunter](https://hunter.io/the-state-of-cold-email)
- Gong: activity/company personalization had **9% direct replies** versus a **2% baseline**; individual/industry personalization showed 6%. Gong explicitly says referencing an executive’s alma mater is low value. [Gong](https://www.gong.io/files/gong-guide-how-to-master-cold-email-get-the-data-backed-guide-based-on-85-million-emails.pdf)
- Gong’s median manual emails got **2.1% replies**, versus **1.1%** for automated emails. [Gong Engage benchmark](https://help.gong.io/docs/engage-analytics-benchmarks-and-best-practices?app=wp)

“Personalization” means: a specific technical event that creates a plausible reason to care now.

Good: “You just opened a public issue about tracing agent failures across multi-step jobs. I built a small repro that identifies the missing handoff; want the 4-minute teardown?”

Bad: “Noticed you’re a staff engineer at Acme and love AI.”

Use AI for account research, deduplication, and drafting alternatives. Do not send its first draft unedited. It tends to manufacture relevance, which is worse than being terse.

**Signal threshold:** send one tightly defined thesis to **50 delivered contacts**, not 500 mixed contacts. If there are **zero positive replies after 100 delivered**, the 95% “rule of three” puts the upper bound of your observed positive-response rate at roughly 3%; stop scaling that thesis and change the segment, offer, or channel. This does not prove “no market.”

Do not A/B test copy at founder-scale. Distinguishing a 3% reply rate from 6% with conventional statistical power requires roughly **750 delivered contacts per arm**. Early tests should detect a live problem, not crown a subject line winner.

### 2. Short sequence, but published data conflicts on exactly how short

Hunter’s 31m-email analysis says **three total emails** produces 6.8% replies versus 3.3% from one, and that three or more follow-ups reduce average response. [Hunter](https://hunter.io/the-state-of-cold-email)

Gong’s 85m-email report recommends roughly **six emails over 14–28 days**, saying incremental reply falls below 0.5% after that. [Gong](https://www.gong.io/files/gong-guide-how-to-master-cold-email-get-the-data-backed-guide-based-on-85-million-emails.pdf)

For a zero-audience founder, use **three emails maximum**: initial note, one follow-up with a new concrete artifact/observation, final close-the-loop. The Hunter result is newer and better aligned with avoiding reputation damage; the six-touch rule is not established fact.

**Signal threshold:** the second touch must produce incremental positive replies. If it only generates “unsubscribe,” “not interested,” or silence across 50+ contacts, stop the sequence rather than adding steps.

### 3. Small batches and restrained send volume

Hunter reports:

- Sequences of **21–50 recipients**: 6.2% reply; 500+: 2.4%.
- **20–49 emails/account/day**: 5.7% reply versus 4.5% overall.
- One or two contacts per company: 5.1% reply; three or more: 3.5%. [Hunter](https://hunter.io/the-state-of-cold-email)

Those are associations, not a safe-domain formula. Still, for this goal: start at **10–20 new emails per weekday**, one person per account, one account at a time. There is no reason to send 100/day before you know that anyone has the problem.

**Hard operational thresholds:**

- Gmail-reported spam: investigate immediately above **0.1%**; do not continue at **0.3%**. [Gmail](https://support.google.com/mail/answer/14229414)
- Bounce rate: Hunter’s dataset average was 3.6%; treat **>2%** as a list-verification failure before blaming copy. The 2% cutoff is practitioner guidance quoted by Hunter, not a mailbox-provider rule. [Hunter](https://hunter.io/the-state-of-cold-email)
- Do not contact three people at the same company simultaneously.
- Do not use LinkedIn automation/scraping. LinkedIn explicitly prohibits bots for access, adding/downloading contacts, messages, and profile scraping. [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement)

## LinkedIn: useful for instrumentation, not a magic inbox

For software, Expandi’s huge but vendor-owned dataset reports **27.5% connection acceptance**, **2.8% connection-note reply**, and **8.8% later-message reply**. This is below its platform’s 10.4% message-reply average. [Expandi appendix](https://expandi.io/blog/linkedin-outreach-benchmarks-2026/)

Use LinkedIn manually for a different job than email:

1. Find and verify the right buyer/champion.
2. Establish that you understand their actual technical context.
3. Ask permission to send a tiny useful thing, not for a sales call.
4. Move a willing person to a trial, issue thread, demo repo, or 15-minute problem interview.

A connection acceptance is not interest. A reply such as “thanks” is not interest. The first meaningful signal is a recipient answering a concrete problem question, asking for the artifact, or agreeing to test something.

**Operational threshold:** over 50 genuinely relevant requests, compare against the software benchmark: below ~20% acceptance or below ~8% message reply is a warning to fix targeting/profile/relevance before increasing volume. This is a triage line, not a statistically significant verdict. LinkedIn itself does not publish an account-safety connection-request quota; third-party “100/week” and “300/week” rules are operational advice, not platform guarantees.

## Building a technical-buyer list from zero

Do this company-first, not “buy 5,000 developer emails first.”

| Source | How to find it cheaply | What it proves | First contact |
|---|---|---|---|
| Public GitHub org/repo/issues/releases | Search orgs using your adjacent tools; inspect recent issues, changelogs, public repos | They use or are building around the relevant stack; a specific friction may exist | CTO/founder/engineering leader for budget; maintainer only for technical fit |
| Hiring pages and job descriptions | Search for roles mentioning the workflow/tool category | The company is investing in the problem now | Hiring manager, eng manager, or platform/devex lead |
| Integration directories, public docs, marketplace listings | Find companies using an adjacent provider or exposed architecture | Stack fit, not necessarily pain | Technical owner or product/engineering lead |
| OSS/community activity | Issues, discussions, meetups, newsletters, technical posts | Specific individuals have a live problem | Reply in the venue where the problem was raised; do not harvest a contributor list into a blast |
| LinkedIn, manually | Role/company/technology filters, then verify on the company site | Identity and role | Engineering leader or technical founder; use a developer as champion only if the product is self-serve |

GitHub is usable for public-company research without an expensive data provider; its REST API has rate limits and authenticated access generally allows 5,000 requests/hour. [GitHub API limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28) Do not use GitHub activity as permission to mass-email contributors.

Create a spreadsheet with these mandatory fields:

`company | why-now signal URL/date | stack evidence | likely economic buyer | technical champion | publicly listed contact route | hypothesis | first artifact offered | delivered | human reply | positive problem | meeting | trial/install | repeat use | opt-out`

Build the first **50 companies manually**. For each, identify one economic buyer and, only where relevant, one technical champion. Your list is ready only when every row has a dated “why now” signal and a falsifiable hypothesis. A job title plus email address is not a list; it is inventory.

A developer-focused product should normally split outreach:

- **Economic buyer:** “Is this a current engineering/DevEx/platform priority?”
- **Developer/champion:** “I made a concrete technical artifact for the workflow you publicly use—would testing it save you time?”

Do not force developers through a generic “book a discovery call” funnel. The 2025 Stack Overflow marketer survey says developers most often evaluate tools through a **free trial (75%)**, then colleagues/networks (**~73%**) and communities (**61%**). That is much stronger evidence for a working demo, repo, benchmark, or drop-in trial than for sales copy. [Stack Overflow survey findings](https://stackoverflow.co/advertising/resources/stack-overflow-developer-survey-for-b2b-tech-marketers/insight-1/)

## Is outreach to developers effective or counterproductive?

**Direct cold selling to developers is usually counterproductive when it is generic, asks for a call, or treats a technical person as the economic buyer.** The best current direct evidence is imperfect because it is recruiting-focused, but it is directionally harsh: daily.dev’s September 2025 survey of 4,040 developers found 46% rated trust in cold outreach 0–2/5, 55% suspect “personalized” messages are AI-generated, and 64% perceive recruiter messages as copy-pasted. That is not a SaaS-purchasing study, so do not overgeneralize it; it does show the existing trust deficit. [daily.dev methodology and results](https://recruiter.daily.dev/state-of-trust/statistics/)

It can work when all of these are true:

- the person demonstrably works on the exact problem;
- the message names a real technical condition, without pretending intimacy;
- the ask is to inspect/run/use something useful, not to sit through a pitch;
- you make clear why they were selected and provide a one-click exit;
- you recognize they may be a champion rather than the person who can buy.

For developer tooling, a useful cold message’s job is often **not conversion**. It is to obtain a technically credible “yes, this is painful / no, wrong abstraction / here is the owner” that improves the next build. Three independent teams who install or run a prototype, return to it, and describe the same costly workflow is stronger signal than 30 polite replies.

## Minimum-cost setup

- Custom domain: registrar cost varies materially by TLD/renewal; budget roughly **$10–20/year**, but verify the current registrar checkout before committing.
- One Google Workspace Business Starter mailbox: **$7/user/month on annual commitment or $8.40 month-to-month** in the US. [Google Workspace pricing](https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions)
- Spreadsheet/CRM: $0 initially.
- Manual company research, GitHub, company sites, job boards, and basic LinkedIn: $0.
- Optional Sales Navigator: defer until manual research proves that LinkedIn is your best source; Core offers advanced search and **50 InMail credits/month**, with country-specific pricing and free-trial eligibility. [LinkedIn plan features](https://www.linkedin.com/help/linkedin/answer/a104003), [trial rules](https://www.linkedin.com/help/sales-navigator/answer/a547186)

Minimum recurring cash cost is therefore about **$7–9/month plus a domain**, not a stack of Apollo/Clay/warm-up/automation subscriptions.

Realistic setup time:

- DNS, SPF, DKIM, DMARC, reply mailbox, and logging: **1–3 hours** if you already manage a domain; this is an estimate, not a published benchmark.
- First 50-company list with dated signals: **6–12 focused hours**.
- First 100 delivered contacts at 10–20/day: **one to two weeks**.
- First credible conclusion: **two to four weeks**, assuming you can respond rapidly and run interviews/trials.

## What to run first

Run two 50-company micro-campaigns, not one 500-person campaign:

1. Choose two narrowly different “why-now” hypotheses.
2. Send 10–20/day, manually reviewed, one contact/company.
3. Use three touches maximum over 10–14 days.
4. Offer an artifact: a test harness, benchmark, failure analysis, migration script, or private preview—not “15 minutes to learn about our AI platform.”
5. Log positive problem replies separately from all replies.
6. After 100 deliveries per hypothesis, either:
   - continue only if people recognize the problem and take an observable next action; or
   - replace the segment/thesis. Do not “optimize” subject lines from a handful of replies.

## WHAT I COULD NOT FIND

- A reliable, independent 2025–2026 benchmark for **cold LinkedIn DMs specifically to technical B2B buyers/developers**. The best large datasets are owned by outreach vendors; LinkedIn’s public figures are product-policy metrics, not sales benchmarks.
- A credible causal estimate of how much **AI-generated outreach flooding** has reduced cold-email or LinkedIn reply rates. There is survey evidence of fatigue and observational declines, but no controlled attribution.
- A provider-published safe threshold such as “send exactly X cold emails/day before domain damage.” Google publishes spam-rate and bulk-sender rules, not a safe cold-outreach quota. Numbers like 20/day, 50/day, or 100/day are operator heuristics.
- A trustworthy published cost/time benchmark for setting up a solo-founder outbound system. Tool pricing is observable; labor time depends overwhelmingly on ICP clarity and research depth.
- Evidence that “hyperpersonalization” universally beats concise, relevant outreach. Large vendor datasets support relevant company/activity signals; claims that one hour of bespoke research per prospect yields superior economics are mostly survivorship anecdote.
- A product-buying study proving that cold outreach to developers is broadly harmful or broadly effective. The daily.dev evidence is recruiting-specific; developer-tool discovery evidence favors trials, peers, and communities, but does not isolate cold outreach as a channel.
