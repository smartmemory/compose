# COMP-GATE-JEV-1 — Jev for the gate approve/revise default (design)

**KILLED (2026-10-10):** value spike FAILED condition 4 (Jev p95 1602 ms, bar < 1 s). Conditions 1-3 passed. See "Spike results".

**Status:** KILLED. **Value spike:** FAIL (run 2026-10-10).
**Origin:** redirected from `stratum/docs/features/STRAT-JUDGE-JEV-1/design.md` (PARKED 2026-10-10: its `stakes: cheap`
target has zero real callers). Owner pick: "redirect Jev to a live call site".

## Related Documents

- Parked predecessor: `/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-JUDGE-JEV-1/design.md` (existing)
- Survey: `/Users/ruze/reg/my/forge/scratch/2026-10-10-jev-fit/report.md` (existing)
- Prior Jev spike (method and client reused): `/Users/ruze/reg/my/SmartMemory/scratch/2026-10-10-maya-jev-intent/REPORT.md` (existing)
- Spike folder: `/Users/ruze/reg/my/forge/scratch/2026-10-10-gate-jev-spike/` (new)
- Code: `lib/gate-prompt.js` (existing), `buildRecommendation()` at :42, keyword regex at :49; callers `lib/build.js:32`, `lib/new.js:12`

## Problem

When Stratum sends a step summary, `buildRecommendation()` picks the gate's default answer with one regex:
`/(?<!\bno\s)(?<!\b0\s)\b(critical|error|fail|missing)\b/i`. A summary that says "returned false" or "not a defect"
can flip it either way. The default is what Enter accepts, so a wrong "approve" default is the costly error.

Honest size of the win: this is a suggested default that a human confirms. The value is modest, so the build stays small.

## Value spike (run BEFORE any build)

Pre-registered here before any run. Do not edit this section after results exist.

- **Corpus:** `scratch/2026-10-10-gate-jev-spike/corpus.jsonl`, 51 distinct real `build_step_done` summaries from four
  projects' `.compose/build-stream.jsonl`. sha256 `93ac13b2ddd13a6c9c5614902fb056cca6193314f6babff3734b00b358581284`.
  The regex verdict is stored per row (14 revise, 37 approve).
- **Question (all arms):** "This is the summary of a finished lifecycle step, shown at a review gate. Should the default
  answer be APPROVE (the step reports its work done, nothing blocking) or REVISE (it reports a defect, failure, missing
  artifact or unresolved blocker in the step's own work)?"
- **Reference:** `gpt-6.1-sol/high`, one call per row.
- **Arms:** (1) the current regex; (2) `gpt-6-luna/low`, one call per row; (3) Jev `choice`, one call per row.
  Jev wording is frozen before the run. No tuning rounds (n is too small for a dev split).
- **Pre-registered bar, all four must hold:**
  1. Jev agreement with the reference >= regex agreement **+ 3 rows** (fewer is noise at n=51).
  2. Jev REVISE recall (vs the reference) >= regex REVISE recall.
  3. Jev agreement >= luna agreement.
  4. Jev p95 latency < 1 s, measured from this Mac.
- **Outcome:** pass, build below. Fail, mark KILLED with the numbers. If the regex already agrees on >= 49/51, record
  "regex is good enough" and kill.

## Build (only after a pass)

- [ ] `buildRecommendation()` asks Jev when `COMPOSE_GATE_JEV=1` and `JEV_API_KEY` is set. Off by default.
- [ ] Jev error, timeout (budget 1500 ms) or missing key: log one WARNING and use the regex. Never block the gate.
- [ ] The key is read by name only. No key value in code, logs, fixtures or docs.
- [ ] Table-driven test over: Jev approve, Jev revise, Jev error, Jev timeout, flag off, key missing.
- [ ] CHANGELOG entry in the same commit.

## Acceptance criteria

- [x] Spike run, results recorded in this file against the bar
- [x] Spike artifacts and a README in the spike folder, `JEV_API_KEY` absent from all of them
- [x] On pass: the build checklist above, with tests green. On fail: status KILLED with numbers (FAIL, killed 2026-10-10)

## Spike results (2026-10-10, recorded after the run; the bar above is unchanged)

Report: `/Users/ruze/reg/my/forge/scratch/2026-10-10-gate-jev-spike/REPORT.md`. Numbers re-computed by the coordinator from
`preds-*.jsonl` and the frozen corpus (sha matches). Reference labelled 15 REVISE, 36 APPROVE.

| arm | agreement | REVISE recall |
|---|---|---|
| regex (current) | 30/51 | 4/15 |
| gpt-6-luna/low | 40/51 | 11/15 |
| Jev | 46/51 | 11/15 |

| condition | result |
|---|---|
| 1. Jev >= regex + 3 | 46 vs 30, PASS |
| 2. Jev REVISE recall >= regex | 11 vs 4, PASS |
| 3. Jev >= luna | 46 vs 40, PASS |
| 4. Jev p95 < 1 s from this Mac | p50 708 ms, p95 1602 ms, max 2647 ms (n=51), FAIL |

Outcome per the pre-registered rule: KILLED. Caveat from the report: Jev was timed while the Codex reference arm was also
starting on the same Mac, and the prior SmartMemory spike measured Jev p95 580 ms from this Mac. A re-time is a new
pre-registered spike, not a revision of this one.

**Finding independent of Jev:** the current keyword regex disagrees with the reference on 21 of 51 real summaries. It
misses 11 of 15 REVISE cases (it suggests "approve" when the step reported a problem) and raises 10 false REVISEs on
words like "missing" or "error" inside a clean summary. That is a defect in the gate default on its own.

## Re-time spike (pre-registered 2026-10-11, owner: "sure run one")

Why: the first run opened a new TLS connection through the local proxy (`127.0.0.1:8118`) on every call, while the
Codex arms were starting on the same Mac. Measured afterwards: a new proxied connection costs 0.4-0.9 s even for an
unauthenticated 403, a reused one about 0.21 s, and the direct route is refused (HTTP 451). So the first run's latency
mostly measured connection setup. This spike re-times Jev with the connection held open. Same corpus (sha above),
same `question.txt` (sha `8dc77be7...52dd1`), same Jev question payload, no tuning. No Codex calls.

- **Arm W (warm, the bar):** one persistent HTTPS connection through the proxy, 3 uncounted warm-ups, the 51 rows
  sequentially, wall-clock per call.
- **Arm C (cold, descriptive):** a new connection per call, the 51 rows sequentially, same run conditions. Tells how much
  of the first run was overlap with the Codex arms.
- **Idle probe (descriptive):** after one warm call, wait 30, 60, 120, 300 s, call again on the same connection. Record
  whether the connection was reused and the latency. This decides whether a build can rely on keep-alive, because real
  gates are minutes apart.
- **Conditions:** no other spike work from this session. Other sessions' jobs cannot be stopped, so record the load
  average at start and end.
- **Pre-registered bar, all must hold on Arm W:** p95 < 1000 ms, and on Arm W's labels the original accuracy conditions
  1-3 still hold (agreement >= 33/51, REVISE recall >= 4/15, agreement >= 40/51, scored against the same reference labels).
- **Outcome:** pass, the KILLED status is reversed and the build proceeds, with the idle probe deciding the connection
  design (keep-alive, or pre-warm at step start). If the idle probe shows the connection never survives a gate-length idle
  AND Arm C p95 >= 1 s, the build must pre-warm, and that is stated in the build checklist. Fail, KILLED stands, final.
