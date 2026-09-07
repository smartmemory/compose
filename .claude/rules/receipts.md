# Receipts (compose)

**A claim written as a fact carries its receipt beside it.** Enforced on every push by
`bin/receipts-gate.js` from the pre-push hook — including docs-only pushes — and pinned by
`test/receipts-gate.test.js`, not by anyone remembering this file.

## The three shapes it refuses

| You wrote | It needs, within the same item / 3 lines / the commit message |
|---|---|
| a **checked** box `- [x] … (pinned by test)` | the test path: `test/<file>.test.js:line` |
| `flake` / `flaky` as a state | a measurement (`14/450 under load`, `0 of 40`, `15 runs`), or `RESOLVED`/`KILLED` with a sha or date |
| a commit message saying the suite is green | the counts (`node 6412/6412, UI 624/624`) |

Only ADDED lines in the pushed range are scanned — every `*.md` at any depth (rules files included: that is where a `known flake` gets written) plus `docs/**/*.json`. History is never re-litigated, and there
is no baseline to reconcile. An unchecked box may say "(pinned by test)" — that is intent;
the gate fires when the box is ticked, which is when the claim becomes a fact.

**Talking about a phrase is not asserting it.** Quote it in backticks (`flaky`) or a fenced
block and the gate ignores it. A receipt in backticks still counts as a receipt.

## Why

Measured 2026-09-07: one session's sweep found five wrong facts in the repo, and they were
one habit in five wordings — `known flake`, `pinned by test`, `verified independently`,
"suite green", "names the recycled-pgid case outright". Each was a confident claim with no
measurement behind it, and each was loaded into later sessions' context and steered them.

The worst was `test/build-stream-smoke.test.js`, written off as a `known flake` in three
places over two months (journal sessions 99, 110, 115). It was a live product defect the
whole time — a build's cockpit stream silently never starting (`12a357a`). "Green in
isolation" had been accepted as the control, and isolation removes the exact condition.

The gate was run against those incidents before it shipped: today's whole day passes; all
six historical offending commits fire. Two of its first drafts let offenders through
(a neighbouring item's path vouching for a box; lowercase "fixed" + any sha vouching for an
open `flake`), which is why the fixtures in the test are the real lines, verbatim.

## What it cannot catch, stated so nobody thinks it does

**A wrong diagnosis.** `14be1a7` said a probe reading `not-ours` "names the recycled-pgid
case outright". That is a conclusion, and a conclusion has no canonical receipt a regex can
demand. The gate catches claims of a *kind* that have one — test coverage, `flake` state,
suite state. For the rest, the rule is the same and the enforcement is you: no number, no
fact. `feedback_verify_before_claims` and `feedback_causal_claims_need_controls` still apply.

## Extending it

Add a shape to `lib/receipts-gate.js` with the incident that justifies it in the comment,
plus a fixture in the test that MUST fire and one that MUST pass. A shape with no incident
behind it is a philosophy checker, not a gate — and a gate that annoys gets bypassed.

## Bypass

`git push --no-verify`, same as every other gate in this hook. Accepted residual.
