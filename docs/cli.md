# CLI Reference

Reference for every `compose` subcommand. Source of truth: `bin/compose.js`.

The verbs group naturally:
- **Workflow:** `new`, `import`, `feature`, `roadmap`, `build`, `fix`
- **Pipeline editing:** `pipeline`
- **Triage and QA:** `triage`, `qa-scope`
- **Tracking:** `ideabox`, `gates`, `loops`
- **Setup:** `init`, `setup`, `install`, `doctor`
- **Server:** `start`

---

## Workflow

### `compose new`

Kickoff a new product. Runs the full kickoff pipeline (research, brainstorm, roadmap, scaffold).

```bash
compose new "Structured log analyzer CLI for JSON-lines files"
compose new "REST API for managing team todo lists" --auto
compose new "OAuth2 provider library" --ask
compose new "..." --from-idea IDEA-42
```

**Arguments:**
- First argument: product description (quoted string)
- `--auto` — skip the questionnaire entirely
- `--ask` — re-run the questionnaire (uses previous answers as defaults)
- `--from-idea <ID>` — pre-populate intent from a promoted ideabox entry

Auto-initializes the project if `.compose/` doesn't exist. Reads existing context from `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, and any prior `project-analysis.md` from `compose import`. Loads `pipelines/new.stratum.yaml` (currently absent — see `COMP-NEW-PIPELINE-MISSING`).

### `compose import`

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

The generated analysis is automatically consumed by `compose new` as context.

### `compose feature`

Add a single feature with folder structure, seed design doc, and ROADMAP entry.

```bash
compose feature LOG-1 "CLI tool for parsing JSON-lines log files"
compose feature AUTH-2 "Add OAuth2 login flow with PKCE"
```

Creates:
- `docs/features/<CODE>/design.md` — seed design doc
- Appends a row to `ROADMAP.md` with the feature code and PLANNED status
- Updates the project description in ROADMAP if still placeholder

### `compose roadmap`

Manage the roadmap representation across `ROADMAP.md` and per-feature `feature.json` files.

```bash
compose roadmap generate              # regenerate ROADMAP.md from feature.json files (alias: gen)
compose roadmap migrate               # extract ROADMAP.md rows into feature.json files
compose roadmap migrate --dry-run     # preview without writing
compose roadmap migrate --overwrite   # replace existing feature.json files
compose roadmap check                 # verify feature.json ↔ ROADMAP.md consistency
```

### `compose build`

Run a feature through the headless build lifecycle. Main execution command.

```bash
compose build FEAT-1
compose build FEAT-1 FEAT-2 FEAT-3      # batch build, multiple codes
compose build STRAT-COMP                # prefix match — builds all features whose code starts with STRAT-COMP
compose build --all                     # build all PLANNED features in dependency order
compose build --all --dry-run           # print the planned batch order, do not execute
compose build FEAT-1 --skip-triage
compose build FEAT-1 --cwd /path/to/repo
compose build FEAT-1 --team frontend
compose build FEAT-1 --template api
compose build --abort                   # abort the active single build
compose build FEAT-1 --abort            # abort a specific feature's build
```

**Flags:**
- `--abort` — abort the active build (cannot combine with batch flags)
- `--all` — build every `PLANNED` roadmap entry in dependency order
- `--dry-run` — print the build order; valid only with `--all`, multiple codes, or a prefix match (batch mode)
- `--skip-triage` — skip the triage step (single build only)
- `--cwd <path>` — agent working directory, for cross-repo features
- `--team <name>` — team template (single build only; mutually exclusive with batch builds)
- `--template <name>` — pipeline template name (single build only)

A "prefix" feature code is one without a trailing digit; it matches every feature whose code begins with that string. Single-code build dispatches via `lib/build.js`; batch dispatches via `lib/build-all.js`. Auto-runs `compose init` if the project lacks `.compose/compose.json` or `pipelines/build.stratum.yaml`. Active build state lives in `.compose/data/active-build.json`.

### `compose fix`

Run a bug through the bug-fix pipeline (`pipelines/bug-fix.stratum.yaml`): reproduce → diagnose → bisect → scope_check → fix → test → verify → retro_check → ship. Thin delegation to `runBuild()` with `template='bug-fix'`. The pipeline owns iteration (test step `retries=5` plus `ensure passing==true`; retro_check enforces a hard stop at attempt 2 for visual/CSS bugs and flags fix chains).

```bash
compose fix BUG-12
compose fix BUG-12 --resume
compose fix --abort
compose fix BUG-12 --cwd /path/to/repo
```

