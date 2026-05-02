# 2026-05-02 — Session 30: Slimming the README

## What happened

The compose README had grown to 1025 lines. It read like a reference manual — exactly what a top-level README shouldn't be. We ran COMP-DOCS-SLIM through `/compose build` to enforce review discipline on what was otherwise a mechanical refactor.

The roadmap entry already specified the target shape (5-block skeleton, 9 subpages with section→subpage mapping), so Phase 1 design and Phase 6 plan were short. Phase 7 was the real work: extract 19 H2 sections into topic-scoped subpages, write a fresh attractor, link-check, and run a Codex review pass.

The Codex review surfaced something interesting. Of seven findings, only one was introduced by the move (the new attractor's quick-install dropped the `stratum-mcp` prerequisite and silently switched from `npx compose` to bare `compose`). The other six were *pre-existing factual drift* in the original README — phantom pipeline specs, an MCP tool that no longer exists, a wrong IR field name, wrong retry counts, missing CLI verbs. None of those were introduced this session; they had simply been hiding in the old wall of text.

We took the narrow option per the user's `/feedback_ship_narrow_first` rule: fix what we broke (the install block), file the inherited drift as `COMP-DOCS-FACTS`, and ship. The drift is now *more visible* in topic-scoped subpages, which is itself an improvement — a `pipelines.md` claiming five shipped specs is easier to spot-check than a buried section in a 1000-line README.

The new README came in at 75 lines, well under the 130–180 target. We chose not to pad it. The plan's line range was a ceiling, not a floor; the spirit was "slim," and padding would have re-introduced exactly the noise we were removing.

## What we built

**Added:**
- `compose/docs/install.md` — prerequisites, `compose init`, `compose setup`, `~/bin` symlink, backwards-compat shim
- `compose/docs/cli.md` — every documented subcommand
- `compose/docs/cockpit.md` — web UI shell zones and persistence
- `compose/docs/pipelines.md` — kickoff and build pipelines, sub-flows, contracts, Stratum IR v0.3
- `compose/docs/agents.md` — connector layer (Claude SDK, Codex CLI, Opencode SDK, base class, registry)
- `compose/docs/lifecycle.md` — questionnaire, gates, validation, recovery, progress logging, vision writer, result normalization
- `compose/docs/configuration.md` — config files and env vars
- `compose/docs/mcp.md` — MCP server tool list
- `compose/docs/examples.md` — workflows + `compose pipeline` editing reference
- `docs/features/COMP-DOCS-SLIM/{design,plan}.md`, `README.original.md` snapshot

**Changed:**
- `compose/README.md` — rewrote as 75-line attractor (down from 1025)
- `compose/CHANGELOG.md` — added 2026-05-02 entry
- `/Users/ruze/reg/my/forge/ROADMAP.md` — flipped `COMP-DOCS-SLIM` to COMPLETE; added `COMP-DOCS-FACTS` follow-up row

## What we learned

1. **Codex review on a "mechanical" task still pays for itself.** The whole point of routing this through `/compose build` instead of editing the README inline was review discipline. We expected a clean review and got six pre-existing drift findings instead. The discipline is what surfaced them; without it they would still be hiding.

2. **Topic-scoped subpages amplify drift.** When `compose pipeline show` says "Pipeline: build (17 steps)" but the build pipeline lists 17 steps in a focused `pipelines.md`, every wrong claim is now adjacent to the thing it's wrong about. That's pressure toward correctness.

3. **The "ship narrow" instinct is right even mid-feature.** Expanding scope mid-Phase-7 to fix the inherited drift would have mixed two changes in one diff (mechanical move + content fixes), made the diff harder to review, and risked introducing new errors while fixing old ones. A separate ticket keeps the cuts clean.

4. **A line-count target is a ceiling, not a floor.** The plan said 130–180 lines; the actual attractor is 75. Padding to hit a numeric target would have undone the work.

## Open threads

- [ ] `COMP-DOCS-FACTS` — fix the 6 inherited drift items in a follow-up pass
- [ ] Decide whether to ship `pipelines/new.stratum.yaml` or remove all references to it (part of `COMP-DOCS-FACTS`)

A 1025-line README is a confession; the slim version is a promise.
