---
date: 2026-09-06
session_number: 115
slug: release-day-and-the-lying-doctor
summary: Three packages published (stratum 0.4.5, compose 0.3.8, compose-mcp 0.1.0 first ever), a near-miss shipping the operator's signing keys, and COMP-DEPS-AUTOINSTALL — which uncovered that doctor had been reporting uninstalled plugins as present.
feature_code: COMP-DEPS-AUTOINSTALL
closing_line: Every real bug this session came from running the thing for real; not one of them would have failed a test we already had.
---

# Session 115 — COMP-DEPS-AUTOINSTALL

**Date:** 2026-09-06
**Feature:** `COMP-DEPS-AUTOINSTALL`

## What happened

The ask was small — push the COMP-GUARD-ONE-TAP work — and then "also deploy new packages". Both repos pushed clean. Publishing is where it got interesting.

CI is dead on **both** repos, not just stratum: zero workflow runs on either since 2026-07-22, every workflow `active`, including from that day's own pushes. Memory recorded this for stratum only. So all three publishes were manual.

The near-miss: stratum's guard trust root (`ts/contracts/guard-signers.allowed`) is supposed to ship EMPTY — "no default trust" is the entire design. But the checkout is *itself* an install site, so the owner's two enrolled public keys are committed there, and `prepare-dist` copies that file into `dist/`, which is inside the tarball. Published 0.4.4 had 0 signer entries; the tree about to become 0.4.5 had 2. One `npm publish` from shipping a package that trusts this machine's operator on every installer's machine. The owner chose ship-empty, so `prepare-dist` now strips signer entries under `STRATUM_TRUST_ROOT_EMPTY=1`, set by a new `npm run release` — which also rebuilds afterwards, because a stripped dist left behind would fail the symlinked consumer's own signature check on the next one-tap.

Then "how does a new user set up?" Rather than describe it from the repo, we installed the published packages into an empty directory. `compose init` reported `Stratum: enabled` with no sibling checkout anywhere — so the README and install.md prerequisite telling new users to clone Stratum as a sibling was stale, a leftover from before Stratum was published. Fixed both.

That same clean-install run surfaced the real thread: `4 required deps missing` and "lifecycle will run in degraded mode". The owner asked to automate it. Building COMP-DEPS-AUTOINSTALL then turned up a bug that had nothing to do with the feature and everything to do with trusting it: the plugin **cache outlives `claude plugin uninstall`**. `checkExternalSkills` walked that cache, so a plugin the user had removed still counted as present. `compose doctor` had been reporting "All 12 deps present" for skills Claude Code would not load — and auto-install would never have fired, because nothing ever looked missing.

## What we built

**Released:** `@smartmemory/stratum` 0.4.5, `@smartmemory/compose` 0.3.8, `@smartmemory/compose-mcp` 0.1.0 (first publish ever; its parent dep had rotted at `^0.1.5-beta`, nine minor versions stale).

- `stratum/ts/scripts/prepare-dist.mjs` — trust-root strip behind `STRATUM_TRUST_ROOT_EMPTY=1`
- `stratum/ts/package.json` — `npm run release` = strip, publish, rebuild
- `compose/.compose-deps.json` — `plugin` and `marketplace_source` on the six superpowers entries
- `compose/lib/deps.js` — `installMissingPlugins()` + `printInstallReport()`; `readInstalledPluginPaths()` makes `installed_plugins.json` authoritative over the cache walk
- `compose/bin/compose.js` — auto-install wired into setup/init/update with a post-install rescan; `--no-install-deps`
- `compose/test/suppress-expected-drift.js` — `COMPOSE_NO_PLUGIN_INSTALL=1` for the whole run
- `compose/test/comp-deps-package.test.js` — 8 new tests; `compose-mcp-package.test.js` — hardcoded dep range replaced with a derived one
- README, docs/install.md, SKILL.md §Dependencies, CHANGELOG
- `docs/features/COMP-DIST-EXEC/` — roadmap entry for multi-machine execution, cross-linked to the COMP-AGT-COORD non-goal it lifts

## What we learned

1. **A trust root committed in a repo is not the same artifact as the one in the tarball.** The memory said "ships EMPTY" and that was true of the release and false of the checkout — because a dev checkout is its own install site. "Ships empty" is a property of the *release path*, and it needs a build step to stay true, not a note.

2. **The cache outlives the uninstall.** Presence-by-filesystem-walk answers "were these bytes ever here", not "is this installed". The authoritative record (`installed_plugins.json`) existed the whole time. A green suite never caught it because every fixture built a cache tree *without* that file — testing only the fallback branch.

3. **Only the real run finds these.** Injected-spawn tests asserting argv pass against a broken scanner. It took an actual `claude plugin uninstall` to see doctor lie, and an actual pristine `HOME` to discover that the first install fails on a new machine because no marketplace is registered — the retry that fixes it exists *only* because we ran it for real. Both are the fake-producer pattern again.

4. **A feature can silently arm a side effect in the test suite.** Making setup install plugins meant every test spawning `compose init` could now mutate global state or clone a marketplace. Same shape as the STRATUM_GUARDS_DIR leak two days earlier. The reflex worth keeping: when a command gains a write, immediately ask what the suite does with it.

5. **A hardcoded version in a test is a rot timer.** `^0.1.5-beta` sat wrong for nine releases and only surfaced when something finally moved it.

## Open threads

- [ ] compose-mcp is on npm but NOT in the MCP registry — `publish-compose-mcp.yml` runs `mcp-publisher publish` after npm, and CI never fires. Claiming `io.github.smartmemory/compose-mcp` is a public name claim; deliberately left for the owner.
- [ ] 0.3.9 not published — auto-install is committed but not released, so a new user installing today still hits degraded mode.
- [ ] CI dead on both repos since 2026-07-22. Nobody has diagnosed why; every release is hand-rolled.
- [ ] `compose init` (a project command) now mutates global plugin state. Defensible for a first-run experience, but it is a scope crossing worth revisiting.
- [ ] A stale-but-registered marketplace gets the same "not found" error and no retry (`marketplace add` on an existing one likely fails). Soft failure, real stderr shown, but untested.
- [ ] COMP-DIST-EXEC is PLANNED with a grounded seed; no design work started.
- [ ] `test/build-stream-smoke.test.js` still flakes under full-suite load; green in isolation every time.

---

*Every real bug this session came from running the thing for real; not one of them would have failed a test we already had.*
