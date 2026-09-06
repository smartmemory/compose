---
date: 2026-09-06
session_number: 114
slug: guard-one-tap-ships
summary: "COMP-GUARD-ONE-TAP ships: one Touch ID per descriptor signature; six review rounds, two P1s caught in the CLI slice; npm test does not set NODE_ENV"
feature_code: COMP-GUARD-ONE-TAP
closing_line: The signature is the one thing the agent must never hold, so we spent the whole day making sure the human holds nothing else.
---

# Session 114 — COMP-GUARD-ONE-TAP

**Date:** 2026-09-06
**Feature:** `COMP-GUARD-ONE-TAP`

## What happened

We resumed mid-Phase-7 with the design and blueprint gates already clean and slice S1 still running under Codex. The rest of the day was three implementation slices, each dispatched to Codex on terra/high, each adjudicated against the blueprint, each reviewed by Codex and fixed by Sonnet agents under tight briefs.

S1 (custody, dir-lock timeout, generations) landed clean. S2 (the gate hook and refusal envelope) exposed the recurring sandbox problem: Codex cannot bind a server, so three of its four suites never executed. Run unsandboxed, two real test bugs appeared. One row had been built on the guard-off context and returned 200 without ever reaching the upgrade path. The other asserted that two legacy features share a policy checksum, which is false because edge predicates embed the feature directory. The real behaviour is better than the blueprint's premise: one generation enumerates every registered legacy resource, so the second feature is fresh with no prompt.

The review loop ran six rounds in total and earned its keep. The S3 review found two P1s in the enrol ceremony: the plan emitter defaulted to a no-op, so an in-process caller could reach `sudo -k /bin/sh -s` with no plan ever shown; and the packaged signer path was interpolated unquoted into the root shell, so an install path with a space or semicolon would break or inject. The fix for the second removed the path from the root script entirely and embeds the signer bytes via a quoted heredoc, which also puts the installed signer content into the plan the human approves. Later rounds chased containment: symlinked generation dirs, symlinked files inside them, a symlinked generations root, and finally a dangling `.sig` symlink that `realpath` reported as absent, which would have let a signature be written through it.

The one full-suite run failed only in the backfill golden file, which had been green in isolation all day. Cause: `npm test` does not set `NODE_ENV`, and every targeted run had. The custody seam correctly refused. The suite's own precedent is that test files set the variable themselves, so that is what we did.

## What we built

- `lib/guard-custody.js` (new): sudo custody, refusal mapping, custodyStatus, NODE_ENV-gated test seam
- `lib/guard-descriptors.js`: immutable generations, `ensureSignedDescriptors`, verified legacy adoption, containment (dir, file, sig, generations root; lstat-based .sig presence), `prepareUnsignedCandidate`, `pruneGenerations`; `writeDescriptorFile` removed
- `lib/guard-enrol.js`, `lib/guard-cli.js` (new), `bin/compose.js`: `compose guard enrol | sign | descriptors | status [--prune]`
- `lib/dir-lock.js`: `acquireDirLock(path, { timeoutMs })`
- `server/lifecycle-guard.js`, `lib/completion-gate.js`, `server/vision-routes.js`, `server/compose-mcp-tools.js`: sign-on-demand gate, lock held through apply, `hint` end to end
- 12 test files, 141 tests; `docs/features/COMP-GUARD-ONE-TAP/{report,progress,plan,blueprint}.md`, `reviews/` (six dispositions)
- stratum `5106933`: trust-root header note on ssh-agent confirm mode
- compose `ebd98cc`

## What we learned

1. **A Codex sandbox cannot bind a port, and a suite it "ran" may never have executed.** Two real test bugs hid behind that. Rerun every server and route suite unsandboxed before adjudicating; treat the sandbox pass as a syntax check.
2. **The blueprint can encode a false premise and the tests will faithfully assert it.** "Two features share a checksum" was wrong on inspection of `edgePredicates`. When a golden-flow assertion fails, check the premise before the code.
3. **`npm test` does not set `NODE_ENV`.** A seam gated on it is green under `NODE_ENV=test node --test` and red in the suite. Run the ship gate the way the suite runs, with the variable unset, and have seam-using test files set it themselves.
4. **Review rounds on security-sensitive code keep paying past round three.** The two P1s (plan-less sudo, unquoted path in a root shell) surfaced in the S3 review, not the S1+S2 one; the dangling-symlink `realpath` hole surfaced in round six. The budget rule is about convergence, not a fixed count: stop when a round returns only P2s on the previous round's fixes.
5. **Remove the path, not the quoting.** Embedding the signer by heredoc was safer than escaping the path and had a second benefit: the human now sees the exact bytes that will run as root.
6. **Parallel fix agents on disjoint files work; the controller owns the overlap.** Two Sonnet agents fixed enrol/cli and descriptors concurrently while Codex built S3 barred from descriptors; the one shared edit (removing the flat writer) was done by hand between them.

## Open threads

- [ ] Owner runs `manual-check.md` once (interactive terminal + Touch ID), then `compose record-completion`
- [ ] Measure `compose guard status` coverage cost on this repo (every feature dir × 4 modes through the stratum CLI); likely a `--coverage` opt-in
- [ ] IDEA-1274: compile per-step workflows from `plan.md` with per-harness emitters (Claude Workflow tool vs a `codex exec` driver); the plan-to-DAG half is harness-free

---

*The signature is the one thing the agent must never hold, so we spent the whole day making sure the human holds nothing else.*
