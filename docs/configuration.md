# Configuration

Files Compose reads and writes, plus environment variables.

## `.compose/compose.json`

Project-level configuration. Created by `compose init`.

```json
{
  "version": 2,
  "capabilities": {
    "stratum": true,
    "lifecycle": true
  },
  "agents": {
    "claude": { "detected": true, "skillInstalled": true },
    "codex": { "detected": true, "skillInstalled": true },
    "gemini": { "detected": false }
  },
  "paths": {
    "docs": "docs",
    "roadmap": "ROADMAP.md",
    "features": "docs/features",
    "journal": "docs/journal",
    "context": "docs/context",
    "ideabox": "docs/product/ideabox.md"
  }
}
```

### `capabilities` block

Feature toggles. Absent keys take their default.

| Key | Default | Effect |
|---|---|---|
| `stratum` | `true` | Use the Stratum execution kernel; when `false`, fall back to flat prompt chains. |
| `lifecycle` | `true` | Maintain the per-feature lifecycle projection. |
| `vocabularyCompliance` | `true` (opt-out) | When a `contracts/vocabulary.yaml` exists, `compose build` appends the `vocabulary_compliance` ensure to the `review` step so rejected naming aliases block the build (STRAT-VOCAB). Set `false` to disable even when a vocabulary file is present. With no vocabulary file the build is byte-identical regardless. |

### `paths` block

Where Compose reads and writes each **artifact**. Keys: `docs`, `roadmap`, `features`, `journal`,
`context`, `ideabox`. Each value may be:

- **in-root** (the default), e.g. `"docs/features"` — relative to the workspace root;
- **`../`-escaping**, e.g. `"../smart-memory-docs/features"` — a sibling folder/repo;
- **absolute**, e.g. `"/srv/shared/ROADMAP.md"`.

This lets a product whose code lives in many repos keep **one** roadmap + features folder in a
dedicated docs repo (e.g. `smart-memory-docs`) while you run Compose from any of them. `.compose/`
(config + state, including `data/vision-state.json`) always stays at the workspace root; only the
artifacts relocate. Unset/default values resolve byte-identically to the legacy in-root locations.

Caveats for a **relocated** setup (COMP-PATHS-EXTERNAL):
- If the artifact lives in a **different git repo**, `compose build` writes it but does **not** commit
  that repo (it logs a "commit it there" notice) — commit the docs repo yourself. Cross-repo
  auto-commit is tracked as `COMP-PATHS-EXTERNAL-1`.
- The MCP-enforcement and STRAT-GUARD subsystems match in workspace-relative space, so guarded edits to
  **relocated** canon are not enforced; this is surfaced with a visible warning at ship.

### `tracker` block

Optional. Controls where feature/completion/changelog/event data is persisted.

