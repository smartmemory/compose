# S5 — the external oracle: calibration and first run (2026-09-13)

Status: **DONE.** Oracle calibrated (`729f213`) and repeatable via
`scripts/cost-oracle.mjs` (`5b2d2e4`). Run it with `node scripts/cost-oracle.mjs --all`;
**exit 1 means at least one flow is UNDER**, i.e. findings are present.
Nothing in this file changes code. It records measurements and their confidence.

## What S5 is for

Every cost check we own compares our numbers to our own numbers (`scripts/cost-census.mjs`
included — it compares stratum's token tally to compose's, and both descend from the same
dispatch records). A mistake shared by both sides passes clean. S5 needs a number produced by
something that shares no code with us.

## The oracle: `ccusage`, not a recompute

`npx -y ccusage@latest session --json` reads `~/.claude/projects/**.jsonl` and prices every
model we actually use, with **no model priced at $0 despite non-zero output** (checked across
16,640 sessions; 20 distinct models, Claude and Codex alike). It keys each session by
`period` = the session uuid = the jsonl filename.

Using it rather than writing our own recompute is deliberate and sits with the S3 decision
that **compose prices nothing**: a recompute would require a rate table, which is the thing
S3 deleted. The oracle stays outside the repo.

## Correction to the prior flush note

The resume note said `~/.claude/projects/*.jsonl` carries "no cost field at all", citing a
grep. That is **false in general and true where it matters**:

- `176 / 10,091` sessions carry a `type: "cost-state"` record with first-party
  `totalCostUSD`, per-model `modelUsage.<model>.costUSD`, and a `hasUnknownModelCost` flag.
- **0 / 21** compose fanout-worktree sessions and **0 / 26** compose-cwd sessions carry one.
  `cost-state` appears only in recent interactive sessions.

So compose's own build sessions genuinely have no cost field, and the oracle must price them.
But the 176 that DO carry one are a free calibration corpus, which is what makes the rest of
this file possible.

## Calibration — does the oracle agree with Claude Code's own accounting?

Compared ccusage's per-session `totalCost` against first-party `cost-state.totalCostUSD`
on the 168 joinable sessions. The corpus splits cleanly:

| Corpus | n | median rel. err | within 5% | aggregate | direction |
|---|---|---|---|---|---|
| **Single-segment** (cost-state covers the whole file) | 160 | **2.58%** | 128/160 | $8909.70 vs $8680.92 (**2.57%**) | ccusage LOWER in 149/160 |
| **Resumed** (cost-state starts late) | 6 | 322% | 1/6 | $212.97 vs $332.31 (56%) | ccusage HIGHER in 5/6 |

The resumed group is **not an oracle error**. Dissected the worst case
(`01c1e4ea`, rel. err 594%): one sessionId, file spans 2026-08-20 → 08-27, but its single
`cost-state` record has `startTime` on 08-27. **First-party cost-state covers only the final
resumed segment; ccusage sums the whole file.** The oracle is the more complete number there.

**Detection rule:** a session is single-segment iff `cost-state.startTime` is within 5 min of
the file's first `timestamp`. Resumed sessions cannot be calibrated against first-party.

### The residual 2.5% is real, systematic, and unattributed

ccusage runs ~2.5% low, consistently (149/160). Tested the leading hypothesis — that 1h cache
writes price at 2x base and a ccusage-shaped computation assumes 1.25x — and **could not
confirm it**:

- No contrast group exists: **every** session in the corpus is 95-100% 1h-cache
  (`cache_creation.ephemeral_1h_input_tokens`), so bucketing by 1h-share has one bucket.
- Direct recompute test found **0** single-model `claude-sonnet-4-6` sessions to test against.
- A least-squares derivation of the implied rate table returned **negative rates and 26-66%
  fit error** — the design matrix is near-degenerate because `input_tokens` is 1-3 per turn
  once caching is on, and `cost-state` includes sidechain/tool costs absent from the main
  file's assistant rows.

