# COMP-RTK-INTEROP: Implementation Report

**Status:** COMPLETE — 2026-06-15
**Design:** [design.md](./design.md) · **Blueprint:** [blueprint.md](./blueprint.md)

## Summary

Optional interop with [RTK](https://github.com/rtk-ai/rtk) ("Rust Token Killer"), a lossy
command-output compressor. Compose now routes its one genuinely LLM-bound shell-out through RTK
when installed, detects RTK at `compose doctor`, and recommends RTK's Claude Code hook (`rtk init -g`)
for the larger token win it can't install itself. Byte-identical degrade when RTK is absent.

## Delivered vs Planned

| Planned (Approach A) | Status |
|----------------------|--------|
| `lib/rtk.js` helper (`isRtkAvailable` memoized, `rtkPrefix`, kill-switch) | ✅ |
| Wrap LLM-bound diff site(s) in `build.js` | ✅ — **1** site (`build.js:221`), not 2 (see deviation) |
| `external_binaries` in `.compose-deps.json` + loader/checker/reporter | ✅ |
| `compose doctor` reports rtk + `rtk init -g` recommendation | ✅ |
| Tests | ✅ 11 new (helper + manifest/binaries) |

## Architecture Deviations

- **1 wrapped site, not 2.** The blueprint's verification phase caught that `build.js:4087`
  (`git diff --cached HEAD`), which an explorer had tagged LLM-bound, actually flows into `taskDiffs`
  → `.patch` files → **`git apply`** (`build.js:3553-3559`, `3739`). It is a mechanically re-applied
  patch; RTK's lossy rewrite would break the apply. It was correctly **excluded**. Net LLM-bound
  surface in compose's own code is a single site (`build.js:221`, the Tier-1 Codex review diff).
- The roadmap row's "route git diff/status/npm test" was too coarse: most git shell-outs are
  parse-bound or discard output (`npm test` at `build.js:2253` is `… || true`, output thrown away).

## Key Decisions

- **RTK is a command-prefix wrapper, not a stdin filter** — so integration is prefix-injection at the
  call site (`rtkPrefix('git diff …')`), passing only operator-free bare commands.
- **Detect-and-recommend, not install.** The biggest saving is on the agent's *own* Bash output during
  review/coverage loops, which only RTK's `rtk init -g` CC hook can compress. Compose surfaces that
  recommendation rather than trying to install it.
- **`external_binaries` is additive and never fatal** — a missing/malformed array degrades to `[]`;
  only `external_skills` remains a load gate.

## Test Coverage

- `test/rtk.test.js` — prefix-when-available, byte-identical passthrough, probe memoization, kill-switch.
- `test/rtk-deps.test.js` — manifest binary load, default `[]`, skip-invalid, malformed-array safety,
  present/missing split, report projection.
- Full suite green: node 3878, tracker 100, UI 421. Codex review: **REVIEW CLEAN** (1 iteration).

## Known Issues & Tech Debt

- DISPLAY sites (`bug-checkpoint.js:117`, `sections.js:242`, gate-error slices) are parse-safe RTK
  candidates but small/capped; deferred — file a follow-up only if measured savings justify it.
- No live measurement of compression ratio on the wrapped site yet (RTK not installed in this env).

## Lessons Learned

- **Blueprint verification earns its keep.** An explorer's classification put a `git apply` patch in
  the LLM-bound bucket; tracing the data flow (`taskDiffs` → `git apply`) before wrapping it avoided a
  silent merge-corruption bug that no unit test would have caught.
- **Lossy tools need a parse-bound/LLM-bound taxonomy, not a command allowlist.** "Wrap git diff" is
  wrong because the same command is used both ways; the consumer of the output decides safety.