```json
{
  "tracker": {
    "provider": "local",
    "github": {
      "repo": "owner/repo",
      "projectNumber": 42,
      "branch": "main",
      "roadmapPath": "ROADMAP.md",
      "changelogPath": "CHANGELOG.md",
      "cacheTtlSeconds": 300,
      "auth": { "tokenEnv": "GITHUB_TOKEN" }
    }
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `provider` | `"local"` | `"local"` or `"github"`. `local` = filesystem only, zero behavior change. |
| `github.repo` | — | Required for `github`. `owner/repo` format. |
| `github.projectNumber` | — | Required for `github`. GitHub Projects v2 project number. |
| `github.branch` | `"main"` | Branch for Contents API reads/writes (roadmap, changelog). |
| `github.roadmapPath` | `"ROADMAP.md"` | Repo-relative path to roadmap file. |
| `github.changelogPath` | `"CHANGELOG.md"` | Repo-relative path to changelog file. |
| `github.cacheTtlSeconds` | `300` | Read-cache TTL for GitHub API responses. |
| `github.auth.tokenEnv` | — | Name of env var holding a GitHub PAT. Falls back to `gh auth token` if unset. Required scopes: `repo`, `project`. |

### `roadmap` block

Optional. Controls roadmap generation policy.

```json
{
  "roadmap": {
    "narrative": true
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `narrative` | `false` | When `true`, the workspace is **narrative-owned**: `ROADMAP.md` is hand-authored and must not be machine-regenerated from `feature.json`. `generateRoadmap`/`writeRoadmap` no-op with a warning and `add_roadmap_entry` refuses. The roundtrip *checks* skip too — `compose roadmap check` exits 0 ("skipped") and the validator emits an info `ROADMAP_NARRATIVE_OWNED` rather than false `ROUNDTRIP_NOT_FIXED_POINT`/`ROADMAP_LOSSY` drift. `feature.json` files may still exist as structured link carriers (xref-sync) — they just don't drive `ROADMAP.md`. See issue #39. |

### `fleet` block

Optional. Written by the cockpit's left bar (COMP-COCKPIT-FLEET-PROJECTS-1, -2); you rarely edit `projects` by hand.

**Which file:** the `.compose/compose.json` of the project the cockpit server **started on**, not the project the cockpit has switched to. The left bar switches projects, and the list must not change under you when it does. To move the list, restart the server on another project (or copy the block).

```json
{
  "fleet": {
    "projects": ["forge", "hub", "main"],
    "roots": { "main": "~/reg/my/SmartMemory", "trader": null }
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `projects` | absent | The PROJECTS list in the Fleet room's left bar, in order: the lanes the Process tab shows (comparison columns and time-split rows) and their order. Absent means every lane `GET /api/process` knows, in builder order. A name the builder no longer knows is skipped. Written by `POST /api/fleet/projects` (loopback callers only, known lane names only, no duplicates) as an atomic rewrite that keeps every other key; a `compose.json` that is not valid JSON is refused (409), never overwritten. |
| `roots` | absent | Lane name to the Compose project a PROJECTS click opens in Home, Ideas, Roadmap, Build and Review: a path (`~` expands) or `null` for none. A lane absent here uses the built-in default (forge, cadence, 2.0, maya and trader, taken from the status builder's configs); every other lane has none. A root counts only while `<root>/.compose` is a directory; otherwise the room shows "No Compose project for <lane>". Served by `GET /api/fleet/roots`. A malformed value is ignored whole and named in that route's `error`. Saving the order keeps this key. |

### `verify` block

Optional. Shape: `contracts/verify-config.schema.json`. Two independent keys, neither required, and a
project may declare either, both or neither; any other key is refused. `preflight` is read by
`lib/preflight.js` (COMP-SETUP-PREFLIGHT-1); `flows` by `lib/verify-flows.js` (COMP-VERIFY-FLOW-1).

```json
{
  "verify": {
    "preflight": {
      "checks": [
        { "id": "falkordb-up", "command": ["redis-cli", "-p", "19123", "ping"], "expect": "PONG", "timeout_s": 5 }
      ],
      "exclusive_runs": true,
      "busy_wait_s": 0
    },
    "flows": [
      {
        "id": "pipeline-roundtrip",
        "command": ["node", "scripts/flows/pipeline-roundtrip.mjs"],
        "covers": ["src/lib/pipeline-model.js", "server/pipeline-routes.js"],
        "expect": ["EDGES total 62", "KEY after"],
        "timeout_s": 300,
        "setup_exit_codes": [3, 127]
      }
    ]
  }
}
```

#### `verify.preflight`

An invalid `preflight` block fails the run as `SETUP-FAIL config` rather than being ignored.

| Field | Default | Notes |
|-------|---------|-------|
| `preflight.checks[]` | none | Cheap checks run before the pre-push test gate, `compose build` (before the first agent dispatch) and `compose preflight`. `id` names the check in output and in `failureReason: setup:<id>` (`stratum-engine` is reserved). `command` is an argv array run in the project root, never a shell string. `expect` is a substring of stdout or stderr. Without it the check passes on exit 0. `timeout_s` defaults to 10. |
| `preflight.exclusive_runs` | `false` | The pre-push gate holds a run lock for the whole suite at `<main checkout>/.compose/data/verify-run.lock`, one per repository (every worktree shares it). A second gate run prints `SETUP-BUSY` with the holder's pid, start time and command, and refuses. A holder whose pid is no longer running is a stale lock and is taken over, with a line saying so. A live holder is never overridden. A holder on another host, or an unreadable lock, is never judged stale: remove the directory by hand. |
| `preflight.busy_wait_s` | `0` | Seconds a gate run waits for a live holder before refusing. `0` refuses at once. |

Without a `preflight` block only the built-in Stratum engine check runs (`compose preflight` in `docs/cli.md`).

#### `verify.flows`

Declares the project's **user flows**: commands that do what a person does
(start the app, click, save, reload) and print lines that prove it worked. When `flows` is present,
`compose record-completion` runs the flows that cover the changed files before it writes anything, and
refuses the completion if one fails. A project without `flows` (no `verify` block, or one holding only
`preflight`) sees no change at all: no flow runs, no new line, no new file. An invalid `verify` block
(either key) refuses the completion at load (`VERIFY_CONFIG_INVALID`, naming the field).

| Field | Default | Notes |
|-------|---------|-------|
| `id` | required | Lowercase letters, digits and dashes, at most 64 characters; unique in the block. |
| `command` | required | An argv array, run from the project root with no shell. A string is refused. |
| `covers` | required | Globs (`**`, `*`, `?`) over repo-relative paths. A flow runs when a changed file matches one. With no changed-file list (`--files-changed-from-stdin` absent or empty) every flow runs. |
| `expect` | required | Lines the output must contain, each as a whole line after trimming. The flow passes only on exit 0 **and** every line present: exit 0 with a line missing, or a failing exit with every line present, is `FLOW_FAILED`. |
| `timeout_s` | `600` | 1 to 7200. Past it the flow's whole process group gets SIGTERM, then SIGKILL after 3 s (servers the flow started go too): `FLOW_TIMEOUT`. |
| `setup_exit_codes` | `[127]` | Exit codes that mean "could not start" (a missing tool, no free port). They report `FLOW_SETUP_ERROR` ("nothing was tested"), not `FLOW_FAILED`, so nobody fixes product code for them. A command that cannot be spawned at all is a setup error too. |

Each run writes a log to `.compose/data/verify/<FEATURE|_adhoc>/<id>-<time>.log` and a line to
`runs.jsonl` beside it. A pass mints a `command` evidence receipt (`lib/evidence.js`) whose claimed line
is the last expected line, so `evidence-cli show <id>` re-checks it against the log; the completion record
keeps `verify_flows[]` (id, verdict, evidence id, log, commit). The flows run whatever
`capabilities.guard` and `--tests-pass` say: no flag completes a feature whose covering flow failed. The
backfill path (`backfill_completions`) does not run flows, because they test today's tree, not a historical
commit. Run them by hand with `compose verify`.

## `.compose/questionnaire.json`

Saved questionnaire answers (enriched intent, project type, language, scope, research preference, notes, review agent choice).

## `.compose/data/vision-state.json`

Vision tracker state: items, connections, gates. Managed by `VisionWriter`. Atomic writes via temp file + rename.

## `.compose/data/active-build.json`

Active build state for resume/abort:

```json
{
  "featureCode": "FEAT-1",
  "flowId": "uuid",
  "startedAt": "2026-03-11T...",
  "currentStepId": "blueprint",
  "specPath": "pipelines/build.stratum.yaml"
}
```

## `pipelines/build.stratum.yaml`

The build pipeline spec. Editable via `compose pipeline` or by hand. See [The Build Pipeline](pipelines.md#the-build-pipeline).

## `pipelines/new.stratum.yaml`

The kickoff pipeline spec. See [The Kickoff Pipeline](pipelines.md#the-kickoff-pipeline).

## `.mcp.json`

MCP server registration. `compose init` adds:

```json
{
  "mcpServers": {
    "compose": {
      "command": "node",
      "args": ["<compose-root>/server/compose-mcp.js"]
    }
  }
}
```

## `ROADMAP.md`

Scaffolded from `templates/ROADMAP.md` with project name, date, and placeholder phases. Updated by `compose feature` and the build pipeline.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Default model for ClaudeSDKConnector |
| `CODEX_MODEL` | `gpt-5.6-terra/high` | Default model for CodexConnector. Canonical source: `stratum/src/stratum/judge/codex_models.py` (see its docstring for how to change this or add a model) |
| `COMPOSE_DEBUG` | (unset) | Enable verbose event logging to stderr |
| `COMPOSE_SKIP_PREFLIGHT` | (unset) | `1` skips every setup check of `compose preflight`, the pre-push gate and `compose build` (built-in `stratum-engine` and `verify.preflight.checks`) with one WARNING naming them. The end-of-run engine re-check is off too. The run lock is unaffected. |
| `COMPOSE_TARGET` | (unset) | Override project root for `compose start` |
| `COMPOSE_SERVER_DISPATCH` | unset | Set to `1` to route `parallel_dispatch` steps through Stratum's server-side executor. Covers `isolation: "none"` unconditionally, and `isolation: "worktree"` steps that declare `capture_diff: true` (Compose consumes diffs from poll response and merges them client-side). When the step also declares `defer_advance: true`, Compose reports merge_status back via `stratum_parallel_advance` — client-side merge conflicts surface as `{status: 'complete', output: {merge_status: 'conflict'}}` and Compose sets `buildStatus='failed'` (non-zero CI exit). Worktree steps without `defer_advance` use the legacy throw-on-conflict path. |
| `COMPOSE_SERVER_DISPATCH_POLL_MS` | `500` | Poll interval (ms) against `stratum_parallel_poll`. Lower = faster task-transition event propagation; higher = less MCP load. |
| `JEV_API_KEY` | (unset) | Key for [Jev](https://typesafe.ai) (sign up at typesafe.ai). When set, Jev picks the review gate's approve/revise default from the step summary instead of the keyword rule. The summary text is sent to `api.typesafe.ai`. See "Jev gate defaults" in the README. |
| `COMPOSE_GATE_JEV` | (unset) | `0` turns Jev gate defaults off even when `JEV_API_KEY` is set. `1` with no key prints one warning. |
