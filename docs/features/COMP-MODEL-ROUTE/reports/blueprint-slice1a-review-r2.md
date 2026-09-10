# S1a blueprint correctness review — r2

Scope: r1 findings 1, 2 and 4 only, against the working-tree blueprint, r1 report and `progress.md:99–110`. Source inspection only; no tests run. Blueprint unchanged.

| Check | PASS/FAIL | Evidence |
|---|---|---|
| Finding 1 — source binding | PASS | Blueprint §5–6 (`:112,148–149`) binds scoped source/run identity, accepted token and full output digest/reference, retaining source-success and drift refusal independently of consumer epoch; this admits decompose 0 → execute 1 (`pipelines/gsd.stratum.yaml:61,78–83`; `lib/gsd.js:715–728`) while preserving the list/item epoch/index/generation/descriptor fences in `lib/build.js:855–875`; changed source evidence refuses, with coverage assigned at blueprint `:178,185`. |
| Finding 2 — cumulative completions | PASS | Blueprint §2/§5 (`:60,108–111`) validates absent cumulative IDs through the same-root retained chain, filters only the immediate-graph intersection, and refuses unknown/conflicting IDs or unexplained mappings; `[A,B,C]` → `[B,C]` → `[C]` validates A through the first link and removes only B on the second, preserving C 2→1→0, consistent with `lib/gsd.js:1118–1129,1160–1183,1260–1310,1410–1424`; `:179` explicitly covers pause/crash bridges, with uncertain execution blocked by `:123–125`. |
| Finding 4 — receipt delivery scope | PASS | Blueprint scan for `receipt`, `usageReport`, `spool`, `flushWaveReceipts`, `recordPendingUsageReceipt` finds only S1b deferrals, exclusions and unchanged legacy receipt compatibility (`:21,23,57,154,159,198,202`), with no new S1a delivery requirement; dispatch-3 checkboxes (`:183–185`) require local shadow/issuance records, consistent with §6's local-only persistence (`:137,151,153`). |

No residual defects found in these three fixes.

REVIEW CLEAN
