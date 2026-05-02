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
    "features": "docs/features",
    "journal": "docs/journal"
  }
}
```

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
