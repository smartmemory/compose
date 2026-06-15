---
date: 2026-06-15
session_number: 74
slug: rtk-interop
summary: COMP-RTK-INTEROP — optional RTK output-compression interop; verification narrowed scope to 1 LLM-bound diff site
feature_code: COMP-RTK-INTEROP
closing_line: "The roadmap row said \"wrap git diff\"; the data flow said \"wrap exactly one of them\" — and that's the whole feature."
---

# Session 74 — COMP-RTK-INTEROP

**Date:** 2026-06-15
**Feature:** `COMP-RTK-INTEROP`

## What happened

We picked up COMP-RTK-INTEROP from the forge-top roadmap — "detect RTK and route compose's shell-outs through it." Before designing, we verified the external tool (RTK is a *lossy* command-prefix wrapper, not a stdin filter) and classified every shell-out in lib/build.js, lib/gsd.js, lib/bug-checkpoint.js, and lib/sections.js. The classification reframed the work: most git shell-outs are parse-bound (filename lists, SHA/shortstat parsing) or discard their output (`npm test` is `… || true`), and routing any of those through a lossy compressor would corrupt them. An explorer flagged two LLM-bound diffs; tracing the second (`git diff --cached HEAD` at build.js:4087) showed it flows into taskDiffs → .patch files → `git apply`, i.e. a mechanically re-applied patch that must stay raw. Net: exactly one genuinely LLM-bound site (build.js:221, the Tier-1 Codex review diff). We shipped Approach A: wrap that one site, add an `external_binaries` manifest section + helper, and have `compose doctor` detect rtk and recommend `rtk init -g` (RTK's CC hook is where the bigger win lives — on the agent's own Bash output, which compose can't route itself).

## What we built

New: `lib/rtk.js` (memoized `isRtkAvailable()` + `rtkPrefix()`, `COMPOSE_DISABLE_RTK` kill-switch), `test/rtk.test.js`, `test/rtk-deps.test.js`, `docs/features/COMP-RTK-INTEROP/{design,blueprint,report}.md`. Modified: `.compose-deps.json` (new `external_binaries` array with the rtk entry); `lib/deps.js` (`external_binaries` loader + `checkExternalBinaries`/`buildBinaryReport`/`printBinaryReport`); `bin/compose.js` (`runDoctor` + setup report binaries, human + `--json` single-root); `lib/build.js` (~L221, the Codex-review diff now flows through `rtkPrefix`); `.claude/skills/compose/SKILL.md` (§Dependencies documents `external_binaries`); CHANGELOG + forge-top ROADMAP row → COMPLETE.

## What we learned

1. Blueprint verification earns its keep: an explorer's classification put a `git apply` patch in the LLM-bound bucket; tracing the data flow before wrapping it avoided a silent merge-corruption bug no unit test would have caught. 2. For lossy tools, safety is decided by the *consumer* of the output, not the command — "wrap git diff" is wrong because the same command is parse-bound at one site and LLM-bound at another. The right abstraction is a parse-bound/LLM-bound taxonomy, not a command allowlist. 3. The honest scope of a roadmap row is often much smaller than its prose; verify-vs-code first (the forge-top rows keep proving this).

## Open threads

- [ ] Measure actual compression ratio on the wrapped site once rtk is installed locally (it isn't in this env).
- [ ] DISPLAY sites (bug-checkpoint.js:117, sections.js:242, gate-error slices) are parse-safe RTK candidates but small/capped — file a follow-up only if measured savings justify it.
- [ ] Consider whether `rtk init -g` should be surfaced more prominently than `compose doctor` (e.g. a one-time nudge at build start when rtk is present but its hook isn't).

---

*The roadmap row said "wrap git diff"; the data flow said "wrap exactly one of them" — and that's the whole feature.*
