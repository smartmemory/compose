# Session 39: Slim wrapper ships (COMP-MCP-PUBLISH)

**Date:** 2026-05-03

## What happened

We resumed `COMP-MCP-PUBLISH` from a Phase 6 plan gate. The plan was sitting one approval away from execute — design done, blueprint Codex-reviewed twice, plan written. Five sequential tasks: add an `exports` map to compose, scaffold the slim `compose-mcp/` package, write the stdio launcher, write the publish workflow, verify.

The `exports` map landed cleanly. Three tests pinned the shape: `./mcp` points at `server/compose-mcp.js`, `./package.json` self-export, and an explicit assertion that no `.` root export exists (would execute the CLI on `require('@smartmemory/compose')`). The full unit suite stayed green at 2421 tests, which was the regression check we cared about — `exports` is a hard boundary, and any internal import the map closed off would have surfaced here.

The launcher wrote in 30 lines. Spawn-based, not import-based, because the embedded server runs `transport.start()` at module load and we wanted the wrapper's process lifecycle separated from the server's. The first attempt at the positive resolution smoke test ran the bin from inside the compose repo and tried `require.resolve('@smartmemory/compose/mcp')` — and it failed. Self-resolution of an own subpath needs a `node_modules/<name>` entry, which npm install creates for real consumers but doesn't exist when you're standing inside the package itself. Pivot: the test now creates a tmp dir, symlinks `node_modules/@smartmemory/compose` to the compose repo, and runs the bin from there. That mirrors the real install layout exactly.

The CI workflow was where Codex earned its keep. Iteration 1 flagged two medium findings on the workflow:

1. The workflow validated three version strings (package.json, server.json top-level, tag) but not `server.json.packages[0].version`. The wrapper tests covered that invariant locally, but the publish workflow didn't run tests, so a nested manifest drift could reach release.
2. The workflow went straight from version checks to `npm publish` without running the wrapper test suite or `npm pack --dry-run` first. A tag push could ship a broken launcher or wrong file allowlist.

Both real. We added an install + test + pack-dry-run gate before `npm publish`, validated `SRV_PKG_VERSION` alongside the others, and locked the new gates in with workflow tests that assert ordering — `npm publish` step index must be greater than the test and pack step indices. Iteration 2 came back REVIEW CLEAN.

The verify step ran 2421 unit + 92 UI + 44 integration tests green. Pre-existing `STRAT-DEDUP-AGENTRUN-V3` integration failure unrelated to this work. The compose root tarball stayed at 216 files with zero leakage of the new `compose-mcp/` directory — the `files` allowlist in compose's own package.json correctly excluded it. The slim wrapper's tarball was exactly four files: `LICENSE`, `README.md`, `bin/compose-mcp.js`, `package.json`.

This commit ships the wrapper + workflow. It does not publish. Publish happens later via `git tag compose-mcp-v0.1.0 && git push --tags`.

## What we built

- `compose/package.json` — added `exports` map (`./mcp`, `./package.json`).
- `compose/compose-mcp/package.json` — `@smartmemory/compose-mcp 0.1.0`, MIT, runtime dep `@smartmemory/compose: ^0.1.4-beta`.
- `compose/compose-mcp/server.json` — MCP registry manifest, `io.github.smartmemory/compose-mcp`.
- `compose/compose-mcp/README.md` — install/run/wire instructions, project-layout requirement.
- `compose/compose-mcp/LICENSE` — byte-identical to compose root LICENSE.
- `compose/compose-mcp/bin/compose-mcp.js` — spawn-based stdio launcher, exit 127 on resolve failure.
- `compose/.github/workflows/publish-compose-mcp.yml` — tag-triggered publish to npm + MCP registry. Four versions validated in lock-step, tests + pack run before publish, `mcp-publisher` pinned to v1.2.6.
- `compose/test/exports-map.test.js` — 3 tests, exports map shape.
- `compose/test/compose-mcp-package.test.js` — 9 tests, package identity + LICENSE parity + launcher smoke (positive via tmp install layout, negative via missing parent) + pack contents.
- `compose/test/publish-compose-mcp-workflow.test.js` — 9 tests, workflow YAML structure, secrets, ordering invariants.

## What we learned

1. **Self-resolve of an own subpath via `require.resolve` only works when `node_modules/<name>` exists.** Inside the package itself, the resolver doesn't loop back to the package root. The positive smoke test had to mirror the real install layout (tmp dir + symlink) rather than run from the compose repo. This is the gap between "looks like it should work in my repo" and "actually works for a real consumer" — npm install bridges it for them; tests that don't simulate the install layout will lie to you.
2. **Codex reviews catch release-path gaps that local tests can't.** The local tests verified the wrapper's correctness; Codex pointed out that a tag push wouldn't actually invoke them. The fix wasn't more wrapper tests — it was workflow tests that assert ordering ("`npm publish` index > test step index"). Once those exist, the gate can't be silently removed by a future workflow edit. Mechanical guardrails > convention.
3. **Worth validating every version string a release touches.** Three was the obvious set; the fourth (`packages[0].version` inside `server.json`) was implied but unguarded. It's worth enumerating every version string the release touches and locking all of them in the validate step — drift between any two of them can produce inconsistent metadata in the wild even if the publish step "succeeds."
4. **A Phase 6 plan gate that's been sitting overnight is cheap to resume.** The status.md left by the previous session named exactly the resume point; entry scan picked it up; one human "approve" got us to execute. The pattern works as designed.

## Open threads

- [ ] Publish for real: `git tag compose-mcp-v0.1.0 && git push --tags`. Will need `NPM_TOKEN` and `SMARTMEM_DEV_GITHUB_TOKEN` configured as GitHub Actions secrets. Verify before the first tag.
- [ ] Document `SMARTMEM_DEV_GITHUB_TOKEN` rotation cadence in repo SECRETS.md (or equivalent). PAT lifetime is finite.
- [ ] After the first registry publish, verify `io.github.smartmemory/compose-mcp` resolves on the registry; confirm `npx -y @smartmemory/compose-mcp` works in a scratch dir.
- [ ] If a real external consumer reaches into `@smartmemory/compose/server/foo` or `/lib/foo` and breaks post-ship, add their path to the `exports` map.
- [ ] Sub-ticket #6 of `COMP-MCP-FEATURE-MGMT` ships; remaining sub-tickets are FOLLOWUP, VALIDATE, and MIGRATION.

A slim package and a tag away from being on the registry.
