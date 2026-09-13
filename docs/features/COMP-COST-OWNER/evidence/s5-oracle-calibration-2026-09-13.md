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
2. **Two adjacent rows carry byte-identical totals.** `14:47:10` (`stepCount: 0`, $4.3556,
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
