# COMP-RESUME: Environment-Based Resumability — Design

**Status:** DESIGN
**Date:** 2026-06-02
**Complexity:** L

## Related Documents

- Roadmap: `ROADMAP.md` → `COMP-RESUME: Environment-Based Resumability`
- Feature tracker: `docs/features/COMP-RESUME/feature.json`
- Contract (to be created in plan step 1): `contracts/checkpoint.schema.json`
- Related prior art:
  - Stratum resume primitives — per-step content-addressed result cache, live-process reparenting (`stratum-mcp/.../executor.py`, `proc_identity.py`, `parallel_exec.py`). COMP-RESUME operates one layer up, at the Compose lifecycle.
  - Known gaps this builds on: `lifecycle.phaseHistory` never populated; shared `build-stream.jsonl` concurrency (out of scope here, referenced only).

---

## Problem

When a Compose build is interrupted — process crash mid-step, killed/closed session, machine reboot, MCP server restart — the agent loses the in-context understanding of *what it was doing and why*. Compose persists durable state (`vision-state.json`, `active-build.json`, append-only logs), but:

1. **Derived state can disagree with the logs after a crash** — `active-build.json` / `currentPhase` are last-writer-wins and not rebuilt from the append-only logs on restart.
2. **`phaseHistory` is never backfilled** — timing/decision trail of how the build reached its current phase is lost.
3. **Mid-iteration crashes lose the iteration** — no interim marker, so resume silently redoes work.
4. **Nothing consults the actual environment** — Compose never checks whether the design doc, blueprint, code, commits, or tests on disk match where it *thinks* it is.
5. **The soft layer is unrecoverable** — intent, risk, and "next step because Y" live only in the dead session's context.

A generic job runner can't fix this well. Compose can, because **every phase produces a signature artifact in the environment** (design → `design.md`; blueprint → blueprint doc; implement → source + commits + tests). The filesystem and git history *are* the checkpoint.

## Goal

A resumed Compose build feels like **continuing**, not **re-deriving**. After any in-scope interruption, `bind_session` (or an explicit `compose resume <feature>`) reconstructs correct derived state from ground truth and presents the next action with intent intact — automatically for safe cases, with a human gate only for genuinely ambiguous ones.

**In scope:** crash mid-step, killed/closed session, machine reboot, MCP server restart.

**Out of scope (v1):** partial filesystem corruption; concurrent-build interleaving / shared build-stream demarcation (separate idempotency gap); Stratum-level reparenting (already exists below us); **the SmartMemory backend implementation** — v1 ships the capability-tiered interface + a backend registry so SmartMemory *can* be built later (documented seam), but only the JSONL backend is built now.

**Core principle:** the environment (git state + on-disk artifacts + append-only logs) is **ground truth**. Checkpoints are durable, advisory *intent* anchored to that truth. Resume reconciles intent against truth via an agent — it never blindly trusts a checkpoint.

---

## Architecture: four units

```
                   boundary
  build loop ──────────────────► anchor-hook ──► fingerprint ──► CheckpointStore
       │  (every boundary)                                            ▲
       │  (major boundary)                                            │
       └──────────────► scribe agent ──► {goal,nextStep,risks} ───────┘
                                                                      │
  bind_session / compose resume                                      │
       │                                                              │
       └──► reconciler ──► (1) rebuild derived state from logs+artifacts
                           (2) store.readLatest / semanticRecall ─────┘
                           (3) capture live fingerprint, classify drift
                           (4) reconciliation agent (only on divergence)
                           (5) gate only when confidence low / irreconcilable
```

---

## Decision 1: Two checkpoint grades (anchor vs narrative)

Falls out of the hybrid write strategy. A single grade either over-spends (agent at every boundary) or under-captures (no intent).

- **Anchor checkpoint** (`soft: null`) — written by a **hook** at *every* boundary. Pure deterministic capture, no LLM. Cheap, frequent, always-current.
- **Narrative checkpoint** (`soft` populated) — written by the **scribe agent** at *major* boundaries only (phase transition, pre-risky-action). Carries `{goal, nextStep, risks}`.

Resume always has a recent deterministic anchor even if the last narrative checkpoint is a few boundaries stale, and every soft field is pinned to a fingerprint — so the scribe's claims are verifiable, never free-floating.

**Rationale:** cost scales with importance; the soft layer is the only thing the structural stores can't recover, so it's the only thing an agent writes.

## Decision 2: Fingerprint records, never interprets

The `EnvFingerprint` captures *what exists*, never a verdict. There is no "tests pass" field — only `testRef`, a path to the raw output that the reconciler reads at resume time. This is what makes the scribe's narrative verifiable: every factual claim points at an anchor, not a remembered assertion.

