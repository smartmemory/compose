## Verdict

For a zero-audience AI developer tool, OSS/package registries are primarily **installation and trust infrastructure**, not reliable top-of-funnel. The exceptions are surfaces where the tool is invoked at the moment of pain:

1. **VS Code Marketplace** — if the value happens inside the editor.
2. **GitHub Actions Marketplace** — if the value is CI/PR/repository enforcement.
3. **MCP Registry** — if the value is an agent calling a tool or connecting to a system.
4. **npm/PyPI/Homebrew** — essential friction removal for a CLI/library; weak standalone discovery.
5. **GitHub repo/README** — the credibility and conversion page behind every other surface.

Do not optimize for stars, generic package downloads, or “being listed everywhere.” Instrument activation and retention by source.

## What the evidence says about OSS adoption

### GitHub stars are not users

There is no credible published universal conversion rate from GitHub stars to installs, active users, teams, or revenue.

The best empirical evidence says the relationship is weak and ecosystem-dependent. A 2025 NDSS measurement study of **925,978 observations** found correlation between stars and package downloads from **0.14 for JavaScript** to **0.47 for PHP**; both stars and downloads correlated only moderately with observed JavaScript website deployments (**0.61** and **0.63**, respectively). That is useful as a warning against treating either metric as adoption. [NDSS study](https://www.ndss-symposium.org/ndss-paper/auto-draft-490/)

Stars do affect trust: a survey of **791 developers** found roughly **three in four** consider star count before using or contributing. But the same research found stars are often appreciation or bookmarking, not a usage commitment. [Study](https://www.sciencedirect.com/science/article/abs/pii/S0164121218301961)

Also, the metric is now actively contaminated. A 2024–25 global study identified **4.5 million suspected fake stars** and found any promotional benefit from them was short-lived, under two months. [Paper](https://arxiv.org/abs/2412.13459)

**Signal threshold:** stars alone are never a go signal. Treat a star spike as a prompt to inspect your funnel. A genuine OSS signal is at least **10 unaffiliated activated installations** plus **three independent high-effort behaviors**: an issue with real context, a PR, a production-use report, an integration request, or a request to pay.

### Package downloads are transport events, not users

npm explicitly says its download count is a naïve count of HTTP 200 tarball responses. It includes CI, mirrors, and robots, so it will exceed people who intentionally ran `npm install`. [npm’s definition](https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html)

PyPI is even more explicit: it does not show counts on project pages because they are “highly inaccurate”; pip caches lower counts, internal mirrors can raise or lower them, and scripts can inflate them. [Python Packaging guide](https://packaging.python.org/en/latest/guides/analyzing-pypi-package-downloads/) PyPI’s public BigQuery data is useful for diagnostics, not a unique-user metric. [PyPI dataset docs](https://docs.pypi.org/api/bigquery/)

**Signal threshold:** do not use raw downloads as evidence below the point where your own activation telemetry says otherwise. Require **25 unique successful first runs** and **10 returning repositories/workspaces in a week** before calling package distribution promising. For a library, use downstream dependents and version upgrades as stronger supporting evidence.

### README and docs matter, but published causal conversion evidence is thin

A study of **118 npm developers** plus **2,527 packages** found highly selected packages correlate with downloads, stars, and README size. That is correlation, not proof that longer README files cause adoption. [Study](https://arxiv.org/abs/2204.04562) Another study of **1,950 READMEs** found popular projects more often used organized lists, images, and external links; again, observational. [Study](https://arxiv.org/abs/2206.10772)

The stronger practical point: documentation is where developers look. In Stack Overflow’s 2024 survey, **83.9%** of respondents used technical documentation to learn code. [Survey summary](https://stackoverflow.blog/2025/01/01/developers-want-more-more-more-the-2024-results-from-stack-overflow-survey/)

Your README/listing should answer, in order:

- What painful job does this remove, for whom?
- A copy-paste install and a successful result in under five minutes.
- One realistic before/after output.
- Required permissions, data handling, model/provider costs, and failure modes.
- The integration path for teams.
- Uninstall/rollback.
- A source-tagged activation event after the first valuable result.

**Signal threshold:** **100 qualified docs/listing visitors** with fewer than **10 successful activations** is a conversion failure worth fixing. Fewer than 100 visitors is usually an acquisition sample too small to diagnose.

## Distribution surfaces

The thresholds below are operating criteria for avoiding self-deception, not published industry averages.

| Surface | Real traffic evidence / how to list | Realistic timeline | Meaningful 2026 use and threshold |
|---|---|---|---|
| GitHub repo + OSS | No public repo-page-to-install benchmark exists. Publish normally; discovery comes from search, links, GitHub recommendations, and occasional social spikes. | Same day. | Mandatory trust surface. Meaningful only if it produces activated users, not stars. Threshold: 10 unaffiliated activations and 3 high-effort interactions. |
| npm / PyPI | Huge developer intent, but neither registry publishes reliable per-listing discovery CTR or unique-user counts. `npm publish` / PyPI publish puts a package in the registry; count semantics are weak. | Same day after packaging. | High priority for a JS/Python CLI or library, low priority as a discovery bet. Threshold: 25 unique first runs, 10 weekly returners. |
| VS Code Marketplace | Microsoft says VS/VS Code together have **50M+ developers** and the VS Code Marketplace has **100,000+ extensions**; that proves addressable scale, not organic traffic for a new listing. [Microsoft](https://developer.microsoft.com/blog/celebrating-50-million-developers-the-journey-of-visual-studio-and-visual-studio-code) Listings are searchable/sortable by installs, ratings, categories, and tags; the README is rendered in the detail page. [Marketplace docs](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) | Build time dominates. Publish with `vsce`; no stated human listing-review SLA. Verified publisher requires a six-month-old extension and domain, then review within five business days. [Publishing docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) | Highest-priority marketplace if the user’s work is in-editor. Threshold: 30 activated installs in 30 days, with 10 weekly active after week 2. Raw installs are insufficient because Settings Sync and reinstall behavior muddy counts. |
| JetBrains Marketplace | Officially reported **4.4M plugin downloads/month** across **8,000 plugins** in its 2023 snapshot. [JetBrains](https://lp.jetbrains.com/marketplace-anniversary/) Better metric quality than most: its dashboard can report unique downloads using an OS-bound UUID. [Analytics docs](https://plugins.jetbrains.com/docs/marketplace/analytics-tab.html) | Manual review of every new plugin/update; JetBrains says contact them if no response after **3–4 working days**. [Approval rules](https://plugins.jetbrains.com/docs/marketplace/jetbrains-marketplace-approval-guidelines.html) | Worth it when your buyer is IntelliJ/PyCharm/WebStorm-heavy, especially JVM, Kotlin, Java, Python, or enterprise IDE teams. Threshold: 20 unique downloads plus 10 activated workspaces; otherwise do not build parity merely for coverage. |
| GitHub Actions Marketplace | GitHub reported **11.5B public-project Actions minutes** used for tests in 2025, so the workflow surface is enormous; GitHub does not publish Marketplace browse/CTR/install data. [Octoverse](https://github.blog/news-insights/octoverse/what-986-million-code-pushes-say-about-the-developer-workflow-in-2025/) A public single-action repo with root `action.yml`/`action.yaml`, unique name, and release can be published immediately. [GitHub docs](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace) | Same day after a working action. | Highest priority if the product gates PRs, analyzes code, writes artifacts, or enforces policy in CI. Threshold: 10 independent non-fork repositories pinning a release tag, then 3 upgrading to a later release. |
| Homebrew | Homebrew reports **277.7M formula install events** in the last 365 days, but that includes dependencies and CI. Its stronger public measure is `install-on-request`, the formula explicitly requested by the user. [Analytics](https://formulae.brew.sh/analytics/install/365d/index.html), [semantics](https://docs.brew.sh/Analytics) | Your own tap: same day. `homebrew/core`: review queue, no SLA; stable tagged release, compatible license, tests and audit required. [Acceptance](https://docs.brew.sh/Acceptable-Formulae) | Distribution friction reducer for a Mac/Linux CLI, not an early discovery channel. Start a tap first. Threshold: 50 install-on-request events or 10 teams naming `brew install` as the preferred route before spending effort on core. |
| Official MCP Registry | The registry is **preview**, holds metadata rather than artifacts, and requires a separately published package; its official docs provide no directory traffic or install counts. [Official quickstart](https://modelcontextprotocol.io/registry/quickstart) | Metadata publishing can be same day; preview means schema and registry behavior can change. | Worth doing if agent tool invocation is the product—not merely because “MCP” is fashionable. Threshold: 10 completed connections from distinct workspaces plus 5 weekly active tool callers. Treat directory listing itself as unproven acquisition. |
| Other MCP directories | Smithery-like directories can make setup easier, but I found no reliable, published directory-to-install conversion, unique visitor, or qualified-lead dataset. | Usually same day to days, directory-specific. | Submit only after the official registry and package/docs are clean. Threshold: source-tagged activation must beat the time spent maintaining the listing; otherwise stop. |
| ChatGPT/Codex Plugins Directory | OpenAI’s current public route is a plugin submission/review flow; approved plugins can appear in the directory in both ChatGPT and Codex. OpenAI publishes no traffic, install, or conversion numbers. [Official publishing flow](https://learn.chatgpt.com/docs/submit-plugins#public-publishing-flow) | Explicitly variable: submission starts review; approval and publication are separate. | Experimental only unless the product is unusually native to ChatGPT/Codex work. Threshold: 10 connected, successful workspaces and 3 repeat users; directory presence alone is no signal. |
| Claude Code marketplaces/plugins | Anyone can host a GitHub marketplace that users add with `/plugin marketplace add owner/repo`; this is direct distribution, not evidence of broad organic directory discovery. [Claude docs](https://code.claude.com/docs/en/plugin-marketplaces) Anthropic says there is **no guarantee** a community plugin becomes Anthropic Verified. [Submission docs](https://claude.com/docs/plugins/submit) | Your marketplace: same day. Official/verified exposure: no SLA and no guarantee. | Worth supporting when the product changes Claude Code behavior materially. Threshold: 10 unaffiliated installs and 5 weekly retained plugin users. |
| Raycast Store | Raycast provides in-app and web discovery, but no published aggregate traffic or listing conversion data. Submit via PR; first reviewer contact is expected within **one week**, subject to availability. [Guidelines](https://manual.raycast.com/extensions-guidelines) | Roughly one week to first contact; longer if revisions. | Useful for a crisp macOS command or developer utility. Low priority for a B2B platform. Threshold: 50 installs with 15 repeated command users, or a credible inbound team lead. |
| Alfred Gallery | The official Gallery is curated and contains hundreds of workflows; no published traffic/conversion data. Submission is through its workflow forum. [Alfred](https://www.alfredapp.com/workflows/) | No published SLA. | Niche Mac-power-user route; do it only if the workflow is tiny and naturally keyboard-driven. Threshold: 25 installs plus 5 returning users. |
| Awesome lists | A relevant, maintained list can create a trust backlink and a burst of qualified referral traffic. I found no credible published causal evidence for list inclusion → installs, revenue, or durable adoption. | Hours to weeks; each maintainer’s CONTRIBUTING rules apply. | Submit a narrow, truthful one-line PR only after the project is usable. Threshold: measure referral activations; if it generates none after 30 days, treat it as SEO/trust residue, not a channel. |
| GitHub Trending | GitHub’s only substantive public explanation says trending uses stars, forks, commits, follows, and pageviews with recency weighting, and shows only 25 results. It has not published a current formula, thresholds, or traffic data. [GitHub explanation](https://github.blog/news-insights/company-news/explore-what-is-trending-on-github/) | Unpredictable; not schedulable. | Never build a launch plan around it. Threshold: zero—regard a Trending appearance as a temporary observation to instrument, not a repeatable strategy. |

## How to instrument this without an audience

Use one event chain, source-tagged everywhere:

`listing/referral → install → successful first value → second use in 7 days → team/repository connection → paid intent`

Count entities that map to the product:

- CLI/library: anonymous installation ID plus repository hash; do not count package downloads as users.
- VS Code/JetBrains: extension activation plus first completed job.
- GitHub Action: unique non-fork repository reference, then successful workflow runs.
- MCP: completed OAuth/configuration plus successful tool call.
- SaaS/team tool: unique workspace, not individual chat messages.

Do not require signup before the first success. Show an optional “send diagnostic / get team features” boundary afterward, and collect source, repo type, language, and first-value outcome.

The experiment worth running is not “does this listing get installs?” It is: **does a buyer who finds this in their existing workflow reach value fast enough to use it again without being sold to?**

## Priority for a solo AI-dev-tools founder

- **CLI/library:** GitHub + npm/PyPI + Homebrew tap. These are table stakes.
- **Editor-native feedback loop:** VS Code first; JetBrains only when buyer/stack evidence justifies it.
- **CI/repository control:** GitHub Action first; this usually has more commercial intent than a generic CLI.
- **Agent-access product:** MCP Registry plus excellent client-specific setup docs; treat all MCP directories as experiments.
- **Claude/ChatGPT/Codex plugins:** support where your product is genuinely useful in that host, but do not assume directory traffic.
- **Raycast/Alfred, awesome lists, Trending:** opportunistic additions, not the core experiment.

## WHAT I COULD NOT FIND

- A reliable, published generic conversion rate for **GitHub stars → installs**, **stars → active users**, **stars → paid teams**, or **stars → revenue**.
- Reliable public funnel data for **GitHub repo page views → clone/install**, npm search impressions → install, PyPI search impressions → install, or awesome-list inclusion → activation.
- Official current traffic, CTR, acquisition-rate, or retention benchmarks for new listings in the **VS Code Marketplace**, **GitHub Actions Marketplace**, **MCP Registry**, **Raycast Store**, **Alfred Gallery**, or **ChatGPT/Codex Plugins Directory**.
- A credible causal study proving that README length, screenshots, badges, or documentation quality independently causes OSS adoption; the available research is correlational.
- A current, reproducible GitHub Trending formula or a star-growth threshold that reliably earns Trending placement.
- Reliable public traffic/conversion numbers for third-party MCP directories; almost all advice on “getting discovered through MCP directories” is founder anecdote.
- A public quantitative comparison of Claude Code marketplace, ChatGPT/Codex plugin-directory, and MCP-registry acquisition quality in 2026. These surfaces are too new, fragmented, and opaque to support strong channel claims.
