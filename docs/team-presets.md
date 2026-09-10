# Team Presets

Team presets are curated multi-agent pipeline templates that ship with Compose. They let you run specialized agent teams without writing pipeline YAML from scratch.

## Usage

```bash
compose build <feature-code> --team <name>
```

Available teams: `review`, `research`, `feature`, `fable-astra`.

## Teams

### review

Runs 3 read-only reviewers in parallel (security, performance, architecture), then merges and deduplicates findings. Aborts if any critical-severity finding is detected.

```bash
compose build FEAT-1 --team review
```

**When to use:** After implementation, before merge. Catches issues a single-pass review would miss.

**Agents:** All use `read-only-reviewer` profile (Read/Grep/Glob only, no file modifications).

### research

Runs 3 explorers in parallel (codebase, web search, local docs), then synthesizes findings into actionable recommendations.

```bash
compose build FEAT-1 --team research
```

**When to use:** Cold-start discovery, unfamiliar feature areas, evaluating approaches before implementation.

**Agents:** Codebase and docs explorers use `read-only-reviewer`. Web explorer uses `read-only-researcher` (adds WebSearch/WebFetch).

### feature

Decomposes a feature into parallel tasks with file ownership, implements them in isolated worktrees, merges results, and verifies tests pass.

```bash
compose build FEAT-1 --team feature
```

**When to use:** Multi-file feature implementation where tasks can be parallelized.

**Agents:** Orchestrator decomposes, implementers use `claude:implementer` (full access within their `files_owned`).

### fable-astra

Fable plans and assesses bounded waves. Up to three Codex workers implement
independent tasks in isolated worktrees, with per-task critical/standard/fast
tiers and enforced file ownership. After merge and Sonnet verification, a fresh
read-only Astra reviewer checks the integrated result and cross-module wiring.
Fable requests affected-only repairs, another implementation wave, completion,
or blocking. Completion ships one base-parent commit.

```bash
compose build FEAT-1 --team fable-astra
```

Both gates allow two revisions, sharing a four-revision flow limit. Concurrency
is literal 3; the optional `cost_ceiling_usd` input defaults to $150 in the
sidecar and `--cost-ceiling-usd` overrides it. See [wave loop and recovery](pipelines.md#fable-astra-wave-loop).

## Customization

To customize a preset, copy its YAML and adjacent profiles sidecar to your project's `pipelines/` directory:

```bash
cp presets/team-review.stratum.yaml pipelines/team-review.stratum.yaml
cp presets/team-review.profiles.json pipelines/team-review.profiles.json
# Edit both files to your needs; the sidecar carries roles and restrictions.
```

Project-local templates in `pipelines/` take precedence over bundled presets.
If a local spec has the same basename as a bundled preset whose sidecar configures
execution (per-item tiers, output-driven gates, ownership, a cost ceiling: today
`team-fable-astra`), Compose refuses to build without the adjacent
`<name>.profiles.json`: `PROFILE_SIDECAR_REQUIRED`, before any plan or flow.
Copy both files. A string-only sidecar (tool restrictions and tiers, as the other
presets and pipelines ship) stays optional: a missing one runs on bare defaults and
drops those restrictions, so copy it too.

## Inspecting Presets

View the raw YAML to understand what a team does:

```bash
cat presets/team-review.stratum.yaml
```

Each preset starts with a comment block describing its purpose, pattern, and capabilities.

## Limitations

- `--team` only works with single features (not `--all` or multiple feature codes)
- `--team` and `--template` cannot be used together
- File ownership in `team-feature` is validated at plan time (`no_file_conflicts`), not enforced at runtime
- No custom merge strategies in v1 — deduplication is agent-driven
- Team coordination occurs at step/wave boundaries; no mid-wave worker messaging