The bias is therefore **measured but unexplained**. Do not "correct" for it.

## Tolerance — set BEFORE the comparison run

- Gap **≤ 5%** against the oracle: noise. Not a finding.
- Gap **> 5%**: a finding to investigate.
- Gap where the **ledger is HIGHER** than the oracle: more serious, because the oracle's known
  bias runs the other way (it under-counts), so a high ledger cannot be explained by it.
- **Per-build comparisons must exclude resumed transcript sessions**, or use aggregate only.

## Join — how a build's cost maps to transcripts

Probed, not assumed:

- `~/.stratum/ts/flows/<flowId>.json` carries **no session id and no per-step cost**. Its
  `receipts[]` have `dispatchId`, `stepId`, `source`, `model`, and token `amount`/`split`.
  So the natural `session_id` join **does not exist**.
- Fanout steps run in worktrees whose path embeds the flowId, and Claude Code derives the
  transcript directory name from that path. **That is the only reliable join available.**
- Steps with `source: "main"` run in the primary cwd; their transcripts land in
  `-Users-ruze-reg-my-forge-compose/` mixed with interactive sessions and **cannot be joined
  by path**. Any oracle run must report the unjoined remainder explicitly — never treat it
  as zero.

## Comparison run — all four joinable flows

The oracle column counts **only worktree-joinable fanout sessions**. Main-source steps are
excluded, so the oracle is a **strict lower bound** on each build's Claude spend.

| flow | ledger $ | oracle $ (lower bound) | ledger/oracle | history rows | sessions joined |
|---|---|---|---|---|---|
| `af922492` | 4.5550 | **16.0008** | **0.28x** | 2 | 9 |
| `13fd190e` | 1.8407 | **3.0870** | **0.60x** | 1 | 9 |
| `44c575e7` | 11.6007 | 4.0316 | 2.88x | 3 | 2 |
| `4122e695` | 2.3018 | 0.5760 | 4.00x | 2 | 1 |

**Only two of these four rows support an inference, and the aggregate does not.**

- **`af922492` and `13fd190e` are findings.** The ledger records less than a strict lower
  bound — 28% and 60% of it. Because the oracle omits main-source steps *and* independently
  under-counts by ~2.5%, neither gap can be explained by the oracle. The ledger is missing
  real money.
- **`44c575e7` and `4122e695` are uninformative, not counter-evidence.** They joined only 2
  and 1 sessions respectively, against 9 for the other two. The oracle is missing most of
  those builds' work, so "ledger higher" is the expected artifact of incomplete coverage. It
  is **not** evidence of over-charging.
- **Do not quote the $20.30 vs $23.70 aggregate ('14.3% low').** It is two real findings
  cancelling against two coverage artifacts. It reads as a mild systematic bias when the
  actual per-flow error ranges over **0.28x to 4.00x and is not systematic at all**.

The honest summary: **where the oracle has good coverage, the ledger is substantially low;
where coverage is thin, nothing can be concluded.** Improving the join (main-source steps)
is the prerequisite for any statement about the other two flows.

### Why `13fd190e` is low: the ledger row closes before the flow does

| | |
|---|---|
| `build-history` row | `06:51:59 → 06:57:04`, `stepCount: 2`, `$1.8407` |
| flow file events | `06:52:00 → 07:03:16` |
| flow receipts | 11 total; **9 of them land after 06:57:04** |
| fanout sessions' last activity | `06:59` – `07:03` |
| `build-history` rows for this flowId | **exactly 1** |

Work continued for six minutes after the gate failure, across nine worktrees, and **its cost
never reached build-history.** No second row was written. This is the resume half of the
original defect (owed item 1), measured from outside rather than read off the code.

### Mechanism, pinned to the millisecond

> **SUPERSEDED by the VERDICT section below (2026-09-13).** The timing observation stands,
> but "the row snapshots usage at the instant it is written" is not the cause. The controlled
> repro showed a resumed row is correctly cumulative; the money is lost when a run dies
> before its terminal write.


