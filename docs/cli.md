# CLI Reference

Reference for every `compose` subcommand.

## `compose new`

Kickoff a new product. Runs the full kickoff pipeline: research, brainstorm, roadmap, and scaffold.

```bash
compose new "Structured log analyzer CLI for JSON-lines files"
compose new "REST API for managing team todo lists" --auto
compose new "OAuth2 provider library" --ask
```

**Arguments:**
- First argument: product description (quoted string)
- `--auto` — skip the questionnaire entirely
- `--ask` — re-run the questionnaire (uses previous answers as defaults)

Auto-initializes the project if `.compose/` doesn't exist. Reads existing context from `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, and any prior `project-analysis.md` from `compose import`.

## `compose import`

Scan an existing project and generate a structured analysis at `docs/discovery/project-analysis.md`.

```bash
cd existing-project
compose import
```

Walks the file tree (max depth 4, ignoring `node_modules`, `.git`, etc.), reads key files (`README.md`, `package.json`, config files, top-level source files), and dispatches Claude to produce:
- Project overview (what it does, language, maturity)
- Architecture map
- Feature inventory with suggested codes
- Patterns and conventions
- Gaps and opportunities
- Suggested roadmap

The generated analysis is automatically consumed by `compose new` and `compose build` as context.

## `compose feature`

Add a single feature to the project with a folder structure, seed design doc, and ROADMAP entry.

```bash
compose feature LOG-1 "CLI tool for parsing JSON-lines log files"
compose feature AUTH-2 "Add OAuth2 login flow with PKCE"
```

Creates:
- `docs/features/<CODE>/design.md` — seed design doc with status, date, intent
- Appends a row to `ROADMAP.md` with the feature code and PLANNED status
- Updates the project description in ROADMAP if still placeholder

## `compose build`

Run a feature through the headless build lifecycle. This is the main execution command.

```bash
compose build FEAT-1
compose build --abort        # abort the active build
compose build FEAT-1 --abort # abort a specific feature's build
```

Loads `pipelines/build.stratum.yaml`, starts a Stratum flow, and dispatches each step to the appropriate agent. Tracks active build state in `.compose/data/active-build.json` for resume/abort support. Only one build can be active at a time.

## `compose pipeline`

View and edit the build pipeline spec (`pipelines/build.stratum.yaml`).

```bash
compose pipeline show
compose pipeline set <step> --agent codex
compose pipeline set <step> --mode gate
compose pipeline set <step> --mode review
compose pipeline set <step> --retries 5
compose pipeline add --id lint --after execute --agent claude --intent "Run linter"
compose pipeline remove <step>
compose pipeline enable <step> [step...]
compose pipeline disable <step> [step...]
```

See [Examples and Pipeline Editing](examples.md) for full details.

## `compose init`

Project-local initialization. Creates `.compose/`, detects agents, registers MCP server, scaffolds ROADMAP and pipeline specs.

```bash
compose init
compose init --no-stratum
compose init --no-lifecycle
```

## `compose setup`

Global skill and MCP registration. Installs the `/compose` skill and Stratum skill to all detected agents. At the end, runs an external-dependency check (see `compose doctor`) and prints actionable install hints for any missing external skills or commands.

```bash
compose setup
```

## `compose doctor`

Verifies that the external skills and commands the lifecycle relies on (e.g. `superpowers:*`, `interface-design:*`, `codex:review`, `refactor`, `update-docs`) are installed locally. The authoritative dep list lives in `.compose-deps.json` at the package root.

```bash
compose doctor              # human-readable report
compose doctor --json       # machine-readable, full dep records (id, required_for, install, fallback, optional)
compose doctor --strict     # exit 1 on any missing required dep (use in CI)
compose doctor --verbose    # also list the filesystem paths scanned
```

## `compose start`

Start the Compose app (supervisor with web UI, terminal, and API server).

```bash
compose start
COMPOSE_TARGET=/path/to/project compose start
```
