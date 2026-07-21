## What interviews can and cannot prove

Interviews are good for discovering real workflows, constraints, vocabulary, and existing workarounds. They do **not** validate demand, willingness to pay, pricing, or a scalable acquisition channel. Treat them as hypothesis generation; require an observable costly action to validate a hypothesis.

This distinction matters because hypothetical willingness-to-pay systematically exceeds real willingness-to-pay: a meta-analysis estimated average hypothetical WTP at **20.79% above** real WTP. That is consumer research, not B2B developer tools, but it is strong evidence against treating “I’d buy/use that” as evidence. [Schmidt & Bijmolt meta-analysis](https://doi.org/10.1007/S11747-019-00666-6)

**Minimum threshold:** an interview result counts only if it is anchored to a completed, recent behavior and can change a concrete decision. A compliment, feature request, forecast, or generic problem statement counts as **zero** evidence.

## The Mom Test: actual rules, and what they are for

Rob Fitzpatrick’s *The Mom Test* is a practitioner book, first published in 2013—not a controlled study of startup outcomes. Its core three rules are:

1. **Talk about the customer’s life, not your idea.**
2. **Ask about specific past behavior, not generic opinions or future intentions.**
3. **Talk less and listen more.**

The author’s own site identifies “commitment and advancement” as a separate core part of the method. [The Mom Test](https://www.momtestbook.com/), [author’s teaching guide](https://www.momtestbook.com/teachers)

| Rule | Why it exists | Bad question | Better question | Signal threshold |
|---|---|---|---|---|
| Their life, not your idea | Mentioning your solution invites politeness, speculation, and solution anchoring. | “Would an AI agent that triages CI failures help?” | “Walk me through the last CI failure that blocked a release.” | They recount an actual event, not a view of your pitch. |
| Past specifics, not future intentions | Future behavior and stated WTP are vulnerable to hypothetical bias. | “Would you pay for this?” | “What did you do last time? Who did it? How long did it take? What did it cost?” | A dated incident plus a current workaround, spend, or measurable consequence. |
| Listen more | Founders naturally explain, defend, and supply the premise; the resulting answer measures their pitch, not the buyer’s reality. | “So alert fatigue is the main issue?” | “What made that incident hard?” Then pause. | Customer supplies the problem framing without your nouns. |

The rules are directionally well-grounded in research, but do not turn an interview into an experiment:

- Social-desirability bias can systematically make interview answers more acceptable than true opinions or behavior; interviewer posture and relationship influence it. [Open-access review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9749714/)
- Question wording, form, order, agreement formats, and response options can change answers; this has decades of survey-methodology evidence. [Schuman & Presser review](https://academic.oup.com/jrsssa/article/145/1/42/7105797), [Pew question-design evidence](https://www.pewresearch.org/writing-survey-questions/)
- A customer can sincerely describe a real pain and still not buy your product. The interview establishes the former, not the latter.

## A practical interview protocol for a developer/AI-tool buyer

Interview one narrowly defined segment at a time: for example, “staff/platform engineers at 50–500 person SaaS companies who own CI reliability,” not “developers.”

Open with: “I’m researching how teams handle `<specific workflow>`. I’m not asking you to evaluate a product. Could I understand the last time this happened?”

Use this sequence:

1. **Recent incident:** “Tell me about the last time `<job/problem>` happened.”
2. **Timeline:** “What triggered it? What happened next? Who got involved?”
3. **Current solution:** “How do you handle it today? What tools, scripts, people, and exceptions are involved?”
4. **Cost and frequency:** “How often? How much engineer time? What slips or breaks when it goes badly?”
5. **Existing spend:** “Have you bought, built, or evaluated anything for this? What happened?”
6. **Priority and authority:** “Who feels this pain most? Who can approve a change? What would displace the current approach?”
7. **Evidence:** “Can you show me the runbook, ticket, dashboard, alert, script, or redacted example?”
8. **Only after this:** briefly state the narrow hypothesis and ask for one specific next step.

Do not ask:

- “Would you use/buy this?”
- “Is this a big problem?”
- “How much would you pay?” before observing prior spend and alternatives.
- “Would this save you time?”
- “Do you like this feature?”
- Any question containing your desired causal story: “Would better AI summaries solve your context-switching problem?”

A useful note format is: `segment | date of incident | trigger | current workaround | cost | existing alternatives | buyer | artifact seen | requested next step | action taken`. Record verbatim phrases separately from your interpretation.

**Discovery threshold:** count a problem as plausibly real only when, within one pre-defined segment, at least several independent people describe the same recent job and comparable costly workaround without being prompted. I would use **5 independently evidenced instances across the first 8–12 well-qualified interviews** as a practical gate to continue, and zero as a reason to stop or change segment. That is an operating rule, not a published law.

## How not to lead the witness

- Start with an unbranded job-to-be-done; do not name your product category.
- Ask one neutral, past-tense question at a time.
- Ask for chronology, artifacts, decisions, and tradeoffs—not evaluations.
- Let silence work. Do not rescue an answer with suggested options.
- Ask disconfirming questions: “When is this not a problem?” “Who would be least likely to care?” “What have you tried that made it worse?”
- Separate the interviewer from the builder if possible; if solo, explicitly state that a negative answer is useful and do not defend the idea.
- Code every interview before reviewing your thesis: incident, frequency, impact, workaround, spend, authority, commitment. Do not tally “positive conversations.”

**Fooling-yourself threshold:** if your notes contain mostly adjectives—“excited,” “loved it,” “interesting,” “would use”—and few dates, artifacts, workarounds, or commitments, you did not collect decision-grade signal.

## How many interviews are enough?

“Talk to 10 customers” is not a statistically supported startup-validation rule.

The best directly relevant evidence is qualitative-methods evidence, not B2B demand evidence:

- Guest, Bunce, and Johnson analyzed **60** in-depth interviews with women in two West African countries. In that specific homogeneous study, thematic saturation occurred by **12** interviews; basic metathemes appeared by six. The authors also say prior practical guidance was virtually nonexistent. [Study](https://journals.sagepub.com/doi/10.1177/1525822X05279903)
- Hennink, Kaiser, and Marconi analyzed **25** interviews: they found **code saturation at 9**, but required **16–24** interviews for “meaning saturation”—the nuances needed to understand an issue deeply. [Open-access paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9359070/)
- A 2022 systematic review of empirical saturation studies found saturation commonly at **9–17 interviews** for relatively homogeneous populations and narrowly defined objectives. It is not evidence that 9–17 validates a startup. [Systematic review](https://www.sciencedirect.com/science/article/pii/S0277953621008558)

For this use case:

- Run **8–12** interviews in one narrow segment to map recurring jobs and decide whether to pursue a problem.
- Continue to **16–24** only if the problem is recurring and you need workflow detail, segmentation, buying process, or edge cases.
- Restart the count when the segment materially changes: different company size, role, maturity, regulated vs. unregulated, or buyer.
- Do not call “saturation” because you stopped hearing new feature ideas. The relevant test is whether new interviews still reveal new causes, constraints, purchasing mechanics, or disconfirming cases.

Interviews are non-probability samples. They cannot estimate “X% of the market has this problem” unless you construct a representative sample and use a quantitative design.

## Convert an interview into a commitment

Do not try to manufacture commitment before learning. Once the buyer has described a real workflow, make one transparent, bounded ask tied to that workflow.

Examples, weakest to strongest:

| Ask | What it costs them | What it proves | Threshold |
|---|---:|---|---|
| Send a redacted ticket/log/runbook | A little time and internal trust | The problem is concrete enough to inspect. | Useful discovery, not demand. |
| Introduce the actual owner/buyer | Reputation | They believe the problem belongs with that person. | At least one qualified intro; do not count vague “I can introduce you.” |
| Schedule a workflow review with the operating team | Calendar time and coordination | The issue has enough priority to involve others. | Meeting is on calendar with named participants. |
| Allow instrumented access / agree to a time-boxed design-partner trial | Operational effort and risk | They will alter workflow to test a solution. | Written scope, success metric, owner, start date. |
| Paid pilot, deposit, PO, or signed order | Money and procurement effort | Actual willingness to buy under real constraints. | Money received or an organization-specific purchasing commitment with a date. |

A signed non-binding LOI, waitlist entry, “keep me posted,” or verbal budget approval is **not** equivalent to purchase. It may help identify a champion, but it is weak demand evidence unless it names a buyer, scope, price/budget, decision process, and a dated next action.

For B2B, a good closing question is:

> “You said `<specific incident>` cost `<specific consequence>`, and that `<current workaround>` is inadequate. I’m considering a narrow pilot that does `<outcome>` for one workflow. If I can show it against your data, would you be willing to sponsor a two-week evaluation with `<named team>`? If not, what would need to be true?”

Then ask for the smallest costly next action now—calendar invitation, intro, data sample, security contact, or paid pilot—not a prediction.

**Decision rule:** no verbal answer changes your score. Only completed actions do. A rejection with a concrete reason is higher-quality evidence than praise with no next step.

For a simple numerical sanity check, if **0 of 30** qualified buyers accept the same meaningful ask, the approximate 95% upper bound on the underlying conversion rate is **3/30 = 10%** (“rule of three”). That rules out a conversion rate above roughly 10% for that exact audience/ask, assuming reasonably independent prospects. Conversely, **5 commitments from 30** is encouraging but imprecise: its approximate 95% interval is about **7–34%**. Do not extrapolate either number to the whole market.

## Finding and booking interviews when you know nobody

Start from observable evidence of the problem, not a broad persona list:

- GitHub issues, Discussions, changelogs, and public incident postmortems.
- Job posts mentioning the workflow or tool stack.
- Engineering blogs, conference talks, podcast guests, community Slack/Discord posts, and public Stack Overflow/Reddit threads.
- Companies that recently adopted, replaced, hired for, or complained publicly about the relevant tooling.
- Consultants, integration partners, and maintainers: they see repeated cross-company pain and can identify interview candidates.

Build a list of **100 named people** in one segment with one observable reason each. Do not automate volume before learning which reason produces replies.

Use a research request, not a disguised pitch:

> Subject: Quick question on `<specific workflow>`  
>   
> Hi `<name>` — I saw `<specific public trigger>`. I’m researching how `<role>` teams handle `<concrete job>` when `<trigger>` happens. I’m not asking you to evaluate a product.  
>   
> Would you be open to a 20-minute conversation about the last time your team handled it? I’ll send back an anonymized summary of patterns. `<two specific times>` work, or I can use your calendar link.

Follow up once or twice with a different concrete observation; stop on no response. Ask every completed interview for **one named introduction** to someone who had the same workflow but a different context.

Published outreach numbers are weak guidance here:

- LinkedIn’s sales material claims **10–25%** InMail response rates and compares them with **3%** for cold calls/emails, but it is vendor marketing and not a reproducible benchmark for founder research. [LinkedIn sales guide](https://business.linkedin.com/sales-solutions/b2b-sales-strategy-guides/improve-inmail-response-rates-on-linkedin)
- LinkedIn’s recruiter policy requires a **13% response rate across 100+ InMails in 14 days**, but recruitment is not B2B customer discovery and “response” includes declines. [LinkedIn definition and policy](https://www.linkedin.com/help/linkedin/answer/a414226/finding-your-inmail-response-rate?lang=en)
- An academic study of email invitations across academics and business owners found that blank versus informative/provocative subject lines did not increase overall response; subject-line folklore is not a reliable lever. [Study abstract](https://eric.ed.gov/?id=EJ1190096)

**Instrumentation threshold:** after the first **50–100 precisely targeted requests**, inspect qualified conversations booked per outreach source, not opens. If a source produces no qualified conversations, change the segment, trigger, offer, or channel. Do not conclude the market is dead: you have only falsified your ability to reach that slice with that message.

## Published critiques and known biases

1. **Hypothetical bias.** People overstate what they would pay or choose when consequences are hypothetical; the 2019 meta-analysis’s average was nearly 21% inflated WTP. Mitigation scripts can reduce bias in some contexts, but they do not replace a binding action. [Meta-analysis](https://doi.org/10.1007/S11747-019-00666-6), [review of mitigation evidence](https://arxiv.org/abs/2102.02945)

2. **Social desirability and demand characteristics.** Respondents may help, flatter, or present themselves as rational/competent—especially when the interviewer is the founder. This is a systematic risk in interviews, not evidence of dishonesty. [Review](https://pmc.ncbi.nlm.nih.gov/articles/PMC9749714/)

3. **Leading, framing, acquiescence, and order effects.** Wording can change responses, and agree/disagree formats invite agreement bias. The cure is neutral, behavioral prompts; it is not simply adding “be honest.” [Question-wording review](https://academic.oup.com/jrsssa/article/145/1/42/7105797)

4. **Selection bias.** People who reply to an interview request are not necessarily typical buyers; they may be unusually dissatisfied, curious, available, or friendly. In survey research, interviewer selection of likely responders can itself distort the relationship between response rate and data quality. [European Social Survey analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC6741813/)

5. **Recall and post-hoc rationalization.** A buyer’s reconstruction of a past incident is evidence, but imperfect evidence. Demand artifacts—tickets, logs, calendar events, invoices, procurement steps—are stronger than a polished narrative.

6. **False “saturation.”** Repetition of headline themes can conceal new causal detail, edge cases, and purchase constraints. The 25-interview Hennink study found code saturation at nine but meaning saturation only at 16–24. [Study](https://pmc.ncbi.nlm.nih.gov/articles/PMC9359070/)

7. **Founder interpretation bias.** The same transcript can be selectively coded as validation. Predefine disconfirming outcomes, code evidence before discussing the thesis, and keep a “why this might fail” column.

## WHAT I COULD NOT FIND

- A credible controlled study showing that using *The Mom Test* improves startup survival, revenue, product-market fit, interview accuracy, or conversion to paid customers.
- A reliable universal number of customer interviews for B2B developer/AI tooling. The published 9, 12, 16, and 24 figures come from qualitative-health or other bounded research settings, not startup demand validation.
- A robust public benchmark for cold outreach from a zero-audience solo B2B founder to **completed qualified discovery interviews**, including list quality, channel, offer, cost, and time. Most available figures are vendor marketing, agency case studies, or incompatible definitions of “reply,” “lead,” and “meeting.”
- Evidence for a universal threshold such as “10 interviews,” “3 LOIs,” “20 waitlist signups,” or “five design partners.” Those are practitioner heuristics, not validated cutoffs.
- Evidence that a non-binding LOI reliably predicts a B2B purchase; its predictive value depends heavily on procurement authority, commercial terms, alternatives, urgency, and whether it imposes any real cost.
- A published causal estimate that a particular number of interview-derived commitments predicts product-market fit. Paid commitments are stronger than compliments by basic incentive logic and stated-preference evidence, but their predictive value is still segment- and offer-specific.
