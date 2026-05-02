# Install

How to install Compose, initialize a project, and register the global skill.

## Prerequisites

- Node.js 18+
- `stratum-mcp` on PATH (`pip install stratum`)
- For Codex steps: the official OpenAI `codex` CLI (`npm i -g @openai/codex` or `brew install codex`), authenticated via `codex login` (ChatGPT OAuth) or `OPENAI_API_KEY`. Optional: install the Claude Code plugin for interactive slash commands: `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`.

## Install Compose

```bash
git clone https://github.com/smartmemory/compose.git
cd compose
npm install
```

## Project-local setup (`compose init`)

Run from inside your project directory:

```bash
cd /path/to/your/project
npx compose init
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

## Global setup (`compose setup`)

Installs the `/compose` skill globally and registers `stratum-mcp`:

```bash
npx compose setup
```

This:
1. Copies the `/compose` skill to `~/.claude/skills/compose/`
2. Installs the Stratum skill to all detected agents
3. Registers `stratum-mcp` with Claude Code (if available)

## Global CLI via ~/bin

To use `compose` as a global command:

```bash
ln -s /path/to/compose/bin/compose.js ~/bin/compose
chmod +x ~/bin/compose
```

## Backwards compatibility

`compose install` runs both `init` and `setup` in sequence.
