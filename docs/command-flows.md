# Compose Command Flows

Mermaid flow diagrams for every `compose` CLI verb. Rendered inline on GitHub and in the cockpit's Docs view.

Three primary lifecycles (`build`, `fix`, `gsd`) drive feature/bug development. The remaining commands are scaffolding, housekeeping, and observability.

---

## `compose build <feature-code>`

Headless feature lifecycle. Spec: [`pipelines/build.stratum.yaml`](../pipelines/build.stratum.yaml). Entry: [`lib/build.js`](../lib/build.js) `runBuild`.

```mermaid
flowchart TD
    Start([compose build CODE]) --> Triage{auto-triage?}
    Triage -->|yes| TriageRun[Pre-build triage:<br/>profile + skip toggles]
    Triage -->|skip| Design
    TriageRun --> Design

    Design[Phase 1: explore_design<br/>writes design.md] --> DesignGate{design_gate}
    DesignGate -->|approve| PRD
    DesignGate -->|revise| Design
    DesignGate -->|kill| Killed([killed.md])

    PRD[Phase 2: prd<br/>skippable] --> Arch
    Arch[Phase 3: architecture<br/>skippable] --> Blueprint

    Blueprint[Phase 4: blueprint<br/>file:line refs +<br/>optional Boundary Map] --> Verify
    Verify[Phase 5: verification<br/>boundary-map.js validator]
    Verify -->|stale refs| Blueprint
    Verify -->|clean| Plan

    Plan[Phase 6: plan<br/>tasks + acceptance] --> PlanGate{plan_gate}
    PlanGate -->|approve| Decompose
    PlanGate -->|revise| Plan

    Decompose[Phase 7a: decompose<br/>TaskGraph w/<br/>files_owned] --> Execute

    Execute[Phase 7b: execute<br/>parallel_dispatch<br/>max_concurrent: 3<br/>isolation: worktree<br/>merge: sequential_apply]

    Execute --> Review
    Review[Phase 7c: parallel_review<br/>Claude lenses]
    Review -->|findings| Execute
    Review -->|clean| Codex

    Codex[Phase 7d: codex_review<br/>independent cross-model]
    Codex -->|findings| Execute
    Codex -->|clean| Coverage

    Coverage[Phase 7e: coverage<br/>test suite<br/>retries: 15]
    Coverage -->|fail| Coverage
    Coverage -->|pass| Report

    Report[Phase 8: report<br/>skippable] --> Docs
    Docs[Phase 9: docs<br/>CHANGELOG, ROADMAP,<br/>README, CLAUDE.md]
    Docs --> Ship

    Ship[Phase 10: ship<br/>tests + build +<br/>commit in-process]
    Ship --> ShipGate{ship_gate}
    ShipGate -->|approve| Done([COMPLETE])
    ShipGate -->|revise| Ship

    classDef gate fill:#fef3c7,stroke:#d97706,stroke-width:2px
    classDef terminal fill:#dbeafe,stroke:#2563eb
    classDef killed fill:#fee2e2,stroke:#dc2626
    class DesignGate,PlanGate,ShipGate,Triage gate
    class Start,Done terminal
    class Killed killed
```

**Flags:** `--through <phase>` partial run, `--abort`, `--resume`, `--skip-triage`, `--template <name>`, `--cwd <path>`.

---

## `compose fix <bug-code>`

Headless bug-fix lifecycle. Spec: [`pipelines/bug-fix.stratum.yaml`](../pipelines/bug-fix.stratum.yaml). Eight steps with hard-bug machinery (hypothesis ledger, two-tier escalation, bisect).

