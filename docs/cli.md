# CLI Reference

Reference for every `compose` subcommand. Source of truth: `bin/compose.js`, indexed from `lib/cli-commands.js`.

The Command Index below is generated from the command table and lists every shipped command. Deep-dives for the primary verbs follow.

## Command Index

<!-- Generated from lib/cli-commands.js (COMP-AUDIT-13). Every shipped command appears here. -->

### Getting started

| Command | Summary |
|---|---|
| `compose init` | Initialize Compose in the current project |
| `compose setup` (alias: `sync`) | Install/sync global Compose skills |
| `compose install` | Legacy bootstrap — runs init + setup |
| `compose import` | Scan an existing project and generate a structured analysis |
| `compose doctor` | Check external skill dependencies |
| `compose update` (alias: `upgrade`) | Pull latest compose, reinstall deps, refresh global skill |

### Features & roadmap

| Command | Summary |
|---|---|
| `compose new` | Kickoff a product (research, brainstorm, roadmap, scaffold) |
| `compose feature` | Add a single feature (folder, design seed, ROADMAP entry) |
| `compose roadmap` | Show roadmap status; generate/migrate/check ROADMAP.md |
| `compose triage` | Analyze a feature and recommend a build profile |
| `compose qa-scope` | Show affected routes from a feature's changed files |

### Build & implement

| Command | Summary |
|---|---|
| `compose build` | Run a feature through the headless lifecycle |
| `compose fix` | Run a bug through the headless bug-fix lifecycle |
| `compose plan` | Plan work into a structured roadmap from a prompt |
| `compose gsd` | Per-task fresh-context dispatch from a blueprint + Boundary Map |
| `compose pipeline` | View and edit the build pipeline |
| `compose experiment` | Run an A/B model experiment from a spec |

### Lifecycle, gates & review

| Command | Summary |
|---|---|
| `compose gates` (alias: `gate`) | List and resolve pending gates |
| `compose loops` | Manage iteration loops for a feature |
| `compose guard` | Manage the canon guard and drift detection |
| `compose validate` | Validate feature/project artifacts against contracts |
| `compose record-completion` | Record a completion bound to a commit SHA (flips status to COMPLETE) |
| `compose lineage` | PROV-O artifact lineage: stamp \| stale \| show |
| `compose context` | Show the build decision log |

### Vision, ideas & tracking

| Command | Summary |
|---|---|
| `compose items` | List vision items from local state (no server) |
| `compose ideabox` | Capture, review, and promote product ideas |
| `compose judgment` | Judgment records: trace a position's causal ancestry |
| `compose metrics` | Report dispatch, settlement, and triage metrics |
| `compose tracker` | Tracker provider status and op-log sync |

### App, integrations & runtime

| Command | Summary |
|---|---|
| `compose start` | Start the compose app (UI + API) for this project |
| `compose remote` | Manage remote access: pair, list, revoke, status |
| `compose smartmemory` | Sync feature-events/journal/artifacts into SmartMemory |

### Maintenance & info

| Command | Summary |
|---|---|
| `compose migrate-state` | Run pending feature.json state migrations |
| `compose migrate-anon` | Promote anonymous ROADMAP rows to typed features (interactive) |
| `compose hooks` | Manage Claude Code hooks (install \| uninstall \| status) |
| `compose version` (alias: `--version`, `-V`) | Print compose version, git SHA, and install root |

> (The table above is generated from `lib/cli-commands.js` — do not hand-edit its rows.)

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

