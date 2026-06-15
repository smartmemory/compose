# COMP-RTK-INTEROP: Design

**Status:** DESIGN — APPROVED (gate 2026-06-15: Approach A, extend manifest with `external_binaries`)
**Date:** 2026-06-15

## Related Documents

- Roadmap row: `COMP-RTK-INTEROP` (forge-top `ROADMAP.md`, Standalone Tickets; impl owned by compose)
- External tool: [rtk-ai/rtk](https://github.com/rtk-ai/rtk) — "Rust Token Killer", a lossy CLI output-compression proxy
- Dep manifest: `compose/.compose-deps.json`

---

## Problem

Compose shells out constantly (git diff, test runs, gate commands). Some of that output is fed
into LLM context — Codex reviews, parallel-task result payloads — where verbose output burns the
context budget on every review-loop / coverage-sweep iteration. RTK compresses command output
60–90% before it reaches an LLM. The roadmap row asks: detect RTK at startup, route compose's
shell-outs through it when available, degrade to raw output when absent.

## What RTK actually is (verified, not assumed)

- A **command-prefix wrapper**, not a stdin pipe filter: you run `rtk git diff`, and RTK runs the
  command itself and rewrites stdout. There is no documented `cmd | rtk` stdin-filter mode.
- **Lossy by design**: filters noise, groups similar lines, dedupes with counts, truncates. Built
  for output a human or an LLM *reads*.
- Single Rust binary, zero deps. Install: `brew install rtk` / `cargo install` / curl script.
- Ships a Claude Code hook (`rtk init -g`) that auto-rewrites the **agent's own** Bash commands.

## The roadmap row is too coarse — corrected scope

A full classification of every shell-out in `lib/build.js`, `lib/gsd.js`, `lib/bug-checkpoint.js`,
`lib/sections.js` (see blueprint for the table) splits them three ways:

- **PARSE-BOUND** (majority): output is `split('\n')` into filename lists, regex'd for SHAs /
  shortstat numbers, or `.trim()`-compared to exact strings. Routing these through a *lossy*
  compressor would **corrupt the parse**. e.g. `git diff --cached --name-only`, `git rev-parse HEAD`,
  `git diff --shortstat`, `git ls-files`. **These MUST NOT be wrapped.**
- **CONTROL**: output discarded; only exit code matters. e.g. `git add`, `git worktree add`, and —
  notably — `${testCommand} 2>&1 || true` at `build.js:2253` (run only to stage changes; output
  thrown away). So "route `npm test`" from the row does **not** apply here.
- **LLM-BOUND** (the real targets): captured and fed into an LLM prompt.

Only **two** in-code sites are genuinely LLM-bound:

| Site | Command | Where the output goes |
|------|---------|----------------------|
| `lib/build.js:217` | `git diff --no-color HEAD` | sliced to 8000 chars → Codex tier-1 escalation review |
| `lib/build.js:4087` | `git diff --cached HEAD` | embedded in a parallel-task result object → dispatched to an agent |

Both are simple single commands RTK can wrap. Lower-value **DISPLAY** sites (markdown embedded in
checkpoint/section reports a human or resume-agent later reads) exist but are parse-safe and small:
`bug-checkpoint.js:117`, `sections.js:242`, and the gate-error slices at `build.js:3462/3491`.

**The bigger token win isn't in compose's code at all.** The verbose test/diff output that burns the
agent's context during review and coverage loops is run by **Claude's own Bash tool**, which RTK
intercepts via its CC hook (`rtk init -g`). Compose can't install that for the user, but it can
detect RTK and recommend it.

## Goal

- **In scope:** route the 2 LLM-bound diff sites through RTK when available; degrade byte-identically
  to raw `git` when absent; detect RTK at startup and surface it in `compose doctor`, including the
  `rtk init -g` recommendation for the larger hook-level win.
- **Out of scope:** wrapping any PARSE-BOUND or CONTROL site; a generic "compress everything" pass;
  bundling/vendoring RTK; auto-installing RTK or its hook.

---

## Decision 1: How broad to go (approach)

- **A — Targeted wrap + detect + recommend (RECOMMENDED).** Central helper wraps only the 2
  LLM-bound sites; RTK detection memoized once; `compose doctor` reports availability and recommends
  `rtk init -g`; rtk added as an optional binary dep. Smallest change that captures every real
  in-code win and points at the bigger hook win.
- **B — A plus the DISPLAY sites.** Also wrap `bug-checkpoint.js:117` / `sections.js:242` / gate
  error slices. More surface, more edits, marginal token gain (these are already capped/small), and
  each adds a parse-safety judgement call. Defer to a follow-up if measured savings justify it.
- **C — Hook-only (detect + recommend, no code edits).** Just `compose doctor` detection + the
  `rtk init -g` nudge. Smallest possible, but leaves the 2 genuine in-code wins on the table for no
  real saving in complexity over A.

**Recommendation: A.** It's minimal, captures the real in-code wins, and the helper makes B a trivial
later extension if measurements justify it.

## Decision 2: Wrapping mechanism

A single helper, `lib/rtk.js`:

- `isRtkAvailable()` — memoized; one `rtk --version` (or `which rtk`) probe per process, cached.
- `rtkPrefix(command)` — returns `rtk ${command}` when available, else `command` unchanged.

The two call sites change from `execSync('git diff …', opts)` to
`execSync(rtkPrefix('git diff …'), opts)`. Because RTK *runs* the command, the bare command string
(no shell operators) is passed; both target commands are already operator-free. Degrade path is the
original string verbatim → byte-identical behavior when RTK is absent.

**Safety invariant:** `rtkPrefix` is applied at exactly 2 call sites, never to parse-bound commands.
No global/automatic interception inside compose.

## Decision 3: Detection surface

- Extend `.compose-deps.json` with an `external_binaries` array entry for `rtk`
  (`id`, `detect: "rtk --version"`, `install`, `recommend: "rtk init -g"`, `optional: true`).
- `compose doctor` reads it and reports installed/missing + the `rtk init -g` recommendation.
- Runtime detection in `lib/rtk.js` is independent of the manifest (the manifest drives doctor's
  human-facing report; the helper drives the live wrap decision).

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/rtk.js` | new | `isRtkAvailable()` (memoized) + `rtkPrefix(command)` helper |
| `lib/build.js` | edit (2 sites: ~217, ~4087) | wrap the 2 LLM-bound `git diff` calls via `rtkPrefix` |
| `.compose-deps.json` | edit | add `external_binaries` entry for `rtk` |
| `bin/compose.js` (doctor path) | edit | report rtk availability + `rtk init -g` recommendation |
| `test/rtk.test.js` | new | helper: available→prefixes, absent→passthrough (byte-identical), memoization |
| `CHANGELOG.md` / `ROADMAP.md` | edit (Phase 9) | record feature; mark row COMPLETE |

## Open Questions

1. **Approach A vs C** — confirm we want the 2 in-code wraps, not just detect-and-recommend. (Rec: A.)
2. **DISPLAY sites (B)** — defer to a follow-up ticket, or fold in now? (Rec: defer; file follow-up if measured savings justify.)
3. **`.compose-deps.json` schema** — add a new `external_binaries` array (manifest currently only
   has `external_skills`). Confirm that's the right home vs a separate doctor check. (Rec: extend manifest.)
4. **RTK flag pass-through** — `rtk git diff --no-color HEAD` must pass `--no-color`/`HEAD` to git
   untouched. Blueprint will verify against RTK's actual git filter before finalizing.
