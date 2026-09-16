---
date: 2026-09-16
session_number: 119
slug: host-portability-audit
summary: "COMP-HOST-PORTABILITY-1 audit: measured Compose under Claude Code, a Codex host and a bare shell; lifecycle is Claude-SDK-bound at every phase, connector neutrality refuted, 14 silent degradations, compose start killed the owner's server"
feature_code: COMP-HOST-PORTABILITY-1
closing_line: "We asked whether Compose was portable and found out who it actually calls when nobody is looking: Claude, every time."
---

# Session 119 — COMP-HOST-PORTABILITY-1

**Date:** 2026-09-16
**Feature:** `COMP-HOST-PORTABILITY-1`

## What happened

The session resumed from a flush note with two items shipped and one left: the host portability audit filed the day before. The design's rule was "measure, do not reason", so instead of reading source and forming an opinion we ran four Codex arms in parallel under a Stratum spec: a static sweep of every Claude assumption in compose/lib, bin, skills and installed agent definitions; a standalone-shell arm that ran all 88 CLI command surfaces in a throwaway project under an isolated HOME; a Codex-host arm where an inner codex exec drove Compose and Stratum over their MCP servers and pushed a hello-world feature through compose build; and a connector arm that ran one matched Stratum flow through claude.ts and codex.ts and diffed the audit traces. The three measurement arms ran outside the Stratum codex sandbox on purpose, because that sandbox has no network or loopback and would have confounded exactly what we were measuring.

The measurements were less flattering than the claims. The standalone CLI is real for 55 of 88 surfaces, but both lifecycle runs spawned only Claude agents through the Agent SDK no matter who was driving. The Codex-hosted run implemented the README and its test correctly, then failed loudly in review when two Claude lenses rejected an oversized prompt and rate-limited on retry, and nothing could resume it: the MCP resume failed, the CLI said "Nothing to resume", stratum_resume completed without restoring Compose's state, and --fresh restarted at design. That failure cost $14.04. The standalone run reached the design gate, printed "Gate delegated to web UI. Waiting for resolution..." and waited forever, because the running server did not know the scratch workspace. The connector diff refuted the neutrality claim outright: seventeen capability groups exist on one connector only.

We also caused an incident. The standalone brief allowed a bounded 20-second compose start probe. compose start reads a machine-wide PID file and SIGTERMs whatever supervisor it names before binding :4001, so the probe replaced the owner's running server and then tore down only its own replacement. The agent followed the brief; the brief was the fault. The server was left down pending the owner's decision, and the behaviour became gap G8 in the report.

An astra pass synthesized the four artifacts into the report, the feature was committed, pushed, and completed through the completion gate.

## What we built

- `docs/features/COMP-HOST-PORTABILITY-1/report.md` — command matrix, 14-row silent-degradation inventory, Claude-coupling inventory, Stratum layer verdict (REFUTED), lifecycle B/C narratives, ranked gap list G1–G14, staged recommendation.
- `docs/features/COMP-HOST-PORTABILITY-1/audit/static-inventory.md` — 89 command surfaces, 68 coupling sites, 26 fallback candidates, all file:line.
- `docs/features/COMP-HOST-PORTABILITY-1/audit/host-c-matrix.md` — standalone measurements, 4 silent rows, two lifecycle runs.
- `docs/features/COMP-HOST-PORTABILITY-1/audit/host-b-lifecycle.md` — Codex-host MCP surface table and phase-by-phase lifecycle table.
- `docs/features/COMP-HOST-PORTABILITY-1/audit/connector-diff.md` — capability table, quoted trace diff, failure-surfacing comparison.
- `docs/features/COMP-HOST-PORTABILITY-1/progress.md` — controller ledger incl. the incident and the source-verified supervisor finding.
- `docs/features/COMP-HOST-PORTABILITY-1/.stratum.yaml` — the five-step spec; flow 05e46af9 completed with 5 dispatches, 0 retries.
- Commits `2afbdb6` (audit) and `8ee7cd8` (completion projection). No source changed.

## What we learned

1. **The host is not who drives; it is who gets spawned.** Codex drove every MCP call and CLI command on host B, and every agent the lifecycle actually launched was Claude. A Codex-hosted Compose cannot move spend to the Codex pool until the phase dispatch itself is routable, which is gap G5 and is L-sized.
2. **Silent degradations hide inside phases that report complete.** The design phase was told to launch 2–3 explorer subagents and launched one or none; decompose declared T2 depends_on T1 and the fanout ran both at stage 0; triage flipped needs_verification from true to false without a word. None of these fail a contract check, so none would ever have shown up without diffing effects against intent.
3. **A bounded probe is not bounded if the command it probes is destructive.** compose start is a machine-wide singleton by PID file. "Run it for 20 seconds then stop it" kills the incumbent first. Briefs must classify start, update, upgrade, install and guard enrol as never-run, not as capped probes.
4. **Lifecycle state has two planes that disagree.** Compose's tracker MCP returned no pending gates while Stratum's flow had one at design_gate; the foreground runner then failed when the gate had already been resolved externally. Any headless or non-Claude driver hits this immediately.
5. **The outcome-enum mismatch is not a curiosity, it is a tax.** `outcome: "success"` against a contract of complete|skipped|failed forced a full extra Claude dispatch on both hosts in this session alone, and the learn harvester counts 23 occurrences across stratum and compose. It is the cheapest gap on the list (G6) and it costs money every day.
6. **The Stratum sandbox is the wrong place to measure host portability.** No network, no loopback: the measurement arms had to run as raw unsandboxed codex exec, and the report says so. Conversely the `flow` lineage parameter on stratum_agent_run is incompatible with background runs, so lineage lives in the ledger, not the run record.

## Open threads

- [ ] Owner decision: restart the compose supervisor on :4001 (killed during the host C arm).
- [ ] Owner decision on the report's recommendation: staged path (declare limits, fix G1–G4 and G6–G10, then a bounded Codex pilot) vs. Claude-only vs. full port.
- [ ] File G6 (outcome enum: widen the contract or fix the step instructions; check the steps first) as its own feature — the cheap ongoing cost.
- [ ] File G8 (supervisor ownership check before takeover) as its own feature.
- [ ] File G1/G4 (gate addressing + one lifecycle state plane) together; they overlap.
- [ ] Scratch project under the session scratchpad still holds a stale `active-build.json` marked running from the interrupted second host B flow; it is disposable.
- [ ] Host A (Claude Code) cells in the command matrix are marked reference, not re-measured; a future pass could measure them the same way.

---

*We asked whether Compose was portable and found out who it actually calls when nobody is looking: Claude, every time.*