The ledger row's `output_tokens` is **exactly** the cumulative receipt total at the instant
the row was written, and everything settled afterwards is lost:

```
06:56:32.025 main   explore_design  tok=4900   cum=4900
06:57:04.512 main   explore_design  tok= 763   cum=5663   <-- ledger row: out=5663
06:57:04.537                                              <-- row completedAt (25 ms later)
06:58:19.105 main   decompose       tok=1370   cum=7033   <-- everything below never recorded
06:59:20.589 fanout execute         tok=2163   cum=9196
   ... 5 more fanout receipts ...
07:03:14.972 fanout execute         tok=9683   cum=36354
```

**30,691 of 36,354 tokens — 84% of the flow — settled after the row closed and no second row
was ever written.** Note the next missing receipt (`decompose`, 1370) is a **`main`** step,
not fanout, which rules out "fanout usage is never forwarded" as the explanation.

### `af922492` is the SAME defect, not a second one

| | tokens |
|---|---|
| flow total (`flowSpent`) | 163,156 |
| sum of its 2 ledger rows' `output_tokens` | 33,177 |
| **recorded share** | **20.3%** |

That 20.3% token share matches its independently-derived **28% cost share** (ledger $4.56 vs
oracle lower bound $16.00). Same shape, same magnitude: the ledger records the work settled
before each row is written and drops the rest. **An earlier draft of this file called these
two distinct defects on the strength of a timestamp comparison; the token accounting shows
one defect.**

### A second process was driving the flow

The receipt timeline settles that this is a *resume*, not merely orphaned workers: the first
missing receipt is `decompose`, a **`main`-source** step, settled at `06:58:19` — 75 seconds
after the row closed. Orphaned fanout workers cannot run a main-source step. Something was
driving the flow from the top after the ledger row was written, and it wrote no row of its own.

**Confidence:** figures and timings are measured, and the mechanism is **demonstrated from
the receipt timeline**. It is still not reproduced **under control** — a forced repair-wave
run is owed before this is called proven.

## Three further defects visible in the ledger itself

Printing all 9 `build-history` rows surfaced problems independent of the oracle:

1. **`input_tokens: 0` on every single row (9/9)**, mirroring stratum receipts'
   `split: {input: 0, ...}`. Precisely: with 1h caching on, genuinely *uncached* input is
   only 1-3 tokens per turn, so a near-zero value is not itself absurd. The real defect is
   that **the cache tokens — which are 95%+ of the actual input, and are billed — have no
   field in the ledger row at all.** The row cannot represent what the build consumed.

   **Set-site traced 2026-09-13.** The accumulator DOES maintain them: `lib/build.js:2238-2246`
   accumulates `cache_creation_input_tokens` and `cache_read_input_tokens`. They are dropped
   one layer up — `buildCostSnapshot()` at **`lib/build.js:3825`** copies only `usd`,
   `input_tokens`, `output_tokens` and `usd_unknown_count` out of the accumulator, and both
   `appendBuildHistory` call sites (`lib/build.js:3336` and `:6438`) spread only that. So the
   data exists and is discarded at the history-write boundary.
   **Falsifier: add the two fields to `buildCostSnapshot` and they appear in new rows.**
2. **SUPERSEDED — see VERDICT.** ~~Two adjacent rows carry byte-identical totals.~~ Now
   understood as cumulative seeding working **by design**: a resumed segment that added no
   spend reports the same running total. Not an accumulator-reset bug. Original text:
   Two adjacent rows carry byte-identical totals. `14:47:10` (`stepCount: 0`, $4.3556,
   out=25638) and `14:50:19` (`stepCount: 2`, $4.3556, out=25638). A run with **zero steps**
   recorded $4.36, and the next run recorded exactly the same figures — consistent with an
   accumulator not being reset between runs.
