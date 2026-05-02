# Examples and Pipeline Editing

Worked examples for common workflows, plus the `compose pipeline` editing reference.

## Examples and Workflows

### Start a new project from scratch

```bash
mkdir my-cli-tool && cd my-cli-tool
compose new "CLI tool that converts CSV files to JSON with filtering and validation"
# Answer questionnaire questions
# Approve brainstorm at gate
# Approve roadmap at gate
# Feature folders scaffolded

compose build CSV-1  # build the first feature
```

### Add a feature to an existing project

```bash
cd existing-project
compose import                           # scan and analyze
compose feature AUTH-1 "JWT auth middleware with refresh tokens"
compose build AUTH-1
```

### Customize the pipeline before building

```bash
compose init
compose pipeline show                    # see default pipeline
compose pipeline enable prd architecture # enable optional phases
compose pipeline set review --agent codex --retries 5
compose pipeline add --id lint --after execute --agent claude --intent "Run ESLint and fix issues"
compose build FEAT-1
```

### Skip research for a well-understood project

```bash
compose new "Internal admin dashboard for existing API" --ask
# At "Research prior art?" question, answer: n
```

### Use automated review instead of human gates

```bash
compose new "microservice template" --ask
# At "Who should review?" question, choose: Codex (automated review)
```

### Abort a stuck build

```bash
compose build --abort
```

### View pipeline state

```bash
compose pipeline show
```

Output:
```
  Pipeline: build (17 steps)

   1. explore_design  agent  agent: claude [2 ensures] (retries: 2)
   2. scope           agent  agent: claude (retries: 2)
   3. design_gate     gate   human gate (timeout: 3600s)
   4. prd             skip   PRD skipped by default
   5. architecture    skip   Architecture skipped by default
   6. blueprint       agent  agent: claude [2 ensures] (retries: 3)
   7. verification    agent  agent: claude [1 ensures] (retries: 2) -> on_fail: blueprint
   8. plan_gate       gate   human gate (timeout: 3600s)
   9. decompose       agent  agent: claude [2 ensures] (retries: 2)
  10. execute         par    parallel_dispatch (worktree isolation)
  11. review          flow   parallel_review: triage → lenses → merge (retries: 5)
  12. codex_review    flow   review_check: review (agent: codex, retries: 3)
  13. coverage        flow   coverage_check: run_tests (agent: claude, retries: 15)
  14. report          skip   Report skipped by default
  15. docs            agent  agent: claude (retries: 2)
  16. ship            agent  agent: claude (retries: 2)
  17. ship_gate       gate   human gate (timeout: 1800s)
```

## Pipeline CLI

`compose pipeline` provides full control over `pipelines/build.stratum.yaml`.

### `show`

Pretty-prints the pipeline with color-coded step types:
- Green: agent steps (with ensure count, retries, on_fail)
- Yellow: gate steps (with timeout)
- Cyan: flow steps (sub-flow name, inner steps, agent)
- Gray: skipped steps (with reason)

Also shows sub-flow details and contracts.

### `set`

Modify step properties:

```bash
# Change which agent executes a step
compose pipeline set execute --agent codex

# Convert a step to a human gate
compose pipeline set review --mode gate

# Convert a step to a codex review sub-flow
compose pipeline set review --mode review
# Creates a review_check sub-flow with codex agent, ReviewResult contract,
# ensure "result.clean == True", retries 10

# Convert back to a regular agent step
compose pipeline set review --mode agent

# Set retry count
compose pipeline set blueprint --retries 5
```

### `add`

Insert a new step after an existing one:

```bash
compose pipeline add --id lint --after execute --agent claude --intent "Run linter and fix issues"
```

Creates a step with default `PhaseResult` output contract, 2 retries, and `depends_on: [<after>]`. Rewires the next step's dependencies.

### `remove`

Remove a step and rewire dependencies:

```bash
compose pipeline remove prd
```

Steps that depended on the removed step inherit its dependencies. Gate references (`on_approve`, `on_revise`, `on_fail`) are also rewired.

### `enable` / `disable`

```bash
compose pipeline enable prd architecture report  # remove skip_if
compose pipeline disable prd                      # set skip_if: "true"
```
