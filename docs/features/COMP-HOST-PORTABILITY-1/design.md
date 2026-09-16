# COMP-HOST-PORTABILITY-1 — Host portability audit: Codex CLI host and standalone CLI

**Status:** PLANNED
**Priority:** HIGH
**Created:** 2026-09-16
**Class:** audit / measurement — produces a findings report and a ranked gap list, not a port.
**Effort:** M (audit only; the remediations it spawns are separate features)

## Related Documents

- [`COMP-AGENT-VENDOR-1`](../COMP-AGENT-VENDOR-1/design.md) — COMPLETE; shipped the
  `compose-explorer` / `compose-architect` subagent definitions and made `compose setup` install
  them to `~/.claude/agents/`. That work deepened the Claude coupling this audit measures, and its
  failure mode ("the lifecycle silently falls back to built-ins" when a subagent is missing) is the
  exact shape to look for on a non-Claude host.
- [`STRAT-HERMES-CONNECTOR`](../STRAT-HERMES-CONNECTOR/feature.json) — prior third-host connector work.
- `stratum/ts/src/connectors/` — `claude.ts` and `codex.ts` are already peers there.
- `compose/lib/local-claude-connector.js` — Compose's only connector.

## Why

Two claims are made routinely and neither has been measured:

1. **"Compose has a standalone CLI."** `bin/compose.js` exposes 30+ commands across seven groups
   (init, feature, build, fix, gsd, gates, guard, validate, judgment, tracker, metrics, …). Many
   look host-independent. Nobody has established which ones actually complete without a Claude Code
   session driving them, and which ones return success while doing nothing.
2. **"Stratum is host-agnostic."** True at the connector layer — `claude.ts` and `codex.ts` are
   peers. Not established above it: Compose ships exactly one connector
   (`lib/local-claude-connector.js`), `compose setup` installs agent definitions to
   `~/.claude/agents/`, and the lifecycle's subagent dispatch names Claude subagent types
   (`compose-explorer`, `compose-architect`).

The asymmetry is the risk. If a Codex-hosted or host-free run silently falls back instead of
failing, we will believe we have portability we do not have — the same failure class as
`COMP-AGENT-VENDOR-1`, where a missing agent definition degraded to built-ins with no signal.

There is also a live operational reason. Claude and Codex quotas are budgeted separately, and a
Codex-hosted Compose would let a whole lifecycle run on the cheaper pool. That option is currently
unpriced because nobody knows what breaks.

## Scope

Three hosts, one matrix:

| Host | What it means |
|---|---|
| **A — Claude Code** | Today's baseline. Establishes the reference behaviour every command should match. |
| **B — Codex CLI** | `codex exec` as the driving agent, reaching Compose/Stratum through their MCP surfaces and the CLI. |
| **C — none (standalone)** | `compose <command>` run directly from a shell with no agent host at all. |

## Acceptance criteria

- [ ] **Command matrix.** Every `compose` CLI command classified per host as `works` |
      `degrades-loudly` | `degrades-silently` | `fails` | `n/a`. Derive the command list from
      `bin/compose.js`, not from the README.
- [ ] **Silent-degradation inventory.** Every command that exits 0 on host B or C while doing less
      than it does on host A, with `file:line` for the fallback branch. **This is the headline
      deliverable** — a loud failure is a known limitation, a silent one is a trap.
- [ ] **Claude-coupling inventory.** Every hardcoded assumption of a Claude Code host across
      `compose/lib/`, `compose/bin/`, the skills, and the installed agent definitions, with
      `file:line`. Include `~/.claude/` path writes, `subagent_type` literals, Claude-specific
      prompt/tool shapes, and any MCP tool name assumed present.
- [ ] **Stratum layer verdict.** Confirm or refute that `stratum/ts/src/connectors/` is genuinely
      host-agnostic by running the same flow through `claude.ts` and `codex.ts` and diffing the
      resulting audit traces. Note any capability that exists on one connector only.
- [ ] **Lifecycle end-to-end.** Run one real feature through `compose build` on host B and host C.
      Record where each run stops, and whether stopping was loud. A run that "completes" while
      skipping phases counts as a silent degradation, not a pass.
- [ ] **Gap list, ranked.** Each gap: what breaks, blast radius, rough remediation cost, and whether
      it blocks a Codex-hosted lifecycle or merely degrades it. Ranked by (blocking × cheapness).
- [ ] **Report** at `docs/features/COMP-HOST-PORTABILITY-1/report.md` with the matrix, the two
      inventories, the verdict, and the ranked gap list.

## Explicit non-goals

- **No porting.** This audit does not make Compose host-agnostic. Remediations spawn as separate
  features from the gap list.
- **No new connector.** Writing a `local-codex-connector.js` may well be the top gap; writing it is
  not part of this feature.
- **No third-party hosts.** Cursor, Windsurf, Hermes and friends are out of scope. Three hosts only.

## Method notes

- **Measure, do not reason.** A command's portability is established by running it on each host and
  diffing observable effects (files written, exit code, artifacts produced, roadmap rows changed),
  never by reading the source and concluding it looks fine.
- Prefer a throwaway scratch project for lifecycle runs. Do not run `compose build` against this
  repo's own roadmap as a test.
- Host B needs a Codex surface that can reach local MCP servers. Note that Stratum's Codex sandbox
  has no network and no loopback today (`STRAT-CODEX-DISPATCH-1` is adding an opt-in full-access
  mode); if that lands first, use it — if not, record the constraint as a finding, because it is
  itself a portability blocker.
- Where a fallback is found, check whether it logs. An unlogged fallback is a finding in its own
  right regardless of whether the outcome was acceptable.

## Open question for the report to answer

Is host-agnosticism worth buying? The report should end with a recommendation: invest in a real
Codex-hosted lifecycle, keep Claude Code as the only supported host and make the CLI honestly
declare its limits, or something between. State the cost.