3. **`output_tokens` does not mean the same thing in every row.** `16:09:23` records
   **436,736 output tokens for $0.6974**, while `15:24:12` records 50,860 for $1.6045 — 8.6x
   the tokens for 2.3x less money. 436,736 tokens priced at *cache-read* rates
   (~$0.30-1.50/M) comes to roughly $0.13-0.65, which brackets the $0.70. So that row's
   `output_tokens` looks like a **total including cache reads**, not output. The figure is
   probably not impossible — the *field* is inconsistently populated across rows, which is
   the same provenance defect in a subtler form.

Together these say the ledger's `cost_usd` and its token counts have **different provenance
and neither reconciles the other** — the COMP-COST-OWNER thesis, now with external evidence.

## Reproduction

```sh
node scripts/cost-oracle.mjs --all          # exit 1 = at least one flow UNDER
node scripts/cost-oracle.mjs --flow <id> --json
```

The script holds no rate table and does no price arithmetic beyond summing ccusage's own
totals. It labels the oracle a strict lower bound on every line, counts files with no
ccusage entry as `unjoined` (unknown cost, never zero), and reports thin coverage as
INSUFFICIENT-COVERAGE without setting a non-zero exit.

## Landmines paid for here

- **`grep -q PATTERN "$f"` where `$f` starts with `-`** silently reads the filename as flags.
  Every project dir under `~/.claude/projects/` starts with `-`, so a naive scan reported
  **0 sessions with cost data when the true answer was 176**. Always `grep -q PATTERN -- "$f"`.
  Same family as the zsh word-splitting landmine: a check that could not fail.
- **Transcript rows duplicate.** The same `message.id` appears up to 3x. Summing without
  dedup by `(message.id, requestId)` inflated one session's output tokens **2.36x**
  (38,289 → 16,225). ccusage dedupes; a hand-rolled recompute must.

## Next

1. Reproduce the resume undercount under control (owed item 1) — forced repair wave, read
   `cost_usd`, resume, read again, oracle both.
2. `input_tokens: 0` is a separate, universal, and cheap defect — trace its set-site.
3. Adjudicate the duplicate-totals rows (accumulator reset between runs).


---

# Controlled repro — PRE-REGISTERED 2026-09-13, before the run

Written and committed **before** spending anything, so no outcome can be reinterpreted as a
pass after the fact.

## What the free evidence already changed

Reading `.compose/build-stream.jsonl` and `active-build.json` for `13fd190e` (no cost, done
first) moved the diagnosis:

- There **is** a `build_resume` event. The flow WAS resumed.
- The last three events are `build_step_start` at generations 7, 8, 9 with **no matching
  `build_step_done` and no terminal event** of any kind.
- `.compose/data/active-build.json` still reads
  `{featureCode: COMP-SEMVER-STRICT, flowId: 13fd190e…, status: "aborted"}`.

So the resumed segment **never reached its terminal write**. The single history row is the
FIRST segment's (`status: failed`, 06:57:04). The money was still spent and still went
unrecorded — that part is unchanged and is measured — but the mechanism is now
"the resumed run did not reach the write" rather than "the resumed run wrote a wrong row."
**Those are different defects with different fixes,** and the earlier framing conflated them.

## Prediction

`runBuild` seeds `lastOwnerCost` from `selectedAccumulator` on resume (`lib/build.js:3798-3823`),
whose comment states the accumulator is the sole owner and preserves pre-resume totals. So a
resume that **completes normally** should write a row carrying the CUMULATIVE total.

## Pre-registered outcomes — three, not two

| Outcome | Reading |
|---|---|
| Row 2 carries the cumulative total | Seeding works as designed. **This is NOT a clean bill of health** — it would mean `13fd190e`'s missing row is caused by the resume being killed before its terminal write, a *separate* defect that this run does not exercise. |
| Row 2 carries only the resumed segment | Seeding is broken; totals under-report by exactly the pre-resume spend. |
| No row 2 at all | Directly reproduces `13fd190e`. |

## Method

Scratch project (fresh git repo, own `.compose`), so nothing touches this repo and the
transcript directory contains only this build's sessions.

