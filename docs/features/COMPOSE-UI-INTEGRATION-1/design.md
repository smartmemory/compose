# COMPOSE-UI-INTEGRATION-1: Stratum and Cadence inside the Compose UI (design, one shape)

**Status:** DESIGN, not built, no units dispatched. Opus (`hard:`), 2026-10-29, for s1-chat (owner:
"make them able to be integrated into compose UI"). Contract: [read-model-contract.json](
read-model-contract.json).

## Related Documents

- Audits: [STRATUM-UI-AUDIT-1](../../../../stratum/docs/features/STRATUM-UI-AUDIT-1/audit.md),
  [CADENCE-UI-AUDIT-1](
  /Users/ruze/reg/my/SmartMemory/cadence/docs/features/CADENCE-UI-AUDIT-1/audit.md),
  [COMPOSE-UI-AUDIT-1](../COMPOSE-UI-AUDIT-1/audit.md),
  [COMPOSE-UI-STEAL-1](../COMPOSE-UI-STEAL-1/steal-list.md).
- Prior designs this builds on (cited per decision below): `OPS/docs/process/operating-process.md`
  §4, `OPS/units/OPS-EVENT-LOG-1/design.md` (owner pick B), COMP-COCKPIT-12, COMP-OBS-CONTRACT,
  SESSION-MGMT-1, cadence R31. `OPS/` = `/Users/ruze/reg/my/SmartMemory/smart-memory-ops`.

## The shape in plain English