```jsonc
EnvFingerprint {
  capturedAt:     "ISO-8601",
  git:            { head: "sha", branch: "str", dirty: bool,
                    dirtyHash: "sha256 of `git status --porcelain` + diff" },
  phaseArtifacts: { design: "path|null", blueprint: "path|null",
                    implementFiles: ["path", ...], contracts: ["path", ...] },
  testRef:        "path|null",   // latest test-output artifact (raw), never a summarized verdict
  buildStreamSeq: 0,             // last build-stream _seq at capture
  flowId:         "str|null"     // stratum flow this build drives
}
```

```jsonc
Checkpoint {
  id, featureCode, phase, createdAt,
  trigger:    "phase-transition" | "pre-risky-action" | "iteration-complete" | "manual",
  fingerprint: EnvFingerprint,     // deterministic truth at write time
  soft:       { goal: "str", nextStep: "str", risks: ["str"] } | null,  // agent-authored, major boundaries only
  artifactIds: ["str", ...]        // refs into the CheckpointStore backend
}
```

Schema is the source of truth: `contracts/checkpoint.schema.json` with `_source` / `_roadmap` fields (per contract conventions). Created as plan step 1.

## Decision 3: Capability-tiered, interchangeable CheckpointStore

An interchangeable memory spec: a portable floor every backend implements, plus optional richer capabilities the reconciler uses opportunistically via capability detection. Capability gaps degrade gracefully (semantic query → recency/substring fallback), never error.

**Base contract (floor):**
```
write(checkpoint) -> id
readLatest(featureCode) -> Checkpoint | null
list(featureCode, { limit }) -> [Checkpoint]      // newest-first
capabilities() -> Set<"semanticRecall"|"temporalRange"|"procedureMatch">
```

**Optional capability methods (ceiling):**
```
semanticRecall(featureCode, query, { limit }) -> [Checkpoint]
temporalRange(featureCode, fromTs, toTs)      -> [Checkpoint]
procedureMatch(situation)                     -> [Procedure]
```

**Backends shipped in v1:**

| Backend | Floor | Capabilities | Mapping |
|---|---|---|---|
| **JSONL** (default, store of record) | ✓ | none | `.compose/data/checkpoints-<featureCode>.jsonl`, append-only, atomic temp+rename. `readLatest` = last line, `list` = tail-N. Consistent with existing compose stores. |
| **SmartMemory** (opt-in, rich) | ✓ | all three | **DEFERRED — seam only in v1.** Registered backend id whose factory throws `NOT_IMPLEMENTED`, with the intended mapping recorded in comments: `write` → `ReasoningTracesAPI.store({trace, artifactIds})`; `semanticRecall` → `query({query, limit})`; `temporalRange` → `TemporalAPI`; `procedureMatch` → `ProcedureMatchAPI`. No SDK dependency added now; a later feature implements `smartmemory.js` against the interface and registers it (optional peer dep + lazy import at that time). |
| **file-memory pointer** (optional add-on) | partial | none | thin pointer-only writer to `~/.claude/.../memory/` so a *fresh* session with zero compose context can discover "build X is resumable." Not a full store. |

**Default = JSONL store of record + render-to-markdown view** (`lib/checkpoint/render.js`) for human inspection. Markdown is *not* the store of record: the dominant consumer is the reconciler (machine), the frequent grade (anchors) is pure structured data, and append-atomicity matches compose's existing crash-consistency model. Markdown's only edge — human readability — is served by the rendered view and, far better, by the SmartMemory backend.

**Selection:** `compose.json` → `checkpoint.backend: "jsonl" | "smartmemory" | "jsonl+memory-pointer"`, default `jsonl`. Reconciler and scribe code against the interface only; they never name a backend.

## Decision 4: Write path — hook anchors + on-demand scribe, best-effort