```mermaid
flowchart TD
    Start([compose fix CODE]) --> Scaffold{description.md<br/>exists?}
    Scaffold -->|no| Stub[Scaffold stub<br/>+ exit 1]
    Scaffold -->|yes| Reproduce

    Reproduce[F2: reproduce<br/>failing test or<br/>repro confirmed<br/>retries: 2]
    Reproduce --> Diagnose

    Diagnose[F3: diagnose<br/>ensure: trace_evidence ≥ 2<br/>retries: 2]
    Diagnose -->|cap exceeded| Checkpoint
    Diagnose -->|ledger pre-fill| Diagnose
    Diagnose --> Bisect

    Bisect{classifyRegression?}
    Bisect -->|yes| BisectRun[runBisect<br/>git bisect run<br/>5-min timeout per probe]
    Bisect -->|no| Scope
    BisectRun --> Scope

    Scope[scope_check<br/>cross-repo grep for<br/>cross-layer references<br/>retries: 1] --> Fix

    Fix[Phase 7 step 1: fix<br/>TDD, minimal change<br/>retries: 2] --> TestLoop

    TestLoop[Phase 7 step 4: test<br/>inner fix-and-retest loop<br/>retries: 5]
    TestLoop -->|fail| Fix
    TestLoop -->|pass| Verify

    Verify[verify<br/>original repro now passes<br/>retries: 1] --> Retro

    Retro[retro_check<br/>scans git history for<br/>fix chains<br/>hard stop at attempt 2<br/>for visual/CSS]
    Retro -->|fix chain| Escalation
    Retro -->|clean| ShipFix

    Escalation[Tier 1: codex<br/>second opinion]
    Escalation -->|new hypothesis<br/>Jaccard < 0.7| Tier2
    Escalation -->|stale| ShipFix
    Tier2[Tier 2: fresh worktree<br/>+ detached HEAD<br/>DO-NOT-COMMIT]
    Tier2 --> ShipFix

    ShipFix[ship<br/>commit + CHANGELOG<br/>retries: 1]
    ShipFix --> Done([COMPLETE])

    Checkpoint[Write checkpoint.md<br/>+ docs/bugs/INDEX.md]
    Checkpoint --> Halt([HALTED<br/>compose fix --resume])

    classDef gate fill:#fef3c7,stroke:#d97706,stroke-width:2px
    classDef terminal fill:#dbeafe,stroke:#2563eb
    classDef halt fill:#fee2e2,stroke:#dc2626
    class Scaffold,Bisect,Retro,Escalation gate
    class Start,Done terminal
    class Halt,Stub halt
```

**Paths:** Quick (known root cause + single file) collapses F2/F3 → Fix. Hotfix time-boxes F3 with `// HOTFIX:` follow-up.
**Flags:** `--abort`, `--resume`, `--cwd <path>`.

---

## `compose gsd <feature-code>`

Per-task fresh-context dispatch (COMP-GSD-2). Spec: [`pipelines/gsd.stratum.yaml`](../pipelines/gsd.stratum.yaml). Entry: [`lib/gsd.js`](../lib/gsd.js) `runGsd`.

