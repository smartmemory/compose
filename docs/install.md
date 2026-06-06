# Install

How to install Compose, initialize a project, and register the global skill.

## Prerequisites

- Node.js 18+
- Python 3.11+ and `stratum-mcp` on PATH (`pip install stratum-mcp`). Run `stratum-mcp doctor` to diagnose install/PATH issues.
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

Installs all compose-owned skills globally and registers `stratum-mcp`:

```bash
compose setup     # or: compose sync
```

This:
1. Copies every bundled skill to `~/.claude/skills/` (`/compose`, `/context-budget`, …)
2. Installs the Stratum skill to all detected agents
3. Registers `stratum-mcp` with Claude Code (if available)

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
