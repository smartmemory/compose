# Lifecycle Behaviors

Cross-cutting runtime behaviors: questionnaire, gates, validation, recovery, progress logging, vision tracking, and result normalization.

## Questionnaire System

Interactive pre-flight for `compose new`. Runs automatically on first invocation, then only with `--ask`. Skip entirely with `--auto`.

### Questions Asked

1. **Refine description** — text input with previous answer as default
2. **Project type** — CLI tool, Web API, Library/SDK, Full-stack app, Other
3. **Language/runtime** — Node.js (JS), Node.js (TS), Python, Go, Rust, Other
4. **Scope** — Small (1-3 features), Medium (3-8), Large (8+)
5. **Research** — yes/no: research prior art before brainstorming?
6. **Additional context** — multiline free-form notes
7. **Review agent** — Human (gate prompt), Codex (automated review), Skip review
8. **Confirm** — summary + launch confirmation

### Answer Persistence

Answers are saved to `.compose/questionnaire.json`. On subsequent runs:
- Without `--ask`: saved answers are loaded silently to enrich the intent
- With `--ask`: saved answers appear as defaults (press Enter to keep)

### Pipeline Customization

The review agent choice modifies the pipeline:
- "Codex (automated review)" sets the `review_gate` to `--mode review`
- "Skip review" disables the `review_gate` step

### Enriched Intent

The questionnaire output is an enriched intent string combining:
- Refined description
- Project constraints (type, language, scope)
- Additional context notes
- Any existing project context (README, package.json, project-analysis.md)

## Gate System

Gates pause the pipeline for human decisions. Three outcomes:

| Key | Outcome | Effect |
|-----|---------|--------|
| `a` | **approve** | Proceed to `on_approve` step |
| `r` | **revise** | Loop back to `on_revise` step |
| `k` | **kill** | Terminate the flow |

### Conversation Mode

If the user types anything other than `a`/`r`/`k`, it's collected as a note/question. The user can ask questions or provide feedback before making their decision. Notes are included in the rationale sent to Stratum.

```
Gate: review_gate
  [a]pprove -> roadmap
  [r]evise  -> brainstorm
  [k]ill    -> (terminate)
  Or type a question/comment to discuss before deciding.

> What about error handling for edge cases?
  (noted -- enter a/r/k when ready to decide)
> The feature list looks comprehensive
  (noted -- enter a/r/k when ready to decide)
> a
  Notes collected: 2
  Additional rationale (or Enter to use notes):
```

### Rationale

A rationale is always required. If notes were collected during conversation mode, they serve as the rationale. Otherwise, the user is prompted explicitly.

### Gate Definitions in Specs

```yaml
functions:
  design_gate:
    mode: gate
    timeout: 3600   # seconds

steps:
  - id: design_gate
    function: design_gate
    on_approve: plan        # proceed to this step
    on_revise: explore_design  # loop back
    on_kill: null           # null = terminate flow
```

### Artifact Display

Before gate prompts in the `new` pipeline, the artifact produced by the prior step is displayed so the user can make an informed decision. For short documents (<= 80 lines), the full content is shown; for longer ones, the first 60 lines plus a truncation notice.

## Validation System

Agent-as-validator: after a step writes its artifact, a separate lightweight agent call reads the artifact and checks it against criteria defined in the pipeline spec.

### How It Works

1. The pipeline spec defines `validate` on a step:
   ```yaml
   - id: brainstorm
     validate:
       artifact: docs/discovery/brainstorm.md
       criteria:
         - "Contains at least 3 features with short codes"
         - "Contains user stories in 'As a...' format"
         - "Contains at least 2 architecture options"
   ```
2. After the step completes, the validator dispatches a fresh Claude call with a prompt asking it to read the artifact and check each criterion.
3. The validator returns `{ valid: boolean, issues: string[] }`.
4. If `valid` is false, a fix agent (claude) is dispatched to fix all issues, then the pipeline continues.
5. If the validator can't extract structured JSON, it optimistically assumes valid (no crash).

### Criteria

Criteria are human-readable strings. The validator agent interprets them and returns a boolean judgment per criterion. This means validation is semantic, not syntactic — "Contains at least 3 features" is checked by an agent reading the document, not by a regex.

## Recovery Logic

When a step's postconditions fail (`ensure_failed` or `schema_failed`), Compose runs a two-phase recovery:

### 1. Fix Pass

A fix agent is dispatched with the violations:

```
Fix step "review" -- postconditions failed:
- result.clean == True
Fix every issue. Do not skip any.
```

