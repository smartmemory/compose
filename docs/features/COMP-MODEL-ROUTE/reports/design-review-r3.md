# COMP-MODEL-ROUTE — independent design review, round 3

Reviewed 2026-09-10. Final gate limited to the round-2 fixes and accepted adjudication (`progress.md:56–72`). Design references below are to this feature's `design.md`; code paths are Compose-relative.

| Check | Result | Evidence |
|---|---|---|
| 1. GSD continuation protocol | PASS | D3 (:174–198) preserves logical task/wave/epoch decisions under one start while D1 (:94–103) gives redispatches distinct records and D8 (:328–334) counts that start once; verified resume filtering/dependency removal (`lib/gsd.js:112–115,1300–1320`), fresh plan (:294–304), injected decompose output (:599–603), and new run id (`../stratum/ts/src/engine/engine.ts:578–579`). |
| 2. Ordinary per-epoch admission | PASS | D2 (:131–135), D3 (:145–169,195–198) and D8 (:355–361) separate frozen candidates from journaled admissions, suppress repair-ineligible trials/exploration and reuse same-epoch entries; the separate route map leaves preflight's hashed `{normalized, resolved, overrides}` unchanged (`lib/pipeline-profiles.js:179–199`); engine revise increments epochs (:2805–2837). |
| 3. Single acceptance-eligible population | PASS | D6 (:281–303) explicitly makes accepted positive, repaired/retried/failure negative, and re-implemented/cancelled/unknown censored; D8 (:328–341) uses exactly those complete supported binary rows for durability, breadth, acceptance and policy cost, with all-observation totals separate. |
| 4. S1a/S1b delivery and dependencies | PASS | Slices (:410–428), Completion evidence (:438–459) and Files (:465–484) agree: S1a establishes identities, admission and continuation recovery; dependent S1b adds joins, receipt recovery, captured outcomes and complete shadow samples; S2/S3 depend on S1b, with trials and floor enforcement in S3 (also :200–203,311–324). |

No new contradiction, false code claim or unresolved fork found within the four checks. The lifecycle and route-map guarantees are specified changes, not claims that the current code already implements them.

No tests run. `design.md` and `progress.md` were not edited.

REVIEW CLEAN
