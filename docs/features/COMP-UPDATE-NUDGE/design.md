# COMP-UPDATE-NUDGE: Design — startup version-drift nudge (compose + stratum)

**Status:** DESIGN
**Date:** 2026-07-25

## Related Documents

- `lib/version-check.js` — existing drift detection this feature generalizes
- `bin/compose.js:643` `runUpdate` — the update path this feature points users at
- COMP-UPDATE-VERSIONED-INSTALL — the real auto-updater, deliberately filed separately

---

## Problem

`compose update` already does the whole job: npm-vs-git install detection, reinstall or
fast-forward pull, skill refresh, `runInit` state migration, `healStratumWiring`, and the
MCP-restart warning. What is missing is that **nothing tells you to run it.** You learn you
are behind only if you happen to run `compose doctor`.

A second gap opened on 2026-07-25, when compose 0.3.7 moved its stratum dependency from an
exact pin to `^0.3.3`. npm does not re-resolve a caret range unless something triggers an
install, so **"compose is current" no longer implies "stratum is current"**: a user can sit on
compose 0.3.7 with stratum 0.3.3 still resolved in `node_modules` while 0.3.4 is published. A
compose-only check reports that state as healthy.

## Goal

Print one line, at session entry points, naming whichever of compose and stratum is behind.

**Non-scope: this feature never mutates an installation.** That boundary is deliberate, and
the reason is specific to compose rather than general caution — see Decision 1.

---

## Decision 1: Notify only — never self-update in place

`bin/compose.js` and `lib/**` contain **109 lazy `await import()` sites** (75 in
`bin/compose.js` alone). An in-place self-update — `npm install -g @smartmemory/compose@latest`
over a running process — replaces module files that a live process has not yet imported. That
process then lazily loads *new* modules into an *old* module graph. Mixed-version code inside
one process is a worse failure than stale code, and it is undebuggable from the outside. The
longest-lived compose process, the MCP server, is exactly the one that would hit it.

No timing guardrail fixes this, because a CLI invocation cannot know what else is running.

Safe auto-update requires never overwriting a running version's files. Claude Code does this
with versioned directories plus a symlink flip (`~/.local/bin/claude` →
`~/.local/share/claude/versions/<v>`, last 3 kept). That approach is sound, and is filed as
COMP-UPDATE-VERSIONED-INSTALL. It is out of scope here because it replaces compose's install
layout and needs a migration for every existing npm global.

## Decision 2: Read the RESOLVED stratum version, never the declared range

`resolveStratumVersion` reads `version` from `node_modules/@smartmemory/stratum/package.json`.
Reading the declared `^0.3.3` from compose's own `package.json` would defeat the entire
purpose: the caret is precisely what lets the installed version drift away from the declared
one. Absent stratum (not installed, or `capabilities.stratum` false) returns `null` — a normal
state, not an error.

## Decision 3: A pure formatter

`formatDriftNudge({compose, stratum})` takes two already-resolved `{current, latest, behind}`
shapes (or `null`) and returns `string[]` — empty, or exactly one line. Every branch is then
decidable with no network, filesystem, or clock, so the truth table is a plain unit test
rather than an integration fixture.

## Decision 4: Session entry points only

Exactly three: `compose init`, `compose doctor` (which already prints its own check), and the
first output of `compose build` / `compose plan`. Nowhere else — not `roadmap`, `validate`,
`status`, `guard`, or any MCP tool call.

The reason is latency, not taste. The check is `async` and does a network fetch: free on a
cache hit, up to the 3s timeout on a miss. Attaching that to trivial commands like
`compose roadmap` would be felt; attaching it to commands that already do real work would not.
The two fetches run in parallel, so a double miss costs one timeout, not two.

## Decision 5: Silence is the default

Output is one line, or nothing:

```
⚠ update available: compose 0.3.7 → 0.3.9, stratum 0.3.3 → 0.3.4 — run: compose update
```

Only packages actually behind are named. When both are current, or when anything fails,
nothing prints. A nudge that appears on every run gets filtered out by the reader, at which
point it has negative value.

The whole feature inherits `version-check.js`'s existing contract: **any failure returns
`null` and prints nothing** — network down, registry 500, unparseable JSON, malformed semver,
missing `node_modules`. Nothing here may ever fail the command it is attached to.

## Decision 6: Per-package cache, tolerant of the old shape

`~/.compose/version-cache.json` becomes per-package:

```json
{
  "@smartmemory/compose": { "fetchedAt": 1753440000000, "latest": "0.3.9" },
  "@smartmemory/stratum": { "fetchedAt": 1753440000000, "latest": "0.3.4" }
}
```

The current shape is flat (`{fetchedAt, latest}`) and every existing install has one on disk.
Reading it must not throw and must not be mistaken for a valid entry: an unrecognized shape is
treated as a cache miss and overwritten on the next successful fetch. This is a test, not a
comment.

---

## Known limits (accepted after the final review, not defects)

- **The capability read uses `process.cwd()`, not a resolved workspace.** `--workspace <id>`
  can select a different workspace whose `capabilities.stratum` the nudge will not see. This
  follows directly from Decision 4's placement rule: resolving a workspace properly can print
  errors and call `process.exit`, and the nudge runs ahead of argument parsing on purpose.
  Reading the manifest at cwd is exactly what `lib/stratum-engine.js:103` already does for
  `capabilities.stratumEngine`. `--cwd` is NOT affected — it sets the agent's working
  directory for cross-repo builds, not the compose workspace that owns capabilities.
- **The manifest read is a synchronous `readFileSync` with no timeout.** A
  `.compose/compose.json` that is a FIFO or a symlink to a blocking device would stall startup
  before any catch could run. Reaching that state requires write access to your own workspace,
  and the same unbounded read already exists at `lib/stratum-engine.js:108`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `lib/version-check.js` | existing | Generalize to `checkPackageVersion(pkg, current, opts)`; keep `checkLatestVersion` as a wrapper; per-package cache |
| `lib/version-check.js` | existing | Add `resolveStratumVersion(cwd)` and pure `formatDriftNudge({compose, stratum})` |
| `bin/compose.js` | existing | Emit the nudge at `init` and build/plan kickoff |
| `test/version-check.test.js` | new | Truth table, cache-shape migration, resolver behavior |

## Acceptance criteria

- [ ] `checkPackageVersion(pkg, current)` fetches and caches per-package
- [ ] `checkLatestVersion` still returns the identical shape for `@smartmemory/compose`
- [ ] `compose doctor` output is byte-identical to before (its golden test is unchanged)
- [ ] `resolveStratumVersion` returns the version resolved in `node_modules`, not the declared range
- [ ] `resolveStratumVersion` returns `null` when stratum is absent, without throwing
- [ ] A pre-existing flat-shape cache file is read without throwing and replaced on next fetch
- [ ] `formatDriftNudge` truth table: both current → `[]`; compose behind only; stratum behind
      only; both behind; stratum `null` → compose-only line; unparseable version → `[]`
- [ ] The nudge appears on `compose init` and on `compose build` / `compose plan` when behind
- [ ] The nudge does NOT appear on `compose roadmap`, `validate`, `status`, or `guard`
- [ ] Nothing prints when the checker returns `null`
- [ ] No test performs a network fetch

## Open Questions

None. Scope, placement, output shape, and the no-self-update boundary were all decided during
design.