For codex steps, the fix pass goes to **claude** (cross-agent fix). For claude steps, the fix is same-agent but with a distinct prompt focused on fixing.

### 2. Retry

After the fix pass, the original step is retried with a retry prompt that includes both the original intent and the violations:

```
RETRY -- Previous attempt failed postconditions:
- result.clean == True
Fix these issues and try again.
[original step prompt]
```

### Retry Limits

Each step has a `retries` count (set in the pipeline spec). The `review_check` sub-flow defaults to 5 retries; coverage defaults to 15. When retries are exhausted, `on_fail` routing kicks in (if configured), or the step fails.

### on_fail Routing

Steps can specify `on_fail: <step-id>` to route to a different step when retries are exhausted. The `verification` step uses `on_fail: blueprint` to loop back for a blueprint rewrite.

## Progress Logging

During agent execution, Compose renders a live progress display to stderr with two modes:

**Collapsed (default):** Shows the last 5 tool events, a status line with elapsed time and tool count, and a key hints bar. Redraws in-place every 5 seconds (heartbeat).

```
  ● explore ─ ● scope ─ ◉ blueprint ─ ○ plan ─ ○ execute ─ ○ review ─ ○ codex
[3/17] blueprint...
    ↳ Read: lib/build.js
    ↳ Grep: pattern match in server/
    ↳ Read: docs/features/FEAT-1/design.md
    ↳ Edit: src/App.jsx
    ↳ Bash: npm test
  blueprint · 45s · 5 calls
  keys: t=toggle  s=skip  r=retry  Ctrl+C=abort
```

**Expanded:** Shows all tool events as they arrive, plus elapsed time heartbeat every 5 seconds.

### Key commands during build

| Key | Action |
|-----|--------|
| `t` | Toggle between collapsed and expanded view |
| `s` | Skip the current step (interrupts agent, moves to next) |
| `r` | Retry the current step (interrupts agent, re-runs same step) |
| `Ctrl+C` | Abort the build |

### Pipeline bar

The pipeline bar shows all build steps with status indicators:
- `●` (green) — completed steps
- `◉` (cyan, bold) — current active step
- `○` (dim) — pending steps

Adapts to terminal width with a sliding window for narrow terminals.

### Findings table

When the review step returns violations, they're rendered as a formatted table with severity coloring (must-fix=red, should-fix=yellow, nit=gray).

### Gate panel

Gate prompts render as a boxed panel showing the artifact path, phase transition, and color-coded action options instead of raw readline text.

Enable verbose event logging with `COMPOSE_DEBUG=1`.

## Vision Writer Integration

The `VisionWriter` (`lib/vision-writer.js`) maintains `.compose/data/vision-state.json` with atomic read-modify-write operations (POSIX rename).

### What It Tracks

- **Feature items**: Each feature gets a vision item with id, type, title, status, phase, featureCode, slug, confidence, timestamps
- **Phase updates**: As each step executes, the item's `lifecycle.currentPhase` is updated
- **Gate entries**: Each gate creates a record with flowId, stepId, itemId, status, timestamps
- **Gate resolutions**: Outcome (approve/revise/kill) and resolution timestamp

### Lookup Conventions

Supports both `feature:CODE` (seed convention) and `lifecycle.featureCode` (lifecycle-manager convention) for feature item lookup.

### Status Transitions

```
planned -> in_progress -> complete
planned -> in_progress -> killed
```

## Result Normalization and JSON Extraction

The result normalizer (`lib/result-normalizer.js`) bridges the gap between streaming agent text and structured step results.

### Schema Injection

When a step has `output_fields`, the normalizer:
1. Converts Stratum's flat type map (`{ clean: "boolean", findings: "array" }`) to JSON Schema
2. Injects schema instructions into the prompt via `injectSchema()`
3. The agent sees: "include a JSON code block at the very end of your response matching this schema"

### JSON Extraction

After the agent completes, the normalizer tries three extraction strategies in order:

1. **Full text parse** — the entire output is valid JSON
2. **Fenced block** — extract from ` ```json ... ``` `
3. **Balanced braces** — find the first `{` and its matching `}`, parse the substring

If all strategies fail, a warning is logged and a fallback `{ summary: "..." }` is returned (first 200 chars of output). The pipeline does not crash.

### Error Handling

- `AgentError` — thrown when the agent yields an error event
- `ResultParseError` — thrown when JSON extraction fails (includes raw text for debugging)
