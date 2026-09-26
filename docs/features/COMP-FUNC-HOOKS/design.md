# COMP-FUNC-HOOKS — Migrate forge hooks to Claude Code function hooks

**Status:** PLANNED (waiting on upstream GA)
**Created:** 2026-09-24
**Source:** "Function Hooks: Core Architecture", Anthropic, Aug 2026 (`~/Downloads/EXTERNAL.Function.Hooks.Core.Architecture.pdf`, 10 pp)

## Related Documents

- [COMP-CANON-GUARD design](/Users/ruze/reg/my/forge/compose/docs/features/COMP-CANON-GUARD/design.md) — the PreToolUse guard being migrated
- [COMP-LOOP-DETECT](/Users/ruze/reg/my/forge/compose/docs/features/COMP-LOOP-DETECT/feature.json) — PLANNED; first new hook to build on the module path
- [HOOK-CACHE-2](/Users/ruze/reg/my/forge/compose/docs/features/HOOK-CACHE-2/feature.json) — read-cache invalidation hooks
- [COMP-HOST-PORTABILITY-1](/Users/ruze/reg/my/forge/compose/docs/features/COMP-HOST-PORTABILITY-1/feature.json) — Codex-host constraint this migration must not regress
- [STRAT-ENG-HOOKS design](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-ENG-HOOKS/design.md) — how stratum installs its shell hooks today (`~/.stratum/hooks/`)

## Prior-art check (2026-09-24)

`ls compose/docs/features stratum/docs/features | grep -i hook` → HOOK-CACHE*, STRAT-ENG-HOOKS,
COMP-CANON-GUARD family. None covers function hooks. A grep of compose/stratum docs for
`function hook|hooks-module|"modules"|engine.create|koa` returned nothing. STRAT-ENG-HOOKS is about
where shell scripts are installed, not the hook runtime. So this is new work, not an extension.

## What upstream is shipping (summary of the source doc)

- A fifth hook type. `hooks/hooks.json` gains `"modules": ["./x.ts"]`, a JS/TS file in a
  **plugin's** `hooks/` dir exporting `register(on, options)`.
- Every hook is Koa-style middleware `($, e, next) => R | Promise<R>`. One event covers
  before/after/during/instead/modify (§2.2), which replaces the Pre/Post split.
- **Order is authority.** Earlier-registered plugins wrap later ones. Admin-prepended plugins sit on top,
  and core sits at the bottom (§2.1, §2.3, §5).
- `$` is the only I/O door. No ambient fs/network in the hook environment. `claude plugin validate`
  statically lists a plugin's events and side effects (§4).
- `ui.render` / `ui.press` make UI components hookable (§3.2). `engine.create` lets plugins add
  nouns to `$` (§4.1). A `*` hook sees every event, with `next.origin` naming the caller (§6.3).
- A hook is never re-entered while its own frame dispatches (§6.4).

**Evidence it is landing:** Claude Code 2.1.280 (installed) contains the module-loader strings
`no hooks module to load; hooks/hooks.json names none in "modules"` and
`registers no hook on engine.create`. Whether it is enabled, flagged, or GA is **unverified**.

## Current forge hook inventory (what migrates)

| Hook | Today | Location | Owner |
|---|---|---|---|
| canon-guard | PreToolUse `Write\|Edit\|NotebookEdit`, node process per call, fail-open deny envelope | `compose/.claude/hooks/canon-guard.mjs` → `compose/lib/canon-guard.js` | compose (`compose guard install`) |
| stratum session start / stop / tool-failure | SessionStart, Stop, PostToolUseFailure, bash | `~/.stratum/hooks/*.sh`, registered in project `settings.json` | stratum (`stratum-mcp install`) |
| read-cache | PostToolUse Edit/Write/MultiEdit + PreCompact, python | `~/.claude/hooks/read-cache*.py` | HOOK-CACHE |
| agent telemetry | in-process SDK callbacks POSTing to :4001 — **SDK sessions only** | `compose/server/agent-hooks.js` | compose |
| loop-detect | not built | — | COMP-LOOP-DETECT |

## Load-bearing constraints

1. **Host-neutral logic.** Decisions live in pure `lib/` modules, with one thin adapter per host (shell
   hook, function hook, Codex). canon-guard already follows this (`lib/canon-guard.js`). Nothing
   may move logic *into* a hooks-module that the Codex host then loses (COMP-HOST-PORTABILITY-1).
