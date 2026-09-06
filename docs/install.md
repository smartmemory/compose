# Install

How to install Compose, initialize a project, and register the global skill.

## Package versions

Three packages ship together: `@smartmemory/compose`, its thin MCP wrapper
`@smartmemory/compose-mcp` (always the exact same version), and `@smartmemory/stratum` (same
minor, independent patch). A compose 0.4.x install expects a stratum 0.4.x, which its dependency
range already pins. The rule and its enforcing test live at `.claude/rules/versioning.md` and
`test/version-sync.test.js`.

## Prerequisites

- Node.js 18+
- Stratum. **Nothing to install:** `@smartmemory/stratum` is a declared dependency of
  `@smartmemory/compose`, so `npm install` brings it down and `compose init` registers that
  installed copy's MCP entrypoint. A sibling `stratum/` checkout is a *development* convenience,
  not a prerequisite — and when one is present the installed dependency still wins (compose warns
  when the two versions differ; see "Running a Stratum checkout" below). The python `stratum-mcp`
  PyPI package is retired (2026-07-18) and no longer used. Run `compose doctor` to diagnose
  environment issues.
- For Codex steps: the official OpenAI `codex` CLI (`npm i -g @openai/codex` or `brew install codex`), authenticated via `codex login` (ChatGPT OAuth) or `OPENAI_API_KEY`. Optional: install the Claude Code plugin for interactive slash commands: `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`.

## Install Compose

The package is published to npm as `@smartmemory/compose`.

**Option A — npm (recommended for users):**

```bash
npm install -g @smartmemory/compose
```

**Option B — git clone (for development):**

```bash
git clone https://github.com/smartmemory/compose.git
cd compose
npm install
```

## Project-local setup (`compose init`)

Run from inside your project directory:

```bash
cd /path/to/your/project
compose init
```

If compose is not on `PATH` (e.g. you cloned but didn't symlink to `~/bin`), use the fully-qualified package name with `npx`:

```bash
npx @smartmemory/compose init
```

This:
1. Creates `.compose/` directory with `compose.json` config
2. Creates `.compose/data/` for vision state
3. Detects installed agents (Claude, Codex, Gemini)
4. Registers `compose-mcp` in `.mcp.json`
5. Scaffolds `ROADMAP.md` from template (if absent)
6. Copies default pipeline specs to `pipelines/`
7. Installs the Stratum skill to detected agents

Flags:
- `--no-stratum` — disable Stratum integration
- `--no-lifecycle` — disable lifecycle tracking

## Global setup (`compose setup`, alias `compose sync`)

Installs all compose-owned skills globally and registers the Stratum MCP server:

```bash
compose setup     # or: compose sync
```

This:
1. Copies every bundled skill to `~/.claude/skills/` (`/compose`, `/context-budget`, …)
2. Installs the Stratum skill to all detected agents
2b. Installs the plugins behind any missing **required** external deps (COMP-DEPS-AUTOINSTALL) — today that is
   `superpowers`, registering the `claude-plugins-official` marketplace first if it is not configured yet.
   Optional deps stay printed hints. Opt out with `--no-install-deps` or `COMPOSE_NO_PLUGIN_INSTALL=1`.
3. Registers the Stratum TS MCP server with Claude Code (the installed `@smartmemory/stratum` dependency, or a sibling checkout via `COMPOSE_STRATUM_TS_MCP_BIN`)

It's idempotent — re-run it (or `compose sync`) after adding/editing skills locally to re-sync them. `sync` is just a clearer-named alias; it does **not** fetch a new version (that's `compose update`).

## Global CLI via ~/bin

To use `compose` as a global command (only needed for git-clone installs — `npm install -g` puts `compose` on `PATH` automatically):

```bash
ln -s /path/to/compose/bin/compose.js ~/bin/compose
chmod +x ~/bin/compose
```

## Upgrading

One command — auto-detects npm vs git-clone install:

```bash
compose update
```

- **npm install:** runs `npm install -g @smartmemory/compose@latest`
- **git clone:** runs `git pull --ff-only && npm install` (refuses if the working tree is dirty; pass `--force` to skip that check)

Either way, `compose update` then re-runs `compose setup` to refresh the global skill, and if invoked inside a Compose project, re-runs `compose init` to refresh `.mcp.json` and pipeline templates.

Check the installed version, git SHA, and root path:

```bash
compose --version
```

## Backwards compatibility

`compose install` runs both `init` and `setup` in sequence.


## Developing Compose and Stratum together

Execution profiles require Stratum MCP surface 17 or newer (tool restrictions,
reasoning settings, and acknowledged foreground cancellation). Compose checks the
connected server's advertised agent options before dispatch and refuses unsupported
settings with `UNSUPPORTED_AGENT_OPTIONS`.

The production resolver prefers an installed `@smartmemory/stratum` package over
an adjacent checkout. Editing Stratum source alone does not update that installed
runtime. For development, build the sibling and point both entrypoints at it:

```bash
cd ../stratum/ts
npm run build
cd ../../compose
export COMPOSE_STRATUM_TS_MCP_BIN="$(cd ../stratum/ts && pwd)/dist/mcp/main.js"
export COMPOSE_STRATUM_TS_CLI_BIN="$(cd ../stratum/ts && pwd)/dist/cli/stratum.js"
```

Keep both overrides together so the CLI and MCP inspect the same engine contract.
`node --test test/execution-runtime.test.js` exercises the production resolver and
real stdio/process boundaries without calling a model provider. Its SDK/CLI fixtures
replace inference only. Before publishing Compose, publish the matching Stratum
package and update Compose's dependency and lockfile to that release; a local
checkout or link is not a published dependency update.