Auto-initializes the project if `.compose/` doesn't exist. Reads existing context from `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, and any prior `project-analysis.md` from `compose import`. Loads `pipelines/new.stratum.yaml` as the kickoff spec.

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
compose build FEAT-1 --quick            # trimmed lifecycle (design → implement → ship) for small additive work
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
- `--quick` — trimmed lifecycle (design → implement → ship, single design gate) for small-but-real additive work; selects the `build-quick` pipeline. Single-feature only; mutually exclusive with `--template` and batch builds. Phase-7 enforcement (review loop, coverage sweep, generated-test review, TDD) is preserved — only phase ceremony shrinks. See COMP-BUILD-QUICK.
- `--abort` — abort the active build (cannot combine with batch flags). Since 0.5.0 this is a real cancel: it asks the stratum engine to cancel the flow first (which kills every flow-tagged agent's process group, including agents dispatched by another process), waits a bounded time for the build driver to write its own terminal record, and only then falls back to local cleanup. It exits 0 only when the build is durably stopped; a refusal (no active build, feature mismatch, already terminal, flow not found, run lock held, engine dispatch active, transport failure, ownership lost) exits 1 and prints the reason. No patch captured after the cancel is merged: an applied merge is reversed and journaled with `rollbackReason: cancelled`. Ctrl+C / SIGTERM on the build process runs the same teardown and exits 130 / 143. Knobs: `COMPOSE_ABORT_RETRIES` (default 2), `COMPOSE_ABORT_LOCK_WAIT_MS` (10000), `COMPOSE_ABORT_DRIVER_WAIT_MS` (20000), `COMPOSE_CANCEL_TIMEOUT_MS` (15000), `COMPOSE_TEARDOWN_DRAIN_MS` (10000); `COMPOSE_FLOW_TAGGING=0` is the kill switch that drops flow tagging (agents then fall back to the pre-0.5 behaviour and cannot be cancelled cross-process).
- `--all` — build every `PLANNED` roadmap entry in dependency order
- `--dry-run` — print the build order; valid only with `--all`, multiple codes, or a prefix match (batch mode)
- `--skip-triage` — skip the triage step (single build only)
- `--cwd <path>` — agent working directory, for cross-repo features
- `--team <name>` — team template (single build only; mutually exclusive with batch builds)
- `--template <name>` — pipeline template name (single build only)
- `--cost-ceiling-usd <amount>` (or `--cost-ceiling-usd=<amount>`) — finite positive USD limit for a single build whose sidecar enables `_costCeiling`; rejected for batch builds. Overrides the configured input/default without changing the profile revision digest. Exceeding it pauses at the configured gate for a human, including under skip/flag policies. Resume interactively with `compose build FEAT-1 --resume --cost-ceiling-usd 200`, then explicitly choose approve/revise/kill; raising the limit alone does not resolve the held token. See [wave accounting and integration status](pipelines.md#cost-ceiling-and-checkpoint-recovery).
- `--resume` — resume the feature's active/resumable flow, preserving its pinned profiles and checkpoint evidence.
- `--fresh` — start a new flow and remove only the previous flow's recorded `compose/wave/<flowId>` ref with an expected-tip check. Mutually exclusive with `--resume`; both are single-build options.

A "prefix" feature code is one without a trailing digit; it matches every feature whose code begins with that string. Single-code build dispatches via `lib/build.js`; batch dispatches via `lib/build-all.js`. Auto-runs `compose init` if the project lacks `.compose/compose.json` or `pipelines/build.stratum.yaml` (or, with `--quick`, `pipelines/build-quick.stratum.yaml` — so a workspace initialized before the quick pipeline existed re-seeds it). Active build state lives in `.compose/data/active-build.json`.

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

Idea management CLI. Ideas are stored as git-tracked records under `docs/product/fluid/records/`, and `docs/product/ideabox.md` (default) is a **generated projection** of them. Edit ideas with the subcommands below, never by editing that file: it is rewritten on every change and a hand edit is discarded.

```bash
compose ideabox add "Short title" [--desc "..."] [--cluster <name>]
compose ideabox list
compose ideabox triage
compose ideabox pri <ID> <priority>
compose ideabox discuss <ID> "comment"
compose ideabox promote <ID>
compose ideabox kill <ID> "reason"
compose ideabox render
```

`promote` records a `promoted_to` link on the idea's record and may scaffold a feature folder with `feature.json`. It does not append to `ROADMAP.md` directly; use `compose roadmap generate` afterward if you maintain `ROADMAP.md` from `feature.json` files.

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

Open-loop tracker (COMP-OBS-LOOPS). Communicates with the running compose server (default `http://127.0.0.1:4001`, matching `COMPOSE_PORT`/`PORT`; override via `COMPOSE_URL`).

```bash
compose loops add --feature FEAT-1 --kind decision --summary "Pick auth provider" [--ttl-days 14] [--parent-branch <bid>]
compose loops list --feature FEAT-1 [--include-resolved] [--format json]
compose loops resolve <loopId> --feature FEAT-1 --note "Picked Clerk"
```

`--feature <code>` is required on every subcommand.

## Completion

### `compose record-completion`

Record a typed completion against a commit SHA. Wraps `record_completion` (MCP) for shell use.

```bash
compose record-completion <FEATURE_CODE> --commit-sha=<full-40-hex> [--tests-pass=true|false] [--notes='...'] [--files-changed-from-stdin] [--no-status] [--force] [--idempotency-key=<key>]
```

**Arguments:**
- `<FEATURE_CODE>` (positional, required)
- `--commit-sha=<sha>` (required) — full 40-char hex SHA. Short prefixes are rejected on write (use `git rev-parse HEAD`).
- `--tests-pass=true|false` — default `true`.
- `--notes='...'` — single-line provenance text.
- `--files-changed-from-stdin` — read newline-separated paths from stdin.
- `--no-status` — record only; do not flip feature status to COMPLETE.
- `--force` — replace an existing record on the same `(feature_code, commit_sha)` in place.
- `--idempotency-key=<key>` — caller-supplied retry key.

Writes the record to `feature.json` `completions[]` and (when `--no-status` is omitted) flips status to `COMPLETE` via `set_feature_status`. Stale state on partial-write failures surfaces typed via `STATUS_FLIP_AFTER_COMPLETION_RECORDED` with `Caused by [...]`.

### `compose hooks install|uninstall|status`

Manage the opt-in git post-commit hook that auto-records completions from `Records-completion: <CODE>` trailers.

```bash
compose hooks install [--force]
compose hooks uninstall
compose hooks status
```

**Behavior:**
- `install` reads `bin/git-hooks/post-commit.template`, substitutes `__COMPOSE_NODE__` (current `node` binary, absolute) and `__COMPOSE_BIN__` (absolute path to `bin/compose.js`), and writes the result to `<repo>/.git/hooks/post-commit` with mode 0755. Refuses to overwrite a foreign post-commit without `--force`. Idempotent on re-run if the marker matches.
- `uninstall` removes the file iff its content matches the compose marker.
- `status` reports `installed (current) | installed (stale paths — re-run install) | foreign | absent`.

**Trailer format** (case-insensitive header):

```
Records-completion: COMP-FOO-1
Records-completion: COMP-FOO-1 tests_pass=false
Records-completion: COMP-FOO-1 notes="partial — backfill deferred"
```

Multiple trailers fire multiple `record_completion` calls in order. Unknown qualifiers warn (logged to `.compose/data/post-commit.log`) but do not fail the hook. The hook always exits 0 — post-commit hooks must not influence the just-committed state.

**Path independence:** the installed hook calls the absolute `node` and `bin/compose.js` paths baked in at install time. It does not require `compose` or `node` on PATH. Re-run `compose hooks install` after a compose upgrade to refresh the paths.

## Setup

### `compose init`

Project-local initialization. Creates `.compose/`, detects agents, registers the MCP server, scaffolds `ROADMAP.md` and pipeline specs.

```bash
compose init
compose init --no-stratum
compose init --no-lifecycle
```

### `compose setup` (alias: `compose sync`)

Global skill and MCP registration. Installs **all** compose-owned skills (`/compose`, `/context-budget`, the Stratum skill, …) to every detected agent's skill dir, then registers stratum-mcp. At the end, runs an external-dependency check (see `compose doctor`) and prints actionable install hints for any missing required external skill or command.

Idempotent — re-run it after editing or adding skills locally to re-sync them. `sync` is an alias that names that job more clearly; it does **not** fetch a new version (use `compose update` for that).

```bash
compose setup     # or: compose sync
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

For npm installs, the API server serves the prebuilt cockpit at `http://localhost:4001`; Vite is not installed or needed. Source checkouts run the Vite development server at `http://localhost:5195` for HMR and require their development dependencies to be installed with `npm install`.

`render` rewrites `docs/product/ideabox.md` from the records without changing any of them. It is
the repair path: every command writes its record before regenerating the file, so if the file is
stale, missing, or was edited by hand, `render` brings it back into line.

On first use in a project that already has a hand-written `docs/product/ideabox.md` and no records
yet, the ideas in that file are imported once, keeping their existing `IDEA-N` numbers. If the file
contains ideas that have no record behind them and records already exist, the command stops and
names them rather than overwriting the file.

The cockpit's ideabox write endpoints return 409 while this migration is in progress. Reads are
unaffected.

Ideas are stored by the **local** fluid provider by default, which is what you want.
Setting `fluid.provider: "smartmemory"` in `.compose/compose.json` is not recommended for
the ideabox yet: that provider does not serialize handle allocation, so two writes at once
can be given the same idea number and one of them is lost, and an import interrupted by a
network error cannot be re-run. Compose prints a warning if you configure it. Tracked as
`COMP-FLUID-SEAM-GUARANTEES`.