```mermaid
flowchart TD
    Start([compose gsd CODE]) --> CheckBP{blueprint.md<br/>exists?}
    CheckBP -->|no| ErrorBP[Error:<br/>run compose build CODE first]
    CheckBP -->|yes| ValidateBM

    ValidateBM{validateBoundaryMap<br/>.ok === true?}
    ValidateBM -->|no| ErrorBM[Error: BM invalid<br/>+ violations list]
    ValidateBM -->|yes| Clean

    Clean{git workspace<br/>clean?}
    Clean -->|no| ErrorDirty[Error: commit or stash<br/>(allowDirtyWorkspace<br/>opt-in for advanced)]
    Clean -->|yes| GateCommands

    GateCommands[Resolve gateCommands<br/>compose.json or defaults<br/>pnpm lint/build/test] --> Plan

    Plan[stratum.plan<br/>gsd.stratum.yaml<br/>inputs: featureCode +<br/>gateCommands] --> Decompose

    Decompose[Step 1: decompose_gsd<br/>agent reads blueprint.md +<br/>Boundary Map →<br/>TaskGraph w/ rich descriptions]
    Decompose --> Enrich

    Enrich{enrichTaskGraph<br/>structural check}
    Enrich -->|orphan slice/task| FailLoud[Throw loud<br/>no repair path]
    Enrich -->|valid + sections OK| Execute
    Enrich -->|valid + missing<br/>section markers| Repair

    Repair[buildTaskDescription<br/>per-task fallback<br/>6 sections from slice +<br/>upstream + gates]
    Repair --> Execute

    Execute[Step 2: execute<br/>parallel_dispatch<br/>max_concurrent: 1<br/>isolation: worktree<br/>capture_diff: true<br/>merge: sequential_apply<br/>retries: 2]

    Execute --> TaskAgent
    TaskAgent[Each task agent:<br/>TDD implement +<br/>run gateCommands +<br/>write per-task<br/>TaskResult JSON]
    TaskAgent --> MergeDiffs

    MergeDiffs[applyServerDispatchDiffsCore<br/>topological merge to base cwd<br/>per-task .json lands at<br/>.compose/gsd/CODE/results/]

    MergeDiffs --> CaptureFiles[Capture filesChanged<br/>via git diff]
    CaptureFiles --> Ship

    Ship[Step 3: ship_gsd<br/>executeShipStep in-process<br/>stages filesChanged +<br/>ROADMAP/CHANGELOG/CLAUDE<br/>+ commit<br/>(push deferred to user)]

    Ship --> Blackboard
    Blackboard{collectBlackboard<br/>validate each<br/>TaskResult}
    Blackboard -->|any invalid| FailLoudBB[Throw loud<br/>list all failures<br/>no partial blackboard]
    Blackboard -->|all valid| WriteBB

    WriteBB[writeAll<br/>blackboard.json<br/>one-shot replace +<br/>mkdir lock]
    WriteBB --> Done([COMPLETE])

    classDef precond fill:#fef3c7,stroke:#d97706,stroke-width:2px
    classDef terminal fill:#dbeafe,stroke:#2563eb
    classDef error fill:#fee2e2,stroke:#dc2626
    classDef sentinel fill:#e0e7ff,stroke:#6366f1
    class CheckBP,ValidateBM,Clean,Enrich,Blackboard precond
    class Start,Done terminal
    class ErrorBP,ErrorBM,ErrorDirty,FailLoud,FailLoudBB error
    class Repair sentinel
```

**Flags:** `--cwd <path>`. `{allowDirtyWorkspace: true}` opt-in via programmatic API.

