# Compose

### Structured AI dev pipeline: goal to shipped code, with gates that hold

#### *Your agent writes the code. Compose makes it prove it.*

> Describe what you want. Compose decomposes it, forces the design decisions before any code is written, hands each step to the right agent, and refuses to advance until that step proves it is done. What comes back is a feature folder with the design, the blueprint, the plan, the code, the tests, and the full review trail. Auditable end to end.

## The problem

An agent finishes, reports done, and the suite is green. Weeks later you find the feature. It exists, it has tests, and nothing calls it. The tests exercise a path that real data never enters.

Nobody lied. The agent did what it was asked, the tests assert what they assert, and no step in between ever had to prove the thing was wired to anything. That gap does not show up in a diff review. It shows up in production, or it never shows up at all, which is worse.

The general form: AI agents can write code, but going from "I want X" to "X is built correctly" takes a process. Decomposition, design decisions, acceptance criteria, sequencing, verification, and course correction when things drift. Today that process lives in the developer's head, where it is manual, fragile, and gone by the next session.

## What it is

Compose sits above Claude Code and Codex rather than in place of them. It decides what the next step is, hands it to whichever agent should do it, and will not advance until the step proves it finished.

## Who it's for

- **Solo builders and small teams** shipping more code each week than they can personally review, who need something other than trust to decide when a feature is really done
- **Tech leads reviewing agent output** who keep finding work that passes its own tests and is wired to nothing
- **Anyone running more than one agent** (Claude for implementation, Codex for review) who wants the same standard applied no matter which model did the work
- **Developers who lose the thread at a session boundary** and want the plan, the decisions, and the open questions to outlive the context window instead of living in chat scrollback
- **Maintainers whose roadmap has drifted from reality** and want status derived from what actually shipped rather than from what someone remembered to update
- **Teams who have to explain a decision months later**, what was chosen, what was rejected and why, and cannot reconstruct any of it from a diff

## Why Compose

| | Prompting the agent directly | A plan.md or TODO list | **Compose** |
| --- | --- | --- | --- |
| **Definition of done** | Whatever the agent says | A checkbox someone ticks | Postconditions checked before the step can pass |
| **Design decisions** | In the chat, then gone | Sometimes written down | Recorded artifacts, gated before any code |
| **Survives a session boundary** | No, only scrollback | The text, not the reasoning | Feature folder: design, blueprint, plan, review trail |
| **Review** | Whenever you remember | Manual | Enforced at every gate, and runnable on a different model than the one that wrote the code |
| **Catches wired-to-nothing code** | No | No | Implementation review keyed to wiring, not only to tests |
| **Roadmap status** | Manual | Manual, and it drifts | Generated from what actually shipped |
| **Recovery mid-build** | Start over | Re-read and guess | Resume from recorded state |

## How it works

**One pipeline, variable entry points.**

```
Any prompt → Context → Decompose → Q&A → Decide → Design → Plan → Build
```

- "Build me X" — full pipeline from scratch
- "Fix this bug" — context + diagnosis → design fix → build
- "Add Y to Z" — context(Z) → plan(Y) → build
- "Continue where I left off" — recover state → rejoin mid-stream
- "I have a fuzzy idea" — optional discovery on-ramp → converge to a goal → enter pipeline

Every entry point passes through a context phase (F0) that gathers what's needed: code context always, project history and work state when available. First use is lightweight. Tenth use has accumulated reasoning.

## What keeps it on rails

LLMs drift. The rails are:

- **Traceability** — every output links to the goal it serves
- **Acceptance criteria** — "done" is defined before work starts
- **Verification hooks** — automated checks at each pipeline step
- **The 3-mode dial** — gate (human decides), flag (AI proceeds, human notified), skip (AI autonomous)
- **Self-escalation** — AI tightens the dial when it's uncertain. Only the human loosens.
- **Hard limits** (always enforced: tests pass, no secrets, traceability) vs **soft limits** (flex by trust level: conventions, review, documentation)

## Features

| Feature | What it does | Role |
|---|---|---|
| **F0: Context** | Gather code, project history, work state before decomposing | Front door |
| **F4: Plan & Decompose** | Break goals into executable work with dependencies | Core pipeline |
| **F3: Distill & Decide** | Resolve decision points, converge evidence into commitments | Core pipeline |
| **F5: Execute with Agents** | Direct AI agents, provide context, enforce guardrails | Core pipeline |
| **F2: Capture Knowledge** | Record decisions, rationale, evidence as the pipeline runs | Support |
| **F6: See Everything** | Visibility into pipeline state, confidence, status | Support |
| **F1: Discover** | Explore when the goal is fuzzy, brainstorm, converge | On-ramp |

## Architecture

**4 primitives:** Discovery (Q&A process between phases), Work (trackable items), Policy (gate/flag/skip dials), Session (actors doing work).

**7 phases:** Vision → Requirements → Design → Planning → Implementation → Verification → Release. Phases are levels of concreteness. Discovery is the process that moves between them.

**Cross-cutting:** Tracking, confidence (Bayesian), visibility, knowledge capture, the 3-mode dial, persistence, audit/history.

**Connectors:** Persistence, retrieval, agents, and external systems are swappable. Built-in default: markdown files in git. No infrastructure required.

## Who it's for

**Primary:** Solo developer working with AI agents. Knows what to build, wants the process on rails.

**Secondary:** Founder/PM who shifts between strategic thinking and hands-on building. Same person, different depth — "developer mode" vs "product mode."

**Not for (v1):** Large teams, enterprise workflows, non-technical users.

## What it's NOT

- Not a task tracker (though it tracks work)
- Not a chat wrapper (though it involves conversation)
- Not an IDE (though it embeds terminals and agents)
- Not a project management tool (though it manages projects)

It's the structured process between "I want X" and "X is built correctly."

## Current state

**Updated 2026-07-22.** Shipping. Compose is at npm `0.3.0` with the build / fix / plan / new lifecycles live, a Stratum-backed pipeline engine, an MCP server, a tracker-provider layer, and a generated `ROADMAP.md` carrying 367 COMPLETE features against 113 PLANNED. The back half (goal → design → blueprint → implement → ship) works and is dogfooded daily.

The live frontier is the **front half** — what to build, and how to know. See [The Discovery Loop](product/2026-07-20-discovery-loop-vision.md) (the ladder), [What To Build — The Judgment Layer](product/2026-07-20-what-to-build-vision.md) (the spine), and [COMP-PLAN-RIGOR](design/2026-07-20-front-funnel-rigor-design.md) (the near-term slice).

> **Everything above this section is the founding vision and is preserved as written.** It was accurate as a statement of intent and remains the reference for what Compose is *for*. This section is the only part that tracks reality, and it had rotted five months before being caught — cluster docs were citing the "Vision phase" line as current. If you are citing this document for Compose's *state*, cite this section only.