2. **Guards keep their guarantees under order-is-authority.** A plugin above ours can skip `next`, or
   write through `$.fs.*` without ever raising `tool.call`. canon-guard must hook the fs write events
   as well as `tool.call`, and the migration must document what it can no longer guarantee.
3. **Fail-open is explicit.** canon-guard fails open by design. The source doc does not specify what
   a throwing hook does to the chain, so every adapter wraps its body in its own try/catch and calls `next(e)`
   on error until upstream behaviour is verified.
4. **Dual path until proven.** The shell hooks remain registered and authoritative until the module path
   passes the golden flows. Retirement is its own phase with its own gate.

## Open questions (Phase 1 answers these empirically, not from the doc)

- Can a project's `.claude/settings.json` name modules, or only a plugin's `hooks/hooks.json`? If
  plugin-only, **forge must ship its hooks as a Claude Code plugin** (no `.claude-plugin/` exists in
  compose or stratum today). This is likely the largest single cost.
- What happens when a hook throws? Does the tool call fail, or is the hook skipped?
- Among two plugins, does any `deny` win, or does only the outermost plugin's result count? (Today's
  command-hook precedence is also unverified here, so check both.)
- Do shell hooks and module hooks for the same event both run, and in what order?
- What `$` nouns exist for network (the :4001 telemetry POST) and fs (the read-cache dir)?
- Is the feature flag-gated in 2.1.x, and under what name?

## Phases and acceptance criteria

### Phase 0 — Landing trigger
- [ ] Falsifier for "not landed yet": Claude Code release notes or the official hooks docs list a
      `modules` / function hook type. Check with `claude --version` plus the docs page. The strings
      in the binary alone do not count.
- [ ] On trigger, flip this feature to IN_PROGRESS and start Phase 1.

### Phase 1 — Spike (read-only, throwaway plugin)
- [ ] Minimal plugin with a `tool.call` hook that logs and calls `next`, loaded in a scratch project
- [ ] Every open question above answered, each with a command transcript saved under
      `docs/features/COMP-FUNC-HOOKS/spike/`
- [ ] Verdict recorded: project-level modules vs plugin-only packaging

### Phase 2 — Packaging
- [ ] (new) forge Claude Code plugin skeleton (manifest + `hooks/hooks.json` + `hooks/forge-hooks.ts`), if Phase 1 says plugin-only
- [ ] `compose setup` / `compose update` / `compose guard install` install the plugin idempotently
- [ ] `stratum-mcp install` path decided: either stratum ships its own module or forge's plugin
      subsumes the three stratum hooks. Record which, with the reason

### Phase 3 — Migrate existing hooks (dual path)
- [ ] canon-guard as a function hook on `tool.call` **and** the `$.fs` write events, calling the
      unchanged `lib/canon-guard.js`. Fail-open wrapper. `test/canon-guard.test.js` still green
- [ ] Golden flow: a real Claude Code session attempts a canon write and gets denied through the module path
- [ ] stratum session start/stop/tool-failure as a module (`session.*` / `tool.call` after-placement)
- [ ] read-cache: invalidation as an after-placement hook. Serving a cache hit as an **instead**
      placement only if Phase 1 confirms `$` exposes the cache dir
- [ ] `*` telemetry hook sending `next.origin` + `next.event` to :4001, so CLI sessions get the
      activity feed that only SDK sessions get today
- [ ] Codex-host run of the compose golden flows unchanged (COMP-HOST-PORTABILITY-1 matrix re-run)

### Phase 4 — New hooks on the module path
- [ ] COMP-LOOP-DETECT built as a function hook (in-memory counter, `ask` on trip), with logic in `lib/`
- [ ] Optional: `ui.render` badge for pending compose gates on `ToolUse`. Scope separately if wanted

### Phase 5 — Retire shell hooks
- [ ] Shell registrations removed from `settings.json` by the installers, not by hand
- [ ] `compose update` migrates existing installs (COMP-MIGRATE-ON-UPGRADE path)
- [ ] CHANGELOG entry in the same commit

## Risks

- **Weaker guard semantics.** Covered by constraint 2. If Phase 1 shows a plugin above ours can bypass
  canon-guard with no signal, keep the shell hook permanently as a belt-and-braces second guard.
- **Upstream churn.** The design may change before GA. Phase 1 runs only after the trigger.
- **Plugin-level UI power.** Another plugin's `ui.render` could restyle our gate prompts. That is out of our
  control, so note it and move on.