1. `COMPOSE_PORT=19997` on **every** phase. The dev server on :4001 is up and a non-TTY gate
   would route to it and **hang waiting for a human** rather than fail. An unreachable server
   is what made `13fd190e` abort, so this reproduces the real failure reason.
2. Build with no `--all` → aborts at the first gate. Record row 1.
3. **Before resuming**, dump `active-build.json` and `build-accumulator/<F>.json`. The
   accumulator is DELETED by `finalizeBuildAttempt` on a terminal (`lib/build.js:2820`); if it
   is gone and `active-build.json` carries no cost, the seed is already broken and the resume
   need not finish to show it.
4. Resume with `--all` → completes. Record row 2.
5. Oracle both. **For this run only the oracle is a FULL accounting, not a lower bound** — the
   scratch project's own transcript directory holds only this build, so main-source steps are
   joinable for once. Sum it alongside the fanout dirs by hand.

No cost ceiling is configured (`.compose/compose.json` has no ceiling key), so no budget hold
can hang the run.

**Deviation from the owed spec, stated up front:** the spec said "forced repair wave." A
trivial feature under `--all` may pass review with no repair. What S5 actually observed was a
gate-abort-then-resume, and that is what this reproduces.


## Run log — deviations recorded as they happened

Pre-registration only means something if the deviations are logged when they occur, not
reconstructed afterwards.

### Attempt 1 (flow `d99082ba`) — never reached a gate

The plan assumed the build would pause at a gate the way `13fd190e` did. It did not: it died
at the FIRST step on a strict-contract rejection, and the stratum flow went `status: failed`,
which is terminal. **A terminal flow is not resumable** — `runBuild`'s
`decideBuildStart` probes stratum (`lib/build.js:4031-4040`) and refuses with "Nothing to
resume", even though `active-build.json` said `status: failed` and looked resumable to the
CLI-level guard. Row 1: `$0.5737263`, `in=14 out=3618`, `stepCount: 2`.

**A real defect found on the way, unrelated to cost.** `explore_design` failed twice for two
different reasons and the second is the interesting one:

- attempt 1 returned `outcome: "success"` — not in the enum `complete|skipped|failed` — but
  **had already committed** (`commit_hash: 'ffab7f2'`).
- attempt 2 returned a valid `outcome: "complete"` with `commit_hash: null`, because the work
  was already committed on attempt 1 and there was nothing left to commit. The strict
  contract rejects the null.

So **a schema-invalid first attempt makes the retry structurally unable to satisfy the
contract**: the commit it must report was consumed by the attempt that failed validation.
`13fd190e` hit the identical attempt-1 enum error and recovered only because its attempt 1
had not committed. Worth filing separately (`feedback_strict_contract_seams` shape).

Also: `compose build` exited **0** while printing "Build failed."

### Attempt 2 (flow `64f8c243`) — deliberate kill, which is `13fd190e`'s real shape

Since the natural pause is unreliable, the pause was forced. **SIGKILL, not SIGINT** —
SIGINT runs the cancel handler and sets `active-build.status = 'aborted'`, which the resume
guard refuses outright. Killed the **process group** (via `perl setpgrp`; macOS has no
`setsid`) so the runtime children died with it rather than orphaning — the
`compose-switch-runtime` landmine. Verified zero orphans afterwards.

Killed at flow spend `$0.2617`. Post-kill state:

| | |
|---|---|
| history rows | 2 — **a row WAS written despite SIGKILL** (`$0.261692`, `in=7 out=1489`, `stepCount: 1`) |
| accumulator | survived, `usd: 0.26169239999999994` — exactly the row |
| `active-build.json` | `status: failed`, `cumulative_cost_usd: 0.2617`, `pid` dead |
| stratum flow | **`status: running`** — NOT terminal, therefore resumable |

### Three corrections to earlier claims in this file

