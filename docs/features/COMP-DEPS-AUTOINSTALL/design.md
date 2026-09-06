# COMP-DEPS-AUTOINSTALL: Auto-install missing required plugin dependencies during compose setup/init/update instead of printing an install hint and running degraded

**Status:** PLANNED
**Created:** 2026-09-06

## Related Documents

- [ROADMAP.md](/ROADMAP.md) — phase "COMP-DEPS-AUTOINSTALL: Auto-install required plugin deps"
- [COMP-DEPS-PACKAGE](/docs/features/COMP-DEPS-PACKAGE/) — the manifest and scanner this extends
- [`.compose-deps.json`](/.compose-deps.json) — the manifest; `plugin` + `marketplace_source` fields
- [SKILL.md §Dependencies](/.claude/skills/compose/SKILL.md) — the install contract agents read

---

## Intent

Install the plugins behind missing **required** external deps during `compose setup` / `init` /
`update`, instead of printing a hint and running degraded.

A clean install reported `6 of 12 deps missing (4 required)` and told the user the lifecycle would
run degraded. Reaching a working state depended on the user reading the report and acting on it.

## Decisions

1. **Never execute the manifest's `install` string.** Several entries are prose ("user-installed
   skill at `~/.claude/skills/refactor/`"), and shelling manifest text is an injection surface. A
   structured `plugin` field carries the `<plugin>@<marketplace>` spec, and compose only ever
   invokes `claude plugin install`.
2. **Required only.** Optional deps (interface-design, openai-codex) live in third-party
   marketplaces that each need their own `marketplace add`. That is a larger consent step than
   pulling from a marketplace the user already has, so those stay hints.
3. **Dedupe by plugin spec.** Six `superpowers:*` deps are one plugin, therefore one install.
4. **Register the marketplace, then retry once.** Measured against a pristine `HOME`: the first
   install fails with "not found in marketplace" because nothing is registered yet. Compose adds the
   manifest-declared `marketplace_source` and retries. Only the declared source is ever added, never
   one parsed out of the failure text.
5. **Report the post-install scan.** The dep report is re-run after installing, so the user reads
   the state they end up in.
6. **Soft everywhere.** `--no-install-deps` / `COMPOSE_NO_PLUGIN_INSTALL=1` opt out; a missing
   `claude` CLI is a skip with a reason; failures print the real stderr and never change the exit
   code. `compose doctor` stays read-only — its own comment says it never repairs.

## Bug found while building this

`checkExternalSkills` walked `~/.claude/plugins/cache/` to find plugin-provided skills, but that
tree **outlives `claude plugin uninstall`**. An uninstalled plugin therefore read as present:
`compose doctor` reported "All 12 deps present" for skills Claude Code would not load, and
auto-install would never fire because nothing looked missing. `installed_plugins.json` is now the
authority when readable, with the cache walk kept as a fallback for older Claude Code.

This is why the feature was verified against a real uninstall rather than only an injected spawn —
a test asserting argv would have passed against the broken scanner.

## Verification

| Check | Result |
|---|---|
| Pristine `HOME`, no marketplaces | 4 required missing → marketplace added → installed → 0 missing |
| Real machine, plugin uninstalled | `compose setup` printed `+ superpowers@claude-plugins-official`, then all 12 present |
| Injected spawn | dedupe, optional-skipped, ENOENT skip, stderr surfaced, add-then-retry, no-add on other failures |

## Known limitation

Auto-install covers plugins reachable from a marketplace compose can name. A dep whose install path
is prose (`refactor`, `update-docs`) is still a manual step, by design.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
