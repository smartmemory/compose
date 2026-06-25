# COMP-BUILD-RESUME — Explicit `compose build --resume` / `--fresh` + crash-gap fix

**Status:** DESIGN (approved 2026-06-25). Not yet implemented. Review as a design doc, not shipped code.
**Owner:** compose. **Implementer:** Codex. **Reviewer:** Claude (Opus).
**Mode:** build. **Complexity:** M.

## Why

A user asked to "add a `--resume` flag to `compose build` so it can resume a failed
build without clobbering." Investigation (two read-only explorers) showed the request
is mostly a wiring + bug-fix task, not new resume machinery:

- **`compose build` already auto-resumes implicitly.** `runBuild` re-attaches to the
  in-progress Stratum flow from `.compose/data/active-build.json` (`lib/build.js:1086`)
  on any same-feature re-run. Stratum's per-step content-addressed **result cache**
  additionally replays unchanged steps without re-running agents, even on a fresh start.
- **The full explicit-resume machinery already exists** (`opts.resumeFlowId` path at
  `lib/build.js:1042`, role restoration, stream-seq continuation, cost re-seeding) and is
  wired for `compose fix` (`bin/compose.js:2318-2344`) and `compose plan` — `build` just
  never parses a flag or sets `resumeFlowId`. Today resume is implicit and
  **status-dependent** (non-deterministic).
- **Crash-gap bug:** the main build loop's `try` at `lib/build.js:1006` has **no `catch`**,
  only a `finally`. A mid-loop throw leaves `active-build.json` stuck at `status:'running'`
  with no terminal record / no `build-history` entry. That stuck state then makes the
  *next* run try to resume a possibly-dead flow instead of recovering cleanly. This is the
  real "can't cleanly recover a failed build" pain.

## Scope (and non-scope)

In scope (single-feature `compose build` only):
- Explicit `--resume` and `--fresh` flags.
- A pure `decideBuildStart(...)` helper that centralizes the fresh-vs-resume-vs-refuse
  decision (today tangled inline at `build.js:1042-1137`).
- The crash-gap `catch` so failed/crashed builds leave clean, uniformly resumable state.

Out of scope (YAGNI): GSD (`compose gsd` has its own per-task resume), the
`compose_resume`/checkpoint advisory layer (category mismatch — it returns a `nextStep`
string, it does not re-drive a flow), and the batch `--all` path (`lib/build-all.js`).

## Behavior spec

Definitions: *active* = `readActiveBuild(featureCode)` (the `.compose/data/active-build.json`
record for this feature). *Resumable* = active exists, has a `flowId`, the Stratum flow is
non-terminal, the mode matches the requested build mode, and no **live** foreign pid owns it.

Default (no flag) — preserve and extend today's implicit auto-resume:

| active state | no flag | `--resume` | `--fresh` |
|---|---|---|---|
| none, or flow terminal/complete/missing | **fresh** | **error** "nothing to resume" | **fresh** |
| `failed`, or `running`+dead pid (crash), same mode | **resume** | **resume** | **fresh** (discard old flow) |
| `running` + **live** foreign pid | **refuse** (`--abort`) | **refuse** (`--abort`) | **refuse** (`--abort`) |
| mode mismatch (e.g. prior bug build) | **fresh** | **error** | **fresh** |

- `--resume` is the explicit/guaranteed verb: if there is nothing resumable it **errors**
  (exit 1) rather than silently starting fresh.
- `--fresh` forces a clean restart, discarding any prior failed/stale flow, but does **not**
  override a *live* build (still requires `--abort` first).
- `--resume` + `--fresh` together → exit 1, mutually exclusive.
- A `fresh` start is not full rework: Stratum's result cache still replays unchanged steps.

## Architecture

Three units, each independently understandable and (for the helper) independently testable.

### 1. `decideBuildStart(...)` — pure decision helper (new, `lib/build.js`, exported)

```
decideBuildStart({ active, opts, pidAlive, flowTerminal, sameMode })
  → { action: 'resume' | 'fresh' | 'refuse' | 'error', flowId?, reason }
```