1. **`input_tokens: 0` is weaker than stated.** These runs recorded `input_tokens` of **14**
   and **7** — small but non-zero. So the zeros on compose's 9 rows may be honest (with
   caching, uncached input really is a handful of tokens) rather than a broken field. **The
   defect that survives is the one already traced: cache tokens have no field on the row at
   all.** The "a build cannot consume zero input" framing was wrong and is withdrawn.
2. **Newer stratum flow files carry `usd`.** `64f8c243` and `d99082ba` both have
   `flowSpent.usd`, and it agrees with the accumulator AND the history row **to the cent**
   ($0.26169239999999994 three ways). `13fd190e` (2026-08-30) has no `usd` key at all. That
   is why `cost-census.mjs` compares tokens rather than dollars — a limitation of the old
   records, not a design choice. On new flows a dollar-level census is now possible.
3. The three-way agreement above is a **free calibration point** and it is exact, which is
   evidence the per-segment accounting is sound. The defect is about what survives ACROSS
   segments, not within one.


## VERDICT — controlled repro, flow `64f8c243`

### Pre-registered outcome 1: the resumed row carries the cumulative total. Correctly.

**Three independent sources agree to the cent** on a build that was killed mid-flight and
resumed to completion:

| source | figure |
|---|---|
| ccusage over transcripts — **full coverage** ($4.0210 main-source + $3.1730 fanout) | **$7.1940** |
| stratum `flowSpent.usd` | **$7.1940315** |
| compose ledger, resumed row | **$7.194031** |

Attempt 1 corroborates independently: its two main-source sessions total **$0.5738** against
row 1's **$0.573726**.

This is the one run where the oracle is a FULL accounting rather than a lower bound, because
the scratch project's transcript directory contains only this build. **Per-flow, per-segment
cost accounting is exact — including across a kill and a resume.** The seeding design works.

**As pre-registered, this is NOT a clean bill of health.** It relocates the cause: `13fd190e`
lost its money because the resumed run was **killed before its terminal write**, not because
the resume computed a wrong number. Those are different defects with different fixes.

### The repro also falsified my own tool

Rows 2 and 3 belong to the SAME flow, and row 2 ($0.261692) is contained in row 3
($7.194031). `scripts/cost-oracle.mjs` summed `cost_usd` across a flow's rows, so it
**double-counted every resumed segment**. The sum, $7.455723, overstates by exactly the
killed segment.

Correcting it changed three of five verdicts — and **removed the "ledger is high" direction
entirely**:

| flow | old (SUM) | corrected | stratum `flowSpent` | verdict |
|---|---|---|---|---|
| `af922492` | 0.28x | **0.28x** (sum) / 0.15x (last) | $16.4574 | **UNDER** |
| `13fd190e` | 0.60x | **0.60x** | n/a (old flow) | **UNDER** |
| `4122e695` | 4.00x "high" | **0.92x** | $2.5118 | **UNDER** — was never high |
| `44c575e7` | 2.88x "high" | **2.87x** | $4.0447 | OK — but see below |

**Both flows I reported as "ledger higher, uninformative" were artifacts of my own summing
bug.** One is actually UNDER; the other is fine. My caution about not quoting them as
over-charging was right, but for the wrong reason.

### Rows are cumulative only within an accumulator lifetime

Neither aggregation rule is universally correct, and the evidence is mutually exclusive:

- `44c575e7`'s row SUM ($11.6007) **exceeds its own flow's total spend** ($4.0447). A sum
  cannot be right.
- `4122e695`'s LAST row ($0.6974) is **below its earlier row** ($1.6045), so it cannot be a
  running total.

`clearBuildAccumulator` (`lib/build.js:2820`) deletes the accumulator on a terminal, so a
later run starts from zero. Rows are cumulative *within* one accumulator lifetime and
disjoint *across* lifetimes, **with nothing on the row saying which** — so a consumer cannot
compute a build's cost from `build-history.jsonl` at all. That is the deeper defect, and it
is worse than either mis-aggregation.