- **Anchor (hook, every boundary):** post-step hook runs `git rev-parse HEAD` / `git status --porcelain` (+ dirty hash), globs phase-signature artifacts, grabs latest test-output path and build-stream `_seq`, then `store.write`. No LLM, no interpretation. Boundaries: phase transition, iteration-complete, gate resolution, pre-risky-action (destructive shell op, force-y git op, kill).
- **Narrative (scribe agent, major boundaries):** main loop invokes a lightweight scribe agent with the current anchor fingerprint, recent journal/build-stream tail, and the prior narrative checkpoint. Returns *only* `{goal, nextStep, risks}`, merged onto a fresh anchor. The agent is instructed that factual claims must reference the fingerprint's anchors (point at `testRef`, never assert "tests pass").
- **Failure isolation:** checkpoint writes are best-effort and never block the build. A failed `store.write` logs a warning and continues. A missing checkpoint degrades resume quality; it never breaks the build. (Mirrors Stratum's "a cache miss is never wrong.")

## Decision 5: Resume path — reconcile, sync via agent, gate only when needed

Triggered on `bind_session` (automatic) and explicit `compose resume <feature>`.

1. **Rebuild derived state (deterministic, no LLM).** Reconcile-on-bind: read append-only logs (`build-stream`, `feature-events`, `gate-log`) + present on-disk artifacts; rebuild derived pointers (`active-build`, `currentPhase`) and backfill `phaseHistory`. Fixes the existing logs-vs-derived-state inconsistency independent of checkpoints.
2. **Load intent.** `store.readLatest` (or `semanticRecall` if advertised) → latest narrative `{goal, nextStep, risks}` + its fingerprint.
3. **Capture live fingerprint & classify drift** against the checkpoint's:
   - **clean-continue** (match) → resume at `nextStep`, no agent.
   - **env-advanced** (HEAD moved forward, clean tree, artifacts only added) → fast-forward.
   - **env-diverged** (tree edited / HEAD rewritten / artifact missing or changed) → step 4.
4. **Reconciliation agent (divergence only).** Env is ground truth. The agent reads the stale checkpoint + scans the live environment and emits a **synced checkpoint** — corrected `{goal, nextStep, risks}` reflecting what the environment shows now — plus a `confidence` and a `resumeAction`. It writes the synced checkpoint back to the store (the correction is itself durable).
5. **Gate only when needed.** If confidence is below threshold or the agent flags an irreconcilable conflict, open a Compose gate (`approve_gate`) showing checkpoint-vs-env-vs-synced diff for a human decision. Confident syncs proceed automatically.

The human is involved only in the genuinely ambiguous tail; clean/advanced cases and confidently-reconciled divergences flow automatically.

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| `contracts/checkpoint.schema.json` | new | Source-of-truth shape for Checkpoint + EnvFingerprint; `_source`/`_roadmap` |
| `lib/checkpoint/fingerprint.js` | new | Capture `EnvFingerprint`; classify two fingerprints → clean / advanced / diverged |
| `lib/checkpoint/store/index.js` | new | Interface + backend selection from `compose.json` |
| `lib/checkpoint/store/jsonl.js` | new | Default backend (store of record), append-only atomic |
| `lib/checkpoint/store/smartmemory.js` | new | Opt-in rich backend (ReasoningTraces / Temporal / ProcedureMatch), lazy SDK load |
| `lib/checkpoint/store/memory-pointer.js` | new | Optional pointer-only add-on to file-memory |
| `lib/checkpoint/render.js` | new | Render a checkpoint → markdown for human inspection |
| `lib/checkpoint/anchor-hook.js` | new | Best-effort anchor write at boundaries |
| `lib/checkpoint/reconciler.js` | new | Rebuild derived state from logs+artifacts; backfill phaseHistory; drive classify→sync→gate |
| `.claude/agents/compose-scribe.md` | new | Scribe agent — emits soft layer only, anchored to fingerprint |
| `.claude/agents/compose-reconciler.md` | new | Reconciliation agent — sync stale checkpoint ↔ live env; emit synced checkpoint + confidence + resumeAction |
| `server/compose-mcp-tools.js` | extend | `compose_resume`, `write_checkpoint`; hook reconcile into `bind_session` |
| `compose.json` | extend | `checkpoint.backend` selector |

**Boundary clarity:** the store knows nothing about builds; the fingerprint knows nothing about storage; the reconciler orchestrates but holds no persistence logic. Each is independently testable with a fake of its one dependency. New code lives in small focused files under `lib/checkpoint/` rather than swelling the large existing server files.

---

## Testing

Per the project test hierarchy (golden flows, real backends, no mocking the unit under test):

- **Golden flow (the capability):** start build → write anchors across phases → write a narrative checkpoint → simulate interruption (kill) → `bind_session` → reconciler rebuilds state + resumes at correct next step. Real JSONL backend, real git, real fs. If this passes, resume works.
- **Drift table (error harness):** one reusable table-driven harness over clean-continue / env-advanced (commit added) / env-diverged (tree edited / HEAD rewritten / artifact deleted), asserting the correct path (auto vs gate) and that env wins as ground truth.
- **Contract test:** every checkpoint validates against `checkpoint.schema.json`; both backends pass an identical interface-conformance suite (SmartMemory behind a real-instance guard).
- **Unit (only where it earns it):** fingerprint classification (pure); markdown render (pure).
- **Best-effort guarantee:** a failing `store.write` logs and continues without breaking the build.

---

## Open Questions

- [ ] Confidence threshold for the reconciliation agent's auto-proceed vs gate — fixed default, or configurable in `compose.json`?
- [ ] SmartMemory auth/connection in headless/cron contexts (interactively-authenticated backends may be absent) — fall back to JSONL automatically when SmartMemory is unreachable?
- [ ] Exact "major boundary" set that triggers the scribe agent — is `pre-risky-action` detectable cheaply at the hook layer, or does it need explicit marking by the build loop?
- [ ] Retention/eviction for the JSONL store (mirror Stratum's age/entry caps, or unbounded per-feature?).
