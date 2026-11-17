# COMP-SETUP-PREFLIGHT-1: real-use notes and right answers

Frozen 2026-11-17 before any code (OPS-VERIFY-CONFORM-1 pass 3). The build is done when every case below
gives the right answer when a person runs it by hand, not when its unit tests pass. A case that turns out
wrong is changed here, in its own commit with the reason, before the code that depends on it.

Surfaces marked **(new)** do not exist yet; everything else is today's Compose.

## Who and what

A developer (or an agent) runs an expensive check through Compose: the pre-push test gate (`git push`
with Compose's pre-push hook, which runs the full `npm test`), or `compose build <FEATURE>` whose later
steps dispatch Claude and Codex reviews. Today, a broken setup (a missing engine build, another test run
on the same repo, a missing tool) shows up only after the full run, as a red that looks like a product
failure, and gets rerun. After this feature, Compose checks the cheap things a run depends on first and
says `SETUP-FAIL` or `SETUP-BUSY` in seconds, and expensive stages wait for cheaper ones to pass.

## Case 1 (replays I19): the Stratum engine is rebuilt in the middle of a full gate

Own-use incident: ops ledger 2026-10-20 14:23 (L:10275). Compose's gate went red 7 of 7830; two of those
files failed because `stratum/ts/dist/cli/stratum.js` was missing, since a Stratum build ran during the
gate ("self-inflicted"). It cost a seven-file control rerun.

**Case 1a, engine missing before the run.** The engine Compose resolves (`lib/stratum-engine.js`
`resolveStratumBin`, sibling checkout via `COMPOSE_STRATUM_ENGINE` or the installed package) is absent.
The developer runs `git push` (or `compose preflight`, **new**).
**Right answer:** within 10 seconds, before `npm test` starts: `SETUP-FAIL stratum-engine: <resolved path>
not found` and how to fix it (`cd stratum/ts && npm run build`, or unset `COMPOSE_STRATUM_ENGINE`). Push
blocked, exit non-zero, no test started.

**Case 1b, engine rebuilt during the run.** The engine exists at start; a `npm run build` in `stratum/ts`
replaces it while the gate runs, and two test files fail with the engine path missing.
**Right answer:** the gate's summary says `SETUP-INVALID stratum-engine changed during the run (hash
<before> -> <after|missing>)`, lists the failed files whose output names the engine path as setup-invalid,
not as product reds, and prints the one command that reruns only those files. Other reds (timeouts, real
failures) are reported as they are today. Nothing is retried automatically.

## Case 2 (replays I13): two verification runs on the same repo at once

Own-use incident: ops ledger 2026-10-23 02:32 (L:12636) and
`smart-memory-ops/units/COMP-GOLDEN-LEAK-RACE-1/report.md:4`. Compose's landing was blocked after 2 full
runs: the leak gate compared a whole-repo worktree snapshot, so a probe worktree that a concurrent test
process added failed whichever run was alive. The leak gate itself was repaired (foreign probe worktrees
are filtered); that repair stays as it is.

With the project's opt-in (`"verify": { "preflight": { "exclusive_runs": true } }` in
`.compose/compose.json`), the developer runs `npm test` through the gate while an agent's `git push` gate
is already running the full suite on the same checkout.
**Right answer:** the second run does not start its suite. It prints `SETUP-BUSY: another verification
run holds <repo> (pid <n>, started <time>, <command>)` and waits up to the configured `busy_wait_s`
(default 0 = refuse at once), then refuses with exit non-zero. When the first run ends (or its pid is
dead, a stale lock), the second run proceeds. Without the opt-in, today's behaviour, no lock.

## Case 3: a project-declared cheap check fails

`.compose/compose.json` declares
`"verify": { "preflight": { "checks": [ { "id": "falkordb-up", "command": ["redis-cli", "-p", "19123", "ping"], "expect": "PONG", "timeout_s": 5 } ] } }`
and the throwaway database is not running. The developer runs `compose build FEAT-3`.
**Right answer:** before the first agent step is dispatched: `SETUP-FAIL falkordb-up: expected "PONG",
got "Could not connect ..."` in under 5 seconds; the build stops with `failureReason: setup:falkordb-up`
in build history (`compose` build history, the same record `lib/build.js` writes at :6890-6910); no agent
was dispatched, no fix iteration was started, no tokens spent.

## Case 4: a cheap tier fails, so the expensive review is not dispatched

`compose build FEAT-4` on a change whose lint (T1) or tests (T2) step fails.
**Right answer:** the Claude multi-lens review (T3) and the Codex review (T4) are **not dispatched**.
The build stream shows `skipped T3,T4: T1 failed` and `gate_tier_summary` lists them in `tiersSkipped`.
Proof is from the dispatch log (no review agent was started), not from `evaluateTiers` arithmetic.
If today's dispatch already behaves this way, the right answer is a test that pins it, and this case
passes without new code.

## Case 5: setup failures do not count as product failures

After Case 3 or Case 1a, the developer looks at the build and the feature.
**Right answer:** the feature's iteration and fix budget is unchanged (a setup failure never starts a fix
round), the failure is labelled `setup:<check id>`, and `compose build FEAT-3` after starting the
database runs normally.

## Case 6: a project with no preflight config

`git push` and `compose build` in a project with no `verify.preflight` block.
**Right answer:** only Compose's own built-in check runs (the Stratum engine, Case 1a), because it turns a
failure that would happen anyway into an early clear one. No lock, no project checks, no new prompts.
`COMPOSE_SKIP_PREFLIGHT=1` turns the built-in check off and logs one WARNING saying what was skipped (same
pattern as `COMPOSE_SKIP_CODEX_PROBE` in `lib/codex-preflight.js`).

## Case 7: preflight itself is cheap

Running `compose preflight` (**new**) on Compose's own repo with the engine present and no project checks.
**Right answer:** finishes in under 2 seconds and prints one line per check with its result and time.