**v1 limits:** sequential only (`max_concurrent: 1`); no runtime task-to-task handoff (tasks see spec-level upstream context only); no per-task gate bounce-back (gates run inside each agent's TDD loop). GSD-3..7 extend.

---

## `compose new`

Kickoff a product: research → brainstorm → initial roadmap → scaffold.

```mermaid
flowchart LR
    Start([compose new]) --> Idea[User idea<br/>or one-liner]
    Idea --> Research[Research:<br/>competitors,<br/>tech landscape]
    Research --> Brainstorm[Brainstorm:<br/>scope, MVP,<br/>roadmap shape]
    Brainstorm --> Roadmap[Generate ROADMAP.md<br/>+ feature.json files]
    Roadmap --> Scaffold[Scaffold .compose/<br/>+ docs/features/<br/>+ initial CHANGELOG]
    Scaffold --> Done([Ready for<br/>compose build])

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start,Done terminal
```

---

## `compose import`

Scan an existing project and generate structured analysis.

```mermaid
flowchart LR
    Start([compose import]) --> Scan[Scan repo:<br/>package.json,<br/>directory structure,<br/>existing docs]
    Scan --> Analyze[Generate analysis:<br/>tech stack,<br/>architecture,<br/>conventions]
    Analyze --> Seed[Seed docs/features/<br/>+ scaffold .compose/<br/>+ propose roadmap]
    Seed --> Done([Ready for<br/>compose build])

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start,Done terminal
```

---

## `compose feature <code>`

Add a single feature: folder + design seed + ROADMAP row.

```mermaid
flowchart LR
    Start([compose feature CODE]) --> Folder[Create<br/>docs/features/CODE/]
    Folder --> Templates[Copy templates:<br/>design.md, prd.md,<br/>architecture.md,<br/>blueprint.md, plan.md]
    Templates --> Json[Write feature.json<br/>status: PLANNED]
    Json --> Roadmap[Append row to<br/>ROADMAP.md]
    Roadmap --> Done([Ready for<br/>compose build])

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start,Done terminal
```

---

## `compose roadmap [generate|migrate|check]`

Source-of-truth is `feature.json`; ROADMAP.md is generated.

```mermaid
flowchart TD
    Start([compose roadmap])
    Start --> Sub{subcommand?}
    Sub -->|none| Status[Show status:<br/>buildable features,<br/>blockers, next steps]
    Sub -->|generate| Gen[Read all feature.json →<br/>regenerate ROADMAP.md<br/>atomically]
    Sub -->|migrate| Mig[Parse existing ROADMAP.md →<br/>create feature.json per row]
    Sub -->|check| Check[Diff feature.json vs ROADMAP.md →<br/>report drift]

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start terminal
```

---

## `compose triage <feature-code>`

Analyze a feature and recommend build profile.

```mermaid
flowchart LR
    Start([compose triage CODE]) --> Read[Read docs/features/CODE/<br/>design + complexity hints]
    Read --> Score[Score: complexity,<br/>files-affected,<br/>cross-repo blast]
    Score --> Profile{recommend<br/>profile}
    Profile --> Quick[quick:<br/>skip PRD/arch/report]
    Profile --> Standard[standard:<br/>full lifecycle]
    Profile --> Heavy[heavy:<br/>+ codex review,<br/>+ extra coverage]

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start terminal
```

---

## `compose qa-scope <feature-code>`

Show affected routes from a feature's changed files. Read-only.

```mermaid
flowchart LR
    Start([compose qa-scope CODE]) --> Diff[git diff base...HEAD]
    Diff --> Map[Map changed files →<br/>HTTP routes /<br/>UI components]
    Map --> Report[Print:<br/>routes touched,<br/>components changed,<br/>suggested manual checks]

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start terminal
```

---

## `compose pipeline`

View / edit `.stratum.yaml` pipelines.

```mermaid
flowchart LR
    Start([compose pipeline]) --> Choice{action}
    Choice -->|view| Show[Show pipeline:<br/>steps, contracts,<br/>flow graph]
    Choice -->|edit| Edit[Open in $EDITOR;<br/>re-validate on save]

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Start terminal
```

---

## Setup commands (`init`, `setup`, `update`, `doctor`)

```mermaid
flowchart TD
    subgraph init [compose init - project-local]
        I1[Create .compose/compose.json] --> I2[Scaffold docs/, pipelines/]
        I2 --> I3[Install hooks]
    end

    subgraph setup [compose setup - user-global]
        S1[Install ~/.claude/skills/compose/] --> S2[Register stratum-mcp<br/>in ~/.claude/settings.json]
        S2 --> S3[Sync vendored skills]
    end

    subgraph update [compose update]
        U1[git pull latest compose] --> U2[npm install]
        U2 --> U3[Re-sync skill files]
    end

    subgraph doctor [compose doctor]
        D1[Check stratum-mcp installed] --> D2[Check external skill deps]
        D2 --> D3[Print install commands<br/>for missing pieces]
    end
```

---

## Lifecycle overview

The three primary verbs map to feature lifecycle stages:

```mermaid
flowchart LR
    Idea([raw idea]) -->|compose new| Roadmap([roadmap + features])
    Roadmap -->|compose feature CODE| Feature([feature folder])
    Feature -->|compose build CODE| Built([implemented + shipped])
    Built -->|bug found| Bug([bug])
    Bug -->|compose fix CODE| Fixed([fixed + shipped])
    Built -->|long-run / many tasks| GSD([compose gsd CODE])
    GSD --> Built

    classDef terminal fill:#dbeafe,stroke:#2563eb
    class Idea,Roadmap,Feature,Built,Bug,Fixed,GSD terminal
```

`compose build` is the default. `compose fix` handles non-trivial bugs (with hard-bug escalation machinery). `compose gsd` runs an existing blueprint as per-task fresh-context dispatch — the load-bearing primitive for long autonomous runs (COMP-GSD-2).