The bug description must exist at `docs/bugs/<bug-code>/description.md`. If absent, `compose fix` scaffolds a stub and exits 1 so you can fill it in before retrying. Auto-runs `compose init` if `pipelines/bug-fix.stratum.yaml` is missing.

## Pipeline editing

### `compose pipeline`

View and edit `pipelines/build.stratum.yaml`.

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

See [Examples and Pipeline Editing](examples.md) for full details on each subcommand.

## Triage and QA

### `compose triage`

Classify a feature into a complexity tier and persist the profile + tier to `feature.json`.

```bash
compose triage FEAT-1
```

Reports: tier, rationale, profile (per-axis scores), and signals (file paths found, task count, security paths, core paths). Creates `feature.json` if absent; otherwise updates `complexity`, `profile`, and `triageTimestamp`.

### `compose qa-scope`

Map a feature's `filesChanged` set to affected and adjacent routes.

```bash
compose qa-scope FEAT-1
```

Reads `feature.json`, runs `mapFilesToRoutes` and `classifyRoutes` from `lib/qa-scoping.js`, and prints framework, docs-only flag, affected routes, adjacent routes, and unmapped files. If `filesChanged` is empty, suggests running a build first.

## Tracking

### `compose ideabox`

Idea management CLI. Subcommands operate on the ideabox file (default `docs/product/ideabox.md`).

```bash
compose ideabox add "Short title" [--desc "..."] [--cluster <name>]
compose ideabox list
compose ideabox triage
compose ideabox pri <ID> <priority>
compose ideabox discuss <ID> "comment"
compose ideabox promote <ID>
compose ideabox kill <ID> "reason"
```

`promote` marks the idea promoted in the ideabox file and may scaffold a feature folder with `feature.json`. It does not append to `ROADMAP.md` directly; use `compose roadmap generate` afterward if you maintain `ROADMAP.md` from `feature.json` files.

### `compose gates`

Gate audit log report (COMP-OBS-GATELOG).

```bash
compose gates report                                    # last 24h, text format
compose gates report --since 7d
compose gates report --since 1h --feature FEAT-1
compose gates report --format json
compose gates report --rubber-stamp-ms 3000
```

**Flags:**
- `--since <window>` — `24h`, `7d`, `1h`, or an ISO date (default 24h)
- `--feature <code>` — restrict to one feature
- `--format text|json` — output format (default text)
- `--rubber-stamp-ms <N>` — threshold below which a gate decision counts as rubber-stamped (default 3000ms)

Reports per-gate stats: total decisions, approve/deny/interrupt percentages, median decision time, and a rubber-stamp percentage. Gates with rubber-stamp >50% are flagged in the text view as candidates for downgrade to a flag or skip.

### `compose loops`

Open-loop tracker (COMP-OBS-LOOPS). Communicates with the running compose server (default `http://localhost:3000`; override via `COMPOSE_URL`).

```bash
compose loops add --feature FEAT-1 --kind decision --summary "Pick auth provider" [--ttl-days 14] [--parent-branch <bid>]
compose loops list --feature FEAT-1 [--include-resolved] [--format json]
compose loops resolve <loopId> --feature FEAT-1 --note "Picked Clerk"
```

`--feature <code>` is required on every subcommand.

## Setup

### `compose init`

Project-local initialization. Creates `.compose/`, detects agents, registers the MCP server, scaffolds `ROADMAP.md` and pipeline specs.

```bash
compose init
compose init --no-stratum
compose init --no-lifecycle
```

### `compose setup`

Global skill and MCP registration. Installs the `/compose` skill and Stratum skill to all detected agents. At the end, runs an external-dependency check (see `compose doctor`) and prints actionable install hints for any missing required external skill or command.

```bash
compose setup
```

### `compose install`

Backwards-compatibility shim: runs `compose init` followed by `compose setup`.

```bash
compose install
```

### `compose doctor`

Verify external skills and commands the lifecycle relies on (e.g. `superpowers:*`, `interface-design:*`, `codex:review`, `refactor`, `update-docs`). Authoritative dep list lives in `.compose-deps.json` at the package root.

```bash
compose doctor              # human-readable report
compose doctor --json       # machine-readable, full dep records
compose doctor --strict     # exit 1 on any missing required dep (use in CI)
compose doctor --verbose    # also list scanned filesystem paths
```

## Server

### `compose start`

Launch the Compose supervisor: web UI, terminal, agent, and API server.

```bash
compose start
COMPOSE_TARGET=/path/to/project compose start
```

Resolves the project root from the current working directory upward, or uses `COMPOSE_TARGET` when set. Errors out if the resolved root has no `.compose/compose.json`.