**One live board in Compose, fed by small read-only "reporters", one per system.** Each reporter
is a command the owning system already ships or adds as a read verb (Stratum's `stratum query`,
Cadence's diary and snapshot). It prints records in one fixed shape. Compose runs each reporter on
a timer, keeps one picture in memory (the read model), and pushes each change to the browser.
Nobody changes how their records are written; the diary and Stratum's run files stay the truth.
Like a newsroom: every desk keeps its own notebook, and a runner copies new lines onto one wall.

- **Spine:** Compose's read model (one projection, `GET /api/ops/state`, WebSocket `opsEvent`)
  plus one record shape, `ops-event/1` (events) and `ops-snapshot/1` (current readings).
- **Plugins:** providers, one per data family, declared in `.compose/ops-providers.json`.
- **Adapters:** the read verbs each subsystem owns (`ev.py export`, `stratum query events`, ...).
  Translation from native records to the contract happens on the producer's side, in its language.
- **One-offs:** daemon heartbeats (read from log mtimes), the ledger tail (shown raw, never parsed).
- **Bottleneck:** sessions and seats are not events yet (no `session.*` kind), and Stratum step
  detail has no reader. Everything else already exists on disk.

## Prior shape decisions checked (shape-before-mapping step 2)

| Prior decision | Where | This design |
|---|---|---|
| One event log is the truth; "status pages and the Compose view are generated from it" | `OPS-EVENT-LOG-1/design.md:3` (owner pick B, 2026-10-25); `cadence/docs/ROADMAP.md:56` | follows: Compose is one more generated view of the diary |
| `ops-event/1` envelope, idempotent `event_id`, pointers only, no prose parsing, kill switch | `operating-process.md` §4b | follows; extended additively (`provider`, Stratum kinds, snapshots) |
| Push bridge daemon `ops_compose_bridge.py` POSTs to `POST /api/ops/events` | `operating-process.md` §4b, units COMPOSE-LIVE-INGEST-1, CADENCE-UI-BRIDGE-1 | **deviates: pull**, reasons below |
| Cadence must not depend on Compose or Stratum | `cadence/docs/features/CADENCE-OPS-REQ-1/design.md:168` (R31) | follows: Compose calls Cadence's readers, never the reverse |
| "Reuse the TUI's data readers. Do not write a second set of parsers in Node." | `COMP-COCKPIT-12/design.md` (Hard requirement) | follows: mapping lives in the producer's read verb, Compose only validates the contract |
| Only one Compose module spawns the Stratum CLI | `compose/server/stratum-client.js:4-6` | follows: Stratum providers go through it |
| Closed schema, region ownership in the Vision Surface | `docs/features/COMP-OBS-CONTRACT/design.md`, `layout.md:77-80` | follows: closed contract; new **Ops** view, does not touch regions ① ② |
| Stratum session door is the launch path; a Compose Sessions screen is "a later layer" | `stratum/docs/features/SESSION-MGMT-1/plan.md:1-3` | follows: v1 reads `stratum session fleet\|status --json`; no launch button before U13/U14 |
| Fleet reader = `sm_status.py --json` | `COMP-COCKPIT-12/design.md` | kept as fallback provider; primary per COMPOSE-UI-AUDIT-1 Q1(a) (owner question) |
| Live view "not before 2.0.0" | `operating-process.md:3` | **owner question 1**: tonight's ask may supersede it |

**Why pull, not the push bridge.** (1) The diary now exists and is the one log, so a bridge with
its own cursors and an ingest store would duplicate it. (2) Pull needs no new launchd daemon and no
new write route on a port (FILING BAR, `no-claude-coding.md`; smaller surface). (3) Two working
precedents: Compose already spawns `stratum query` (`stratum-client.js:304-316`) and the status
builder already runs a configured command per section (`OPS/status/configs/cadence-section.json`:
`command`, `timeout_s`, `kill_env`). (4) R31 holds either way. Kept from §4b: the envelope, the
state map, idempotency, pointer-only payloads, fail-visible, kill switch per provider.

## Record contract (summary; full text in `read-model-contract.json`)

- `ops-event/1`: `schema, event_id, ts, provider, source, source_ref, kind, object{type,id},
  feature_code, lane, repo, session, seat, actor, from_state, to_state, verdict, sha, payload_ref,
  extra`. `event_id = sha256(provider + source_ref)`.
- `ops-snapshot/1`: `schema, provider, ts, object, state, stale_after_s`; replaces the previous
  record for the same object. Used for seats, sessions, gate states, Cadence's "why waiting".
- Provider entry: `name, mode, command (argv), cursor_arg, interval_s, timeout_s, kill_env, cwd`.
- Read model objects: units, jobs, owner questions, sessions, seats, gate states, review batches,
  daemons, flows, steps, gates, agent runs, providers (each with `last_ok`, `last_error`).
- v1 writes nothing. Actions later go through the owners' writers (`owner_queue.py`, `stratum
  gate`, `stratum session launch`).

## Sources (existing producers unchanged)

| Provider | Mode | Command (adapter) | Reads (unchanged producer) | New? |
|---|---|---|---|---|
| cadence-diary | events | `python3 S/ev.py export --since <day:line> --schema ops-event/1` | `OPS/events/live/*.jsonl` (`S/ev.py:78-79`) | read verb |
| cadence-snapshot | snapshot | `python3 -m cadence status --json` (flag at `cadence/cli.py:560`; that `status` honours it is unverified) or read `~/.cadence/snapshot.json` | Cadence tick | exists / check |
| seats | snapshot | `python3 S/usage_watch.py status --json` | `~/.claude/usage/snapshots.jsonl` | exists |
| gate states | snapshot | `python3 S/launch_gate.py --status --json` | launch gate | exists |
| sessions | snapshot | `stratum session fleet --json`, `status --json`; fallback `sm_status.py --json` | session scripts (`stratum/ts/src/session/backend.ts:45`) | exists |
| review batches | snapshot | `python3 S/batch_review.py status` + new `--json` (verb at `batch_review.py:1978`, no `--json` today) | `OPS/batch/groups.json` | read flag |
| stratum-flows | events | `stratum query events --since <cursor>`, `query flow <id> --detail`, `query audit <id>` | `~/.stratum/ts/flows/*.json` | read verbs |
| stratum-agents | events | `stratum query agent-runs --since <cursor>` | `~/.stratum/ts/agent_runs/*/meta.json` | read verb |
| daemons | snapshot | Compose reads mtime + last line of `~/.claude/logs/<daemon>.log` per a list | launchd logs | one-off |

`S/` = `OPS/claude/scripts/`. "check" rows are verified by the unit that adds the provider.

## What must change, per subsystem

- **Stratum (read verbs only, engine untouched):** `query events --since`, `query flow --detail`
  (steps with status, attempts, last ensure/cert violation, spend), `query audit`, `query
  agent-runs`; same `_schema_version` discipline as `query_gate.ts:164-205`. Optional: SESSION-MGMT-1
  U3 (MCP session tools) is not needed by the cockpit.
- **Cadence / ops:** `ev.py export` (diary to `ops-event/1` with the fixed state table); typed diary
  kinds for sessions, deploys, owner decisions (existing unit CADENCE-UI-TYPED-1); a `--json` status
  read where missing. No writer changes, no Compose dependency (R31).
- **Compose:** provider runner (spawn argv, timeout, kill env, cursor, validate against the
  contract, `provider.error` on a bad line), read model, `GET /api/ops/state`, `GET
  /api/ops/events`, `opsEvent` on `/ws/vision`; an **Ops** view (belt, fleet strip, jobs, flows,
  "needs you" list); follow all Stratum flows, not only those bound to items
  (`stratum-sync.js:51,168`); mount or fold the orphaned `src/components/StratumPanel.jsx`.

## Units (shapes, in landing order; each lands something visible; no dates)

Prerequisite from the sibling audit: COMPOSE-UI-RUN-1 (registered ports, supervised start, live
walk). Without it nothing below is visible.

1. **COMPOSE-OPS-READMODEL-1 (M):** provider runner, registry file, read model, two GET routes,
   `opsEvent`, plus provider `cadence-diary` (`ev.py export`). Visible: a live Ops feed of unit,
   job and owner-question events. Supersedes COMPOSE-LIVE-INGEST-1 + CADENCE-UI-BRIDGE-1.
2. **COMPOSE-OPS-BELT-1 (M):** the belt board per lane, open owner asks with age, job list, from the
   read model. Visible: the board. Was COMPOSE-LIVE-PROJECTION-1 + BOARD-1.
3. **COMPOSE-OPS-FLEET-1 (M):** seat strip, sessions list, launch-gate state, "why waiting" chips
   (providers seats, sessions, gate states, cadence-snapshot). COMP-COCKPIT-12 re-scoped.
4. **STRAT-QUERY-EVENTS-1 (M):** Stratum read verbs `events`, `flow --detail`, `audit`, plus the
   `stratum-flows` provider. Visible: every flow with step progress and failed postconditions.
5. **STRAT-QUERY-AGENTS-1 (S):** `query agent-runs` plus provider. Visible: Codex/Claude runs in
   the job list, joined to their unit.
6. **COMPOSE-OPS-ATTENTION-1 (S):** one "needs you" list: Stratum gates (existing approve/revise
   routes, `stratum-api.js:45-67`) and owner asks (read-only), in the Ops Strip pills
   (`docs/cockpit.md:33`). Replaces the orphaned StratumPanel.
7. **CADENCE-UI-TYPED-1 (S, existing, re-pointed):** typed `session.*`, `deploy`, `owner.decision`
   diary kinds. Visible: sessions and deploys in the feed without parsing prose.
8. **COMPOSE-OPS-HEALTH-1 (S):** provider health plus daemon heartbeat badges and the review-batch
   counter. Visible: red badge when a daemon or provider goes stale (incident: land daemon silent
   25 h, operating-process D1).

Later, outside this list: COMPOSE-LIVE-ASKS-2WAY-1 (answer from the board), SESSION-MGMT-1
U13/U14 before any launch button, CADENCE-DAG-DISPATCH-1 and CADENCE-OUTAGE-STATE-1 as new kinds.

## What the Orca steal list supplies

From [steal-list.md](../COMPOSE-UI-STEAL-1/steal-list.md): row 3 (terminal pane + per-agent status
light) is the session row's detail view in unit 3; row 2 (diff line notes sent back as gate
"Revise") is the action half of unit 6; row 4 (launch catalog) must sit behind the Stratum session
door, not Orca's launcher. It supplies UI pieces, not data: units 1, 4, 5 and 7 have no Orca help.

## Questions for the owner

1. Does tonight's ask lift the "not before 2.0.0" hold on the live view (`operating-process.md:3`)?
   Recommend: yes for read-only units 1-3, the rest after 2.0.
2. Pull (reporters run by Compose, recommended) or the push bridge daemon of §4b?
3. Sessions reader: `stratum session` JSON (recommended, contracted) or `sm_status.py` only (same
   as COMPOSE-UI-AUDIT-1 question 1).

## ELI5 TLDR

Three systems each keep their own notebook: Compose (features), Stratum (step-by-step checks) and
Cadence (tickets, jobs, accounts). **They can share one screen without rewriting any notebook: each
gets a small "read it out" command, and Compose copies the lines onto one live wall.** Most of the
information is already written down; the gaps are a few missing read commands and a few facts still
written only as sentences. Your call: lift the "after 2.0" hold for the read-only first three steps,
and confirm Compose should pull the news rather than have a new background program push it.