The script now takes the **most generous** reading (`max(sum, last)`) and flags UNDER only
when even that falls short. `44c575e7` therefore reads OK despite an impossible sum; the
over-count is recorded here rather than asserted by the tool.

### stratum `flowSpent.usd` is now a second oracle in the tool

It needs no transcripts, so it also fixes the thin-coverage blind spot (`4122e695` joined one
session; `flowSpent` judged it anyway). Where both exist they corroborate closely — `44c575e7`
$4.0316 vs $4.0447 (0.3%), `af922492` $16.0008 vs $16.4574 (2.8%, and the oracle is a lower
bound there). Two accounting paths in different repos agreeing that far is strong evidence
both are sound and the ledger is the outlier.

### What is now established

1. **Per-flow accounting is exact** — three sources to the cent, across a resume.
2. ~~**The ledger loses money when a run dies before its terminal write.**~~ **SUPERSEDED
   2026-09-13 — see `part-b-abort-path-2026-09-13.md`.** The money is recorded; it is
   `build-history.jsonl` that is missing rows, and this file measured `build-history`. For
   `13fd190e` the full $4.5037144/36354-token spend is in `dispatch-ledger.jsonl`. Restate as
   a history-completeness gap. The under-record percentages below are history-vs-oracle, not
   truth-vs-oracle.
3. **`build-history.jsonl` cannot be aggregated per flow** — cumulative and disjoint rows are
   indistinguishable.
4. The mechanism for `13fd190e` is a killed resume, **not** faulty resume arithmetic.
   **Refined 2026-09-13:** and the consequence is a missing `build-history` row, not missing
   money — the spend is in the ledger (`part-b-abort-path-2026-09-13.md`).

### Still owed

- ~~**Part B, not run**~~ — **DONE 2026-09-13 at $0, no build run**, by tracing plus data
  already on disk: `part-b-abort-path-2026-09-13.md`. Confirmed "no row appears", and
  inverted the cause — the spend is in `dispatch-ledger.jsonl`; two paths write the ledger and
  not history (`abortBuild` `lib/build.js:7745-7750`; `terminalizeThrownBuild`'s
  `if (!flowId) return false` at `:3365`), and which fired for `13fd190e` is undetermined.
- A row field distinguishing cumulative from disjoint, or a documented aggregation rule.

### Three caveats on the verdict

- **The $7.77 total.** `$0.5737263` (attempt 1) + `$7.1940315` (attempt 2, which already
  CONTAINS the killed segment's `$0.2617`) = **$7.7678**, which is exactly the independent
  transcript total for the scratch project. Adding the `$0.2617` separately would repeat the
  very double-count this section is about.
- **"Removed the ledger-is-high direction" applies to the LARGE over-counts only.**
  `44c575e7`'s last row (`$4.3556`) still sits **7.7% above** two sources that agree with each
  other (`$4.0316`, `$4.0447`). That is outside the 5% tolerance and is **unexplained**. What
  the correction removed was the 2.88x and 4.00x artifacts, not every over-count.
- **The 5% tolerance was calibrated for ccusage (n=160), not for `flowSpent`,** which has one
  exact data point plus two close corroborations. `4122e695`'s 0.92x UNDER rests **entirely**
  on `flowSpent` — its transcript oracle joined a single session — making it the weakest of
  the three UNDER findings.

### Why a row survived SIGKILL

Not because the write is signal-robust. `appendBuildHistory` at `lib/build.js:3336` sits in
**`terminalizeThrownBuild`** (`:3303`), the throw path. The step had already failed (the same
strict-contract defect as attempt 1) and the row was written before the kill landed. So this
run did NOT test whether a killed run loses its row.

**That sharpens Part B:** the question is not "does SIGKILL lose the row" but "when the
RESUME's own step-failure path throws, does it write?" `13fd190e` says no row appeared — so
either its resume never threw (killed while a step was in flight, which its three
`build_step_start` events with no `done` support) or the throw path did not run.

**Cost of this measurement: $7.77.**
