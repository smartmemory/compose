# COMP-HOST-PORTABILITY-1 — progress ledger

Started 2026-09-16. Stratum run `05e46af9-0d1e-4009-acce-65c7fc5672c7` (spec: `.stratum.yaml` here).
Scratch root: `/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/`
(briefs `*.brief.md`, run logs `*.run.log`, done markers `*.done`).

| Step | Dispatch | Model | Output | Status |
|---|---|---|---|---|
| static_inventory | stratum_agent_run `a8b078a6d916` (workspace-write, sandboxed) | sol/high | `audit/static-inventory.md` | DONE (94 findings; step_done accepted) |
| host_c_matrix | raw `codex exec` unsandboxed, cwd `hostaudit/hostc` | sol/high | `audit/host-c-matrix.md` | DONE (4 silent rows; lifecycle blocked at design_gate; INCIDENT: start probe killed the :4001 supervisor pid 78098) |
| host_b_lifecycle | raw `codex exec` unsandboxed, cwd `hostaudit/hostb` | sol/high | `audit/host-b-lifecycle.md` | DONE (11 findings; lifecycle FAILED loudly at review, unresumable; ~$14 Claude spend) |
| connector_diff | raw `codex exec` unsandboxed, cwd `hostaudit/conn` | sol/high | `audit/connector-diff.md` | DONE (20 findings; verdict REFUTED) |
| synthesize | pending the four above | astra/medium | `report.md` | DONE (14 rows; run `1122989a700a`; flow 05e46af9 completed 13:47Z) |

Dispatch tokens (stratum): static `bf48ab22-…`, hostc `e3dcdbb3-…`, hostb `feda49e2-…`, conn `10504bc1-…`.

## Decisions
- Measurement arms run OUTSIDE the Stratum codex sandbox (no network/loopback there) so the sandbox
  does not confound host B/C results. The `flow` lineage param on `stratum_agent_run` is incompatible
  with `background: true` (requires a foreground cancellationId), so lineage is recorded here instead.
- Host C/B commands run under an isolated `HOME` so `~/.claude` writes are observable and nothing
  touches the real home. Lifecycle `compose build` runs once with real HOME (real Claude auth, real
  cost) and once isolated, per the design's "run one real feature" criterion.
- Compose's other agent owns `ROADMAP.md` and two `audit.json` files in this tree; not ours, untouched.

## Early observation (to verify against the arms)
`compose build` dispatches via `@anthropic-ai/claude-agent-sdk` directly (`lib/local-claude-connector.js`),
so every host arm of `compose build` still spawns Claude agents. Whether that is loud when auth is
absent is exactly what host C/B measure.

## Incident 2026-09-16 (host C arm)
The Codex agent's bounded `compose start` probe took over :4001 from the pre-existing supervisor
(node pid 78098) and then shut its replacement down, leaving :4001 unbound. The brief said "do NOT
kill anything you did not start". Not restarted by the controller pending the owner's decision
(feedback_no_kill_ports). Note for the report: `compose start` on an occupied port REPLACES the
incumbent — itself a portability/operability finding to verify in source.
Verified in source: `server/supervisor.js:80-93` `killExistingSupervisor()` reads a PID file and
SIGTERMs whatever supervisor it names, so `compose start` from ANY project replaces the incumbent
(singleton by PID file, not by project). Feed into the report as an operability finding.
