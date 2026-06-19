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
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Default model for ClaudeSDKConnector |
| `CODEX_MODEL` | `gpt-5.4` | Default model for CodexConnector |
| `COMPOSE_DEBUG` | (unset) | Enable verbose event logging to stderr |
| `COMPOSE_TARGET` | (unset) | Override project root for `compose start` |
| `COMPOSE_SERVER_DISPATCH` | unset | Set to `1` to route `parallel_dispatch` steps through Stratum's server-side executor. Covers `isolation: "none"` unconditionally, and `isolation: "worktree"` steps that declare `capture_diff: true` (Compose consumes diffs from poll response and merges them client-side). When the step also declares `defer_advance: true`, Compose reports merge_status back via `stratum_parallel_advance` — client-side merge conflicts surface as `{status: 'complete', output: {merge_status: 'conflict'}}` and Compose sets `buildStatus='failed'` (non-zero CI exit). Worktree steps without `defer_advance` use the legacy throw-on-conflict path. |
| `COMPOSE_SERVER_DISPATCH_POLL_MS` | `500` | Poll interval (ms) against `stratum_parallel_poll`. Lower = faster task-transition event propagation; higher = less MCP load. |