- Pure: no I/O, no side effects. Inputs are plain data already gathered by `runBuild`
  (the `active` record; `opts.resume`/`opts.fresh`/`opts.resumeFlowId`; the booleans
  `pidAlive`, `flowTerminal`, `sameMode` computed by the caller via the existing
  `isProcessAlive` / `isTerminalFlow` / mode checks).
- Returns a verdict implementing the table above. `reason` is a human-readable string used
  for the thrown-error message (`refuse`/`error`) and for the `build_resume`/`build_start`
  stream event.
- It does **not** call `stratum.resume` / `startFresh` itself — it only decides. `runBuild`
  applies the verdict.

### 2. CLI flags (`bin/compose.js`, build branch ~2080-2231)

Mirror the `compose fix` resume block (`bin/compose.js:2318-2344`):
- Parse `--resume` → `singleOpts.resume = true`; `--fresh` → `singleOpts.fresh = true`.
- Both present → `console.error` + `process.exit(1)`: "--resume and --fresh are mutually exclusive".
- When `--resume`: resolve `readActiveBuild(featureCode)`; if absent / terminal flow →
  `process.exit(1)` "Nothing to resume for <code> (no in-progress or failed build found)";
  else set `singleOpts.resumeFlowId = active.flowId` (reuses the existing explicit path).

### 3. `runBuild` wiring + crash-gap catch (`lib/build.js`)

- Replace the inline fresh-vs-resume branching (`1042-1137`) so it: gathers `active`,
  computes `pidAlive`/`flowTerminal`/`sameMode`, calls `decideBuildStart`, then dispatches:
  - `resume` → existing `opts.resumeFlowId` path (`1042`) using `verdict.flowId`
    (incl. `restoreRolesFromActive` — roles restored only on an actual resume).
  - `fresh` → `startFresh` (`4748`).
  - `refuse` / `error` → `throw new Error(verdict.reason)` (CLI exit 1).
  - `isFreshStart` is set from `verdict.action === 'fresh'` and continues to thread the
    existing stream-truncate-vs-append + `clearPreCoverageTests` behavior (`1194-1201`).
- Add a `catch` to the main `try` at `1006`: on a thrown build, terminalize to the **same**
  clean state graceful failures already produce — `active-build.json.status='failed'` +
  `failureReason` (flowId preserved), `feature.json`→PLANNED, append `build-history.jsonl` —
  then **re-throw** so the CLI still `exit(1)`s. The existing `finally` (`2473`, stream close)
  stays. Reuse the existing terminal-write helpers; do not duplicate their logic.

## Error handling / edge cases

- Live-owner refusal unchanged: `--fresh` never clobbers a live build (`isProcessAlive`
  guard, `1101-1106`); `--abort` is the path for that.
- `--resume` against a flow that is terminal/missing **server-side** also errors (don't
  silently fresh) — surface "nothing to resume".
- Crash `catch` must be idempotent with the graceful terminal block (don't double-write
  history if the loop already wrote a terminal record before throwing).

## Testing

- **Table-driven unit tests** for `decideBuildStart` — every cell of the matrix above
  (4 states × 3 flag-modes), asserting `action` + that `flowId` is carried on `resume`.
  This is where clobber / no-resume bugs hide.
- **Golden integration** (reuse the existing build test harness/fixtures):
  - mid-loop throw → assert `active-build.json.status==='failed'`, `flowId` preserved,
    one `build-history` record appended, exit 1.
  - then `--resume` continues the **same** `flowId`; `--fresh` starts a **new** `flowId`.
  - `--resume` + `--fresh` → exit 1; `--resume` with nothing resumable → exit 1.
  - live foreign pid → refuse (no clobber).

## Known gotchas (from COMP-CODEX-IMPL)

- **restore-roles-only-on-actual-resume**: keep `restoreRolesFromActive` gated to the real
  resume branch, or a resumed `--codex` build loses its implementer/reviewer roles.
- **recompute-not-store**: derive `pidAlive`/`flowTerminal`/`sameMode` at decision time;
  don't persist a stale verdict.
- **warning ≠ guard**: the live-pid refusal must actually `throw`, not just warn.
