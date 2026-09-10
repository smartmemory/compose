# Slice 3 D2 correctness review — confirmed defects

1. **P1 — Resuming ship can create a second commit and then fail receipt replay.**
   `lib/build.js:995-1003` recognizes the recorded ship commit but returns only its checkpoint tree; `executeShipStep` consequently stages and commits again, then reuses the original receipt ID at `lib/build.js:6289-6291`.
   Reproduction: `node /tmp/d2-r1-probes.mjs ship-replay-sections` (log: `/tmp/d2-r1-ship-replay-sections.log`).
   The real `runBuild` fixture starts with a section file, ships, and loses its ship `step_done` acknowledgement; resume reissues that descriptor. The runner's own post-commit section trailers/rollup supply the dirty files; no intervening user edit is needed. Tests execute isolated pytest, never npm test.
   Observed: first ship reports `outcome:"complete"`; resume prints `Ship failed: Ship failed: Receipt payload changed on replay`; `git rev-list --count <base>..HEAD` is `2`, and the second commit's parent is the first ship commit rather than the pinned base.
   Fix: Return/replay the recorded successful ship result when its commit is already HEAD, without staging or committing again.

2. **P2 — A configured ceiling on the reserved review gate is silently ignored.**
   Runner preflight accepts `_costCeiling.gates:["review_gate"]` at `lib/build.js:1595`; the preserved review branch approves and continues at `lib/build.js:5050-5055,5123`, bypassing the ceiling evaluation at `lib/build.js:5126` entirely.
   Reproduction: `node /tmp/d2-r1-probes.mjs review-ceiling` (log: `/tmp/d2-r1-review-ceiling.log`).
   The real `runBuild` fixture records USD 100 of attributed spend, a USD 1 ceiling targeting `review_gate`, and a clean recorded review; execution is noninteractive.
   Observed: `resolves:[["flow-wave","review_gate","approve","review clean","system","gate-token"]]`, `metadata:[]`; the build completes instead of returning `waiting_gate` or refusing the unsupported configuration.
   Fix: Reject `review_gate` in `_costCeiling.gates` during runner preflight, preserving the reserved review branch.

3. **P2 — Legacy plan gates acquire an unconditional extra audit dependency.**
   `lib/build.js:5126-5128` awaits a second gate audit before `evaluateConfiguredGate` can discover that neither `decide_from` nor `_costCeiling` is configured; legacy consumer enqueue also adds unconditional admission audits at `lib/build.js:3878-3880`.
   Reproduction: `node /tmp/d2-r1-probes.mjs legacy-audits`; baseline: `node --import /tmp/d2-r1-baseline-loader.mjs /tmp/d2-r1-probes.mjs legacy-audits` (logs: `/tmp/d2-r1-legacy-audits-{after,before}.log`).
   The fixture uses only `execute:"codex:implementer:standard"`, waits at `plan_gate`, and makes a second waiting-gate audit unavailable. The loader reads the four changed runner modules from `9e1fa25` with `git show`, without modifying the tree.
   Observed HEAD: `{"error":null,"waitingAudits":1,"resolves":1}`. Working tree: `{"error":"probe: second gate audit unavailable","waitingAudits":2,"resolves":0}`.
   Fix: Check the applicable wave/gate configuration before fetching admission or D2 audits so legacy runs bypass these new calls.
