# Changelog

## 2026-06-11

### Added — COMP-MOBILE-REMOTE: remote transport + auth for the mobile PWA

The mobile cockpit is now reachable from outside localhost through a BYO tunnel, with first-class server auth and QR pairing. Five slices:

- **Server auth core.** `server/auth-store.js` (HS256 JWTs hand-assembled on `node:crypto` — fixed header, `timingSafeEqual`, no algorithm negotiation; device store with atomic writes; 5-minute single-use pairing codes; refresh rotation with a 5-deep history ring and reuse-detection device revoke; JSONL audit log), `auth-middleware.js` (default-deny gate, `requireSensitiveOrPaired` composite, in-house per-IP rate limiter), `auth-routes.js` (pair init/status/complete, refresh, devices list/revoke, rotate-secret).
- **Opt-in remote bind.** `COMPOSE_HOST`/`compose start --host=` — non-localhost refuses to start without `COMPOSE_REMOTE_AUTH=enabled`. In remote mode the gate is credential-only: **loopback is not trusted** (tunnel daemons connect from 127.0.0.1). WS upgrades and the two SSE stream paths take `?token=` (query auth is scoped to an explicit stream-path allowlist — a spoofed `Accept: text/event-stream` cannot authenticate arbitrary GETs). The API server now serves the built PWA (`dist/`, `/m/*` SPA fallback) and proxies agent-server traffic (`/api/agent/proxy/*`, server-side token injection, SSE pass-through) so a tunnel exposes one port. Remote-off is behaviorally unchanged (gate never mounts).
- **CLI.** `compose remote pair|list|revoke|status|rotate-secret` (QR in terminal, status polling, https-aware reachability probe).
- **Cockpit.** "Pair mobile" modal — QR + pair URL (server-composed from the configured `remote.public_host`), live `devicePaired` updates, device revoke.
- **Client.** `wsFetch` is auth-aware (cockpit/mobile-paired modes, 401 ladder keyed on gate body codes, refresh-retry-once); `/m/pair` page (QR code flow + codeless re-pair screen); dual-mode boot — paired mode only when a refresh token exists, the legacy `?token=` flow is byte-identical otherwise; shared `wsUrl.js` WS/SSE URL builders; `createReconnectingWS` accepts function URLs; four mobile hooks' duplicate reconnect loops replaced by the shared helper (−120 LOC); desktop detects remote mode via `/api/health` and switches WS/SSE/agent calls to the authenticated proxy.
- **Fixes folded in:** mobile agent-stop 404 (`AgentCard`/`AgentDetailView` targeted the wrong port since COMP-MOBILE — route lives on 4001); `compose remote status` https probe. Found-and-filed: ChallengeModal's Discuss posts to a route that exists on no server (COMP-COCKPIT-11).
- Gates: design 7 Codex rounds / 10 findings (incl. the tunnel-loopback trust blocker), blueprint 3 rounds / 5, implementation 2 rounds / 5 (one dispositioned as pre-existing), coverage sweep +39 regression locks. Tests: node suite 3344→3677, vitest 342→421. New deps: `qrcode`, `qrcode-terminal`.

### Fixed — COMP-MOBILE-1-1: health-gate downgrades now reach buildState; history records carry per-step results

Backend follow-ups from COMP-MOBILE-1. (1) When the COMP-HEALTH gate downgrades a finished build to failed, the downgrade is now re-persisted to `active-build.json` (new `persistHealthGateDowngrade`, identity-guarded by flowId/featureCode so a concurrent build's last-writer-wins state is never clobbered), which makes the server's file watcher re-broadcast `buildState` with the real outcome; the health reason also threads into the history record's `failureReason` instead of a generic "Build failed". (2) `build-history.jsonl` records gain compact per-step results (`projectHistorySteps`; the outcome→status mapping is now shared with `syncStepHistory` via `stepOutcomeToStatus`; summaries kept only for failed steps), enabling which-step-failed on historical builds — mobile `BuildHistoryList` renders them in expanded rows. Mobile's `useBuildHistory` tracks rebroadcast status changes per flowId so the corrective "post-checks" alert no longer false-fires now that the live state tells the truth.

### Added — COMP-MOBILE-1: mobile monitoring-loop completeness

The mobile PWA can now complete its core monitoring journeys end-to-end (alerted → inspect → act), closing the P1 cluster from the 2026-06-10 mobile parity sweep. UI-only; every endpoint already existed.

- **Badges + alert bar.** BottomNav shows a pending-gate count on Agents and failed/gate-pending dots on Builds; a new `MobileAlertBar` (shares the desktop `compose:notify` contract) surfaces gate-created, build-failed (sticky), and build-complete alerts via `useMonitorEvents`, with tap-to-navigate. Monitoring hooks (`usePendingGates`/`useActiveBuild`/`useRoadmapItems`) lifted to the shell so badge state survives tab switches.
- **Build step breakdown.** `BuildDetailView` gains a Steps/Log toggle; `BuildStepsList` renders the merged pipeline (template + live status + active step from `currentStepId`), grouped by phase with done-run collapsing. The desktop `PipelineView` merge block was extracted to a shared `src/lib/pipeline-steps.js` (`PIPELINE_STEPS`, `mergePipelineSteps`, `isGatePending`, `isTerminalBuildStatus`) consumed by both surfaces.
- **Build history.** `useBuildHistory` + `BuildHistoryList` on the Builds tab (`GET /api/builds`), with a 2.5s flowId-matched retry for the history-append race and a corrective "Build failed post-checks" alert when the health gate downgrades a build after its terminal `buildState` broadcast.
- **Roadmap mutations.** Create (FAB → `CreateItemSheet`), delete (two-tap confirm), and connections (list/add/remove with the required server type enum) from the Roadmap tab; all roadmap mutations now send `x-compose-token`.
- **Fixes folded in:** `useRoadmapItems` WS handler now consumes the server's actual `visionState`/`hydrate` snapshot broadcasts (old granular types were dead code) while preserving in-flight optimistic edits/creates/deletes; `ItemDetailSheet` status options drop the server-invalid `partial` (adds `ready`/`review`) and confidence is corrected to the server's 0–4 range; stale mobile `isTerminal` helpers (missing `complete`) replaced with the shared predicate; three AGENT_PORT re-declarations replaced with shared `agentServerUrl()` (COMP-COCKPIT-2 drift class).
- Tests: +120 net new assertions (vitest 209→329 across pipeline-steps, notifications, builds, roadmap, coverage-sweep suites).

### Added — COMP-COCKPIT Wave 2: UX journey gaps (COCKPIT-7/8/9/10)

- **COMP-COCKPIT-7 — failed-build retry.** Past Builds records with status failed/aborted get a Retry button dispatching the recorded `featureCode`+`mode` through a new shared `startBuild()` helper (also adopted by StartBuildPopover); the per-feature 409 surfaces as a warning toast.
- **COMP-COCKPIT-8 — cross-view entity links.** New `EntityLink` + `NavigationContext` primitive: feature codes, gate ids, and item refs become navigable links. `openGate()` deep-links clear both gate-hiding filters (phase, feature-focus) and scroll-highlight the target in GateView; unresolvable targets degrade to plain text via `canNavigate`. Wired: ItemDetailPanel pending gates, ContextPanel summary gates, OpenLoopsPanel parent feature, Dashboard session codes; the attention queue's "+N more" expands in place (its old target view never existed).
- **COMP-COCKPIT-9 — journal & changelog surface.** `GET/POST /api/journal` and `GET /api/changelog` as thin adapters over the existing writer libs (numeric limit clamp, `?feature` key normalization, token-gated write with slug-collision retry on the writer's `idempotent` signal, `INVALID_INPUT`→400), plus a JournalView tab: source toggle, feature filter, sections through MarkdownViewer, journal-only write form carrying `feature_code`, stale-fetch race guards.

### Changed — COMP-COCKPIT-10: orphaned routes wire-or-remove

- Deleted `GET /api/vision/blocked`, `POST /api/vision/ui`, `POST /api/plan/parse` (zero callers anywhere; blocked-state is already computed client-side).
- Wired roadmap-graph export into the GraphView toolbar (open HTML / save to `docs/roadmap-graph.html`); the save route now requires the sensitive token (it writes to the project filesystem).

## 2026-06-10

### Changed — pre-push hook: docs-only pushes skip the full-suite test gate

The pre-push template ran `npm test` on every push regardless of content, so a roadmap/changelog-only push paid for the whole suite. The hook now parses git's stdin ref lines (before anything else consumes stdin) and skips the test gate when every pushed commit touches only `docs/**` or `*.md`. Detection fails CLOSED — ref deletes are ignored, but new branches (zero remote sha), diff failures, and empty stdin all run the gate; the `compose validate` advisory drift check still runs unconditionally (docs are exactly what it validates). Template change only (`bin/git-hooks/pre-push.template`); reinstall with `compose hooks install --pre-push` to pick it up. 4 new tests execute the installed hook against a red-suite fixture to assert skip vs fail-closed from the exit code.

### Added — COMP-MIGRATE-ON-UPGRADE: versioned feature.json state migration on upgrade

`compose upgrade` refreshed code but ran no `feature.json` state migration, so cold data (legacy free-text `complexity`) sat erroring on every validate. New `lib/state-migrations.js` provides a versioned, eager, idempotent runner (`runStateMigrations`) with an ordered registry of pure/total transforms and a durable stamp at `.compose/data/migration-state.json` (atomic temp+rename; deliberately not in `compose.json`). v1 migration `normalize-complexity` maps legacy free-text complexity to the `S/M/L/XL` enum (`low→S, medium→M, high→L, xl→XL`), leaving valid enum/number untouched and dropping null/unmappable. Convergent (corrupt files reported, not a permanent block); local-provider only; narrative-safe. Wired into `runInit` and `runUpdate` (resolved-cwd threaded), plus a new explicit `compose migrate-state [--dry-run]` verb (distinct from `compose roadmap migrate`). Cleared the 12 live `FEATURE_JSON_SCHEMA_VIOLATION` errors at forge-top.

### Fixed — `compose init`/`upgrade` silently dropped unknown compose.json keys

`runInit` rebuilt `.compose/compose.json` from a fixed `{version,capabilities,agents,paths}` shape, dropping any other top-level key — so an upgrade would wipe `roadmap.narrative` and `tracker` config. It now spreads `...existing` before rebuilding the known sections (regression test in `test/init.test.js`). A corrupt prior `compose.json` is detected and the state-migration step is skipped with a warning rather than running against the normalized rewrite.

### COMP-MCP-ROADMAP-READ-1 — get_roadmap gains a general filtered rows[] + limit so /roadmap next reads PLANNED structured

Follow-up to COMP-MCP-ROADMAP-READ. The shipped tool exposed PLANNED only as a count and the active/blocked lists are fixed-status, so /roadmap's "what to work on next" had to fall back to markdown re-parsing. get_roadmap now returns a general filtered rows list when a status/phase filter or limit is supplied.

**Added:**
- `get_roadmap` `limit` input (default 50; finite values floored and clamped ≥ 0).
- `rows` / `rowsTotal` / `rowsTruncated` output — emitted when status/phase/limit is supplied: named rows matching the status+phase filter (`_anon_` excluded), capped at limit. No-filter summary call stays token-safe (rows omitted).

**Changed:**
- `/roadmap` skill `next` path — now calls `get_roadmap({status:"PLANNED", limit:10})` and reads `rows` instead of re-parsing the markdown table.
- `get_roadmap` MCP schema — `limit` declared integer/minimum:0.

## 2026-06-09

### Fixed — `compose doctor` false-negative on plugin-provided bare-name skills

`checkExternalSkills` (`lib/deps.js`) matched a bare manifest dep id (e.g. `refactor`, `update-docs`) only against `~/.claude/skills/<id>/`, while plugin-provided skills were recorded namespaced (`coder-config:refactor`). Claude Code surfaces those plugin skills under their bare names, so doctor wrongly reported them missing. A bare dep is now satisfied by a user skill at that path **or** any plugin skill whose leaf name matches; namespaced deps still require an exact `<plugin>:<skill>` match (no loosening). Result: `compose doctor` reports `All 12 deps present`. Updated the bare-vs-namespaced matching test to assert the corrected semantics plus a true-negative guard.

### COMP-MCP-ROADMAP-READ — read-only get_roadmap MCP primitive closes the roadmap read-side gap

Adds `get_roadmap`, a read-only MCP tool that returns the roadmap rendered from canon (feature.json) without writing, plus a staleness flag vs on-disk ROADMAP.md. Closes the gap that forced every reader — including the `/roadmap` skill — to read ROADMAP.md directly (a rendered artifact that can drift from canon on feature.json-backed workspaces).

**Added:**
- `lib/get-roadmap.js` — pure `getRoadmap(root, opts)`: renders via generateRoadmap (no write), reads narrative-owned workspaces verbatim, reuses parseRoadmap for rows, reports stale/drift vs on-disk ROADMAP.md (stripping the volatile `**Last updated:**` line), defaults to token-safe `summary` format.
- `get_roadmap` MCP tool — registered in compose-mcp.js, dispatched, and added to the reviewer read-only allowlist.
- `test/get-roadmap.test.js` — 11 tests: rendered/narrative source, no-write (mtime), drift detection, Last-updated normalization, status/phase filters, format, token-size, anonymous-row exclusion.

**Changed:**
- `/roadmap` skill (`~/.claude/skills/roadmap/SKILL.md`) — new step 0 prefers `get_roadmap` when a compose MCP server is connected; surfaces `stale` drift; falls back to file-read otherwise.

## 2026-06-07

### Added — COMP-COCKPIT Slice A: cockpit action feedback, native-dialog replacement, hostname portability, gate-kill guardrail

Closes the correctness/foundation gaps from the 2026-06-07 cockpit UX sweep ({COCKPIT-2, COCKPIT-1, COCKPIT-6}; Slice B {COCKPIT-4,5,3} deferred). A UI-first user no longer hits silent failures, blocking native dialogs, a broken-off-localhost pressure test, or an unguarded one-click gate kill.

- **Shared primitives.** `src/lib/agentServer.js` — `agentServerUrl(path)` builds the agent-server URL from the page hostname + `VITE_AGENT_PORT` (default 4002); `defaultAgentStreamUrl()` now delegates to it. `src/components/ui/DialogProvider.jsx` — a promise-based replacement for `window.confirm`/`prompt` exposing `useConfirm` / `usePrompt` / `useConfirmWithReason`, mounted app-root in `main.jsx`. Degrades to native dialogs if unmounted; reentrancy-safe (a second open settles the prior caller).
- **COCKPIT-2** — `ChallengeModal` no longer hardcodes `localhost:4001/4002`: agent spawn/status use relative `wsFetch` (proxied to 4001), terminal-inject uses `agentServerUrl` (4002), and failures surface a toast.
- **COCKPIT-1** — `notify()` now fires on the previously-silent action sites (`PipelineView` approve/reject, `TemplateSelector` draft, `DocsView` save, `OpenLoopsPanel` resolve, `ItemDetailPanel` kill, `App` stop-agent) on **both** transport and non-ok paths; four blocking `window.prompt`/`confirm` (DesignView, OpenLoopsPanel, ItemDetailPanel delete, SettingsPanel reset) replaced with in-app modals.
- **COCKPIT-6** — killing a gate from the Dashboard now requires a reason via `confirmWithReason`, matching `GateView`/`ItemDetailPanel` (no more instant no-undo kills).
- **Tests:** 16 new Vitest tests in `test/ui/` (agent-server, dialog-provider incl. reentrancy, challenge-modal-host, cockpit-feedback, dashboard-kill-guardrail). Full UI suite 161 + tracker 100 green; `npm run build` OK; Codex design + plan + impl reviews all CLEAN. `docs/features/COMP-COCKPIT/`.

### Fixed — BUG-26: `roadmap generate` emitted a duplicate `## Features` section for phase-less features

Features whose `feature.json` had no `phase` were collected into an `ungrouped` bucket and emitted via a hardcoded `renderPhase('Features', …)`. When the source `ROADMAP.md` already carried a curated `## Features` section, the generator emitted **both** — two identical headings that re-split on every regen and that `roadmap check` masked as a "lossless fixed point" (hand-merging never survived the next `generate`).

- **`lib/roadmap-gen.js`** — phase-less features now fall into the conventional `Features` phase key (the same identity a `## Features` source section parses to), so they **merge** into one section via the normal phase loop instead of double-emitting. Removed the separate ungrouped-bucket render.
- **`lib/feature-validator.js`** — new project-level **`DUPLICATE_PHASE_HEADING`** warning (one per duplicated `## ` title) so a checked-in, never-regenerated duplicate can't silently hide again.
- **Workaround applied to this repo's ROADMAP:** backfilled `phase: "Features"` + sequential `position` on 7 phase-less features (`COMP-CLI-GLOBAL-FLAGS`, `COMP-MOBILE`, `COMP-MOBILE-REMOTE`, `COMP-WORKSPACE-{HTTP,ID,RESUME,WATCHERS}`), collapsing the roadmap to one stable `## Features` section (validate 482 → 475).
- **Tests:** `test/roadmap-ungrouped-features-merge.test.js` (5, BUG-26 convergence + idempotence) and 2 new `DUPLICATE_PHASE_HEADING` cases in `test/feature-validator.test.js`. Regression sweep green: 242 tests across roadmap + validate suites. `docs/bugs/BUG-26/`.

### Fixed — P0 port-default mismatch silently broke the headless CLI ↔ server ↔ MCP handoff

The API server starts on `4001` (`server/index.js`, supervisor), but `lib/resolve-port.js` and several callers still defaulted to the pre-`e139ec3` value `3001` (and `compose loops` to `3000`). In a default install with no `COMPOSE_PORT`/`PORT` set, every CLI server-probe, MCP lifecycle call (`complete_feature`/`approve_gate`/`bind_session`/`compose_resume`), agent-hook event POST, and `compose loops` call hit a dead port — so gate delegation silently fell back to a readline prompt, completions/loops failed with `ECONNREFUSED`, and MCP lifecycle tools threw "Compose server unreachable" while the cockpit was alive on 4001.

- **`lib/resolve-port.js`** default `3001 → 4001` (the single source of truth; now matches `server/index.js`).
- **`server/compose-mcp-tools.js`** (`_getComposeApi`, `_httpRequest`) and **`server/agent-hooks.js`** now route through `resolvePort()` instead of duplicating a stale `|| 3001` literal.
- **`compose loops`** (`bin/compose.js`) default URL `http://localhost:3000 → http://127.0.0.1:${resolvePort()}`.
- Stale comments fixed in `server/supervisor.js` (4001/4002/5195) and `server/agent-server.js`; stale port docs fixed in `docs/cockpit.md` (UI is `:5195`), `docs/cli.md` (loops), `docs/e2e-checklist.md` (`:4001`).
- Corrected `test/integration/vision-unification.test.js` which had asserted the buggy `3001` default. Relevant-surface suite green (242 tests across resolve-port/probe/loops/mcp-tools/vision).

### COMP-ROADMAP-XREF-PUSH-2 — xref-push deferred extensions (MCP tool · local push · additive relabel)

The three pieces `COMP-ROADMAP-XREF-PUSH` deferred, same safety posture (dry-run default, per-ref `push:true` opt-in, degrade-never-write):

- **`roadmap_xref_push` MCP tool** — programmatic push surface (`{ project?, apply? }`), dry-run by default, returns the small `{pushed, skipped, unchanged, scanned}` summary.
- **`local`-provider push** — a `local` push-opted link writes the **sibling repo's** feature status to match `expect`, by delegating to the sibling's own `setFeatureStatus` (so its transition policy + ROADMAP roundtrip apply). Never `force`/`derived`; a disallowed transition or containment-escape token degrades to a skip. The shared containment guard is now extracted to `lib/xref-local.js` `resolveSiblingRoot` and used by both Pull and Push.
- **Additive relabel via `expect_labels`** — a new github-only carrier field: push adds any missing labels and **never removes** ones a human added (PATCHes the full `union(current, expect_labels)`, not the subset). Current labels are normalized from GitHub's label objects to names; case-sensitive; best-effort under concurrency (read-modify-write, no ETag). A single github link reconciles state + labels in **one** PATCH.

**Added:** `lib/xref-local.js`; `planLabels` + provider dispatch in `lib/xref-push.js`; `expect_labels` carrier (schema github-scoped with `expect_labels:false` on local/url, writer validate+preserve+reject-non-github); `roadmap_xref_push` MCP tool (3 sites). ~30 new tests (planLabels/resolveSiblingRoot pure, github-labels golden incl. union-not-subset, local-push golden via real temp sibling, MCP, carrier/schema). Reviewed to CLEAN (design 1 round, blueprint 2 rounds, impl 1 round). Full suite: node 3594 / tracker 100 / UI 146. `docs/features/COMP-ROADMAP-XREF-PUSH-2/`.

### COMP-ROADMAP-XREF-PUSH — write-side counterpart to xref-sync (Pull → Push)

The deferred "push" half of `COMP-ROADMAP-XREF-SYNC`. Pull rewrites the local citation's `expect=` to match external reality; **Push writes the external GitHub tracker to match the locally-declared `expect=` intent** (e.g. close an issue when the repo says it should be closed). Because it mutates a system outside the repo, the safety posture is deliberately conservative:

- **Dry-run by default** — `compose roadmap xref-push` prints what it *would* write; `--apply` is required to mutate.
- **Per-ref opt-in** — only external links carrying `"push": true` in `feature.json` are eligible; nothing is touched without the marker, even under `--apply`.
- **Degrade = never write** — offline / no-token / 404 / rate-limit / non-2xx PATCH / unparseable state → reported skipped, never guessed (mirrors xref-sync's resolver).
- **Idempotent** — reads current state first; if the issue already matches `expect`, no PATCH is issued.
- **Never writes a PR** — GitHub's Issues API treats pull requests as issues, so a PR-backed ref (`body.pull_request`) is skipped, never state-flipped.
- **github only (v1)** — `expect` must be `open|closed`; `local`/`url`/reserved providers are untouched. `expect=` (not feature status) is the explicit per-ref intent.

**Cross-feature contract:** Pull now skips `push:true` links (they're write-managed) so the two never oscillate and the declared intent is never clobbered.

**Added:** `lib/xref-push.js` (pure `planPush` + orchestrator `pushExternalRefs` + exported `defaultResolve`/`defaultWrite` with injectable transport), `GitHubApi.updateIssueResult` (status-returning PATCH so a failed write degrades, never falsely succeeds), `"push"` boolean on external links (schema + typed writer preservation), `compose roadmap xref-push [--apply]` CLI. 23 new tests incl. real-path degrade coverage (PR-skip, 404, no-token, non-2xx) via stubbed transport; Codex 4 rounds → CLEAN. `docs/features/COMP-ROADMAP-XREF-PUSH/`.

### COMP-CTXBUDGET-1-2 — context-budget is now progressive-disclosure-aware

The audit now reports **two numbers per component**: `surface` (full file on disk) and `live` (what actually loads at session start). Claude Code lazy-loads skills/agents — only their `name`+`description` frontmatter loads until invoked — so the prior single number massively over-stated reclaimable context (Forge: ~70.5K "reclaimable" was really **~5.0K live**; deleting the catalog would reclaim descriptions, not bodies, for ~nothing). Now:

- **skills / agents** → `liveTokens` counts only the `name`+`description` fields (robust to extra frontmatter keys; falls back to the whole block only if neither is present).
- **rules / CLAUDE.md chain** → `live == surface` (inlined into the system prompt at startup).
- **MCP servers** → `live == surface` plus an `mcp-may-defer` flag (tool-deferral harnesses like ToolSearch load schemas on demand, so treat as an upper bound).
- **TOP RECLAIMS ranked by live tokens** (what you actually get back); report shows both totals; `buildReport` defaults a missing `liveTokens` conservatively to surface. SKILL.md documents surface-vs-live and the "don't mass-delete lazy-loaded skills" trap.

19→27 `node:test` tests; Codex 2 rounds → CLEAN. Surfaced by dogfooding COMP-CTXBUDGET-1. `docs/features/COMP-CTXBUDGET-1-2/`.

### CLI — `compose sync` alias for `setup`

Added `sync` as an alias for `compose setup` (both run `runSetup` — mirror compose-owned skills into the agent skill dirs + register stratum-mcp). `sync` better signals the idempotent "reconcile local skills with this install" job you run after editing skills locally, when there's no new version to `compose update` to. Help text and `docs/cli.md` updated.

### COMP-CTXBUDGET-1-1 — bound the test suite with `--test-timeout`

Added `--test-timeout=120000` to every bare `node --test` script (`test`, `test:integration`, `test:wave-6`). Previously the scripts omitted a per-test timeout and node's `--test` has no default, so a starved/flaky integration test (`test/proof-run.test.js` — a real ~25s stratum pipeline, the suite's slowest test) could hang the full suite **forever** under parallel load instead of failing — observed as a 1h+ hang during COMP-CTXBUDGET-1, and a hang risk for the pre-push hook (which hard-gates on bare `npm test`). A starved test now fails loudly at 120s. `test:ui`/`test:tracker` are vitest (own timeouts) — unchanged. Surfaced by COMP-CTXBUDGET-1. `docs/features/COMP-CTXBUDGET-1-1/`.

### COMP-ROADMAP-GRAPH-1 — Generated roadmap dependency graph (compose substrate) — v1 (generator core + CLI + MCP)

A generic, deterministic roadmap dependency-graph generator that any compose-using project inherits for free. Walks `docs/features/*/`, derives nodes from feature.json status/phase (ROADMAP.md fallback for unregistered features, feature.json wins), edges from per-folder `deps.yaml`, and display metadata from design.md frontmatter or feature.json keys. Drops COMPLETE/SUPERSEDED/KILLED nodes and **refuses to emit** when any edge points at an unknown feature — killing the dangling-edge Cytoscape-crash bug class that recurred in hand-maintained graphs. Output is byte-identical on re-run (no wall-clock), so `--check` is a reliable CI/pre-commit gate. Ships v1 narrow (P1+P2); enforcement templates (COMP-ROADMAP-GRAPH-1-1) and forge-top dogfood/adoption (COMP-ROADMAP-GRAPH-1-2) are filed follow-ups.

**Added:**
- `compose roadmap graph [--out <html>] [--project <path>] [--check]` CLI subcommand
- `roadmap_graph` / `roadmap_graph_check` MCP tools (small summaries only — never the HTML body; check tool is reviewer-allowlisted)
- `lib/roadmap-graph/` generator core (collect → model → render) + packaged Cytoscape/dagre template with `@generated:*` sentinel regions
- `contracts/roadmap-deps.schema.json` + `contracts/roadmap-graph-frontmatter.schema.json`
- 27 unit + integration tests

**Changed:**
- External-prefix codes (cross-project refs) are treated as known-but-unrendered so edges to them never dangle

### COMP-ROADMAP-GRAPH-1-1 — Roadmap-graph enforcement: reusable opt-in pre-push gate + CI snippet; --check is the hand-edit lint

Ships the enforcement layer for the roadmap dependency graph. A reusable, source-safe pre-push hook template and a copy-paste GitHub Actions snippet let any compose project guard the graph. The gate is opt-in by graph-file presence (no-op until a graph is generated) and blocks on dangling edges (the Cytoscape-crash bug class) or a stale/hand-edited graph. `compose roadmap graph --check` regenerates and byte-compares the whole file, so it subsumes the proposed sentinel-only hand-edit lint — no separate lint script needed.

**Added:**
- `templates/hooks/roadmap-graph-pre-push.sh` — source-safe (`roadmap_graph_gate` fn) opt-in pre-push gate; standalone or sourced
- `templates/ci/roadmap-graph.yml` — reusable CI snippet (Mode A committed-graph `--check`; Mode B artifact-only generate)
- `test/integration/roadmap-graph-hook.test.js` — executes the hook (opt-in skip, fresh ok, stale/dangling block, source-safety)

### COMP-ROADMAP-GRAPH-1-2 — Roadmap-graph dogfood: compose CI workflow + adoption howto; seeded real deps.yaml edges

Dogfoods the roadmap-graph generator on the compose project itself and documents adoption. A CI workflow regenerates compose's own graph fresh on relevant changes, fails on any dangling edge, and uploads the HTML as a build artifact — the graph is deliberately NOT committed because compose's feature statuses churn too often for a committed graph to stay fresh (it would block every status-flip push). Seeding real deps.yaml on the two follow-ups gives the live graph its first edges (3: two depends_on + one concurrent_with), exercising the deps.yaml path end to end. Deviation from the original spec: the literal plan named forge-top as the first consumer, but forge's root is not a git repo, so compose-self is the committable, CI-gated dogfood target.

**Added:**
- `.github/workflows/roadmap-graph.yml` — compose dogfood: fresh regen + fail-on-dangling + artifact upload (path-filtered, incl. .compose/compose.json)
- `docs/howto/roadmap-graph.md` — adoption recipe (deps.yaml, frontmatter, config, CLI/MCP, both enforcement modes)
- `docs/features/COMP-ROADMAP-GRAPH-1-{1,2}/deps.yaml` — first real edges in compose's own graph

## 2026-06-06

### COMP-CTXBUDGET-1 — `/context-budget` skill: token audit across the loaded surface

New read-only `/context-budget` skill that audits the session-start loaded surface — agents, skills, rules, MCP server tool schemas, and the CLAUDE.md chain — estimates per-component token cost, classifies each into **always / sometimes / rarely needed** (with an explaining reason), and prints a ranked cut list with estimated reclaim. Heuristics are guides surfaced *with their reason*; cuts are never auto-applied (the user reviews and decides). Promoted from `IDEA-5` (ECC competitive scan).

- **`lib/context-budget.js` (new)** — pure ESM core: `estimateTokens` (dependency-free ~4-chars/token heuristic, pluggable; relative budgeting, not billing-accurate), `scanSurface`, `dedupeSkills` (content-hash dedup across `compose/.claude/skills/` vs `~/.claude/skills/`, dup zeroed so totals don't double-count), `nameReferenced` (word-boundary, hyphen/space-tolerant — `compose` matches "compose skill" but not "decompose"), `classifyComponent`, `buildReport`, `auditContextBudget`, plus a CLI guard (`node lib/context-budget.js <root> --tool-counts=compose=46,…`). MCP tool counts aren't on disk → caller-supplied; missing/invalid counts flag `tool-count-unknown` and are excluded from totals (no fabrication).
- **`.claude/skills/context-budget/SKILL.md` (new)** — thin wrapper: gather live tool counts → run the module → interpret buckets + flags (`duplicate`, `wraps-simple-cli`, `over-N-lines`).
- **Forge baseline captured:** ~107.8K loaded tokens; ~55.5K reclaimable (agent/skill catalog); the compose+stratum MCP schemas (~45K) are load-bearing and kept. `docs/features/COMP-CTXBUDGET-1/report.md`.
- 19 new `node:test` tests (real temp-FS fixtures); full node suite green (3339). Codex review 3 rounds → CLEAN (caught a negative-count library-API gap the CLI guard masked, locked with a test). `docs/features/COMP-CTXBUDGET-1/`.

### COMP-MCP-VALIDATE-4 — fix validator escaped-pipe column-parse false positives

`compose validate` was emitting false `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON` / `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE` / `ROADMAP_ROW_SCHEMA_VIOLATION` / `COMPLEXITY_OR_DESCRIPTION_DRIFT` warnings for ROADMAP rows whose status visually **agreed** with feature.json. Root cause: the validator split table cells with `split('|')`, which also splits on escaped `\|` (the markdown escape for a literal pipe). A description containing `\|` added a phantom column, shifting status-column detection so the validator read description prose as the row's "status" (e.g. `ROADMAP says "FLAG"`). Surfaced by COMP-MCP-VALIDATE-2 dogfooding (3 live rows: COMP-PARITY-1, COMP-CAPS-ENFORCE-4, COMP-ROADMAP-RT-GENFIX).

- **New exported `splitRoadmapCells(rawLine)` in `lib/roadmap-parser.js`** — the canonical escaped-pipe-aware row splitter (`/(?<!\\)\|/` + `\| → |` unescape), promoted from the parser's existing inline logic. Now used at **every** ROADMAP-row parse site: the read validator (`lib/feature-validator.js`) and `lib/feature-write-guard.js` (`scanRoadmapRows`), replacing the naive `rowMatch[1].split('|')`. Byte-identical to the old split for pipe-free rows.
- Live repo: the 3 false positives cleared (601 → 592 findings, 0 errors). Real status mismatches on `\|`-rows are still detected. Codex review CLEAN; full suite green (`node:test` 3471 + ui + tracker). `docs/features/COMP-MCP-VALIDATE-4/`.

### COMP-MCP-VALIDATE-2 — reconcile / `compose validate --fix` (closed-loop remediation)

Turns the detect-only cross-artifact validator into a **closed loop**. `compose validate --fix` (and `validate_project {fix:true}` over MCP) reconciles five mechanical drift classes through typed, audited writers — draining the validate backlog instead of hand-fixing JSON. **Dry-run by default**; `--apply` writes; **per-class opt-in** keeps destructive/heuristic classes off unless explicitly selected. Final slice of the **COMP-MCP-VALIDATE: Closed-Loop Hardening** umbrella (with −1 write-time validation and −3 vision-state projection, both shipped).

- **New `lib/feature-reconciler.js` — shared-context reconcile pass.** `reconcileProject(cwd, {apply, classes, scope, code, …})` reuses the validator's now-exported `loadValidationContext`/`loadFeatureContext` to rebuild the *same* `ctx` the detector builds — the **validator itself is unchanged in behavior** (pure detect-only). Status/ROADMAP classes dispatch on the validator's emitted findings (post-projection, narrative-suppressed); link/partial classes derive from `ctx`. Mirroring the detector's exact semantics is the convergence invariant.
- **Five fix classes.** *Default (non-destructive):* `dangling_link` → drop (per-feature single `rewriteLinks` so one bad link can't block another), `invalid_link_kind` → drop, `status_fj_vision` → reproject vision-state from canonical feature.json via `featureStatusToVisionStatus`. *Opt-in:* `partial_age` (PARTIAL→PLANNED, but only when there are no canonical docs **and** no `artifacts[]` **and** no CHANGELOG evidence), `roadmap_status_rewrite`, and `invalid_link_kind_repair` (edit-distance nearest-allowed).
- **Surgical ROADMAP-row edit (`setRoadmapRowStatus`).** A full `renderRoadmap()` regeneration was found to *corrupt* hand-authored ROADMAPs — it appends a generated section beside existing rows, leaving duplicate conflicting rows. Replaced with a column-aware single-cell edit that mirrors the validator's row parser, patches the **last** matching row (validator `Map` last-wins), requires an alpha status token, **refuses escaped-pipe rows**, preserves emphasis, and leaves every other byte untouched.
- **Safety rails.** v1 is **local-provider only** (`GitHubProvider` skips the local existence + narrative guarantees the fixes rely on — reconcile refuses on non-local). `featureJsonMode:false` drops feature.json-mutating classes. Guarded no-ops are reported as `noop` (never claimed as fixes); CLI/MCP **re-validate after `--apply`** so the exit/finding state reflects actual convergence. `writeFeature` hardened to an atomic temp+rename.
- **Surfaces.** CLI `--fix` / `--apply` / `--fix-class=CSV`; MCP `validate_project` gains `fix` / `apply` / `fix_classes`, returning the plan under `reconcile`.
- Codex design+blueprint+impl review CLEAN (impl loop caught: per-feature-link convergence, both-side status projection, dropped validate options, GitHub-provider divergence, ROADMAP regeneration corruption, duplicate-row last-wins, non-status-cell mangling, false-success on guarded no-ops — all fixed before ship). Full suite green: `node:test` 3483, ui 146, tracker 100. `docs/features/COMP-MCP-VALIDATE-2/`.

### chore(validate): clear the 5 blocking `compose validate` errors (roadmap-data hygiene)

Pre-existing data drift unrelated to any feature build, surfaced as advisory at pre-push. Brings `compose validate` to **0 errors** (warnings only).

- **3× `MISSING_DESIGN_ARTIFACT`** (COMP-TEAMS-2, COMP-TEAMS-3, COMP-AGENT-CAPS-4): each was mislabeled `PARTIAL` (no `design.md`) though its v1 slice had shipped — COMP-AGENT-CAPS-4 was completed under COMP-AGENT-CAPS-5 (`03ebfff`); COMP-TEAMS-2/3's v1 shipped with COMP-TEAMS v1 (`fd95a36`) via existing machinery (`no_file_conflicts` ensure / `claude:orchestrator` decompose), with their remaining scope deferred to named follow-ups in the descriptions. Reconciled to `COMPLETE` via evidence-bound `record_completion` against the real shipping commits.
- **`DANGLING_LINK_FEATURES_TARGET` + `XREF_TARGET_MISSING`** (COMP-ROADMAP-GRAPH-1): removed a stale structured `links` entry to `META-GRAPH-1` in repo `smart-memory` — consolidated away by the SmartMemory org migration, target resolvable nowhere, repo not a sibling under `forge/`. The provenance it carried is already preserved in the feature description prose.

### COMP-MCP-VALIDATE-3 — vision-state status projection from the canonical source of truth

Closes the **source** of `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE` and `STATUS_MISMATCH_FEATUREJSON_VS_VISION_STATE` by projecting feature.json status onto `vision-state.json` on every status mutation, plus a one-time back-projection of historical drift. Third slice of the **COMP-MCP-VALIDATE: Closed-Loop Hardening** umbrella; unblocks −2 (`validate --fix`), which consumes this canonical status projection. Status previously lived in three surfaces (ROADMAP.md, feature.json=canonical, vision-state.json) but the typed writers only synced ROADMAP+feature.json, so vision-state drifted as an orphan (e.g. COMP-GSD/COMP-GSD-3 read COMPLETE everywhere but `in_progress` in vision-state, indefinitely).

- **New `lib/status-projection.js`** — the single canonical `featureStatusToVisionStatus()` mapping (feature/ROADMAP UPPERCASE → vision lowercase; `PARTIAL→in_progress`, `SUPERSEDED→superseded`). Used on **write** (the `setFeatureStatus` projection + the migration) AND on **read** (the validator comparison), so a projected status can never itself trip a `*_VS_VISION_STATE` mismatch — one rule set, enforced on write and read (the COMP-MCP-VALIDATE-1 principle).
- **Write-time projection at one chokepoint** (`setFeatureStatus`, `lib/feature-writer.js`): after the canonical feature.json + ROADMAP write, best-effort project the new status into vision-state via the existing dual-dispatch `VisionWriter` (REST when the server is up → the in-memory store stays the single writer authority; atomic file write when down). One hook covers `set_feature_status`, `record_completion`, and lifecycle `start`/`advance`/`skip` (which previously updated `lifecycle.currentPhase` but never `item.status`). Best-effort: a vision-state failure never fails the canonical write. Runs only on a real transition (the `from===to` noop returns first). No recursion (the REST PATCH route updates the store only); idempotent same-value write on `kill`/`complete` which already self-sync. `build.js` self-syncs vision and is untouched.
- **Validator delegation** (`lib/feature-validator.js`): `projectToVisionStatus` now delegates to the shared helper (UPPERCASE-preserving, identity-fallback for `ready`/`review`). Proven finding-equivalent on the live corpus (632→632, 0 added / 0 removed before migration).
- **`superseded` blessed across status consumers** (D1): 2 features are SUPERSEDED (1 already `superseded` in vision-state), so `→killed` folding was rejected as mislabeling. Added to `VALID_STATUSES` (`server/vision-store.js` — schema already sanctioned it), `STATUS_COLORS`+`STATUSES` (`src/components/vision/constants.js`), and `STATUS_MAP` (`server/graph-export.js`, `→complete`). Preset filter buckets left unchanged — `superseded` is All-only, matching the existing `killed` convention.
- **One-time migration** (`scripts/backproject-vision-status.mjs`): idempotent, dry-run by default, `--apply` writes atomically; resolves the features dir via `loadFeaturesDir(cwd)` (respects `paths.features`); matches by `lifecycle.featureCode`; skips unbound/external items. Applied to the live project: **19 items reconciled** (incl. COMP-GSD/COMP-GSD-3 `in_progress→complete`, COMP-DEBUG-1 `→superseded`), driving `STATUS_MISMATCH_*_VS_VISION_STATE` from **38 → 0** (4 errors → 0).
- Codex design+blueprint+impl review CLEAN (blueprint pass caught: non-finding-equivalent lowercase rewrite, hardcoded features dir, unwired `superseded` consumers — all fixed before coding). Full suite green: `node:test` 3460, ui 146, tracker 100. `docs/features/COMP-MCP-VALIDATE-3/`.

### COMP-MCP-VALIDATE-1 — write-time feature.json link validation

Closes the **source** of `FEATURE_JSON_SCHEMA_VIOLATION` (link-kind) and `DANGLING_LINK_FEATURES_TARGET` by enforcing, at write time, the same rules the read validator (`validate_*`) applied only on read. First slice of the **COMP-MCP-VALIDATE: Closed-Loop Hardening** umbrella (−2 reconcile / −3 vision-state projection still PLANNED).

- **New `lib/feature-write-guard.js`** — a leaf module (imports only the Ajv `SchemaValidator` + the feature-code regex, so the graph stays acyclic) exporting `assertValidLinkShape` (link-shape via the canonical `contracts/feature-json.schema.json`), `assertLinkTargetsExist` (same-project target existence), `knownFeatureCodes` (folders ∪ ROADMAP ∪ vision-state union, mirroring the read validator), `scanRoadmapRows`, and `FeatureWriteValidationError`.
- **Chokepoint guard** (`writeFeature`, `lib/feature-json.js`): every funnel write (CLI, all three providers, xref-sync, migrate, build-raw, completion) now validates link shape + introduces-existence before `writeFileSync`. The existence check is **delta-aware** — it only validates links a write *introduces* (vs the on-disk `priorLinks`), so a legitimately forced forward-reference is durable across later status/completion/build writes while a genuinely-new dangling link on any raw write is still caught. The prior-read is skipped unless the payload carries same-project targets (the common write stays zero-I/O).
- **Typed `linkFeatures`** gives an early, friendly `DANGLING` error (after the source-exists guard; the no-op short-circuit precedes it so an idempotent retry of a forced link doesn't throw) and stamps a `forced_dangling` event marker so the one case `force` intentionally allows is auditable.
- **Bypass writers routed through the guard**: the vision-route group write-back (`server/feature-scan.js`, shape-only by design — group-only mutation can't introduce a dangling link) and both ideabox-promote paths (`server/ideabox-routes.js`, `bin/compose.js`) now go through `writeFeature`. The GitHub provider enforces link-shape on `create`/`put`/`persistRaw` too, making the guarantee uniform across backends.
- **Scope:** only `/links` violations are gated; `complexity`/`artifacts`/`additionalProperties` tightening stays deferred to `COMP-MCP-VALIDATE-SCHEMA-TIGHTEN` (per the schema's own field comments). `{ validate: false }` opt-out for migration/fixture-planting; `force` / `allowForwardRefs` for intentional forward-refs.
- Repaired the one shape-invalid corpus file (`COMP-ROADMAP-GRAPH-1` — added the missing `to_code` on its external-local link); a corpus-clean regression test guards against new ones. Codex impl-review CLEAN (3 rounds: GitHub-provider parity, idempotent-retry ordering, forward-ref durability). Full suite green: `node:test` 3455, ui 146, tracker 100. `docs/features/COMP-MCP-VALIDATE-1/`.

### feat(COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY): consumer-path parallel retry loop + mis-route fix + default-OFF gate opt-in

Closes the deferred D4/D5 of **COMP-PAR-MERGE-QUEUE-CONSUMER**: the consumer-dispatch path (`executeParallelDispatch`, the default for `compose build`) gains a bounded, bounce-injected **retry loop** (design model **C**), the pre-existing single-agent **mis-route** of a parallel `ensure_failed` is fixed for both outer loops, and `build.stratum.yaml` gets a **default-OFF** `pre_merge_gate` opt-in. No Stratum change.

- **Retry loop** (`executeParallelDispatch`, `lib/build.js`): each round re-runs ONLY the failed subset (`taskResults.filter(failed)` — covers gate-failed, schema_failed, and the merge-conflict loser); the round's successful diffs replay onto a throwaway per-round **anchor commit** (`buildAnchorCommit`, dangling commit-tree built through a temp index — base/HEAD untouched) so re-run tasks see prior good work; the real base is restored to an **entry snapshot** (`captureEntrySnapshot`/`restoreToSnapshot`, tracked + untracked via temp index) between rounds, so `applyTaskDiffsToBaseCwd` never double-applies a prior round's union. The union is applied to the base BEFORE `parallelDone` every round (today's order); a single terminal `build_step_done` fires after the terminal `parallelDone` (mirrors `executeParallelDispatchServer`). Retry is **gated on a guaranteed-clean base** (`entrySnapshot !== null`; a restore failure aborts the retry) and is **worktree-only** — `isolation: none` steps (the review lenses) are byte-identical to before (raw envelope, pre-feature emit ordering, no snapshot).
- **Bounce injection** (`lib/step-prompt.js` `formatBounceForPrompt`, ported from Stratum's `_format_bounce_for_prompt`): a re-run task's prompt carries the prior round's gate-failure / merge-conflict context, appended at the consumer-dispatch task-prompt hook.
- **Mis-route guard** (W4): `executeParallelDispatch` tags a cap-exhausted terminal `_parallelRetriesExhausted`; `isParallelRetriesExhausted` guards the `ensure_failed`/`schema_failed` branches of both `runBuild` and `executeChildFlow` so a failed parallel step terminates the build instead of being single-agent-retried (which cannot re-run parallel tasks). Keyed on the explicit marker, not a brittle `response.tasks` heuristic.
- **D5 opt-in** (default-OFF): `runBuild` resolves the gate via `resolvePreMergeGate` only when `capabilities.preMergeGate` is set, threads it through `startFresh` into `planInputs` ONLY when defined (key omitted, not `[]`, when off → byte-identical plan envelope); `build.stratum.yaml` gains a `pre_merge_gate` input + `execute.pre_merge_verify`.
- **Fix (parent-feature latent bug):** the per-task `.owner` worktree-ownership marker is now unstaged before diff capture — it was being captured into every task's diff, so multi-task consumer-dispatch merges conflicted on `.owner` in any repo not gitignoring it.
- Compose 3426 `node --test` green (new `test/par-merge-consumer-retry.test.js`, 17 tests covering every blueprint test-plan row); Codex impl-review CLEAN (4 rounds: cap source, `isolation:none` emit parity, snapshot-required-for-retry invariant). `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY/`.

### COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1 — fix unbound `response` ref in executeParallelDispatch review scaffold

Follow-up to **COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY**, surfaced by its golden integration test. Inside `executeParallelDispatch(dispatchResponse, ...)` (`lib/build.js`) the `if (isReview)` review-scaffold branch read `response.inputs?.task` / `response.inputs?.blueprint` — but `response` is unbound in that function; only `dispatchResponse` is in scope. The result was a latent `ReferenceError`, swallowed by the per-task try/catch, that silently failed any review/lens task reaching the scaffold on the consumer-dispatch path (the default for `compose build`). The two `startFresh` call sites (~1109 main, ~1734 retry) legitimately use `response` and are unchanged.

**Fixed:**
- `executeParallelDispatch` review-scaffold (`lib/build.js`): `response.inputs` → `dispatchResponse.inputs` for `taskDescription`/`blueprint`, so a consumer-path lens dispatch builds its review scaffold instead of throwing an unbound-reference error.
- Regression test (`test/par-merge-consumer-retry.test.js`, 'CONSUMER-RETRY-1'): drives an `isolation:none` lens dispatch with `dr.inputs={task,blueprint}` through the scaffold and asserts the task+blueprint thread into the dispatched prompt. The pre-existing `isolation:none` test never set `lens_name`/`review_mode`, so `isReview` stayed false and the bug stayed latent — this is the first test to exercise the scaffold on the consumer path.

**Snapshot:**
- Full suite green: 3429 `node --test` + 146 vitest UI + 100 vitest tracker. Codex review CLEAN (1 round). `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY-1/`.

## 2026-06-04

### chore(roadmap): reconcile COMP-PARITY-5/7 + COMP-DEBUG-1 status vs shipped COMP-MCP-ENFORCE

Roadmap-metadata reconciliation surfaced by a forge-top sync audit: three rows stayed `PLANNED` after their work shipped/was absorbed under **COMP-MCP-ENFORCE** (Slices 1–4, 2026-06-02). The ENFORCE `report.md` itself deferred the restatusing ("lands when the umbrella progresses") and it was never done. No code change — `feature.json` (canonical) + `ROADMAP.md` (render) kept in sync; `roadmap check` green (fixed point, lossless); `compose validate` error count unchanged (no new errors).

- **COMP-PARITY-7 → SUPERSEDED** — its one-way-sync gap was closed by ENFORCE Slice 2 (lifecycle-as-truth, `phaseToStatus`/`projectFeatureStatus`).
- **COMP-DEBUG-1 → SUPERSEDED** — re-filed as **COMP-MCP-ENFORCE-1** ("Was COMP-DEBUG-1"), shipped COMPLETE. `## COMP-DEBUG` phase heading → SUPERSEDED.
- **COMP-PARITY-5 → PLANNED (reduced scope)** — enforcement half absorbed by ENFORCE (guard verdict-gate + evidence-bound completion + loopback REST auth); only the UI-view residual remains. Kept PLANNED rather than PARTIAL (never started; PARTIAL would falsely trip `MISSING_DESIGN_ARTIFACT`).
- **COMP-MCP-ENFORCE/report.md** header corrected: Slice 1 → Slices 1–4 shipped.

### feat(COMP-PAR-MERGE-QUEUE-CONSUMER): per-task pre-merge gate on the consumer-dispatch path (v1: gate + surfacing)

Extends the per-task pre-merge gate + structured bounce to Compose's **consumer-dispatch** path (`executeParallelDispatch` → `stratum_parallel_done`) — the default for `compose build` (agents run in Compose, not Stratum's `_run_one`; the parent feature only covered server-dispatch/GSD). v1 ships the gate + bounce surfacing; the retry-with-context loop is deferred (see follow-up).

- **`runPreMergeGateLocal`** (`lib/build.js`): the consumer-dispatch mirror of Stratum's `worktree.run_pre_merge_gate` (node_modules symlink, per-command run, bounded excerpt, changed-files). Runs in each task's worktree in `executeParallelDispatch` **before diff capture**; a gate failure marks the task failed, records a `gate_failed` bounce, emits a `build_error` stream event, and **skips diff capture** so the bad work never merges.
- **Structured `parallelDone`** (`lib/build.js`): gate-failed + merge-conflict bounces are collected and passed via a structured `{status, bounced_tasks}` `merge_status` (bare string when no bounces — byte-identical). Reuses `buildMergeConflictBounce` + `applyTaskDiffsToBaseCwd` from the parent.
- **Stratum** (see stratum CHANGELOG): a shared `resolve_pre_merge_verify` surfaces the resolved gate on the dispatch envelope (omitted when empty); `stratum_parallel_done` accepts `merge_status: str | dict`; gate/conflict bounces derive readable `violations` strings.
- **Activation:** any `parallel_dispatch` step declaring `pre_merge_verify` gets the gate — `compose build`'s default behavior is unchanged unless a step opts in.
- **Deferred → COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY:** the consumer retry loop (Compose-side bounce-into-reprompt + fixing the pre-existing single-agent mis-route of a parallel `ensure_failed`) + the `build.stratum.yaml` default-OFF opt-in. The consumer retry state-model is heavier than the server path's (Compose applies successful diffs to base before `parallelDone`).
- Compose 3395 + stratum 1413 tests green; Codex design gate + impl review → CLEAN. `docs/features/COMP-PAR-MERGE-QUEUE-CONSUMER/`.

### feat(COMP-PAR-MERGE-QUEUE): per-task pre-merge gate + bounce-with-context — closes COMP-GSD-3

A dynamic post-dispatch merge gate for `parallel_dispatch`: each task runs a fast per-task **pre-merge verify gate** (default `pnpm lint` + `pnpm build`) in its worktree *before* its diff is captured/merged, so a task whose gate fails (or whose diff conflicts at merge) is rejected before it can pollute base — and re-runs **informed**, with the failure context injected into its next prompt. Cross-repo (stratum primary + compose consumer); v1 = server-dispatch (the GSD/build path). Closes the COMP-GSD-3 residual.

- **GSD wiring** (`lib/gsd.js`, `pipelines/gsd.stratum.yaml`): a `pre_merge_gate` flow input (`resolvePreMergeGate`, default `DEFAULT_FAST_GATE` = lint+build, honors `.compose/compose.json#preMergeGate` / the non-test subset of `gateCommands`) is **single-sourced** into both the enforced gate (`execute.pre_merge_verify: $.input.pre_merge_gate`) and the instructed per-task gate; the `execute` step gains `defer_advance: true`. Full `pnpm test` stays at `ship_gsd`.
- **Merge-conflict bounce** (`lib/build.js`): `extractConflictFiles` + `buildMergeConflictBounce`; the deferred-advance path sends a structured `{status:'conflict', bounced_tasks:[…]}` advance payload instead of a bare `'conflict'`.
- **Server-owned parallel retry loop** (`lib/build.js`): `executeParallelDispatchServer` now owns the parallel retry — on an `ensure_failed`/`schema_failed` parallel outcome it **re-dispatches the same step** (carrying `isolation`/`capture_diff` forward so the re-run still merges), depth-capped, returning only terminal results; `build_step_done` fires once on the terminal attempt. `runGsd` treats a terminal `error` (retries_exhausted) as a clean failure instead of throwing. Replaces the old behavior where a parallel failure leaked to the single-agent retry path / threw `unknown response status`.
- **Bounce delivery moved server-side** (the Compose-side `buildRetryPrompt`/`buildBounceSection` injection was removed as dead — Stratum re-resolves tasks on re-dispatch, so the injection lives in Stratum's `ParallelExecutor._render_prompt`; see stratum CHANGELOG).
- **Contract** `contracts/par-merge-bounce.json` (`ParMergeBounce`).
- Reconciled **COMP-GSD-3 PARTIAL → COMPLETE** and the **COMP-GSD umbrella → COMPLETE**.
- Compose `node --test` 3401 passing (new: `test/par-merge-queue.test.js`, `test/parallel-dispatch-server-defer.test.js` re-dispatch cases); Codex review 3 rounds → CLEAN (round 1 caught two blueprint-missed must-fixes: server-side bounce delivery + parallel retry routing). `docs/features/COMP-PAR-MERGE-QUEUE/`.

## 2026-06-03

### feat(COMP-GSD-7-EVENTLOG): append-only GSD run-event log + real report timeline

GSD runs now write an append-only **`.compose/gsd/<feature>/events.jsonl`** at their lifecycle points, and the COMP-GSD-7 milestone report renders its **Timeline** from that real event stream (the snapshot-derived timeline becomes the fallback). GSD otherwise persists only snapshots, so the report's timeline couldn't show task completions, phase transitions, or cross-session resumes — only whatever halt artifacts happened to be on disk.

- **`lib/gsd-events.js`** (new): `appendGsdEvent`/`readGsdEvents`/`clearGsdEvents` — one `{ts, kind, ...detail}` JSON object per line, **best-effort append** (a log failure never affects the run), reader skips torn/corrupt lines **and parseable non-objects** (a `null` line is not an event).
- **Emission** (`lib/gsd.js`): `run_started` (at the planning checkpoint — a **fresh** run truncates the log + clears stale halt artifacts *after* preconditions pass so a failed fresh start never destroys prior history; a **resume** appends), `phase` (decompose/execute, via `emitPhaseOnce` + a dedupe set — `runState.phase` is set to `execute` before the merge checkpoint so it can't gate the emission), `task_completed` (`emitCompletionDeltas` at the execute-merge **and** both halts, since stuck/budget return before the merge checkpoint; deduped via a set **seeded from the initial completed snapshot** so a resume never re-fires prior-session completions), `paused` (`pauseKind` stuck/budget — *not* `kind`, which the `{ts,kind,...detail}` spread would clobber), `completed`, `failed`.
- **`clearGsdHaltArtifacts`** (`lib/gsd-state.js`): a fresh run removes stale `stuck`/`budget` `.json`+`.md` so both the event log and the report's snapshot fallback reflect only the current run.
- **Report timeline** (`lib/gsd-milestone-report.js`): `buildTimeline` prefers the event stream and falls back to the snapshot timeline on **zero usable events** (absent/empty/torn/corrupt), never rendering empty. Unknown future kinds render verbatim. Zero change to the report's output contract.
- **Tests:** `test/gsd-events.test.js` (10), `test/gsd-milestone-report.test.js` (+2), `test/gsd-budget-run.test.js` (+1 real-`runGsd` integration assertion). Full suite **3228**, 0 fail. Codex gate: design (5 findings — early-truncate history loss, stuck-path completion miss, resume re-emit, zero-event fallback, stale halt markers), impl (2 — `runState.phase` can't gate the execute event, non-object lines crash the reader) → REVIEW CLEAN. `docs/features/COMP-GSD-7-EVENTLOG/`. Closes the last COMP-GSD follow-up tracked from GSD-7.

### feat(COMP-GSD-6-WATCHDOG): hung-child detection for the headless supervisor

The `--headless` supervisor now recovers a **hung** GSD child — one wedged with a frozen heartbeat while its pid is still alive — not just an exited one. v1 blocked forever on `await spawnRun()`; now each attempt **races child-exit against a heartbeat watchdog**, kills a hung child, and resumes it like a crash. On by default, fully configurable.

- **Independent wall-clock heartbeat (the load-bearing fix)** (`lib/gsd.js`): the pre-existing heartbeat only advanced on agent push-events, so a quiet-but-healthy task looked stale — which is exactly why GSD-6 made `heartbeatStale` *advisory only*. A `setInterval` (unref'd, cleared in `finally`) restamps `state.json`'s heartbeat whenever the event loop is turning, so a **frozen** heartbeat now genuinely means the loop is wedged (or the process dead). Gated on `GSD_HEADLESS_ATTEMPT` (supervised children only) → interactive `compose gsd` stays byte-identical.
- **Confirm-poll watchdog** (`lib/gsd-supervisor.js` `defaultWatch`): declares hung only after **two consecutive stale polls with an unchanged `heartbeatAt`** — surviving host suspend / forward clock jumps (a just-woken healthy child re-stamps and clears the alarm). The poll sleep is abort-aware and unref'd, so a clean exit never leaves the supervisor waiting.
- **Kill by pid** (`defaultKillChild`): the supervisor doesn't hold the child handle, so it sends `SIGTERM`, waits `watchdogKillGraceMs`, then `SIGKILL` if `pidAlive`.
- **`hung` resumes like `crash`**: a hung kill leaves the crash signature (running + dead pid); the supervisor `clearGsdPause`s (new export in `lib/gsd-state.js`) so `loadResumeTaskGraph`'s crash-bridge recovers from the current `state.json` rather than a stale `pause.json`. New `autoResume.hung` policy ({enabled:true, maxAttempts:3}) for independent caps; `watchdogPollMs`/`watchdogKillGraceMs`/`watchdogHeartbeatMs` timings, with the `watchdogHeartbeatMs < heartbeatStaleMs` invariant enforced (clamped).
- **Tests:** `test/gsd-watchdog.test.js` (11), `test/gsd-supervisor.test.js` (+4 hung-path), `test/gsd-headless-config.test.js` (+4). Full suite **3201**, 0 fail. Codex gate: design (3 findings — the advisory-heartbeat trap, stale-pause shadowing, suspend/clock-jump), impl (3 — ref'd poll timer, unenforced invariant, non-byte-identical disabled path), + 1 follow-up (`heartbeatStaleMs:0`) → REVIEW CLEAN. `docs/features/COMP-GSD-6-WATCHDOG/`.

### feat(COMP-GSD-7): milestone HTML report generator for completed `compose gsd` runs

The observability capstone of the COMP-GSD umbrella: a GSD feature now finishes with a single self-contained HTML report a human can open from the cockpit. On a clean `compose gsd` completion the run writes **`docs/gsd-reports/<feature>.html`** — per-task summary (status / attempts / files / **elapsed**), **budget actuals-vs-caps**, a run timeline, and **inline per-task diffs**. `compose gsd report <feature>` regenerates it retroactively. It rides the existing cockpit `DocsView` discovery (`/api/files` + `/api/file`, which already renders `.html`) — **zero server changes**.

- **Output relocated to `docs/`** (`lib/gsd-milestone-report.js`): the roadmap's original `.compose/gsd/reports/<feature>.html` "via the cockpit asset pipeline" assumed a pipeline that doesn't exist — `.compose/` is never served to the UI. Writing under `docs/gsd-reports/` makes the report auto-discoverable with no new route. Self-contained HTML (inline CSS, `JSON.stringify` data, HTML-escaped, 200 KB per-task diff cap) following the `server/graph-export.js` precedent; atomic tmp+rename.
- **"Full v1" capture is compose-side — no Stratum change** (`lib/gsd-timing.js`, `lib/gsd-diff-capture.js`, `lib/build.js`): the two inputs the spec named but the system discarded both flow through compose already. **Per-task diffs** (`ts.diff` from the worktree dispatch poll) are snapshotted at the merge site to `.compose/gsd/<f>/diffs/<id>.diff` before worktree cleanup. **Per-task elapsed** is derived from compose's own poll loop (first-sight → `startedAt`, first-terminal → `completedAt`) into a `timing.json` sidecar — Stratum's poll carries no timing, and the blackboard is contract-validated, so the sidecar is the carrier (no `task-result.json` change). Both writes gate on an explicit **`context.gsd === true`** marker so non-GSD build mode is **byte-identical** (proved by `test/gsd-dispatch-instrumentation.test.js`).
- **Completion wiring** (`lib/gsd.js`): on a clean complete the run persists `completedAt` into `state.json` (so retroactive reports recover total wall-clock), writes a `budget-final.json` snapshot (a clean complete writes no `budget.json` — only halts do; distinct filename), and best-effort-generates the report. **Everything report-side is try/catch-wrapped** so a derived-artifact write can never demote a successful run to `failed`.
- **`compose gsd report <feature>`** (`bin/compose.js`): retroactive/archival regeneration from persisted artifacts, mirroring `gsd query`. Budget source precedence `budget_state → budget-final.json → budget.json → unbudgeted`.
- **Tests:** `test/gsd-timing.test.js` (11), `test/gsd-milestone-report.test.js` (16), `test/gsd-diff-capture.test.js` (4), `test/gsd-report-wiring.test.js` (4), `test/gsd-dispatch-instrumentation.test.js` (2, real-git integration). Full suite **3192**, 0 fail. Codex impl gate → CLEAN after one fix (a non-best-effort `writeBudgetFinalSnapshot` that would have turned successful runs into failures — no unit test would have caught it). `docs/features/COMP-GSD-7/{design,blueprint,plan,report}.md`.
- **Deferred (documented, not a gap):** `COMP-GSD-7-EVENTLOG` — a true append-only GSD run-event log. GSD persists only snapshots today, so the v1 timeline is snapshot-derived (start / completion / pause-stuck-budget markers), not an event stream.

### feat(COMP-GSD-6): headless CLI + crash recovery for autonomous `compose gsd` runs

The autonomy-completeness rail: `compose gsd` can now run **unattended** (CI/cron) and survive a hard crash, and its status is observable from **outside the process**. Verify-first reshaped the one-line spec twice — `gsd` was already non-interactive (so `--headless` means *supervised auto-resume*, not prompt suppression), and there was no journal to "extend" (so `state.json` is a standalone checkpoint, still plain JSON, no SQLite).

- **Continuous `state.json` checkpoint** (`lib/gsd-state.js`, `contracts/gsd-state.json`): `.compose/gsd/<feature>/state.json` is flushed pre-plan (a `planning` checkpoint), updated with `flowId`, heartbeat-bumped per task event (via an opt-in `opts.onHeartbeat` threaded into `executeParallelDispatchServer` — build mode byte-identical), marked `resumeReady` once the task graph is decomposed, and terminally flushed. A hard crash leaves `status:"running"` + a dead pid, which readers derive as `crashed`. **Dead-pid is the sole crash signal**; a stale heartbeat on a live pid is advisory only (a long task legitimately sits in the dispatch poll loop).
- **`compose gsd query <feature>`**: an instant (~ms) read-only JSON snapshot — no LLM/server/Stratum. Fixed source precedence `state.json → pause.json → budget.json → absent` (so a pre-dispatch cumulative-budget refusal reads as `budget`, not `absent`). Exit 3 when absent, 0 otherwise. One status vocabulary (`running|crashed|complete|stuck|budget|failed|absent`) shared by query, supervisor, and contract.
- **`compose gsd <feature> --headless`** (`lib/gsd-supervisor.js`, `lib/gsd-headless-config.js`): an outer supervisor that re-spawns plain `compose gsd` children with exponential backoff. Classification is driven by the **terminal `state.json` status**, not exit code alone. **Per-pause-kind policy** under `gsd.headless.*` (every field overridable): defaults are crash✓ + bounded-stuck✓ + **budget✗** (auto-resuming budget would defeat the GSD-4 ceiling — opt-in only). A crash re-spawns `--resume` when `resumeReady`, else a **fresh** restart (crashed during plan/decompose, nothing merged).
- **Crash recovery** (`lib/gsd.js`): `loadResumeTaskGraph` gains a bridge — when `pause.json` is absent (a hard crash never wrote one) but `state.json` shows `running` + dead pid + a populated task graph, it synthesizes the resume input. A fresh run clears any prior `state.json` up front so a stale `complete` can't masquerade as success; the dispatch-try catch writes `failed` on an orderly throw (vs a true crash → `crashed`), keeping the supervisor from retrying deterministic failures.
- **Concurrency + the deferred stale-lock item**: a new atomic `run.lock` (+ holder-written `owner.json`) claimed before `stratum.plan` excludes two fresh runs from racing the results dir (previously unguarded). The explicitly-deferred stale `pause.lock` takeover (`gsd.js:728-732`) is now implemented — keyed on a **holder-written** `owner.json` pid (NOT `pause.json.pid`, the original crashed writer, which is always dead at resume and would break mutual exclusion — caught by the concurrent-resume test) via an **atomic rename-aside** so two reclaimers can't delete each other's fresh lock.
- **Tests:** `test/gsd-state.test.js` (14), `test/gsd-crash-recovery.test.js` (9), `test/gsd-headless-config.test.js` (5), `test/gsd-supervisor.test.js` (12), `test/gsd-query-cli.test.js` (6), +1 killed→failed in `test/gsd-resume.test.js`. Full suite **3158** lib, 0 fail. Codex gate at every phase → CLEAN (design 2 rounds; blueprint coherence loop; impl 3 rounds caught a stale-`complete` false-success, a racy lock takeover, a `killed` terminal escaping the vocabulary, and the supervisor's missing `budget.json` precedence — none caught by tests first). `docs/features/COMP-GSD-6/{design,blueprint,report}.md`.
- **Deferred (documented, not gaps):** `COMP-GSD-6-WATCHDOG` (kill+resume a *hung* child whose heartbeat goes stale while still alive; v1 is exit-code + on-death-status only); a full headless real-spawn E2E (the loop is unit-tested with an injected spawner).

### feat(COMP-GSD-4): budget ceilings + stop conditions for autonomous `compose gsd` runs

The second autonomy-safety rail (alongside COMP-GSD-5 stuck detection): a hard, configurable **run-wide budget** that halts a gsd run with diagnostics instead of letting it run away. Built by **adopting the shipped stratum flow budget (STRAT-WORKFLOW-BUDGET)** rather than rebuilding — verify-first found the enforcement engine, per-task usage accounting, terminal propagation, and the `budget_state` envelope all already exist (same shape as COMP-GSD-3).

- **Opt-in flow budget:** when `.compose/compose.json` `gsd.budget.*` is set, `runGsd` injects a flow-level `budget: {ms, max_agent_dispatches, max_tokens, usd}` block into the gsd spec (`lib/gsd-budget.js` `injectBudget`); stratum then enforces all four axes and halts with terminal `budget_exhausted`. Absent config ⇒ **no block injected ⇒ the spec is byte-identical** (asserted `injectBudget(spec,{}) === spec`), so plain `compose build` and un-budgeted `compose gsd` are unchanged. `usd` is a real cost cap (STRAT-WORKFLOW-BUDGET-DOLLARS; `max_tokens` is the reliable backstop for unpriced models). `gsd.budget.per_task_ms` → the execute step's `task_timeout` (seconds).
- **Clean halt + diagnostic + resume:** the `budget_exhausted` terminal (which carries `budget_state = {caps, consumed}`) is surfaced through `executeParallelDispatchServer` (guarded short-circuit; no-op in build mode) and the gsd run loop. On halt: `.compose/gsd/<feature>/budget.{md,json}` (consumed-vs-cap per axis + remaining tasks) and a `pause.json` with `kind:"budget"`, so `compose gsd <feature> --resume` re-dispatches the unfinished tasks exactly like a stuck halt. `contracts/gsd-stuck.json` gains an optional `kind` discriminator (if/then/else; legacy kind-less pauses still validate).
- **Cumulative cross-session ceiling:** `budget-ledger.js` (`recordGsdUsage`/`checkGsdCumulativeBudget`, back-compatible with COMP-BUDGET's iteration fields) tracks per-feature tokens/cost across runs; a spent `gsd.budget.cumulative.*` ceiling **refuses the run before dispatch** with a refusal diagnostic. `compose gsd <feature> --reset-budget` clears it. Per-run wall-clock/dispatch reset each invocation; cumulative tokens/cost persist.
- **Resume-lock correctness:** the atomic `pause.lock` claim was split from `loadResumeTaskGraph` (`claimResumeLock`) and moved inside `runGsd`'s try; release is **ownership-aware** (`finally` releases only if this process claimed) — no strand on a budget/stuck re-halt or pre-dispatch throw (also fixes a latent GSD-5 stuck-on-resume strand), and no clobber of a concurrent run's claim.
- **Deferred (documented scope cuts, not gaps):** the *live* OpsStrip burn pill → `COMP-GSD-4-OPSSTRIP-LIVE` (gsd emits no build-stream telemetry — a no-op streamWriter — so a live pill needs a gsd-telemetry surface first; v1 surfaces burn via `budget.json` + the ledger); per-*task* token hard cutoff → `COMP-GSD-4-PERTASK-TOKENS` (flow budget is aggregate; per-task wall-clock + the stuck detector already bound a runaway task).
- **Tests:** `test/gsd-budget.test.js` (20), `test/gsd-budget-run.test.js` (5, full runGsd lifecycle incl. ownership-aware lock), `test/contracts-gsd-stuck.test.js` (+5). Full suite: 3110 lib + 146 UI + 100 tracker, 0 fail. Codex gate at every phase → CLEAN (design: usd-enforced + telemetry overclaim; blueprint: pause.lock strand + `kind`-default validation trap; impl: unconditional lock release = concurrency clobber). `docs/features/COMP-GSD-4/{design,blueprint,plan,report}.md`.

### feat(COMP-GSD-5): stuck detection + `--resume` for autonomous `compose gsd` runs

A real-time safety rail for the gsd autonomous long-run mode: during per-task fresh-context dispatch, a `GsdStuckDetector` (`lib/gsd-stuck.js`) watches the agent-stream and halts a spinning task with a structured diagnostic + resume-or-abort.

- **Four signals** (tunable via `.compose/compose.json` `gsd.stuck.*`; defaults 3/3/8/600000ms): same file edited ≥3×; the same *normalized* error recurring ≥3×; ≥8 consecutive non-file-changing tool calls **after the first edit** (upfront read/grep/test exploration is not penalized — a never-editing task is caught by the wall-clock guard); a per-task wall-clock stall. Same-file reuses `FixChainDetector` (`lib/debug-discipline.js`); consumes the per-task `tool_use_summary.input` + `tool_result` telemetry from stratum `STRAT-PAR-STREAM-TOOLDETAIL` (schema 0.2.7).
- **Halt + diagnostic:** on a stuck verdict the dispatch loop cancels the task (`parallelAdvance(…, 'conflict')`), writes `.compose/gsd/<feature>/stuck.{md,json}` (`contracts/gsd-stuck.json`), returns status `stuck`. The detector is an **opt-in** param to `executeParallelDispatchServer` — `compose build` is byte-identical (no detector passed).
- **`compose gsd <feature> --resume`:** re-dispatches the persisted enriched task graph minus already-completed tasks (blackboard-driven; completed deps stripped from remaining `depends_on`), guarded by an **atomic `mkdir` ownership claim** + live-pid/mode check. NOT a mid-task `stratum.resume` (that lands in the wrong step — see T2-F5). The `pause.json` shape is the contract GSD-6 (auto crash-recovery) builds on; stale-claim auto-recovery is deferred to GSD-6.
- **Tests:** `test/gsd-stuck.test.js`, `test/gsd-resume.test.js`, `test/contracts-gsd-stuck.test.js` + dispatch-path cases in `test/parallel-dispatch-server.test.js` (50 GSD-5 tests; build mode unchanged). Full suite: node 3236 + UI 146 + tracker 100, 0 fail. Codex review 3 rounds (telemetry-derivability → resume-into-cancelled-task + no_progress false-positive + resume-claim TOCTOU) → REVIEW CLEAN. `docs/features/COMP-GSD-5/{design,blueprint,plan}.md`.

### fix(validate): reconcile the 8 status-mismatch drift errors (PARTIAL vision-vocabulary projection)

`feature-validator.js`'s `STATUS_MISMATCH_*_VS_VISION_STATE` checks string-compared
the tracker status (ROADMAP / feature.json) against the vision-state item status,
but vision-state's status enum (`contracts/vision-state.schema.json`) is the
tracker's set **minus `PARTIAL`** — it cannot represent "partially shipped". A
legitimately-PARTIAL feature therefore false-fired against a vision item that can
only say `in_progress`. `runStateMismatchChecks` now projects **both** operands to
the vision vocabulary (`PARTIAL`→`IN_PROGRESS`) before comparing: a PARTIAL feature
no longer drifts against `in_progress`; real drift (`PARTIAL` vs `complete`/`planned`)
still fires; tracker↔tracker (`ROADMAP_VS_FEATUREJSON`) keeps the full vocabulary;
and a malformed/legacy vision `"partial"` — still reported as
`VISION_STATE_SCHEMA_VIOLATION` — aligns instead of double-reporting. Paired with a
local vision-state reconciliation of three items whose `status` predated their
real state (COMP-GSD, COMP-GSD-3 → `in_progress`; COMP-WORKSPACE-HTTP →
`complete`). Error findings 18→10 — the 8 `*_VS_VISION_STATE` errors cleared; the
residual 10 (feature.json schema, missing-design debt, entangled cross-feature
links) remain owned elsewhere. Added 4 regression tests; Codex-reviewed clean.

## 2026-06-02

### feat(build-stream): accept schema 0.2.7 (STRAT-PAR-STREAM-TOOLDETAIL tool-detail events)

Consumer side of stratum `STRAT-PAR-STREAM-TOOLDETAIL`: `lib/build-stream-schema.js` `KNOWN_VERSIONS` accepts `0.2.7`. The enriched `tool_use_summary` (raw `input` + `tool_use_id`) and the new `tool_result` event ride the open catch-all (no closed-kind change). Unblocks COMP-GSD-5 stuck detection's per-task tool-use observation. Tests: `test/build-stream-validate.test.js` (0.2.7 envelope + `tool_result` + enriched `tool_use_summary` accepted; unknown versions still rejected).

### fix(validate): CONTRADICTORY_PHASE_CLAIM compared roadmap heading to lifecycle phase

`feature-validator.js`'s `CONTRADICTORY_PHASE_CLAIM` (error) compared
`feature.json.phase` — which holds the ROADMAP heading ("Phase 7: MCP Writers")
— against vision-state's lifecycle phase ("vision"/"explore_design"). Different
vocabularies, so it false-fired on ~40 features (the bulk of the repo's
error-severity validate drift). Now compares lifecycle-phase to lifecycle-phase
only (no roadmap-heading source, no legacy board-`phase` fallback), aligning the
code with its own "does not involve the roadmap" intent. Error findings dropped
58→18. Added 3 regression tests (roadmap-heading and legacy-board-phase must not
fire; a genuine lifecycle mismatch does). The remaining 18 (status mismatches +
missing-design debt + entangled cross-feature links) are owned elsewhere; the
pre-push validate step stays advisory until they're reconciled.

### fix+chore: harden the enforcement gate (post-review follow-up)

Follow-ups from Codex-reviewing the prior commits — "ensure enforcement actually works."

**Fixed (live bug):** `lib/result-normalizer.js`, `lib/build.js`, and
`server/design-routes.js` hard-pinned `schema_version === '0.2.5'` and silently
dropped the current producer's `0.2.6` BuildStreamEvents — live agent-run
streaming (narration/tool-use/usage) was lost end-to-end. All three now gate on
`KNOWN_VERSIONS.has()`. Added a behavioral test (0.2.6 event is forwarded) and a
contract/regression guard that no stream consumer re-pins a version literal.

**Fixed (broken enforcement):** `compose validate` rejected its own documented
`--workspace` flag (exit 2 "Unknown flag"), which broke the pre-push hook's
validate step. Now accepted.

**Gate hardening:** `bin/git-hooks/pre-push.template` now runs `npm test` as a
HARD gate (fail-closed; auto-skips only when `scripts.test` is definitively
absent) — the gate whose absence let a broken integration test reach main. The
`compose validate` drift step is now ADVISORY (the repo carries pre-existing
error-severity drift; strict drift-blocking to be re-enabled after reconciliation).
`test/integration/hook-read-cache.test.js` is now hermetic (skips when its host
hooks/python3 are absent; fixed an `after()` cleanup that orphaned
`~/.claude/read-cache` session dirs) so it's safe in the default gate.

### feat(COMP-RESUME): environment-based resumability for builds

Interrupted builds (crash, killed session, reboot, MCP restart) can now resume
from ground-truth environment state instead of reconstructing context. The
environment — git state + on-disk phase artifacts + append-only logs — is the
checkpoint.

**Added**
- `lib/checkpoint/` subsystem: `fingerprint.js` (deterministic `EnvFingerprint`
  capture + pure `classify` → `clean`/`advanced`/`diverged`), capability-tiered
  `CheckpointStore` (`store/index.js` + `store/jsonl.js`; `smartmemory` and
  `memory-pointer` are registered seams throwing `NOT_IMPLEMENTED`), `anchor.js`
  (best-effort boundary capture), `reconciler.js` (deterministic `reconcile` →
  `ReconcileResult`), `prompts.js`, `render.js`, `checkpoint-writer.js`.
- Contract `contracts/checkpoint.schema.json` (Checkpoint + EnvFingerprint).
- MCP tools `write_checkpoint` (anchor or narrative; returns a `scribePrompt`)
  and `compose_resume` (reconcile → `resume`/`needs-sync`/`gate`).
- `POST /api/session/bind/reconcile`; best-effort anchor checkpoints at every
  lifecycle boundary (phase advance/skip/kill/complete, gate resolve, iteration
  complete/abort) in `server/vision-routes.js`.
- `checkpoint` config block in `.compose/compose.json` (`enabled`, `backend`,
  `confidenceThreshold`).

**Notes**
- Two checkpoint grades: cheap deterministic *anchors* (`soft: null`) at every
  boundary; agent-authored *narrative* checkpoints (`{goal,nextStep,risks}`) on
  demand, anchored to the fingerprint (never assert verdicts — point at `testRef`).
- `reconcile()` is deterministic (no store write, no DB mutation, no LLM); the
  route persists `lifecycleMutations`, the orchestrator runs the agent on
  `needs-sync`. Anchor writes are best-effort and never break a route handler.
- SmartMemory backend intentionally deferred to a follow-up (seam only).

### fix(test): agent-run streaming integration test emitted contract-invalid events

`test/integration/agent-run-streaming.test.js` was failing 2/2 (`expected 3,
actual 0`). Its fake server emitted `task_id: null`, but the real producer
(`stratum_mcp/events.py#to_json`) omits `task_id` when `None`, and the consumer
envelope schema (`lib/build-stream-schema.js`, mirroring the canonical v0.2.6
contract) requires `task_id` to be a string when present — so every event was
correctly dropped as invalid. Fixed the fake server to omit `task_id` (and bumped
its `schema_version` to the current `0.2.6`); the schema/consumer were correct.
Root-caused to `STRAT-PAR-STREAM-CONSUMER-VALIDATE` tightening validation while
this test (which only runs under `npm run test:integration`, not the default
`npm test` gate) went un-rerun. Integration suite now 47/47.

### chore(test): fold `test:integration` into the default `npm test` gate

`test/integration/*.test.js` now runs as part of `npm test` (previously only via
`npm run test:integration`), so contract-drift in integration tests can't rot
undetected — the exact trigger behind the agent-run-streaming break above. All 6
integration suites are self-contained (tmp dirs / git / fakes / mocks; no live
services or fixed ports). Full gate green: 3144 node + 146 UI + 100 tracker.

### COMP-MCP-ENFORCE — Slices 1–4 — mechanical lifecycle/gate enforcement via stratum STRAT-GUARD (default-OFF capabilities.guard, now enabled)

Moves lifecycle enforcement from prompt-trust into the tool/server layer by consuming stratum's STRAT-GUARD. No caller (skill, cockpit, or rogue MCP/REST client) can effect an unverified transition, complete without real evidence, or reach a terminal status outside the lifecycle. All behind capabilities.guard; guard-OFF is byte-identical to before.

**Added:**
- Slice 1: advance/skip/complete/kill verdict-gated by STRAT-GUARD (server-read evidence, tamper-evident ledger); new `guard` CLI subcommand on stratum-mcp; server/lifecycle-guard.js owns the phase graph
- Slice 2: lifecycle-as-truth — roadmap STATUS projected from phase (phaseToStatus/projectFeatureStatus), closing the COMP-PARITY-7 one-way-sync gap; setFeatureStatus `derived` option
- Slice 3: evidence-bound completion (server-read git commit + test attestation, no silent tests_pass=true); MCP boundary closed against force + terminal-status bypasses (set_feature_status/add_roadmap_entry/propose_followup/record_completion) — authorized escape is STRATUM_GUARD_OVERRIDE_TOKEN
- Slice 4 Part A: opt-in loopback REST auth (capabilities.guardAuth, default OFF, fail-closed) on all vision mutation endpoints

**Changed:**
- capabilities.guard enabled in .compose/compose.json
- vision-routes lifecycle endpoints async + guarded; phase graph imported from lifecycle-guard.js (single source of truth)

### COMP-MCP-ENFORCE-1 — Phase-scoped MCP tool capabilities — profile × phase CallTool gate (default-OFF capabilities.phaseScopedTools)

Completes COMP-MCP-ENFORCE Slice 4 Part B (was COMP-DEBUG-1). The compose MCP server gates tool calls by the session's trusted profile × the bound feature's current phase. A subagent spawned with a restrictive profile (implementer/reviewer) is kept in-lane — cannot self-approve, self-complete, or mutate roadmap; the /compose orchestrator (unprofiled) stays unrestricted. Default-OFF; CallTool is the hard guarantee, ListTools a best-effort surface filter.

**Added:**
- server/mcp-tool-policy.js — pure profile×phase policy (isToolAllowed, resolveProfile, resolveSpawnProfile, TEMPLATE_PROFILE_MAP, PROFILE_POLICY, PHASE_REFINEMENT, SETUP_TOOLS)
- Trusted profile via spawn-injected COMPOSE_SESSION_PROFILE env (bind_session may only narrow); _boundFeatureCode anchor (authoritative bind reply) + on-disk phase resolution; feature-scoped ship re-permits

**Changed:**
- server/compose-mcp.js CallTool gate (PHASE_TOOL_DENIED) + ListTools filter behind capabilities.phaseScopedTools (default OFF)
- server/agent-spawn.js injects COMPOSE_SESSION_PROFILE for restrictive spawn profiles/templates

## 2026-05-29

### fix(install): correct `pip install` package name in docs + stop vendored kernel shadowing PyPI (stratum#1)

`README.md` and `docs/install.md` still told users to `pip install stratum` —
the wrong package (a stale unrelated PyPI project); the correct package is
`stratum-mcp` (requires Python 3.11+). Both now point at `stratum-mcp` and
mention `stratum-mcp doctor` for install diagnostics. (The `bin/compose.js`
auto-installer typo was already fixed under compose#1.) Separately, the vendored
test-fixture kernel at `stratum-mcp/` declared distribution `name = "stratum-mcp"`
`version = "0.3.0"` despite being only the IR validator/executor with no MCP
server or console script — an accidental `pip install ./stratum-mcp` would shadow
the real PyPI `stratum-mcp` in `pip show`. Renamed the distribution to
`stratum-mcp-kernel` (module `stratum_mcp` and the `sys.path`-based test imports
unchanged; `test/gsd*.test.js` still green).

### release: 0.2.0

First `0.2.0` stable release of `@smartmemory/compose`. Supersedes the retired
`0.1.0` tag/release; published from the consolidated `smartmemory` org.

### fix(roadmap): guard narrative-owned workspaces from the typed writer (#39)

A workspace whose `.compose/compose.json` declares `roadmap.narrative: true` is
now **narrative-owned**: its hand-authored `ROADMAP.md` is never machine-
regenerated from `feature.json`. `generateRoadmap` returns the on-disk content
verbatim, `writeRoadmap` is a no-op (both warn with an actionable message), and
`add_roadmap_entry` refuses before writing any `feature.json`. The drift
*checks* skip too: `compose roadmap check` **and `roadmap generate`** exit 0 with
a "skipped" notice (generate would otherwise canonicalize-overwrite or crash on
the hand-authored file), the project validator emits an info
`ROADMAP_NARRATIVE_OWNED` instead of `ROUNDTRIP_NOT_FIXED_POINT`/`ROADMAP_LOSSY`,
and killed-mode `KILLED_STATUS_NOT_TERMINAL` ignores the roadmap source (still
checks feature.json/vision). Hand-authored rows are also exempt from
`ROADMAP_ROW_SCHEMA_VIOLATION`, and per-feature artifact/completion checks no
longer fall back to the roadmap row status (feature.json stays canonical) —
otherwise the hand-authored `ROADMAP.md` would always read as false drift. This stops the typed writer from
flattening curated reconciliation prose into rendered tables — the root cause of
the recurring forge-top "Wave 6" duplication. `feature.json` files may still
exist in such a workspace as structured link carriers; the guard stops the
writer, it does not delete data. New `lib/roadmap-config.js`
(`isNarrativeOwned`); documented in `docs/configuration.md`.

### fix(roadmap): em-dash in a phase title no longer truncates the phaseId (#38)

Phase headings whose *title* contains an em-dash (`## Wave 6 — Situational
Awareness — COMPLETE`) were split on the first ` — `, collapsing the phaseId to
`Wave 6` and mis-reading the status as `Situational Awareness — COMPLETE`. That
broke phaseId identity (collisions) and the phase-level status rollup (an
unmarked row under a `COMPLETE` phase was treated as `PLANNED`/buildable). New
shared `lib/roadmap-heading.js` owns `splitPhaseHeading` — the status is the
trailing segment that begins, at a ` — ` boundary, with a recognized status
token; everything before it is the title. The parser and all five preserver
call sites (`readPhaseOverrides`, `readAnonymousRows`, `readPhaseBlocks`,
`readPhaseOrder`, `readPreservedSectionAnchors`) now route through it, so they
can't disagree on a phaseId. `STATUS_TOKENS`/`parseStatusToken` moved there too
(re-exported from `roadmap-parser.js` for compatibility).

### fix(vision): wire UI items to the build/bug-fix lifecycle; stop CLI orphaning (#31)

Desktop `ItemDetailPanel` now has a **Start** button (new
`StartBuildPopover.jsx`) — shown when `!item.lifecycle && status !== 'killed' &&
type !== 'question'` — that POSTs `/api/build/start` (`{featureCode, mode,
description}`, x-compose-token), the same endpoint mobile uses, and surfaces
409/500 errors. The CLI no longer orphans UI-created items: `VisionWriter`'s
lookup (`matchFeatureItem`) falls back from `lifecycle.featureCode` to `item.id`
then top-level `item.featureCode`, so `compose fix <code>` binds to an existing
item instead of minting a duplicate. On bind it seeds `lifecycle.featureCode`
(REST + direct), and `ensureFeatureItem`/`runBuild` now thread `mode` so a bug
build creates a `type: 'bug'` item rather than always `type: 'feature'`. `'bug'`
is now a first-class vision item type (added to `VALID_TYPES` + `TYPE_COLORS`),
so the REST/server create path accepts it instead of rejecting `Invalid type: bug`.

### feat(COMP-ROADMAP-XREF-SYNC): v1 pull reconciliation for external links

Turns the read-only `XREF_DRIFT` warning into an applied fix. `compose roadmap
xref-sync [--dry-run]` (+ `lib/xref-sync.js`) reconciles every feature.json
external `links[]` entry's `expect=` to the live target state — github issues via
`getIssueResult`, local refs via the sibling feature.json status. PULL only: it
updates the local expectation to match reality and **never writes to an external
system**. Operates on the structured links carrier (post-migration source of
truth), so it rewrites no markdown and can't perturb the roundtrip fixed point.
Resolver is injectable (network-free tests); unresolved refs (offline / no-token
/ 404 / rate-limit) are reported skipped, never guessed. External-write (push) is
deliberately out of scope — see docs/features/COMP-ROADMAP-XREF-SYNC/design.md.

### fix(roadmap): tokenize status cells; rename stray 'implementation' phase

`parseRoadmap` now reduces a status cell to its bare enum token, tolerant of
trailing commentary (`PARKED — needs X` → `PARKED`, `PARTIAL (1a COMPLETE)` →
`PARTIAL`), but conservatively — glued forms like `PLANNED-ish` are left for the
validator to flag, not coerced. Prevents inline-rationale status cells from
producing schema-invalid feature.json on (re-)migration. `STATUS_TOKENS` +
`parseStatusToken` consolidated into `roadmap-parser.js` (single source). Also
renamed the stray lowercase `## implementation` phase to `COMP-DEBUG: Debug
Discipline`.

### feat(roadmap): preserved-section-aware parser + historical-row migration (fixed point)

After GENFIX (below) the migration still diverged — root cause was not the sort but
`migrate`/`parseRoadmap` treating the curated `## Execution Sequencing` planning
narrative (non-standard `| Feature | Items | Effort | Rationale |` schema) as feature
tables, minting phantom bare-code features, while `readAnonymousRows` double-captured
its struck rows.

- `parseRoadmap`, `readPhaseOverrides`, `readAnonymousRows` now skip content inside
  `<!-- preserved-section -->` markers (matching `readPhaseBlocks`/`readPhaseOrder`).
  `parseRoadmap` also gained fence tracking and raw-line marker matching so it agrees
  with the preservers. `PRESERVED_OPEN_RE`/`PRESERVED_CLOSE_RE` exported as the single
  source of truth. (Codex-reviewed; review caught + fixed a fence black-hole, a
  dropped-anon-after-block bug, and a trimmed-vs-raw marker mismatch.)
- ROADMAP.md: `## Execution Sequencing` wrapped as a preserved-section (emitted
  verbatim); ~149 compose-owned rows migrated to `feature.json`; 42 STRAT-* skipped
  as external. `roadmap check` is now a clean fixed point + lossless.
- Fixed 5 malformed source rows that yielded schema-invalid feature.json: SKILL-PD-1..4
  carried inline rationale in the status cell (folded into description; status → bare
  PARKED); COMP-CAPS-ENFORCE-4 had an unescaped pipe eating its status (description
  restored, status → PLANNED to match siblings).

### fix(COMP-ROADMAP-RT-GENFIX): deterministic roadmap roundtripping — 5 gen/parse defects

Fixes the five gen/parse defects that broke the roundtrip fixed point, unblocking
(in code) the deferred migration of historical ROADMAP rows into `feature.json`:

- **T1** — `SKIP_STATUSES` override only fills an *empty* status cell, never
  overwrites an explicit one (`roadmap-parser.js`).
- **T2** — `###` milestone headings reset to their parent phase instead of
  accumulating a `Phase > Milestone` path; `checkRoundtrip` compares the
  top-level phase only (`roadmap-parser.js`, `roadmap-roundtrip.js`).
- **T3** — symmetric pipe escaping: emit `\|` in free-text table cells, split on
  unescaped `|` and unescape on parse, in lockstep across
  `roadmap-gen.js`/`roadmap-parser.js`/`roadmap-preservers.js`.
- **T4** — `listFeatures` sorted positions with `(a.position ?? 999) - …`, which
  is `NaN` for ranged-string positions like `"141–144"` — a non-total order that
  made typed-row emit order (and anon-row anchoring) non-deterministic, so regen
  never reached a fixed point. New `positionSortKey()` parses the leading integer
  (numeric or ranged), sentinel + code tie-break. The same key now also drives
  the `newPhases` sort in `roadmap-gen.js` (a second NaN comparator found in
  review). Affects all `listFeatures` consumers (build lists, UI).
- **T5** — `readAnonymousRows` treats a case-insensitive strict-code match as a
  typed row (anchored by the uppercased canonical code) instead of anonymous,
  eliminating phantom-duplicate churn.

Coverage: `test/feature-json-sort.test.js`, `test/roadmap-ranged-position-converge.test.js`,
plus additions to `test/roadmap-parser.test.js`, `test/roadmap-checkroundtrip.test.js`,
`test/roadmap-preservers.test.js`. Full suite green (node 2933 / vitest 139 / tracker 100).

Known follow-up (NOT fixed here): re-running the migration on a scratch copy
still diverges, but the root cause is not the sort — `migrate` parses the curated
`## Execution Sequencing` planning narrative (non-standard `| Feature | Items |
Effort | Rationale |` schema) as feature tables and ignores
`<!-- preserved-section -->` markers, minting phantom bare-code features. Tracked
for a dedicated migrate-hardening + source-cleanup pass.

## 2026-05-18

### fix(roadmap-gen): typed-writer regen now converges on duplicate phase headings

**Root cause of the recurring forge-top "Wave 6" duplication (seen 4×, then 2×
again after hand-collapse).** `readPhaseOrder` returns a phaseId once per `## `
heading occurrence; `generateRoadmapFromBase` iterated that array verbatim and,
for an anon-only phase, pushed `phaseBlocks.get(phase)` once per occurrence.
Regen therefore reproduced the input duplicate count exactly (a fixed point:
2×→2×→2×, proven) instead of converging — so any duplicate introduced once
became permanent and survived a manual collapse on the very next regen.

Fix: dedupe phase identity in the emit order (`[...new Set(sourcePhaseOrder)]`,
first occurrence wins) in `lib/roadmap-gen.js`. Regen is now self-healing:
4×/2×/1× source all converge to a single section, idempotent thereafter.

Latent, not fixed here (noted for follow-up): the phase-heading regex
`/^##\s+(.+?)(?:\s+—\s+.+)?\s*$/` truncates `## Wave 6 — Situational Awareness
— COMPLETE` to phaseId `"Wave 6"` (em-dash in the title collides with the
` — STATUS` delimiter). Dedup converges regardless; an explicit follow-up should
disambiguate title-vs-status parsing.

Regression coverage: `test/roadmap-dup-phase-converge.test.js` (3 tests —
collapse, 4×→1× convergence + byte-idempotence, title/content survival). Full
suite green: 2891 node + 131 UI + 100 tracker.

forge-top `ROADMAP.md` duplicate Wave 6 block hand-removed (narrative-owned;
the typed writer would flatten its curated reconciliation prose).

## 2026-05-17

### docs: Phase 8 (Cinematic) reframed as `MM-ADOPT-1`

`docs/ROADMAP.md` Phase 8 clarified now that `~/reg/my/movie-maker` owns the capture
kit. The phase is the *product-side* adoption of the movie-maker capture contract
(`MM-ADOPT-1`). `COMP-CINE-3` reframed to "expose the `window.__cine` clock seam" (the
stepper/substrate is movie-maker's `MM-CINE-2b`, pluggable, default `claude-in-chrome` —
not Playwright/timecut, not chosen here). `COMP-CINE-5` marked **SUPERSEDED** by
`MM-CINE-2b`/`MM-CINE-3`. Product-side rows (route/layout/camera/sample) unchanged.
Facts only — no renumbering.

### COMP-MCP-XREF-VALIDATE (#16) — read-only external-reference staleness resolution

Second half of COMP-MCP-XREF. Extends `validateProject` in place (no fork). Resolves the external references #15 can store/cite, read-only, and reports drift — never writes back, never bidirectional sync.

**Added:**
- `lib/feature-validator.js` `runExternalRefChecks(ctx, findings, options)` — invoked from `validateProject` after the existing project-level checks. Collects refs from both carriers: an **anon-row-safe** raw ROADMAP citation scan (independent of `roadmapByCode`, which drops non-strict codes) + `feature.json` `links[].kind:"external"`; normalizes to one `ExternalRef`; resolves per provider.
- `lib/tracker/github-api.js` `getIssueResult(number)` — status-returning sibling of `getIssue()` (modeled on `getRepo()`, `{status,body,headers}`, no throw on 4xx). The ONLY github-api.js change; `getIssue()` untouched.
- 5 finding kinds: `XREF_DRIFT` (warning), `XREF_TARGET_MISSING` (error), `XREF_MALFORMED` (warning), `XREF_RESOLUTION_SKIPPED` (warning, never error), `XREF_URL_UNCHECKED` (info).
- `test/xref-golden-flow.test.js` (spec §7: aligned/flipped/degrade/anon-row/#15-independence) + `test/xref-degrade-harness.test.js` (spec §6 matrix) + carrier-parity test in `feature-json-schema-external.test.js`.

**Changed:**
- `bin/compose.js` — `compose validate --external` (parsed before the unknown-flag catch-all) threaded into `validateProject(cwd, {external})`.
- `server/compose-mcp.js` / `server/compose-mcp-tools.js` — `validate_project` gains `external` option.
- `bin/git-hooks/pre-push.template` — documents the OFF-by-default xref behavior + `COMPOSE_XREF_ONLINE=1` / `xref.prePushOnline` opt-in (honored inside the validator; no flag change in the hook).

Degrade contract (spec §6): no-token → one aggregate `XREF_RESOLUTION_SKIPPED` (remaining github silently skipped); offline/≥500/unparseable-2xx → per-ref skip+continue; rate-limit → aggregate + silent short-circuit of remaining github only (local/url still resolve); 404 → `XREF_TARGET_MISSING` (error). Gate OFF (default, incl. pre-push) → github refs skip with no network; local/url/malformed still surface. `validateProject` extended in place with an outer backstop (staleness pass can never abort the run). Local repo token constrained to a safe sibling directory name (no path traversal), grammar-level + resolver containment guard. Catalog doc `docs/features/COMP-MCP-VALIDATE/design.md` created (32 kinds + degrade/gating contract). Codex impl review fixed 4 MUST + 3 SHOULD pre-merge. Codex final integration review fixed a carrier-equivalence gap: the feature.json-link writer (`linkFeatures`) now rejects exactly what the inline citation grammar rejects — invalid github/local `expect` tokens and malformed `repo` shapes (github `owner/name`, local safe sibling segment) — so #16's resolver can never receive a value it would mishandle; `citing.workspaceId` now surfaced in finding detail; unused `_internals` export removed. Suite: node 2883 + tracker 100 + UI 131, 0 fail.

### COMP-MCP-XREF-SCHEMA (#15) — Cross-project external references: schema + grammar + linkFeatures

First half of COMP-MCP-XREF. Local-only, zero network, no validator changes — ships independently with #16 (read-only staleness resolution) entirely absent. Realizes the per-project-provider Roadmap Model: a prose roadmap can cite a product-repo issue/PR via an external reference without embedding or syncing its status.

**Added:**
- `lib/xref-citation.js` — pure parser for inline `<!-- xref: <provider> <target> [expect=…] [note="…"] -->` citations (spec §3.1 EBNF). Order-independent `expect`/`note`, structured `ParseError`, zero I/O.
- `test/xref-citation.test.js` — grammar accept/reject table.
- `test/feature-json-schema-external.test.js` — schema contract test (both link variants; previously-valid real `feature.json` no-regression contract).

**Changed:**
- `contracts/feature-json.schema.json` — `links[]` gains a `kind:"external"` discriminated `if/then` variant (provider enum `github|local|url|jira|linear|notion|obsidian`; github→repo+issue, local→repo+to_code, url-class→url). Same-project links left permissive (no `oneOf`, no `additionalProperties:false`) — no existing `feature.json` regresses.
- `lib/feature-writer.js` — `linkFeatures()` external branch: bypasses same-project `validateCode`/self-link/`LINK_KINDS` guards for `kind:"external"`, in-code provider validation, idempotency on `(kind=external, provider, repo, issue|to_code|url)`. Same-project path byte-for-byte unchanged.
- `server/compose-mcp.js` — `link_features` input schema accepts the external shape (`to_code` no longer globally required; `provider`/`repo`/`issue`/`url`/`expect` added); description documents both shapes + reserved url-class providers.

Reserved providers `jira|linear|notion|obsidian` are parse-valid url-class (recorded, not resolved in v1); real resolvers are follow-on `COMP-MCP-XREF-JIRA` #17 / `COMP-MCP-XREF-LINEAR` #18. Codex impl review fixed 4 findings pre-merge: end-anchored `note=`/`expect=` parsing (URLs containing them no longer mis-parse), schema same-project branch now requires `kind` (no validation widening), external-local `to_code` regex-validated, idempotency null/undefined repo normalized. Suite: node 2868 + tracker 100 + UI 131, 0 fail.

### COMP-TRACKER-PROVIDER — Pluggable TrackerProvider — LocalFile (default, zero behavior change) + GitHub (Issues + Projects v2 + Contents API)

Adds a provider abstraction so feature/completion/changelog/event persistence can be routed to different backends. The `local` provider is byte-identical to prior behavior; `github` syncs to GitHub Issues, Projects v2, and repository Contents API. Tracker tests wired into `npm test` CI gate.

**Added:**
- TrackerProvider interface (`lib/tracker/provider.js`) with capability constants and typed errors
- LocalFileProvider — default provider, zero behavior change, byte-identical output verified by regression golden tests
- GitHubProvider — Issues API (feature CRUD + status comments), Projects v2 GraphQL (field/option resolution, memoized), Contents API (roadmap.md + changelog.md read/write)
- Durable op-log (`lib/tracker/op-log.js`) for offline-capable queued writes
- Read cache + pending-op shadowing + CAS (`lib/tracker/cache.js`, `lib/tracker/cas.js`)
- Sync engine + conflict ledger (`lib/tracker/sync-engine.js`, `lib/tracker/conflict-ledger.js`)
- `compose tracker status` and `compose tracker sync` CLI verbs
- `.compose/compose.json` `tracker` config block: `provider`, `github.{repo,projectNumber,branch,auth.tokenEnv}`
- conformance suite (`tests/tracker/conformance.js`) exercising both providers against a shared contract
- 100-test tracker suite (`tests/tracker/**`) now included in `npm test` CI gate via `test:tracker` script

**Changed:**
- Feature, completion, changelog, and event persistence in `lib/feature-writer.js`, `lib/completion-writer.js`, `lib/changelog-writer.js`, and `lib/build.js` routed through the provider seam — behavior unchanged under default `local` provider
- Unused `appendEvent` import removed from `lib/feature-writer.js`

## 2026-05-15

### CI — Beta publish workflow: drop racy commit-back

- `.github/workflows/beta.yml`: removed the "Commit version bump" step. It pushed a `chore: bump` commit to `main` after a successful npm publish, which raced concurrent pushes and failed the job (with the beta already published) on rapid successive merges. The beta version is derived from `npm view @smartmemory/compose@beta`, so npm is the source of truth and the commit-back was redundant.

### STRAT-GOAL-V1 — New contract: `contracts/goal-result.json`

- New `contracts/goal-result.json`: `allOf` superset of `judge-result.json` with STRAT-GOAL-specific fields — `goal_id` (string), `goal_version` (const `"1.0"`), `mode` (enum: shadow-driven / shadow-observed / advisory / autonomous), `status` (enum: met / not_met / awaiting_decision / budget_exhausted / killed / in_progress), `turns_run` (integer), `worker_runs` (integer), `round` (integer), `predicate_outcomes` (array, MAY be empty for zero-turn results), `would_have_decided` (string/null, shadow-only advisory output)

### STRAT-JUDGE-V1 — New contract: `contracts/judge-result.json`; `contracts/review-result.json` updated

- New `contracts/judge-result.json`: strict superset of `review-result.json` for STRAT-JUDGE outputs. Adds `met` (boolean), `stakes` (enum: cheap / default / paranoid), `predicates` (array of `PredicateResult` with id, type, statement, verdict, confidence, applied_gate, evidence, tier_history), `budget_consumed` (turns, dollars, wall_clock_s), `judge_kernel_meta` (decomposer_mode)
- `contracts/review-result.json` updated: `meta.agent_type` enum extended from `["claude", "codex"]` to `["claude", "codex", "judge"]` — `"judge"` is used for T1-only paths where no LLM was dispatched; when T2 fires, `agent_type` reflects the actual model invoked

## 2026-05-11

### COMP-GSD-2 — Per-task fresh-context dispatch (`compose gsd`)

Second feature of the COMP-GSD initiative. Adds `compose gsd <feature-code>` as a third lifecycle mode alongside `build` and `fix`. Decomposes a feature's blueprint + Boundary Map into per-task work units and dispatches each as a fresh-context worktree-isolated agent via Stratum's `parallel_dispatch` (sequential by default — `max_concurrent: 1`). The load-bearing primitive that makes long autonomous runs possible.

**CLI** — new `compose gsd <feature-code>` verb in `bin/compose.js` (alongside `build` and `fix`). Hard-requires `docs/features/<code>/blueprint.md` with a parseable Boundary Map — errors out with a pointer to `compose build <code>` otherwise. Refuses to start in a dirty workspace (clean-start precondition: every file in the post-execute dirty set is then unambiguously a GSD-produced change). `gateCommands` resolution: `loadProjectConfig().gateCommands` with explicit fallback to `["pnpm lint", "pnpm build", "pnpm test"]` (the loader does not merge defaults).

**Pipeline** — new `pipelines/gsd.stratum.yaml` (3 steps: `decompose_gsd → execute → ship_gsd`). Decompose reads `blueprint.md` + Boundary Map and emits a `TaskGraph` whose `description` strings are pre-baked rich prompt fragments (Stratum's `parallel_dispatch` only interpolates a fixed token set per `stratum-mcp/src/stratum_mcp/spec.py:567-590`, so all spec context — produces/consumes/slice/upstream summary/gates — must ride inside `task.description`). Execute uses `max_concurrent: 1`, `isolation: worktree`, `capture_diff: true`, `merge: sequential_apply`, `retries: 2`. `ship_gsd` updates `ROADMAP.md` + `CHANGELOG.md` + optional `CLAUDE.md`, commits in-process via `executeShipStep`; push deferred to user (mirrors `compose build`).

**Runner** — `lib/gsd.js` is a self-contained status loop. Does NOT modify `lib/build.js` — imports `executeParallelDispatchServer` and `executeShipStep` as existing exports. Validates decompose_gsd output via `enrichTaskGraph` (T3): three cases — structural success + valid descriptions → proceed; structural success + missing/malformed descriptions → repair via `buildTaskDescription` (T4) using the per-slice text and gateCommands; structural failure (orphan slice or task) → throw loudly, no repair. Post-execute, walks `.compose/gsd/<code>/results/<task_id>.json` files committed by each task agent and finalizes `.compose/gsd/<code>/blackboard.json` via `gsd-blackboard.writeAll` (one-shot replace, mkdir-advisory-lock per `lib/completion-writer.js:48-67`); throws loud listing all validation failures rather than producing a partial blackboard.

**Contracts** — `contracts/taskgraph-gsd.json` (extends bare TaskGraph with required `produces`/`consumes` per task), `contracts/task-result.json` (post-execution per-task capture: `status`, `files_changed`, `summary`, `produces`, `gates: Array<{command, status, output}>`, `attempts`). The `gates` field is an array (not an object keyed by lint/build/test) so arbitrary project-configured `gateCommands` are supported.

**Pure helpers** — `lib/gsd-decompose-enrich.js` (no fs; uses `parseBoundaryMap` only — `validateBoundaryMap` is `runGsd`'s precondition); `lib/gsd-prompt.js` `buildTaskDescription({task, slice, upstreamTasks, gateCommands})` produces canonical 6-section description strings; `lib/gsd-blackboard.js` provides `read`, `writeAll`, `validate`.

**v1 scope reductions surfaced by Codex review** — runtime task-to-task handoff is NOT implemented (`executeParallelDispatchServer` is one atomic step; tasks see only spec-level upstream context from Boundary Map; realized handoff requires Stratum protocol extension or one-step-per-task pipelines, both deferred). No per-task gate bounce-back loop (`parallelAdvance` only accepts `clean|conflict`; gates execute inside the task agent's TDD loop instead, and Stratum's per-task `retries: 2` handles transient failure). No `lib/build.js` modifications.

**Verification** — Codex review iterations to convergence: design (1), blueprint (5), plan (3), per-task implementation (T1: 2, T2: 1, T3: 2, T4: 2, T5: 2, T6: 6, T7: 3). 59 dedicated tests across 7 suites. Full suite: **2815/2815 node-test + 122/122 vitest** passing, no regressions.

**Out-of-scope (deferred to subsequent COMP-GSD-N features)** — parallelism via `max_concurrent > 1` and merge-queue (GSD-3, narrowed); budget ceilings + hard stops (GSD-4); stuck detection (GSD-5); headless mode + crash recovery (GSD-6); milestone HTML report (GSD-7); file-granular Boundary Map fallback (no use case until file-only features appear).

## 2026-05-10

### COMP-GSD-1 — Boundary Map artifact for blueprint phase

First feature of the COMP-GSD initiative (autonomous long-run mode parity pass against gsd-build/gsd-2). Adds an opt-in `## Boundary Map` section to multi-unit blueprints declaring inter-slice contracts at file→symbol granularity. Phase 5 verification picks it up and runs four mandatory checks against any Boundary Map present.

**Format** — markdown, embedded in `blueprint.md`, per-slice (not per-edge — fan-out doesn't duplicate). Each slice declares `Produces:` (mandatory `(<kind>)` annotation, ∈ `{interface, type, function, class, const, hook, component}`) and `Consumes: from S##: ...` rows. Leaf slices use `Consumes: nothing`; sink slices use `Produces: nothing`. Author template at `.claude/skills/compose/templates/boundary-map.md`.

**Validator** — `lib/boundary-map.js` exports `parseBoundaryMap` and `validateBoundaryMap`. Returns `{ ok, violations, warnings }` with `Violation = {kind, scope: "parse"|"entry", slice?, file?, symbol?, message}` and `Warning = {kind, scope: "blueprint"|"file-plan"|"entry", ...}`. Four checks: (1) File-Plan-or-disk (accepts `## File Plan` / `## Files` / `## File-by-File Plan` aliases; allow-list of write actions matched on extracted leading verb so `MODIFY (existing, 119 lines)` normalizes to `modify`); (2) symbol-presence (substring grep, only for pre-existing files NOT in File Plan with allow-listed action — name-mention guarantee, see follow-up `COMP-GSD-1-FU-EXPORT-CHECK`); (3) topology (every `from S##:` references earlier slice; document-order acyclic by construction); (4) producer/consumer match (every consumed symbol must appear in the matching producer's symbol set — the core anti-drift check). Warnings: `no_file_plan` (blueprint-scope), `unknown_action` (file-plan-scope, deduplicated per row).

**Skill + pipeline integration** — Phase 4 prompt (`.claude/skills/compose/SKILL.md` ~line 176) instructs authors to include the section when feature has 2+ work units, with kind restriction. Phase 5 prompt (~line 188) and `pipelines/build.stratum.yaml` verification step both reference `lib/boundary-map.js` and surface boundary results inside the existing `PhaseResult.summary` field (no schema widening — kept the contract narrow).

**Dogfood** — `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` retroactively annotated as the first worked example. Target swapped from COMP-OBS-STREAM after Phase 5 verification surfaced that the latter has no `## File Plan`, which would have made the dogfood fail its own validator.

**Verification.** Codex review converged on design (15 passes), plan (3 passes), implementation (3 passes — final REVIEW CLEAN). 41 dedicated tests in `test/boundary-map.test.js` covering parser, all four checks, both warning kinds, parse violations, leaf+sink forms, both `→` and `->` arrow alternatives, duplicate slice IDs, post-`nothing` malformation, File Plan duplicate-row write detection, contract field shape. Full suite: **2878 tests passing** (2756 node + 122 vitest), no regressions.

**Follow-ups filed** in `forge/ROADMAP.md` Standalone Tickets — `COMP-GSD-1-FU-EXPORT-CHECK` (tighten name-mention to definition/export-anchored regex), `COMP-GSD-1-FU-TYPECHECK` (real `tsc --noEmit` for type-only entries), `COMP-GSD-1-FU-MARKDOWN-DOGFOOD` (the COMP-GSD-1 self-Boundary-Map declares markdown anchors with kind `(const)`; surfaces when FU-EXPORT-CHECK lands), `COMP-GSD-1-FU-FILEPLAN-HEADER-DETECT` (validator picks up nested non-File-Plan tables under `## File-by-File Plan`; tighten to require recognized `| File | Action | ...` header).

### COMP-MOBILE — Mobile PWA companion at `/m`

Compose now has a fully functional mobile companion alongside the desktop cockpit — a PWA at `/m` shipped in 5 milestones (M1 shell → M5 builds). Phone-first; tablet inherits. Skips remote-transport (deferred to `COMP-MOBILE-REMOTE`); home-wifi use works today via the existing `x-compose-token` model.

**M1 — Shell + plumbing:** `/m` route via `React.lazy()` split (mobile bundle stays separate from desktop), bottom nav with 4 tabs, mobile-only CSS scoped to `.m-*`, token pairing flow (`?token=…` → `localStorage` → `setSensitiveToken`), service worker (cache-first static, network-first `/api/*`), PWA manifest with `start_url=/m, display=standalone`. Vite `manualChunks` config keeps the mobile chunk under 5 KB gzipped at this stage.

**M2 — Roadmap:** filter (status/group/keyword), drill into items, edit `status`/`group`/`confidence` with optimistic mutations + WS live updates. Extracted `src/lib/wsReconnect.js` (exponential backoff capped at 30s); `useVisionStore.js` refactored to use it (no behavior change for desktop). Edits restricted to fields that exist on vision items; priority/tags excluded.

**M3 — Ideabox:** capture form, swipe-left-to-kill, swipe-right-to-promote, P0/P1/P2/Untriaged filter chips, priority editing. Pure-React pointer-event swipe detection (`src/mobile/lib/swipe.js`). Uses dedicated ideabox routes (`/api/ideabox/ideas/{:id}/{promote,kill}`); status changes via PATCH explicitly rejected by the server.

**M4 — Agents + gates + interactive session:** spawned-agent list with kill, agent output tail (filtered from global SSE stream), single-interactive-session chat (when active), pending-gate list with approve/revise/kill via the `outcome` enum on `POST /api/vision/gates/:id/resolve`. Extracted `src/lib/agentStream.js` (pure SSE consumer with backoff) and `src/hooks/useAgentStream.js`; `AgentStream.jsx` refactored to consume the hook with no desktop behavior change. Sensitive endpoints (kill, chat, interrupt) thread `x-compose-token` via `withComposeToken`. Per-spawned-agent chat is intentionally absent — that surface needs new server APIs.

**M5 — Builds:** `POST /api/build/start` and `POST /api/build/abort` server routes wrap the existing `runBuild`/`abortBuild` from `lib/build.js` (one-character `export` added to `abortBuild`; otherwise no internals changed). Mode is `feature` | `bug` (with `template: 'bug-fix'` for bug); `abortBuild` signature is `(dataDir, featureCode)`. Per-feature concurrency: same-feature active → 409, different feature allowed; UI surfaces the most-recent writer of `active-build.json` (matches desktop). Mobile builds tab: empty state with start sheet (feature autocomplete + mode chip + description), or active-build card with abort + log tail filtered by `flowId`.

**Auth model.** Mobile uses the existing `x-compose-token` infrastructure verbatim. `src/lib/compose-api.js` gained `setSensitiveToken(t)` runtime override that takes precedence over the build-time `VITE_COMPOSE_API_TOKEN`; this is the seam `COMP-MOBILE-REMOTE` will use for remote-pairing tokens. No `Authorization: Bearer` plumbing — that conflicts with the existing model.

**Out of scope for v1 (filed for follow-ups):**
- `COMP-MOBILE-REMOTE` (rows 207) — bind 0.0.0.0, runtime-generated token, pairing URL, tunnel guidance
- `COMP-AGENT-CHAT-PER-ID` — per-spawned-agent chat (server API needed first)
- `COMP-BUILD-HISTORY` — persistent build log (today only `active-build.json` exists)
- SSE/WebSocket workspace tagging — deferred until those routes consume workspace
- Tablet-specific layouts — phone-first; tablet uses the same single-column shell

**Verification across all 5 milestones:**
- 122 vitest UI tests pass (was 92 pre-mobile; +30 across M1–M5)
- 10 new node tests for build routes; full suite 2767/2769 (only pre-existing STRAT-DEDUP failures unchanged)
- Mobile bundle: 65 KB raw / 18 KB gzipped — well under the 200 KB target
- Desktop unchanged: same `App-*.js` size, all existing tests green
- Codex review converged at design (3 passes), blueprint (4 passes), and implementation (clean)

### COMP-WORKSPACE-HTTP — HTTP workspace foundation (middleware + bootstrap)

Compose's HTTP server (port 4001) gains a per-request workspace channel: every request now resolves to a `req.workspace = { id, root, source }` via Express middleware reading `X-Compose-Workspace-Id`. **Behavior-preserving substrate** — singletons stay shared, snapshot sites stay snapshot, agent server stays untouched. The next four tickets (`COMP-WORKSPACE-VISION`, `-SESSIONS`, `-AGENT-SVR`, `-FILES`) build on this foundation.

**Why narrowed.** Original framing was "fix the 6 import-time `PROJECT_ROOT` snapshots." Three Codex review passes surfaced that the real shape was bigger — boot-time `VisionStore`/`SettingsStore`/`SessionManager`/`DesignSessionManager` singletons, the separate agent server on port 4002, file-watcher's HTTP routes, `/api/project/switch` global state. Per `feedback_codex_review_convergence.md`, split into a 5-ticket track. This ticket ships the foundation; the rest builds on it.

**Added:**
- `server/workspace-middleware.js` — `createWorkspaceMiddleware()` factory. `EXEMPT_PATHS = {/api/workspace, /api/project/switch, /api/health}` bypass with `source: 'exempt'`. Header present + valid → resolved via `resolveWorkspace`. Header absent → soft-fallback (v1 applies to all methods, including mutations) with `X-Compose-Workspace-Fallback: true` response header. Resolver errors map to 400 (`WorkspaceUnknown`, `WorkspaceDiscoveryTooBroad`) and 409 (`WorkspaceAmbiguous` with candidates, `WorkspaceIdCollision` with roots). `mapResolverErrorToResponse` helper exported separately.
- `server/workspace-routes.js` — `GET /api/workspace` returns `{id, root, source: 'boot'}` derived from `getTargetRoot()` + `deriveId({root}).id`. **Boot-deterministic**: does NOT call `resolveWorkspace()` so it doesn't 409 in nested-workspace setups.
- `src/lib/wsFetch.js` — `wsFetch(url, opts)` wraps `fetch` and injects `X-Compose-Workspace-Id` from a module-local cache. Works for both relative and absolute URLs. `setWorkspaceId(id)` / `getWorkspaceId()` exposed.
- `src/contexts/WorkspaceContext.jsx` — `WorkspaceProvider` fetches `/api/workspace` on mount, caches id via `setWorkspaceId`, exposes `useWorkspace()` returning `{loading, error, workspace, refresh}`. `refresh()` re-fetches and updates cache (used by `handleProjectSwitch` to invalidate stale id before any view remount fires downstream `wsFetch`).
- 5 new test files: `workspace-middleware.test.js` (13 tests), `workspace-routes.test.js` (4), `compose-mcp-tools-http.test.js` (6), `cli-resolve-workspace.test.js` (3), `golden/http-middleware-multi-workspace.test.js` (5). Plus 4 added to `vision-writer.test.js` and the new `wsFetch.test.js` (5 vitest). 51 net-new tests.

**Changed:**
- `server/index.js` — mounts `attachWorkspaceRoutes(app)` and `createWorkspaceMiddleware()` after `express.json()` (line 49), before all other routes.
- `server/compose-mcp-tools.js` — added `_httpRequest(method, path, body)` helper that reads `_binding.id` and injects `X-Compose-Workspace-Id`. 4 callsites (`toolGetCurrentSession`, `_bindSession`, `_postLifecycle`, `_postGate`) refactored to use it. Added comment documenting why `_binding` is process-global by design.
- `lib/vision-writer.js` — constructor accepts `{workspaceId}`; `_fetch` injects header when set. Backward compat preserved.
- `bin/compose.js` — `resolveCwdWithWorkspace` now returns `{root, id}` (was bare string). 17 consumers updated to destructure `.root`. `httpGet`/`httpPost` accept optional `workspaceId` param; 4 callsites at lines 2491/2510/2536/2584 thread the resolved id.
- `server/design-routes.js` — post-design-completion gate creation (lines 472–477) injects `X-Compose-Workspace-Id` from `req.workspace.id`.
- 19 frontend files migrated from `fetch()` to `wsFetch()` (41 same-origin + 2 absolute-localhost = 43 sites). 3 `:4002` agent-server fetches preserved with `// TODO COMP-WORKSPACE-AGENT-SVR` comments. 6 EventSource/WebSocket sites unchanged (deferred).
- `src/main.jsx` — wraps app in `<WorkspaceProvider>`.

**Out of scope (deferred):** boot-singleton splitting, 6 import-time `PROJECT_ROOT` snapshots, agent server on port 4002, file-watcher HTTP routes, `/api/project/switch` rework. Tracking rows 202–205 in `ROADMAP.md` carry the four follow-ups.

**Verification:** 2743/2745 tests pass; the 2 failures (`STRAT-DEDUP-AGENTRUN-V3`) are pre-existing and unrelated. Frontend `npm run build` green. Codex review converged at iteration 2 of the implementation pass with REVIEW CLEAN.

## 2026-05-09

### COMP-WORKSPACE-ID — workspace identity disambiguation (parent vs child)

Compose now disambiguates between parent and child workspaces (e.g. forge-top vs `forge/compose`) across CLI, stdio MCP, and git hooks. Previously, `add_roadmap_entry` and friends could silently write to the parent workspace when invoked from a Claude session whose cwd was the parent — even when the user mentally meant the child. The fix introduces a single canonical resolver chain plus an MCP `set_workspace` tool.

**Why.** Observed concretely while scaffolding this very feature: invoking `compose feature COMP-WORKSPACE-ID` from forge-top scaffolded the folder under forge-top instead of compose, even though the feature semantically belongs to compose. The resolver had no channel for expressing intent.

**Path A v1 scope.** Stdio MCP + CLI + git hooks. HTTP server's import-time `PROJECT_ROOT` snapshots are deferred to `COMP-WORKSPACE-HTTP` (filed). Cockpit single-workspace UX is unchanged.

**Added:**
- `lib/discover-workspaces.js` — bounded bidirectional discovery: walks up to a `.compose`/`.stratum.yaml`/`.git` anchor, then scans descendants up to MAX_DEPTH=3 / MAX_VISITED=500 for `.compose/` markers. Skip-dirs include `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`. Throws `WorkspaceDiscoveryTooBroad` over cap; silently skips unreadable subtrees (EACCES/EPERM/ENOENT). Exports `findAnchor`, `discoverWorkspaces`, `deriveId`.
- `lib/resolve-workspace.js` — single canonical resolver chain. Precedence: explicit `--workspace=<id>` flag → `COMPOSE_TARGET` env (path or id) → MCP binding → discovery + auto-prompt. Explicit-flag bypass uses cheap upward walk (`findWorkspaceById`) so a known ancestor workspace skips the descendant scan even in deep monorepos. Error classes: `WorkspaceUnknown`, `WorkspaceAmbiguous`, `WorkspaceIdCollision`, `WorkspaceUnset`. Helper `getWorkspaceFlag(args)` mutates args in place.
- New MCP tools: `set_workspace({workspaceId})` and `get_workspace()`. State lives in the stdio child only; lost on MCP restart by design (per-Claude-session scope is the right boundary).
- `__COMPOSE_WORKSPACE_ID__` substitution in git hook templates; hooks pass `--workspace="$COMPOSE_WORKSPACE_ID"` to `record-completion` and `validate`. `compose hooks status` now reports `MISSING_WORKSPACE_ID` (legacy install) and `STALE_WORKSPACE_ID` (drift) and prints the baked id when current.
- 4 new test files: `discover-workspaces.test.js` (12 tests), `resolve-workspace.test.js` (14 tests), `hooks-workspace.test.js` (6 tests), `golden/multi-workspace.test.js` (3 tests). 35 net-new tests; 2547 total node tests pass.

**Changed:**
- `bin/compose.js` — 17 cwd resolution sites migrated to a unified `resolveCwdWithWorkspace(args)` helper that exits via `dieOnWorkspaceError` with structured candidate lists when the cwd is ambiguous. Cached after first resolution so auto-init re-entry from `import`/`new`/`build`/`fix` sees a consistent workspace. `compose init` and `compose update` are workspace-optional (init creates; update is user-global).
- `server/compose-mcp-tools.js` — dropped the `PROJECT_ROOT = getTargetRoot()` import-time cache; `VISION_FILE`/`SESSIONS_FILE` constants converted to `getVisionFile()`/`getSessionsFile()` getters; added `_binding` state plus the new tools.
- `server/compose-mcp.js` — lazy `switchProject` bridge before each tool call (errors propagate to MCP client as structured `WorkspaceAmbiguous` etc with candidate list and next-step guidance). `set_workspace`/`get_workspace` exempt from the bridge.
- `server/project-root.js` — added `getCurrentWorkspaceId`/`setCurrentWorkspaceId`.

**Followups filed:** `COMP-WORKSPACE-HTTP`, `COMP-WORKSPACE-WATCHERS`, `COMP-WORKSPACE-RESUME`, `COMP-CLI-GLOBAL-FLAGS`.

## 2026-05-08

### STRAT-REV-FU-1 / FU-2 / FU-3 — cross-model review hardening

Three follow-ups surfaced during the STRAT-REV reconciliation (the `STRAT-REV-7` archive entry was stale; the feature shipped 2026-05-08 but three refinements were captured during the audit). All three filed as `STRAT-REV-FU-*` rows in `ROADMAP.md` and shipped in this changeset.

**FU-1: Diff-size dual gate.** Original design called for "200+ lines = large"; impl shipped with file-count-only (`≥9 files`). A 200-line single-file mega-refactor was under-classified as `small`. Now `classifyDiffSize(filesChanged, lineCount?)` takes the larger of the two classifications — file-count gate stays primary, line-count gate (`≥200` lines) catches single-file refactors. `runCrossModelReview` computes `lineCount` once via `git diff --shortstat HEAD` (5s timeout, falls back to null on failure preserving original behavior).

**FU-2: Consensus promotion.** Findings present in both Claude and Codex output now get `consensus: true` stamped and confidence boosted by +2 (capped at 10). Cockpit can highlight high-conviction issues by filtering on the flag; numeric confidence reflects that two independent models agreed.

**FU-3: Fallback confidence invariant.** Regression-proofing: previously the synthesis-failure fallback path could ship findings with `confidence < applied_gate`, dropping them silently at the gate filter (already hit once — `codexAsFallback` shipped at 6 with gate 7). `promoteFallbackConfidence` defensively raises any under-stamped fallback confidence to the gate value so caller-supplied findings survive.

**Changed:**
- `lib/review-normalize.js` — added `promoteConsensusFinding` and `promoteFallbackConfidence` helpers; consensus pipeline now `map(normalize) → filter(gate) → map(promoteConsensus)`; fallback branch wraps caller arrays through `promoteFallbackConfidence`.
- `lib/review-lenses.js` — `classifyDiffSize` and `shouldRunCrossModel` accept an optional `lineCount` second arg; larger of file-class and line-class wins.
- `lib/build.js` — added `computeChangedLineCount(cwd)` helper using `git diff --no-color --shortstat HEAD`; `runCrossModelReview` passes lineCount into `shouldRunCrossModel` and emits it on the `cross_model_review` start event.

**Tests:** 21 cross-model + 39 lens tests passing (3 new FU-3 cases, 3 new FU-2 cases, 7 new FU-1 cases). Full node suite: 2622/2623 passing — single pre-existing failure (`comp-deps-package T6: compose doctor --json`) reproduces on clean tree, unrelated to this changeset.

## 2026-05-06

### COMP-MCP-MIGRATION-2-1-1 — Lossless ROADMAP.md round-trip

Typed writers like `set_feature_status` and `add_roadmap_entry` previously destroyed curated content during regen — anonymous historical rows, phase-status overrides like `PARKED (Claude Code dependency)`, and non-phase sections like `Roadmap Conventions` / `Dogfooding Milestones` / `Execution Sequencing` / `Key Documents` all got stripped. The trial bulk backfill that surfaced this ticket dropped `compose/ROADMAP.md` from 1,125 lines to 493. Now fixed via three targeted preservation patches: heading override capture/replay with drift detection, anonymous-row passthrough at parsed positions, and HTML-comment-marker anchors for non-feature sections. No new dependencies, no AST swap, no consumer migration.

**Why hand-rolled, not remark/unified:** Decision 1 originally chose `unified` + `remark-parse` + `remark-stringify` + `remark-gfm`. T2 POC during execution proved the mechanism works for non-table preserved subtrees but `mdast-util-gfm-table` re-pads every column on every regen — hundreds of lines of cosmetic whitespace diff per typed-writer call. Stepped back, scoped to the actual goal (preserve curated content), shipped hand-rolled augmentation in ~200 lines instead of a multi-package AST swap. Full design history at `docs/features/COMP-MCP-MIGRATION-2-1-1/`.

**Added:**
- `lib/roadmap-preservers.js` — six pure functions: `readPhaseOverrides`, `readAnonymousRows`, `readPreservedSections`, `readPreservedSectionAnchors`, `readPhaseOrder`, `readPhaseBlocks`. Each scans existing ROADMAP.md text and returns curated content for the writer to splice back during regen.
- `lib/roadmap-drift.js` — `emitDrift(cwd, {phaseId, override, computed})` writes a `roadmap_drift` event to `feature-events.jsonl` with read-side dedupe (24h window) and an always-emitted stderr warning. Surfaces when a curated heading override (`COMPLETE`) diverges from the rollup computed from feature.json (`PARTIAL`).
- 31 new tests across 4 files: 19 preservers + 8 drift + 5 round-trip integration + 7 edge-case coverage (bootstrap path, absent markers, predecessor-deleted anon rows, override-only phases, multi-row anon chains, drift-on-rich-override, fenced-code-block false-positives).

**Changed:**
- `lib/roadmap-gen.js` — `generateRoadmap()` reads existing ROADMAP.md and splices regenerated tables into source phase blocks via `spliceTableIntoBlock()` so curated intro prose, exit text, and `See \`docs/...\`` doc links survive. Phase order from source is canonical (preserves curated sequencing for legacy phases). Preserved-section markers anchor at their parsed positions relative to phases. Key Documents auto-gen suppressed when a `key-documents` preserved-section exists.
- `lib/feature-writer.js` — `roadmapDiff()` filters out `roadmap_drift` events (internal reconciliation, not user mutations).
- `ROADMAP.md` — wrapped Roadmap Conventions, Dogfooding Milestones, Execution Sequencing, and Key Documents in `<!-- preserved-section: <id> -->` markers.
- `templates/ROADMAP.md` — wrapped Roadmap Conventions and Dogfooding Milestones so `compose init` repos start marker-aware.

**Process:** 7 rounds of Codex review on the (now-rejected) Option B blueprint surfaced 22 architectural findings. After the POC stop, one round of Codex review on the Option A implementation surfaced 2 real issues (typed-phase prose loss, weak round-trip test); both fixed in the same Phase 7 iteration. Final review: REVIEW CLEAN.

**Follow-ups filed:**
- `COMP-MCP-MIGRATION-2-1-1-1` — `/compose migrate-anon` interactive flow for promoting historical anonymous rows to typed features.
- `COMP-MCP-MIGRATION-2-1-1-3` — Key Documents hybrid-merge (auto-add designDoc-linked rows + byte-preserve curated/external rows).

**Tests:** 2495/2496 passing (one pre-existing flake in `test/comp-deps-package.test.js:235` unrelated to this work; reproduces against stash-revert). E2E demonstration via live `setFeatureStatus` against compose's actual ROADMAP.md confirmed all preservation invariants hold.

### COMP-UPDATE-1, COMP-UPDATE-3 — One-step `compose update`, `--version`, doctor version drift

Compose was published to npm as `@smartmemory/compose` but the README still told users to run `npx compose init`, which fails with `could not determine executable to run`. Existing users also had no documented upgrade path — they had to remember `git pull && npm install && compose setup`. Both gaps closed in one feature.

**Added:**
- `compose update` (alias `compose upgrade`) — auto-detects whether compose was installed via npm (PACKAGE_ROOT under `node_modules/`) or git clone (`.git` at PACKAGE_ROOT). For npm installs runs `npm install [-g] @smartmemory/compose@latest`. For git clones runs `git fetch && git pull --ff-only && npm install`, refusing to proceed if the working tree is dirty unless `--force` is passed. Either way, then re-runs `compose setup` and (if invoked inside a `.compose/` project) re-runs `compose init` so `.mcp.json` and pipeline templates stay in sync.
- `compose --version` / `compose version` / `compose -V` — prints package version, git SHA (if running from a clone), and the resolved package root.
- `compose doctor` Version section — fetches the latest version from `registry.npmjs.org/@smartmemory/compose`, compares against the locally-installed version, and prints `✓ up to date` or `⚠ behind — run: compose update`. 24h on-disk cache at `~/.compose/version-cache.json` (3-second timeout, never throws — registry failures degrade silently to `latest: unavailable`). `compose doctor --refresh-versions` bypasses the cache. JSON output mode emits a `version` object alongside the existing dep report.
- `lib/version-check.js` — `checkLatestVersion(currentVersion, { force })` and `compareVersions(a, b)` (semver-ish, prerelease-aware: `0.1.7-beta` < `0.1.7`).

**Changed:**
- `README.md` — split Quick install into npm vs git-clone options; added Upgrading section.
- `docs/install.md` — same split; added Upgrading section; corrected `npx compose` invocations to use the fully-qualified package name when needed.
- `bin/compose.js` — new `runUpdate()`, new `detectInstallStyle()`, version dispatch ahead of help, `runDoctor` is now async and prints version drift.

**Not done in this feature:**
- COMP-UPDATE-2 (npm publish infra) — already shipped before this feature was filed. `package.json` has `bin`, `files`, `publishConfig: public`, `prepublishOnly`, and `.github/workflows/publish.yml` publishes on `v*` tags with provenance. Confirmed via `npm view @smartmemory/compose dist-tags`: `latest: 0.1.0`, `beta: 0.1.7-beta`. Roadmap entry updated to COMPLETE.

## 2026-05-04

### COMP-MCP-MIGRATION-2-1 — Lossless regen prep (PARTIAL)

Surfaced by `COMP-MCP-MIGRATION-2`. Originally scoped as a bulk backfill of `feature.json` for every legacy `compose/ROADMAP.md` row so typed writers could own regen. A trial run revealed the data-loss surface is too large to ship cleanly: anonymous-numbered tables in Phases 0–6 can't be parsed for codes, curated phase-status overrides (`PARKED (Claude Code dependency)`, `PARTIAL (1a–1d COMPLETE, 2 PLANNED)`) get flattened by `phaseStatus()` rollup, and top-level non-phase sections (`Roadmap Conventions`, `Dogfooding Milestones`, etc.) are stripped entirely. Reverted the trial; shipped two narrow infrastructure fixes that prepare for proper backfill once that larger work is designed.

**Changed:**
- `compose/lib/migrate-roadmap.js` — `migrateRoadmap()` defaults `featuresDir` to `loadFeaturesDir(cwd)` instead of the literal `'docs/features'`. Repos with `paths.features` overrides now backfill under the configured root.
- `compose/lib/roadmap-gen.js` — `renderPhase()` emits feature descriptions verbatim instead of truncating at 80 chars + `'…'`. Typed-writer regens preserve full prose; markdown tables tolerate long cells fine.

**Status:** PARTIAL. Bulk backfill of compose's 189 legacy features is deferred — needs parser updates for anonymous tables, a phase-status override mechanism, and preamble/footer preservation in regen output. Hand-edit `compose/ROADMAP.md` for curated phases until then.

**Tests:** No new tests (both changes are mechanical; existing path-respect + regen tests cover them). Full suite: 2570 + 92 UI = 2662, all green.

### COMP-MCP-MIGRATION-1 — Audit-log correlated auto-rollback for `enforcement.mcpForFeatureMgmt`

Surfaced by `COMP-MCP-MIGRATION`. Promoted the prompt-only enforcement flag to true block mode by adding per-build correlation IDs to `feature-events.jsonl` and a pre-stage scan in `executeShipStep` that rejects unauthorized `ROADMAP.md` / `CHANGELOG.md` / `feature.json` edits.

`runBuild` generates a UUID `build_id`, sets `COMPOSE_BUILD_ID` env (so spawned agents and writers stamp it automatically), propagates it through the build context, and restores the prior value in `finally`. `feature-events.appendEvent` reads the env and stamps every audit row with `build_id` (or `null` when invoked outside a build). `executeShipStep` collects dirty files (including pre-staged ones via `git diff --cached`), and when `enforcement.mcpForFeatureMgmt` is `true` (block) or `'log'`, runs `scanGuarded` to verify each dirty `ROADMAP.md` / `CHANGELOG.md` / `feature.json` has a matching typed-tool event with the current `build_id`. For `feature.json` paths the match also requires `event.code === <feature_code from path>`, so an event for feature A cannot bless a manual edit to feature B. Block mode throws `MCP_ENFORCEMENT_VIOLATION`; log mode emits a `mcp_enforcement_violation` decision event and proceeds.

Setting:
- `enforcement.mcpForFeatureMgmt: false` — default, no scan, no prompt.
- `enforcement.mcpForFeatureMgmt: true` — prompt + block-mode scan.
- `enforcement.mcpForFeatureMgmt: 'log'` — prompt + log-mode scan (visibility, no block).

**Added:**
- `compose/lib/mcp-enforcement.js` — `readEnforcementMode`, `filterGuarded`, `isGuardedPath`, `expectedToolsForPath`, `featureCodeFromPath`, `scanGuarded`, `enforcementError`.
- `compose/test/feature-events-build-id.test.js` — 4 unit tests on env-driven stamping.
- `compose/test/mcp-enforcement.test.js` — 25 unit tests on mode parsing, guarded-path matching, `scanGuarded`, code-correlation, and `enforcementError`.

**Changed:**
- `compose/lib/feature-events.js` — `appendEvent` stamps `build_id`.
- `compose/lib/build.js` — `runBuild` generates `build_id`, sets/restores env, propagates through context. `executeShipStep` includes pre-staged files in the dirty scan and runs the pre-stage MCP-enforcement scan. Warns loudly if `COMPOSE_BUILD_ID` is already set when entering `runBuild` (concurrent in-process builds are not supported).
- `compose/ROADMAP.md` — `COMP-MCP-MIGRATION-1` flipped to `COMPLETE`.

**Tests:** 29 new (4 stamping + 25 enforcement). Full suite: 2570 + 92 UI = 2662, all green.

### COMP-MCP-MIGRATION-2 — Honor `paths.features` across all lib writers

Surfaced by `COMP-MCP-MIGRATION`. Lib-side writers previously hardcoded `docs/features` even when `.compose/compose.json` set `"paths": { "features": "specs/features" }` (or any other override). Now every writer reads the override via a tiny shared helper and threads it through to `feature-json.js`, `ArtifactManager`, the build runner, triage, and ship.

**Added:**
- `compose/lib/project-paths.js` — `loadFeaturesDir(cwd)` (reads `.compose/compose.json`, falls back to `docs/features` on missing/malformed config).
- `compose/test/project-paths.test.js` — 7 unit tests.
- `compose/test/feature-writer-paths.test.js` — 6 integration tests verifying writers operate against the override (and that default repos are unaffected).

**Changed:**
- `compose/lib/feature-writer.js` — every public writer (`addRoadmapEntry`, `setFeatureStatus`, `linkArtifact`, `linkFeatures`, `getFeatureArtifacts`, `getFeatureLinks`) threads `featuresDir`; `rejectCanonicalArtifact` substring check uses the resolved root.
- `compose/lib/followup-writer.js` — `nextNumberedCode`, all `readFeature` callsites, and `scaffoldDesignWithRationale`'s feature root all honor the override.
- `compose/lib/completion-writer.js` — `recordCompletion` + `getCompletions` thread it through.
- `compose/lib/roadmap-gen.js` — `generateRoadmap` defaults `opts.featuresDir` to `loadFeaturesDir(cwd)`.
- `compose/lib/build.js` — `resolveItemDir`, triage cache reads, `runTriage` call, `isTriageStale` call, `checkStaleness` call (through `resolveItemDir` so bug mode stays correct), all status flips, and `executeShipStep`'s staging path honor the override.
- `compose/lib/triage.js` — `runTriage` accepts `featuresDir` opt.
- `compose/ROADMAP.md` — `COMP-MCP-MIGRATION-2` flipped to `COMPLETE`.

**Tests:** 13 new (7 unit + 6 integration). Full suite: 2541 + 92 UI = 2633, all green.

### COMP-MCP-MIGRATION — Migrate Compose's own callers to typed MCP tools

Sub-ticket #9 (last) of `COMP-MCP-FEATURE-MGMT`. Reconciles the cockpit lifecycle/complete endpoint, the build runner, and the `/compose` skill with the typed writer tools shipped earlier in the family. After this change, no Compose internal code path edits ROADMAP.md / CHANGELOG.md / feature.json by hand; status flips happen atomically through `record_completion` at ship time (post-commit), not piecemeal through free-text edits during docs.

**Cockpit reconciliation** (`POST /api/vision/items/:id/lifecycle/complete`): accepts optional `commit_sha`, `tests_pass`, `files_changed`, `notes` fields. When `commit_sha` is present and the item has a `featureCode`, the route handler calls `recordCompletion` (which atomically writes the completion record, flips status to COMPLETE, regenerates ROADMAP.md). Without `commit_sha`, it emits a `cockpit_completion_skipped` decision event with `reason: 'no_commit_sha'`. Typed-tool failures emit `cockpit_completion_failed` (or `_partial_status_flip`) decision events and surface `partial: true` in the response — the lifecycle transition itself never rolls back.

**Build runner** (`lib/build.js` `executeShipStep`): after the commit succeeds, calls `recordCompletion` with the resolved 40-char SHA, `tests_pass: true`, and the `git show --name-only` file list. Completion failures degrade to a `completionWarning` field in the ship result; the commit itself is durable.

**Enforcement flag** (`enforcement.mcpForFeatureMgmt` in `.compose/data/settings.json`): when `true`, `step-prompt.js` injects a hard instruction into every agent prompt directing the agent to use the typed MCP tools rather than Edit/Write for ROADMAP / CHANGELOG / feature.json. Prompt-only in v1; audit-log-correlated auto-rollback is filed as `COMP-MCP-ENFORCE-AUTO-ROLLBACK`. Default is `false`.

**Skill files** (`~/.claude/skills/compose/steps/docs.md`, `steps/ship.md`): replaced free-text instructions with typed-tool recipes; documented that the runner records completion automatically (skill only invokes `record_completion` in the manual fallback path).

**Added:**
- `compose/test/migration-cockpit.test.js` — 4 integration tests for the cockpit reconciliation paths (happy with SHA, skip without SHA, invalid SHA partial, no-featureCode legacy).
- `docs/features/COMP-MCP-MIGRATION/{design,blueprint,report}.md`.

**Changed:**
- `compose/server/compose-mcp.js` — `complete_feature` schema gains optional `commit_sha`/`tests_pass`/`files_changed`/`notes`.
- `compose/server/compose-mcp-tools.js` — `toolCompleteFeature` forwards the new fields.
- `compose/server/vision-routes.js` — lifecycle/complete handler does the typed-tool reconciliation.
- `compose/lib/build.js` — post-commit `recordCompletion`; reads `enforceMcpForFeatureMgmt` setting into context.
- `compose/lib/step-prompt.js` — Enforcement instruction block when the flag is set.
- `compose/ROADMAP.md` — `COMP-MCP-MIGRATION` flipped to `COMPLETE`; umbrella `COMP-MCP-FEATURE-MGMT` flipped to `COMPLETE`.
- `~/.claude/skills/compose/steps/docs.md` — typed-tool recipes; no early ROADMAP flip.
- `~/.claude/skills/compose/steps/ship.md` — runner records completion; manual fallback documented.

**Tests:** 4 new cockpit integration. Full suite: 2528 + 92 UI = 2620 tests, all green.

**With this, the COMP-MCP-FEATURE-MGMT umbrella is COMPLETE — all 9 sub-tickets shipped.**

### COMP-MCP-FOLLOWUP — `propose_followup` MCP tool

Sub-ticket #8 of `COMP-MCP-FEATURE-MGMT`. Files a numbered follow-up feature against a parent in one call: auto-numbers the next code in the parent's namespace (`<parent>-N`), adds the ROADMAP row, links `surfaced_by` from new → parent, scaffolds `design.md` with a `## Why` rationale block, and emits a composite audit event. Replaces the manual three-step sequence recent sessions did by hand.

Retry-safe: an inflight ledger at `.compose/inflight-followups/<sha16(parent:key)>.json` persists per-stage progress; same-key replay resumes from the recorded stage. A per-parent file lock at `.compose/locks/followup-<sha16(parent)>.lock` (5 s timeout, throws `FOLLOWUP_BUSY` on miss) guards allocation + addRoadmapEntry so concurrent same-parent callers cannot duplicate codes. On full success, the durable cache via `checkOrInsert` is written before the inflight ledger is deleted — crashes in that window are harmless because the next replay hits the cache.

Refuses to file against `KILLED` or `SUPERSEDED` parents (`PARENT_TERMINAL`); validates parent code, description, rationale, status, and complexity at the boundary (`INVALID_INPUT`); surfaces partial failures as `PARTIAL_FOLLOWUP` with `stage` ∈ `{roadmap_regen, link, scaffold}` so callers know which granular tool to use for manual recovery.

**Added:**
- `compose/lib/followup-writer.js` — `proposeFollowup(cwd, args)` orchestrator + helpers (sha16, fingerprint, ledger I/O, per-parent lock, scaffold-with-rationale + rollback).
- `compose/test/followup-writer.test.js` — 26 unit tests.
- `compose/test/followup-writer-mcp.test.js` — 2 MCP wrapper smoke tests.
- `docs/features/COMP-MCP-FOLLOWUP/{design,blueprint,report}.md`.

**Changed:**
- `compose/server/compose-mcp-tools.js` — `toolProposeFollowup` thin wrapper.
- `compose/server/compose-mcp.js` — `propose_followup` tool definition + dispatch case.
- `compose/ROADMAP.md` — `COMP-MCP-FOLLOWUP` flipped to `COMPLETE`.

**Tests:** 26 new unit + 2 new MCP-end-to-end. Full suite: 2524 + 92 UI, all green.

### COMP-MCP-VALIDATE — Cross-artifact feature validator (`validate_feature`, `validate_project`)

Sub-ticket #7 of `COMP-MCP-FEATURE-MGMT`. Two new MCP tools cross-check ROADMAP row, vision-state item, feature.json, feature folder contents, linked artifacts, and cross-feature references. 27-kind drift catalog with `error`/`warning`/`info` severity. New `compose validate` CLI subcommand with configurable `--block-on` threshold. Pre-push hook template gates drift before push; default `compose hooks install` stays back-compat (post-commit only).

**Phase 0 (ROADMAP consolidation):** Six COMP-MCP-* sub-ticket rows moved from `forge/ROADMAP.md` to `compose/ROADMAP.md` Phase 7. Forge-top now hosts cross-product strategic items only. Standing rule: a feature's ROADMAP row lives in the project that owns the feature.

**Added:**
- `compose/lib/feature-validator.js` — `validateFeature(cwd, code, options?)` and `validateProject(cwd, options?)` (~600 lines). Composes ROADMAP scanner, vision-state loader, ArtifactManager.assess, and SchemaValidator. Path normalization for boundary-aware artifact-folder checks.
- `compose/contracts/{feature-json,vision-state,roadmap-row}.schema.json` — three new JSON Schemas. feature-json is permissive (`additionalProperties: true`) initially; tightening tracked as `COMP-MCP-VALIDATE-SCHEMA-TIGHTEN`.
- `compose/lib/feature-code.js` — extracted `FEATURE_CODE_RE_STRICT` + `validateCode()` from 3 writer sites (feature-writer, completion-writer, journal-writer). roadmap-parser keeps its own deliberately looser regex.
- `compose/server/compose-mcp.js` + `compose-mcp-tools.js` — `validate_feature` + `validate_project` tool registration and thin wrappers.
- `compose/bin/compose.js` — `compose validate [--scope] [--code] [--block-on] [--json] [--help]` subcommand. Refactored hooks installer to handle both post-commit and pre-push via type table; back-compat preserved.
- `compose/bin/git-hooks/pre-push.template` — runs `compose validate --scope=project --block-on=error`; non-zero exit blocks the push.
- 76 new tests across 7 files.

**Changed:**
- `compose/server/schema-validator.js` — generalized: optional `schemaPath` constructor arg (default still comp-obs), per-path cache, new `validateRoot()` method for top-level schemas, `loadSchema(path)` named export. 13 zero-arg test callers untouched.
- `compose/contracts/feature-json.schema.json` — `profile` widened from string-only to `oneOf: [string, object]` to match `COMP-DEBUG-1` legacy shape.
- `compose/.compose/data/vision-state.json` — T7 baseline fixes: `STRAT-COMP-8` complete→superseded, `COMP-UI-3` in_progress→complete (matched ROADMAP).
- `compose/docs/journal/README.md` — index entry added for pre-numbering-rule duplicate `2026-02-11-session-2-resumption.md` (T7 fix for journal-index drift).
- `compose/ROADMAP.md` — new Phase 7 with 9 COMP-MCP-* rows (6 COMPLETE, 1 IN_PROGRESS, 2 PLANNED).

**Snapshot:**
- 2498 unit + 92 UI + 44 integration tests pass. Pre-existing STRAT-DEDUP-AGENTRUN-V3 integration failure unrelated.
- Self-validation against compose's repo: 1 error (architectural folder-location baseline; resolves on ship), 491 warnings, 39 info.
- Six Codex review iterations total: three on design+blueprint+plan (max-5 reached on count + FEATURE_NOT_FOUND shape, both resolved by human), three on implementation (5+1+0 findings, ending REVIEW CLEAN).

## 2026-05-03

### COMP-MCP-PUBLISH — Slim `@smartmemory/compose-mcp` wrapper + MCP registry publish

Sub-ticket #6 of `COMP-MCP-FEATURE-MGMT`. Adds a slim wrapper package and tag-triggered CI workflow that publishes to npm and the official MCP registry under `io.github.smartmemory/compose-mcp`. The wrapper resolves and spawns the embedded server in `@smartmemory/compose` via `createRequire` + `require.resolve('@smartmemory/compose/mcp')` — single source of truth, registry discovery without code duplication.

**This commit ships wrapper + workflow only.** Publish happens via `git tag compose-mcp-v0.1.0 && git push --tags`, which fires the workflow.

**Added:**
- `compose/compose-mcp/{package.json,server.json,README.md,LICENSE,bin/compose-mcp.js}` — slim package skeleton at `@smartmemory/compose-mcp 0.1.0`. Spawn-based stdio launcher (~30 lines), exit 127 on resolve failure with actionable message.
- `compose/.github/workflows/publish-compose-mcp.yml` — triggers on `compose-mcp-v*` tags. Validates four version strings in lock-step (package.json, server.json top-level, server.json packages[0], tag). Installs deps + runs wrapper tests + `npm pack --dry-run` before `npm publish` (added per Codex review). `mcp-publisher` pinned to v1.2.6. PAT-bypass auth via `SMARTMEM_DEV_GITHUB_TOKEN` per `reference_mcp_registry_auth.md`.
- 21 new tests across `test/exports-map.test.js`, `test/compose-mcp-package.test.js`, `test/publish-compose-mcp-workflow.test.js`. Positive resolution smoke uses an ephemeral `node_modules/@smartmemory/compose` symlink to mirror what npm install creates for real consumers.

**Changed:**
- `compose/package.json` — added `exports` map: `./mcp` → `./server/compose-mcp.js` and `./package.json` self-export. Deliberately no `.` root export (would execute the CLI on `require('@smartmemory/compose')`). Hard regression boundary: any future external consumer needing a deep import path must be added here.

**Snapshot:**
- 2421 unit + 92 UI + 44 integration tests pass; 21 new from this feature. Pre-existing STRAT-DEDUP-AGENTRUN-V3 integration failure unrelated. Two Codex review iterations — found two medium release-path gaps (no test gate before publish, missing nested `packages[0].version` validation) — both fixed and locked in with workflow ordering tests.

### COMP-MCP-JOURNAL-WRITER — Journal writer ships

Sub-ticket #4 of `COMP-MCP-FEATURE-MGMT`. Two new MCP tools (`write_journal_entry`, `get_journal_entries`) route every `compose/docs/journal/` mutation and read through a typed surface. Cross-cutting MCP wrapper extension propagates `err.cause` for the whole writer family.

**Added:**
- `compose/lib/journal-writer.js` — `parseJournalEntry`, `parseJournalIndex`, `renderJournalEntry`, `writeJournalEntry`, `getJournalEntries` (~640 lines). Hand-rolled YAML-ish frontmatter codec; advisory-locked global session counter; HR + italic closing-line delimiter; two-file rollback on partial-commit failure (`err.code = JOURNAL_PARTIAL_WRITE`, `err.cause = <original>`).
- Two MCP tools: `write_journal_entry`, `get_journal_entries`.
- Journal-writer section in `docs/mcp.md` documenting frontmatter contract, error codes, rollback semantics.

**Changed:**
- MCP error wrapper in `server/compose-mcp.js` now serializes `err.cause` as `Caused by [CODE]: message` after the existing `Error [CODE]: message` envelope. Backward-compatible — no sibling regressions.
- `.claude/rules/journaling.md` — session numbering documented as global-monotonic (matches actual practice; supersedes the by-date claim).
- `docs/features/COMP-MCP-FEATURE-MGMT/design.md` Journal section — points at `COMP-MCP-JOURNAL-WRITER/design.md` as the canonical contract.

**Fixed:**
- Journal index parser preserves `postamble` (everything after the table) — was an internal-only concept that drifted between design and blueprint until Codex round 3 caught it.

**Snapshot:**
- 70 unit tests + 6 MCP e2e tests + 1 child-process fixture (`test/fixtures/mcp-fail-index-write.mjs`); full suite 2321 node + 92 vitest, 0 fail. Self-applied via `write_journal_entry` (session 37). Five Codex passes total — three pre-code on design/blueprint/plan, two post-code on the implementation — caught 14 actionable issues before ship.

### COMP-MCP-COMPLETION — Completion writer ships

Sub-ticket #5 of COMP-MCP-FEATURE-MGMT. Two new MCP tools (`record_completion`, `get_completions`) record completions bound to a full commit SHA, plus an opt-in PATH-independent post-commit hook that auto-records on `Records-completion: <CODE>` trailers.

**Added:**
- `compose/lib/completion-writer.js` — `recordCompletion`, `getCompletions`. Full-SHA identity (Decision 9), per-feature advisory lock (Decision 10), writer-stamped `feature_code` on every record (Decision 11). Reuses `lib/idempotency.js`, `lib/feature-events.js`, `lib/feature-writer.js#setFeatureStatus`.
- `compose/bin/git-hooks/post-commit.template` — hook template with `__COMPOSE_NODE__` / `__COMPOSE_BIN__` placeholders substituted at install time. Runtime hook is PATH-independent.
- `compose record-completion <CODE> --commit-sha=<full-sha> ...` CLI subcommand.
- `compose hooks install|uninstall|status` CLI subcommand. Refuses to overwrite a foreign post-commit without `--force`.
- Three new MCP tool error codes: `INVALID_INPUT`, `FEATURE_NOT_FOUND`, `STATUS_FLIP_AFTER_COMPLETION_RECORDED` (with three documented `err.cause` subcases including `ROADMAP_PARTIAL_WRITE`).
- Completion writer section in `docs/mcp.md`; CLI subcommand docs in `docs/cli.md`.

**Snapshot:**
- 80 new tests (50 unit + 6 MCP e2e + 19 CLI/hook + 5 hook-parser unit). Full suite 2403 node + 92 vitest, 0 fail. Self-applied via `recordCompletion` against `0c8d120`. 7 Codex doc-review rounds + 2 implementation-review rounds caught 17 issues before ship.

## 2026-05-02

### COMP-MCP-ARTIFACT-LINKER — typed MCP linker for artifacts + cross-feature relationships

Sub-ticket #2 of `COMP-MCP-FEATURE-MGMT`. Two writer + two reader MCP tools that make non-canonical artifacts (snapshots, journals, findings) and typed cross-feature links first-class and queryable. Reuses the framework established by `COMP-MCP-ROADMAP-WRITER` (idempotency keys, best-effort audit log, no HTTP delegation).

**New tools:**
- `link_artifact` — register a non-canonical artifact on a feature. Canonical artifacts (`design.md`/`prd.md`/etc. inside the feature folder) are auto-discovered and rejected here. Storage: additive `artifacts[]` field on `feature.json`. Dedups on `(type, path)`; `force: true` overrides.
- `link_features` — register a typed cross-feature relationship. Closed enum on `kind`: `surfaced_by`, `blocks`, `depends_on`, `follow_up`, `supersedes`, `related`. Self-links rejected. Target code need not exist (supports forward-references). Storage: additive `links[]` field on `feature.json`, source-only. Dedups on `(kind, to_code)`.
- `get_feature_artifacts` — read both canonical (via `ArtifactManager.assess`) and linked artifacts for a feature in one call. Each linked entry carries a current existence stamp.
- `get_feature_links` — read outgoing, incoming, or both directions; optional `kind` filter. Inverse query iterates `listFeatures` and filters.

**Path hardening on `link_artifact`:** must be repo-relative (no leading `/` or `~`); must not contain `..` after normalization; must resolve under `cwd`; symlink targets must also live under `cwd`; must point at an existing file (not directory). Mirrors `server/artifact-manager.js`.

**No bidirectional auto-mirroring** — a link from A → B lives on A only. Inverse queries via `direction: 'incoming'`. Intentional choice to avoid double-writes and reconciliation surface.

**Added:**
- `lib/feature-writer.js` — extended with `linkArtifact`, `linkFeatures`, `getFeatureArtifacts`, `getFeatureLinks`. `validateRepoPath` helper enforces the path-hardening rules.
- `server/compose-mcp.js`, `server/compose-mcp-tools.js` — four new tools registered.
- `test/feature-linker.test.js` (24 tests, unit), `test/feature-linker-mcp.test.js` (3 tests, end-to-end via spawned MCP child). Includes a self-skipping symlink-escape regression test.

**Changed:**
- `docs/mcp.md` — four new tool rows + an "Artifact + feature links" section documenting storage, path validation, link kinds, dedup semantics, and the no-mirroring choice.

Codex review three iterations to clean. Findings caught: `get_feature_artifacts` initially missing the canonical assessment per design (now returns both); `link_artifact` accepting directories; `getFeatureLinks` silently returning empty on bad `direction`; `link_artifact` accepting symlinks pointing outside the repo (fixed via `realpathSync` post-existence check, mirroring `server/artifact-manager.js`). Full suite 2099/2099 green after this ticket lands alongside the same-day COMP-PLAN-SECTIONS-REPORT.

### COMP-PLAN-SECTIONS-REPORT — Section roll-up in `report.md`

Closes the deferred Phase 8 roll-up acceptance criterion from COMP-PLAN-SECTIONS v1. After the post-ship trailer hook runs, compose now writes a mechanical, agent-free `## Section Roll-up` block to `<featureDir>/report.md`: section index with per-section change counts, "Unattributed files this commit" list (files in the ship commit not declared by any section), and a deviations summary. The roll-up regenerates in place on each ship; narrative content above the heading is preserved. The `build_sections_trailed` stream event payload gains an `unattributed: string[]` field. Failure isolation: roll-up write failure emits a separate `build_error` and never suppresses the trailer-success event.

**Added:**
- `lib/sections.js` — three new exports: `analyzeRollup({ sectionsDir, filesChanged })` (read-only analyzer; null when sections/ absent), `renderRollupBlock({ analysis, commit, date })` (pure renderer, no I/O), `writeRollup({ featureDir, analysis, commit, date })` (atomic same-directory temp+rename writer with cleanup-on-failure).
- `lib/build.js` — post-ship hook reordered: `appendTrailers` → `analyzeRollup` (shared try with trailer event) → emit `build_sections_trailed` with `unattributed` → `writeRollup` in own nested try/catch (failure emits `build_error` with `'sections rollup write failed:'` prefix, never suppresses trailer event nor downgrades ship).
- `test/sections-rollup.test.js` — 21 unit tests covering analyzer null/partition logic + H1 fallback, renderer format/short-SHA/date defaulting/None-list rendering, writer no-op/create/append/replace-in-place/atomic-tmp-cleanup.
- 5 new integration tests in `test/integration/build-sections.test.js` covering ship→roll-up, re-ship regenerated in place, unattributed flow to both report and stream, failure isolation via `renameSync` stub, and a static-source guard on hook wiring.

**Knobs:** none.

**Test results:** 2182 unit / 92 UI / 44 integration passed (2 pre-existing `STRAT-DEDUP-AGENTRUN-V3` integration failures unrelated to this feature).

Design: `docs/features/COMP-PLAN-SECTIONS-REPORT/design.md` · Blueprint: `docs/features/COMP-PLAN-SECTIONS-REPORT/blueprint.md` · Plan: `docs/features/COMP-PLAN-SECTIONS-REPORT/plan.md` · Report: `docs/features/COMP-PLAN-SECTIONS-REPORT/report.md`.

### COMP-MCP-ROADMAP-WRITER — typed MCP writers for roadmap mutations

First sub-ticket of `COMP-MCP-FEATURE-MGMT`. Three new MCP tools — `add_roadmap_entry`, `set_feature_status`, `roadmap_diff` — route every roadmap mutation through a typed surface so feature.json + ROADMAP.md stay consistent and every change leaves an audit trail. The writers run as pure file IO inside `lib/`; no HTTP delegation (sidesteps the architectural-review layering finding). Idempotency keys protect against retries; mutations append to `.compose/data/feature-events.jsonl`. Lifecycle transition policy enforced (PLANNED → IN_PROGRESS → COMPLETE etc.; COMPLETE → SUPERSEDED requires `force: true`). Audit-log append is best-effort: a failed append warns but does not roll back the committed mutation.

**Added:**
- `lib/idempotency.js` — file-locked `checkOrInsert(cwd, key, computeFn)` primitive with mkdir-based advisory lock and stale-lock recovery. Cache file `.compose/data/idempotency-keys.jsonl`, capped at 1000 entries, FIFO eviction.
- `lib/feature-events.js` — append-only audit log at `.compose/data/feature-events.jsonl`. `appendEvent(cwd, event)` stamps `ts` and `actor` (`process.env.COMPOSE_ACTOR` or `mcp:agent`); `readEvents(cwd, {since, code, tool})` filters with shorthand `since` (`24h`/`7d`/`30m` or ISO date).
- `lib/feature-writer.js` — `addRoadmapEntry`, `setFeatureStatus`, `roadmapDiff`. Calls into existing `lib/feature-json.js` (`writeFeature`/`updateFeature`) and `lib/roadmap-gen.js` (`writeRoadmap`). New entries default `position` to max-in-phase + 1 when omitted (preserves the "numbered sequentially" convention).
- `server/compose-mcp.js`, `server/compose-mcp-tools.js` — three new tools registered + thin handlers that pass `getTargetRoot()` to the lib functions.
- `test/idempotency.test.js`, `test/feature-events.test.js`, `test/feature-writer.test.js`, `test/feature-writer-mcp.test.js` — 55 new tests including end-to-end smoke tests that spawn the MCP server as a child process and exercise the tools over stdio JSON-RPC. Full suite: 2044/2044 pass (was 1993; +51 new).

**Changed:**
- `lib/roadmap-parser.js` — `SKIP_STATUSES` extended to include `KILLED` and `BLOCKED`. Without this, features marked `KILLED` or `BLOCKED` by the new writers would still surface as buildable in `compose roadmap` and the build-selection path (`bin/compose.js:928`).
- `docs/mcp.md` — documents the three new tools, the transition policy, the idempotency-key path, the audit log format, and the no-HTTP design choice.

### COMP-NEW-QUESTIONNAIRE-MISMATCH — pipeline-cli helpers now target any spec

`bin/compose.js:577-584` applied questionnaire review-agent choices ("Codex (automated review)" / "Skip review") for the kickoff pipeline by calling `pipelineSet`/`pipelineDisable`, but those helpers in `lib/pipeline-cli.js` hardcoded both the spec path (`pipelines/build.stratum.yaml`) and the flow name (`spec.flows.build`). The questionnaire's kickoff customization has been a silent no-op since the helpers were written — the `try/catch` around the call swallowed the resulting "step not found" error.

**Changed:**
- `lib/pipeline-cli.js` — every public export (`pipelineShow`, `pipelineSet`, `pipelineAdd`, `pipelineRemove`, `pipelineEnable`, `pipelineDisable`) gained an optional trailing `specName` parameter defaulting to `'build.stratum.yaml'`. `loadSpec` now derives the flow name from the filename (`<name>.stratum.yaml` → `<name>`) and returns it; every `spec.flows?.build` reference is now `spec.flows?.[flowName]`. Internal mutation helpers (`convertToGate`, `convertToReview`, `convertToAgent`) operate on the resolved `mainFlow`, so they pick up the new target automatically.
- `bin/compose.js:577-584` — questionnaire path passes `'new.stratum.yaml'` to both helpers and updates the catch comment to reflect the actual target.

**User-facing `compose pipeline ...` CLI is unchanged** — it still operates on `build.stratum.yaml` only. Editing the kickoff pipeline interactively is out of scope (no `--spec` flag added).

**Added:**
- `test/pipeline-cli-spec-target.test.js` — 4 tests covering: default path unchanged; `pipelineDisable` targets `new.stratum.yaml` when `specName` is passed (and leaves the build spec untouched); `pipelineSet --mode review` against a kickoff `review_gate` produces a codex sub-flow; missing spec throws cleanly. Full suite green: 1993/1993.

### COMP-NEW-PIPELINE-MISSING — Restore kickoff pipeline + fix two latent bugs

`pipelines/new.stratum.yaml` was deleted on 2026-03-16 in commit `e597e89` (the COMP-UX-1 cockpit batch — apparently unintentionally) and never restored. `bin/compose.js` and `lib/new.js` still required it; `compose new` would error out with "Kickoff spec not found" against any project that didn't already have a copy. `compose init`'s silent existence check on the package source kept the failure invisible during setup.

Restored verbatim from `e597e89^` (`git checkout e597e89^ -- pipelines/new.stratum.yaml`), then validated post-`validate`-strip against current Stratum (`stratum_validate` returned valid; `stratum_plan` resolved all 6 steps). Codex review of the restored file surfaced two pre-existing bugs that would still break `compose new --auto`; fixed inline:

**Fixed:**
- `pipelines/new.stratum.yaml` — restored from git history.
- **brainstorm step**: rewrote the intent so `compose new` works whether or not research ran. The questionnaire can disable research (`bin/compose.js:573`); when skipped, `$.steps.research.output.summary` is `null` and `docs/discovery/research.md` doesn't exist. The intent now reads "If `docs/discovery/research.md` exists, read it first for prior-art context. Otherwise proceed from the product intent alone — research is an optional input."
- **scaffold step**: replaced a misaimed `validate` block (it pointed at `ROADMAP.md` but the criterion was about feature folders, which the artifact-only validator can't enumerate) with `ensure: - "len(result.created) > 0"` against the `ScaffoldResult.created` array. The step now actually fails its postcondition if scaffold reports zero files created.

**Doc updates:**
- `docs/cli.md` — dropped the "currently absent" note from `compose new`.
- `docs/pipelines.md` — dropped both "absent from the shipped package" notes (kickoff section + Pipeline Specs table).

**Filed for follow-up:**
- `COMP-NEW-QUESTIONNAIRE-MISMATCH` — the questionnaire's "Skip review" / "Codex review" options call `pipelineSet`/`pipelineDisable`, but those helpers only mutate `build.stratum.yaml`. They've been silently no-op'ing for kickoff. Code bug in `bin/compose.js`, not the pipeline file.

### COMP-DOCS-FACTS — Reconcile compose docs with current code

Three rounds of Codex review against `bin/compose.js`, `server/compose-mcp.js`, and the shipped pipeline specs corrected pre-existing factual drift surfaced during the COMP-DOCS-SLIM review. No code changes; one finding (missing `pipelines/new.stratum.yaml`) is a packaging gap filed separately as `COMP-NEW-PIPELINE-MISSING`.

**Changed:**
- `docs/cli.md` — expanded from 9 to all 17 CLI verbs (added `roadmap`, `install`, `fix`, `triage`, `ideabox`, `qa-scope`, `gates`, `loops`); corrected `compose build` flag set (`--all`, `--dry-run` is batch-only, `--skip-triage`, `--cwd`, `--team`, `--template`, multi-code, prefix); fixed `compose import` consumer claim (only `compose new`); fixed `compose ideabox add` flag name (`--desc`); corrected `ideabox promote` and `ideabox list` descriptions; added `bisect` step to `compose fix` pipeline.
- `docs/pipelines.md` — replaced "5 specs" inventory with shipped 7 plus the absent-but-expected `new.stratum.yaml`; fixed Stratum IR field name (`version: "0.3"`, not `ir_version`); corrected `review`/`codex_review` retry documentation (outer steps use defaults; inner `review_check` is 5); expanded `ReviewResult` to canonical shape (`meta`, `lenses_run`, `auto_fixes`, `asks`); added `bisect` step to bug-fix lifecycle row.
- `docs/mcp.md` — removed `agent_run` row (tool removed 2026-04-18 per `STRAT-DEDUP-AGENTRUN`) and added a deprecation note pointing to `mcp__stratum__stratum_agent_run`; corrected `report_iteration_result` outcome enum to runtime values (`clean`, `max_reached`, `action_limit`, `timeout`, `null` while running).
- `docs/lifecycle.md` — corrected `review_check` retry default from 10 to 5.

### COMP-MCP-CHANGELOG-WRITER — typed MCP writer + reader for compose/CHANGELOG.md

Sub-ticket #3 of `COMP-MCP-FEATURE-MGMT`. Two MCP tools — `add_changelog_entry` and `get_changelog_entries` — route every `compose/CHANGELOG.md` mutation and read through a typed surface. Reuses the framework established by `COMP-MCP-ROADMAP-WRITER` (idempotency keys, best-effort audit log, no HTTP delegation) and `COMP-MCP-ARTIFACT-LINKER` (atomic tmp+rename writer pattern). Format enforcement is structural, not lexical: the writer renders canonical Added → Changed → Fixed → Snapshot subsections from typed inputs; the parser is permissive of pre-existing prose variation (existing entries with non-canonical labels are preserved as-is).

Two-layer dedup: storage-level (`(date_or_version, code)` lookup across **all** matching surfaces — the file legitimately has duplicate `## 2026-05-02` headings; first/topmost wins on insert) plus optional caller-supplied `idempotency_key` for retry safety. `force: true` replaces in place. Storage-level no-op skips the audit append per design Decision 2.

Typed errors via `err.code`: `INVALID_INPUT` (bad code/date/sections key) and `CHANGELOG_FORMAT` (missing H1 on non-empty file). MCP wrapper extended to surface them as `Error [CODE]: message` so callers can branch deterministically.

Codex review three iterations to clean. Findings caught: reader was discarding `unknownLabels` (e.g. `**Knobs:**`, `**Test results:**`); subsection regex couldn't parse digit-bearing labels like `**Phase 7 review-loop fixes:**`; `inserted_at` lookup was global, returning the wrong line when the same code appeared on multiple surfaces; idempotent no-ops were appending audit rows in violation of design; MCP wrapper was stripping `err.code`.

**Added:**
- `lib/changelog-writer.js` — `parseChangelog` (permissive single-pass parser), `renderEntry` (strict canonical renderer), `addChangelogEntry`, `getChangelogEntries`. Atomic tmp+rename mirroring `lib/sections.js:writeRollup`. Reuses `lib/idempotency.js` and `lib/feature-events.js` framework.
- `server/compose-mcp.js`, `server/compose-mcp-tools.js` — two new tools registered. MCP error wrapper now serializes `err.code` as `Error [CODE]: message` envelope when present (cross-cutting; backward-compatible).
- `test/changelog-writer.test.js` (38 tests) + `test/changelog-writer-mcp.test.js` (3 tests). Coverage includes: parser round-trip on real `CHANGELOG.md`; duplicate same-label surfaces; force replace targets first surface; same code on different dates returns correct line; idempotent no-op skips audit; typed error codes; reader surfaces `unknownLabels`; digit-bearing labels.

**Changed:**
- `docs/mcp.md` — two new tool rows + a "Changelog writer" section documenting two-layer dedup, format enforcement, audit semantics, typed error codes, and the no-HTTP design rationale.

## 2026-05-02

### COMP-DOCS-SLIM — Slim README into attractor + 9 topic subpages

Reshaped `compose/README.md` from 1025 lines to a 75-line technical attractor (what-it-is paragraph, three-bullet pitch, 30-second example, quick install, documentation index). Detailed content moved verbatim into nine new topic-scoped subpages under `compose/docs/`: `install.md`, `cli.md`, `cockpit.md`, `pipelines.md`, `agents.md`, `lifecycle.md`, `configuration.md`, `mcp.md`, `examples.md`. Pure docs refactor — no code change. Pre-existing factual drift (missing CLI verbs, stale MCP tool list, retry counts, IR field name) deliberately preserved during the move and filed for follow-up as `COMP-DOCS-FACTS`.

**Added:**
- `compose/docs/{install,cli,cockpit,pipelines,agents,lifecycle,configuration,mcp,examples}.md` — topic-scoped reference pages; absorb every former README H2 section.

**Changed:**
- `compose/README.md` — rewritten as 75-line attractor with 5 blocks plus documentation index linking to all 9 new subpages and the existing top-level docs (PRD, ROADMAP, taxonomy, PRODUCT-SPEC, compose-one-pager).

**Snapshot:**
- `docs/features/COMP-DOCS-SLIM/README.original.md` — original 1025-line README preserved for diff/audit.

## 2026-05-01

### COMP-PLAN-SECTIONS — Per-section plan files with "What Was Built" trailers

When a feature plan's task count exceeds `COMPOSE_PLAN_SECTIONS_THRESHOLD` (default 5, env-tunable, clamped to ≥1), Compose now emits per-task `docs/features/<code>/sections/section-NN-<slug>.md` files alongside the consolidated `plan.md` after the plan gate is approved. After the feature-final ship step records a commit, an append-only "What Was Built" trailer is written to each section file with `git diff --stat` filtered to that section's declared files (declared-but-unchanged files surfaced as deviations). Re-runs append `iteration N` blocks. v1 ships sections + trailers only; the Phase 8 report-path roll-up and "changed-but-undeclared" attribution are deferred to follow-up `COMP-PLAN-SECTIONS-REPORT`.

**Added:**
- `lib/sections.js` — `SECTIONS_DIR` consumer; `slugify`, `parseTaskBlocks`, `extractSectionFiles`, `shouldEmitSections`, `emitSections` (idempotent — never overwrites existing section files), `appendTrailers` (append-only, max-N iteration counting via regex over existing trailers), `computeFilteredDiffStat` (per-section filtered `git diff --stat` via `execFileSync` argv — shell-injection safe).
- `lib/build.js` — `maybeEmitSectionsAfterPlanGate(stepId, featureDir, opts)` helper invoked from all three plan-gate approve branches (`policy.mode === 'skip'`, `'flag'`, and human gate with `outcome === 'approve'`). Post-ship trailer-append wrapped in try/catch — trailer failure emits a `build_error` stream event but never fails the ship. `executeShipStep` returns additive `commit` and `filesChanged` fields, each best-effort (failure leaves field empty, ship outcome stays `'complete'`); now exported for testing.
- `lib/constants.js` — `SECTIONS_DIR = 'sections'` (separate top-level export, not a `GATE_ARTIFACTS` entry); `getSectionsThreshold()` reads `COMPOSE_PLAN_SECTIONS_THRESHOLD` (unparseable → 5; finite → `Math.max(1, raw)`).
- `test/sections-constants.test.js`, `test/sections.test.js`, `test/build-ship-fields.test.js`, `test/integration/build-sections.test.js` — 45 new tests covering threshold gating, idempotent emission, append-only trailers, max-N iteration counting, three-branch wiring, best-effort metadata, and a shell-injection regression (`$(echo PWN).txt` declared file).

**Hardened:**
- `executeShipStep` `git add` and `git commit` calls switched from `execSync(shellString)` to `execFileSync('git', argv)` to close a latent shell-injection class on user-controlled inputs (filenames, feature description). Pre-existing risk in the same workflow we touched.

**Knobs:**
- `COMPOSE_PLAN_SECTIONS_THRESHOLD` — int; default 5; clamp ≥1. Set to a high value to disable section emission; set to 1 to emit sections for every multi-task plan.

**Test results:** 2102 unit / 92 UI / 39 integration passed (2 pre-existing `STRAT-DEDUP-AGENTRUN-V3` integration failures unrelated to this feature).

Design: `docs/features/COMP-PLAN-SECTIONS/design.md` · Blueprint: `docs/features/COMP-PLAN-SECTIONS/blueprint.md` · Plan: `docs/features/COMP-PLAN-SECTIONS/plan.md` · Report: `docs/features/COMP-PLAN-SECTIONS/report.md`.

### COMP-FIX-HARD — Hard-bug machinery on the bug-fix pipeline

The 8-step `bug-fix.stratum.yaml` pipeline (shipped as part of COMP-FIX) handled easy and medium bugs but failed silently on hard ones: retries re-proposed disproven hypotheses, `test` exhaustion vanished into the failed-build handler with no recovery state, regression bugs got no `git bisect` help, fix-chain detection was session-scoped, and escalation flagged-but-didn't-act. COMP-FIX-HARD adds the persistent state, structured second opinions, and fresh-context retry path needed for genuinely hard bugs — without slowing the easy cases.

**Added:**
- `lib/bug-ledger.js` — JSONL hypothesis ledger at `docs/bugs/<code>/hypotheses.jsonl`. `appendHypothesisEntry` is idempotent on `(attempt, ts)`; `readHypotheses` tolerates malformed lines; `formatRejectedHypotheses` emits the markdown block injected into diagnose retry prompts.
- `lib/bug-checkpoint.js` — emits `docs/bugs/<code>/checkpoint.md` on Compose-side retry-cap exhaustion. Captures current diff (truncated at `DIFF_CAP=5000` chars; `git diff` `maxBuffer` 2MB), last failure, ledger pointer, and a `compose fix <code> --resume` command for the operator.
- `lib/bug-index-gen.js` — renders `docs/bugs/INDEX.md` from per-bug checkpoints. Atomic tmp+rename write. Same pattern as `roadmap-gen.js`.
- `lib/bug-bisect.js` — `classifyRegression` heuristic (test in main + affected files touched in last 10 commits), `estimateBisectCost` with a 5-min sample timeout, `findKnownGoodBaseline` (v* tags → release-* → HEAD~50), `runBisect` driving `git bisect run` and capturing log to `docs/bugs/<code>/bisect.log`, always with `git bisect reset` in finally.
- `lib/bug-escalation.js` — Tier 1 Codex second opinion (read-only via `stratum.runAgentText('codex', ...)`, parses to canonical `ReviewResult`, appends to ledger as `verdict: 'escalation_tier_1'`) and Tier 2 fresh `claude` agent in detached-HEAD worktree (Tier 2 fires when Jaccard token-overlap < 0.7 vs every prior `rejected` ledger entry; ≥ 0.7 suppresses; produces patch artifact at `docs/bugs/<code>/escalation-patch-N.md`; never commits).
- `pipelines/bug-fix.stratum.yaml` — new `bisect` step + `BisectResult` contract inserted between `diagnose` and `scope_check`. `scope_check.depends_on` retargeted.
- `bin/compose.js` — `compose fix <code>` reads `docs/bugs/<code>/description.md`, scaffolds and exits if missing. New `--resume` flag refuses cross-mode resume.

**Changed:**
- `lib/build.js` — `runBuild` accepts `opts.mode: 'feature' | 'bug'`. Single `resolveItemDir(code)` resolver routes `docs/features/` vs `docs/bugs/` at all three `featureDir` binding sites. `startFresh` dispatches `stratum.plan` with `{task: description}` in bug mode. `context.mode` and `context.bug_code` threaded throughout. Feature-JSON updates gated behind `!isBugMode`. Compose-side retry-cap enforcement: `parseRetriesCap(specYaml)` builds a per-step cap map; when `iterN > maxIter`, force-terminate and (in bug mode for `{test, fix, diagnose}` steps) emit a checkpoint. Active-build state now carries `mode` and `pid`; resume refuses cross-mode and refuses if another live process owns the build. `recordDiagnoseSuccessIfBugMode` helper called from both top-level and child-flow step-completion paths so retries see prior accepted hypotheses.
- `lib/step-prompt.js` — `buildRetryPrompt` prepends `formatRejectedHypotheses` block when retrying `diagnose` in bug mode. Single injection point covers both `build.js:1244` and `build.js:2133` retry call sites.
- `lib/debug-discipline.js` — `AttemptCounter` and `FixChainDetector` rewritten around per-bug `byBug` Map. Existing global API preserved via synthetic `__feature_mode__` slot. `fromJSON` now folds top-level legacy fields into `__feature_mode__` (was `__legacy__` — orphaned slot with no public reader).

**Phase 7 review-loop fixes (3 rounds, 14 findings):** partial-migration data loss in `fromJSON`; `isMateriallyNew` substring containment too aggressive (rewritten to Jaccard ≥ 0.7) and zero-token edge case (treats un-tokenizable Codex summary as novel); Tier 2 worktree create wrapped in try/catch with `rm -rf` cleanup; `estimateBisectCost` 5-min sample timeout; `getCurrentDiff` `maxBuffer` set to 2MB (50MB OOM risk → over-corrected to 20KB → 2MB sweet spot); resume path live-pid check + mode persistence + cross-mode refusal at all three resume entry points; attempt numbering `max+1` not `length+1` to prevent collisions.

**Tests:** 91 new test cases across 12 new test files. Suite at 2064 node + 92 vitest, zero failures.

**Follow-up tickets filed:** COMP-MAXITER-DRIFT (cosmetic log fix), COMP-BUG-FORMATTER (`compose bug show <code>`), STRAT-RETRIES-ENFORCE (Stratum-side enforcement; the YAML's `retries:` field is currently declared-but-ignored in `stratum_mcp/executor.py` — Compose enforces in the consumer for now).

### COMP-DEPS-PACKAGE — External skill dependency manifest + `compose doctor`

`compose setup` previously only synced compose-owned skills; the lifecycle's references to external skills/commands (`superpowers:*`, `interface-design:*`, `codex:review`, `refactor`, `update-docs`) had no install check, no warning when missing, and no documented degrade behavior. On a fresh-box install the lifecycle would die mid-phase the first time it invoked a missing dep.

**Added:**
- `compose/.compose-deps.json` — manifest of 12 external skill/command deps with `id`, `required_for`, `install`, `fallback`, `optional` fields. Single source of truth for dep IDs and per-dep degrade behavior.
- `compose/lib/deps.js` — `loadDeps()`, `checkExternalSkills()`, `printDepReport()`. Scans five filesystem patterns (bare `~/.claude/skills/`, marketplace skills A/B, marketplace commands A'/B', versioned cache C). Bare-vs-namespaced match split prevents false positives.
- `compose doctor` CLI subcommand. `--json` for machine-readable output (full dep records), `--strict` for non-zero exit on missing required deps, `--verbose` lists scanned paths.
- `compose setup` now runs the dep check at the end and copies `.compose-deps.json` next to the installed compose SKILL.md so the lifecycle can read it as a fallback when the CLI is unreachable.
- `compose/test/comp-deps-package.test.js` — 16 tests covering manifest schema, drift guard (every manifest ID appears in SKILL.md), bare-vs-namespaced false-positive guard, full-record JSON output, and live `compose doctor` subprocess.

**Fixed:**
- `package.json` `files` allowlist now includes `.compose-deps.json`, `.claude/skills/**`, and `skills/**`. Previous published installs printed `Warning: no skills found to install` because the skill source dirs weren't in the allowlist — silently broken since adoption.

**Updated:**
- `compose/.claude/skills/compose/SKILL.md` §Dependencies — replaced the per-dep external-deps table with a pointer to the manifest as source of truth, plus a "Degrade pattern" subsection describing how the lifecycle uses `compose doctor --json` at Phase 1 entry.

## 2026-04-27

### COMP-AGENT-CAPS-5 — Capability enforcement: integration test, settings UI, severity bucketing

Three polish items completing COMP-AGENT-CAPS-4 (commit `03ebfff`):

**D1 — Integration test for enforcement block/log modes** (`test/capability-enforcement-block.test.js`, new, 9 tests):
Inline reimplementation of the post-step enforcement block from `build.js:763-794` driven by synthetic tool observations. Test 1: `enforcement: 'block'` + disallowed tool throws `StratumError('CAPABILITY_VIOLATION')` with the offending tool names in the message. Test 2: `enforcement: 'log'` (default) — same input, no throw, `capability_violation` event emitted with correct severity. Also covers: absent `settings.json` defaults to `log`; multiple violations reported together in block mode; `violation` vs `warning` severity bucketing in log mode.

**D2 — Settings UI** (`src/components/vision/SettingsPanel.jsx`, modified):
Added "Capability Enforcement" section with a `log` / `block` radio group. Uses the existing `onSettingsChange({ capabilities: { enforcement: value } })` pattern — no new state manager or mutation layer. The `capabilities` section is already a supported top-level key in `settings-store.js` and the PATCH `/api/settings` route. Helper text: "Block stops the build on disallowed tool use; Log records but continues."

**D3 — Build summary bucketing** (`lib/build-stream-writer.js`, `lib/build.js`, `server/build-stream-bridge.js`, `src/components/vision/visionMessageHandler.js`, `src/components/cockpit/ContextStepDetail.jsx`, `src/App.jsx`, modified):
`writeViolation` previously omitted the `severity` field (`'violation'|'warning'`). Added it as an optional param (default `'violation'`). `build.js` now passes `check.severity`. The bridge lacked a `capability_violation` case — events fell to `default: return null` and never reached the UI. Added the bridge case forwarding all fields including `severity`. `visionMessageHandler.js` now accumulates `capability_violation` events into `activeBuild.capabilityEvents`. `ContextStepDetail` accepts a `capabilityEvents` prop and renders a bucketed count: `N findings (X violations, Y warnings)`. `App.jsx` passes `activeBuild?.capabilityEvents`.

**Tests:** 1920 node + 87 UI, 0 failures.

### STRAT-XMODEL-PARITY — Route runCrossModelReview synthesis through canonical normalizer

`runCrossModelReview` in `build.js` previously used a hand-rolled `text.match(/\{[\s\S]*\}/)` + `JSON.parse` block to parse synthesis output, producing a `{consensus, claude_only, codex_only}` shape outside the canonical `ReviewResult` contract. Synthesis output now routes through a new `normalizeCrossModelResult` normalizer that applies the same parse + repair-retry + text-mode fallback + `applied_gate` stamping + `clean` derivation machinery as `normalizeReviewResult`.

A concrete correctness bug was caught and fixed during review: the `codexAsFallback` object used `confidence: 6, applied_gate: 7` — sub-gate, causing all fallback Codex findings to be silently dropped by the normalizer, incorrectly returning `clean: true` on synthesis failure. Fixed by raising fallback confidence to 7 (at-gate).

**New files:**
- `contracts/cross-model-review-result.json` — JSON Schema draft-07 for `CrossModelReviewResult`: extends `ReviewResult` with `consensus`, `claude_only`, `codex_only` arrays of canonical finding items. Sets `_source`/`_roadmap` provenance fields per convention.
- `lib/review-normalize.js` — `normalizeCrossModelResult(rawText, opts)` + `buildCrossModelRepairPrompt` helper added. Normalizes all three partitioned arrays: severity vocab, applied_gate stamping, confidence gate filtering. Falls back to `claudeFindingsFallback`/`codexFindingsFallback` arrays on parse failure.

**Modified:**
- `lib/build.js` — `normalizeCrossModelResult` imported and wired at the synthesis parse site. `codexAsFallback` confidence raised to 7. Synthesis prompt updated to instruct emission of `CrossModelReviewResult` schema with canonical severity/confidence. JSDoc updated.
- `test/cross-model-review.test.js` — replaced "intentionally outside canonical" documentation test with proper `CrossModelReviewResult` schema assertions. Added `normalizeCrossModelResult` test suite: canonical shape, severity normalization, confidence gate filtering, applied_gate stamping, clean derivation, fallback behavior on parse failure.

**Tests:** 1911 node + 87 UI tests, 0 failures. 2 Codex review iterations; prior iteration surfaced the confidence gate bug; second iteration returned REVIEW CLEAN.

### STRAT-CLAUDE-EFFORT-PARITY — Unify Claude/Codex review output contract

Both review paths in compose's build pipeline (`review_check` Codex single-pass and `parallel_review` Claude+lens multi-pass) now produce a single canonical `ReviewResult` schema. Severity vocabulary unified (`must-fix`/`should-fix`/`nit`), confidence scale standardized (1–10), `clean` derivation moved out of the model into a deterministic post-hoc reducer. Downstream consumers — `vision-routes.js:452 result.clean === true` gate, `selective-rerun.test.js`, `lib/health-score.js`, the `.compose/prior_dirty_lenses.json` sidecar — work unchanged.

**New files:**
- `contracts/review-result.json` — canonical JSON Schema (first contract in this dir; sets `_source`/`_roadmap` provenance convention).
- `lib/review-prompt.js` — shared prompt scaffold builder (severity vocab, confidence scale, output format, per-model nudge).
- `lib/review-normalize.js` — parse + one-shot repair retry + text-mode regex fallback + `applied_gate` stamping + deterministic `clean` derivation + summary synthesis.

**Modified:**
- `lib/build.js` — `buildReviewPrompt` wired at all 3 call sites (main 685, retry 1247, parallel-task 2655). `reduce_mode: "true"` flag gates scaffold prepend on the merge step (reducer gets normalization, not reviewer framing). Symmetric retry-path gating. `runCrossModelReview` JSDoc + synthesis prompt strings updated (parser unchanged).
- `lib/review-lenses.js` — 5 occurrences of `LensFinding` in description strings renamed to "ReviewResult finding". `reasoning_template` field preserved.
- `lib/health-score.js` — JSDoc renames; removed dead `?? mergedResult.all_findings` fallback.
- `pipelines/build.stratum.yaml` — dropped `LensFinding`/`LensResult`/`MergedReviewResult` contracts; added canonical `ReviewResult`. Rewrote `review_check`, `review_lenses`, `merge` step bodies. `>= 80` → `>= 7`. `reduce_mode: "true"` on merge step.
- `pipelines/review-fix.stratum.yaml` — `>= 80` → `>= 7`.
- `presets/team-review.stratum.yaml` — drop local `MergedReviewResult`; reference canonical; rename `LensFinding[]`; `reduce_mode` on merge.

The `review_mode` hook scaffold in `lib/result-normalizer.js` shipped with the prior commit (STRAT-DEDUP-AGENTRUN-V3); this commit activates it.

**Tests:** `test/review-parity.test.js` (new, 32 tests) covers parity assertions across Claude/Codex paths, schema validation, applied_gate stamping, repair-retry, scaffold-injection, reduce_mode gating, single-cert-block. `test/cross-model-review.test.js` extended with 3 canonical-schema tests. `test/selective-rerun.test.js` (14/14) and `test/review-lenses.test.js` (32/32) pass without modification. **Full suite: 1906 node + 87 UI tests, 0 failures.**

**Process:** 3 review iterations on the blueprint (5 must-fix, 7 should-fix, 5 nits surfaced and resolved before code) and 3 review iterations on the implementation (caught a critical unwired-deliverable: `buildReviewPrompt` shipped as dead code on first pass — runtime parity didn't exist until iteration 2 fix).

**Why:** Closes the parity gap flagged as a follow-up in `STRAT-DEDUP-AGENTRUN-V3` (2026-04-26). Two paths feeding the same `result.clean === true` gate must emit the same shape.

**Out of scope (follow-ups):** `STRAT-XMODEL-PARITY` (`runCrossModelReview` synthesis output canonicalization); `STRAT-CALIBRATION` (confidence-scale calibration spike); compose-reviewer fallback agent migration (still on 0–100 scale).

## 2026-04-26

### STRAT-DEDUP-AGENTRUN-V3 — Retire Compose's Node connector tree

Removed all 6 JS connector files (`server/connectors/{agent,claude-sdk,codex,opencode,connector-discovery,connector-runtime}-connector.js`) and the `connectors/` directory. All internal agent dispatch now flows through `mcp__stratum__stratum_agent_run` over the persistent stdio MCP session. `stratum_agent_run` extended to emit typed `BuildStreamEvent`s via `ctx.report_progress` — preserves cockpit visibility for one-off agent calls (gates, single steps, child flows, retries) that previously went through the JS tree.

**Producer:** Python `ClaudeConnector`/`CodexConnector` `stream_events()` extended to yield `step_usage` ConnectorEvents (post-Codex-review fix — was silently zero before). New `stratum_cancel_agent_run(correlation_id)` MCP tool. `make_agent_connector` accepts tier primitives (`allowed_tools`/`disallowed_tools`/`thinking`/`effort`).

**Consumer:** `lib/stratum-mcp-client.js` gains `agentRun()` / `runAgentText()` / `cancelAgentRun()`. `lib/result-normalizer.js#runAndNormalize` reimplemented on top of `agentRun()` + `onEvent()` — public `(connector, prompt, dispatch, opts) → {text, result, usage}` shape preserved (first arg ignored). 18 call-sites migrated across `build.js`, `new.js`, `import.js`, `step-validator.js`. Server surfaces (`vision-server.js`, `compose-mcp-tools.js`, `design-routes.js`) migrated; `design-routes.js` uses lazy `StratumMcpClient` singleton + SSE bridging from typed envelopes.

**Codex review (Phase 7) caught two blockers — both fixed before ship:** schema double-injection (client + server both injected) and missing `step_usage` envelope emission (cost telemetry silently zero on streaming path).

**Retired:** `stratum/stratum-mcp/tests/test_codex_connector_sync.py` (interim drift guard — failure class is now structurally impossible). 3 connector-specific test files deleted.

**Tests:** stratum-mcp 889 + 8 new = 889 pass; compose 1871 unit + 87 UI + 32 integration = 1990 pass. **Aggregate: 2,879 passing, 0 regressions.** Live E2E confirms typed envelope wire (`agent_started` + `agent_relay` + `step_usage` with contiguous per-scope seq, correct flow_id/step_id, task_id absent).

**Diff totals:** stratum +596 / -127; compose +1,131 / -1,693. Net **-1,093 lines** across both repos.

**Why:** Eliminates the two-trees drift class structurally. The 2026-04-19 codex hang (Python on opencode while JS on direct codex) is exactly what this prevents. Closes the `STRAT-DEDUP-AGENTRUN` umbrella.

**Known follow-ups:** `STRAT-CLAUDE-EFFORT-PARITY` (Claude SDK has no `effort` param — accepted but no-op, matches prior JS behavior); `connector-factory-shim.js` retained for ~6 legacy tests using `connectorFactory:` injection (debt; tests should migrate to `opts.stratum`).

### STRAT-PAR-STREAM — Typed event streaming for parallel_dispatch

Added server-push event channel from stratum-mcp to Compose during `parallel_dispatch`. Producer-side: `ClaudeConnector` and `CodexConnector` gain `stream_events()` async iterators yielding connector-local `ConnectorEvent`s; `parallel_exec._run_one` mints `BuildStreamEvent` envelopes (per-`(flow_id, step_id, task_id)` `seq`) and forwards via `ctx.report_progress(message=json)`. Consumer-side: `lib/stratum-mcp-client.js` gains `onEvent(flowId, stepId, handler)`; `executeParallelDispatchServer` subscribes before the polling loop (subscription cleanup wrapped in `try/finally`), forwards valid v0.2.5 envelopes to `BuildStreamWriter`; `build-stream-bridge` maps to SSE `{type: 'buildStreamEvent', event}`.

**Schema bump:** CONTRACT v0.2.4 → v0.2.5 (additive). New `BuildStreamEvent` 12-kind discriminated union: 3 live (`agent_started`, `tool_use_summary`, `agent_relay`) + 3 reserved (`iteration_update`, `tier_result`, `health_event`) + 6 legacy imports from `BuildStreamWriter` with open metadata.

**Tests:** stratum-mcp 892 pass (883 existing + 9 new); compose 1902 unit + 87 UI + 28 integration pass; 0 regressions. **Aggregate: 2,909 tests passing.**

**Why:** Gates `STRAT-DEDUP-AGENTRUN-V3`. Without typed streaming, retiring the Node connector tree would silently downgrade cockpit visibility to coarse polling-only updates. v3 effort drops from ~2 weeks to 4–6 days now that the streaming path is settled.

**Out of scope (follow-ups):** `STRAT-PAR-STREAM-LEGACY-CLOSE` (tighten 6 legacy kinds to closed metadata, schema v0.2.6); `STRAT-PAR-STREAM-CONSUMER-VALIDATE` (consumer-side schema validation of received envelopes); cockpit UI renderer for the new typed events; PII redaction policy. End-to-end smoke test of the live Python↔Node↔SSE↔UI loop is an open thread.

## 2026-04-25

### Wave 6 close — integration review signed off

All seven Situational Awareness features shipped against the v0.2.4 contract. Sign-off note authored at `docs/features/COMP-OBS-CONTRACT/integration-review.md`. Wave-6 batch test suite (`npm run test:wave-6`) is 59-pass, 0-fail, 0-skip; full compose suite is **1897 pass, 0 fail, 0 skips**. Stale `COMP-OBS-BRANCH/feature.json` corrected (status was still `PLANNED` from before the 2026-04-20 ship; now `COMPLETE` with `completed: 2026-04-20` and `ship_commit: 644587d`). ROADMAP.md `## Wave 6` heading marked `COMPLETE (2026-04-25)`.

### COMP-OBS-STEPDETAIL — Step Detail surface + budget pill (Wave 6 complete)

Final Wave 6 feature. UI-extension only — no schema bump. Three new sections in `ContextStepDetail` (retries summary, postcondition violations, live iteration counters), a compact budget pill on the ops strip, and a read-only `GET /api/lifecycle/budget` endpoint backed by the existing budget ledger.

**Server:**
- `lib/budget-ledger.js` extended with `readBudget(composeDir, featureCode, settings)` returning `{feature_total, per_loop_type: {review, coverage}, computed_at}`. The ledger does not currently break out per-loopType usage; v1 reports `feature_total.usedIterations` against each loopType's `maxTotal` (documented limitation; ledger refinement is a follow-up).
- `server/vision-routes.js` adds `GET /api/lifecycle/budget?featureCode=<FC>` with 400 on missing featureCode.

**Client:**
- `src/components/cockpit/stepDetailLogic.js` *(new)* — pure helpers `selectRetriesSummary`, `selectViolations`, `findLoopForStep`, `selectLiveCounters`, `formatBudgetCompact`.
- `src/components/cockpit/ContextStepDetail.jsx` rewritten: replaced the self-fetch path (was at :184-212, fired once per `stepId` change) with `useVisionStore` subscription on `activeBuild` + `iterationStates`, so the existing 5s store poller drives updates instead of a one-shot. Promoted the existing `step.retries` and `step.violations` render blocks into clearly-labeled "Retries" and "Postcondition violations" sections (earlier draft inverted the field name — the shipped data is `violations`, not `postconditions`). Added a "Live counters" section gated on `findLoopForStep` returning a running loop, with per-second tick. Net line count dropped from 478 → 350 because the deleted self-fetch effect was larger than the three new sections.
- `src/components/cockpit/OpsStrip.jsx` gains a compact budget pill (`r 5/15 · c 8/15`) when the active feature has any non-null `maxTotal`. Fetched once per featureCode change, refetched when the iteration-count sum changes (proxy for "an iteration completed" without coupling to a specific WS message type).

**Notes:**
- Per-attempt retry timeline is **out of scope for v1** — shipped `iterationStates` is a latest-snapshot `Map` (no per-attempt history). Retries section therefore renders the scalar `step.retries` count from build state.
- Step → loop join walks `iterationStates.values()` and matches on `iter.stepId === stepId`. If iteration entries lack `stepId`, the live-counters section degrades gracefully without a per-step lookup.
- No schema change. STEPDETAIL is UI-extension only.

**Tests:** 39 new (7 budget-route + 27 step-detail-logic + 17 context-step-detail UI + 5 ops-strip-budget UI + 5 wave-6 integration STEPDETAIL slices). Full suite: **1897 pass, 0 fail, 0 skips**.

### COMP-OBS-DRIFT — Mechanical drift axes + ribbon (Wave 6 data plane closed)

Final Wave 6 data-plane feature. Three deterministic ratios per feature recompute on every state-changing event; rising-edge breaches emit `kind=drift_threshold` DecisionEvents that survive WS reconnect via persisted breach-edge metadata.

**Schema bump (v0.2.4):**
- `DriftAxis` gains optional `breach_started_at` (date-time, nullable) and `breach_event_id` (uuid, nullable). Required to make rehydration produce the same DecisionEvent id as the live emit; without these the recomputed event id would drift on every reconnect.

**Axes (Decision 1):**
- `path_drift` — files touched since last `phaseHistory.to === 'plan'` entry that are NOT in the plan's declared paths, divided by total touched. Sources unioned: committed-since-anchor + uncommitted worktree changes + untracked files (mirrors `compose/lib/build.js`'s pattern). Anchor uses the MOST RECENT plan entry to handle replans correctly.
- `contract_drift` — JSON-schema fields added/removed/retyped between anchor commit and HEAD; recursive walk on fully-qualified paths so nested retypes are caught.
- `review_debt_drift` — STRAT-REV JSON `findings[]` entries with `status` ∉ `{resolved, closed, fixed}`, divided by total findings. Missing review files → `threshold: null` (axis disabled), not `ratio: 0`.
- All axes return `threshold: null` rather than false-clean ratio=0 when their source is missing or unparseable.

**Defaults (Decision 2):** `path_drift: 0.30`, `contract_drift: 0.20`, `review_debt_drift: 0.40`.

**Server pipeline:**
- `server/drift-axes.js` *(new)* — pure `computeDriftAxes(item, projectRoot, now)`.
- `server/contract-diff.js` *(new)* — `diffContracts(anchorRef, headPaths, projectRoot)` with recursive `walkSchema` + `collectFieldTypes`.
- `server/drift-emit.js` *(new)* — recompute → preserve breach metadata for axes still breached / assign fresh ids on rising edge / clear on falling edge → `updateLifecycleExt` → broadcast `driftAxesUpdate` → emit `DecisionEvent[kind=drift_threshold]` for newly-breached axes.
- `server/decision-event-id.js` + `decision-event-emit.js` — `driftThresholdDecisionEventId(featureCode, axisId, breachStartedAtIso)` + `buildDriftThresholdEvent(...)`.
- `server/decision-events-snapshot.js` — 5th rehydration source reads persisted `breach_event_id` + `breach_started_at` directly (no recompute).
- `server/vision-routes.js` — DRIFT emit BEFORE STATUS at every state-changing site (12 sites: 5 lifecycle + 4 iteration + 2 gate + 3 loop) so STATUS reads freshly persisted axes.
- `server/cc-session-watcher.js` + `vision-server.js` — DRIFT emit wired post-lineage.

**Client:**
- `src/components/vision/DriftRibbon.jsx` *(new)* — 28px ribbon, region ⑥, mounted as first child of `ItemDetailPanel`'s ScrollArea body. Hidden when no axis breached. Click expands axis table.
- `src/components/vision/driftRibbonLogic.js` *(new)* — pure helpers.
- `src/components/vision/visionMessageHandler.js` — `driftAxesUpdate` patches the affected item's `lifecycle.lifecycle_ext.drift_axes`.

**Reviews:** 6 Codex spec rounds reaching REVIEW CLEAN (initial findings: snapshot rehydrate identity, plan-anchor outcome assumption, STATUS already-correct, missing git-utils.js, file-source semantics for review_debt, working-tree git diff vs commit-only). 1 implementation review caught two more bugs: nested retypes silently undercounted in contract-diff, and plan-anchor used FIRST not LAST plan entry (broke replan semantics). Both fixed with regression tests pinned. REVIEW CLEAN at round 2.

**Tests:** 57 new (14 drift-axes + 13 drift-emit + 7 contract-diff incl. nested-retype regression + 22 ui/drift-ribbon + integration). Full suite: **1858 pass, 0 fail, 0 skips**. Wave 6 data plane closed — DRIFT was the final unshipped sibling on the contract-compliance suite.

### COMP-OBS-GATELOG + COMP-OBS-LOOPS — Gate audit log + Open Loops panel

Combined commit because both touch `status-snapshot.js` (gate_load_24h rollup + open_loops_count semantic fix + isStaleLoop extraction).

**COMP-OBS-GATELOG — Gate decision audit + report CLI:**
- `server/gate-log-store.js` *(new)* — `appendGateLogEntry` (idempotent on id), `readGateLog({since, featureCode})`, `mapResolveOutcomeToSchema` (`approve→approve`, `revise→interrupt`, `kill→deny`). Storage: project-scoped JSONL at `<dataDir>/gate-log.jsonl` (NOT app-global — gate decisions belong to the project they were made in).
- `server/decision-event-id.js` extended with `gateDecisionEventId(featureCode, gateLogEntryId)` (uuidv5).
- `server/decision-event-emit.js` extended with `buildGateEvent(...)` returning a `DecisionEvent[kind=gate]` with `metadata.gate_log_entry_id` populated and `decision` mapped to schema vocab.
- `server/vision-routes.js` `gateResolved` route: new outcome whitelist (`approve|revise|kill` only); lazy-expiry guard parity with GET (returns 409 for expired pending gates); per Decision 3 emit-first-then-append — emit DecisionEvent first, then `appendGateLogEntry` with `decision_event_id` set on success or `null` on emit-throw. Featureless gates (no `lifecycle.featureCode`) skip both writes per Decision 1b. Expired gates skip per Decision 1c (no schema enum value).
- `server/decision-events-snapshot.js` — gate events now rehydrate from `gate-log.jsonl` on WS connect, so live gate cards persist across reconnect.
- `server/status-snapshot.js` — `gate_load_24h` reads from `readGateLog({since: now - 86400000}).length`.
- `bin/compose.js` — new `compose gates report [--since 24h] [--feature FC] [--format text|json] [--rubber-stamp-ms N]` subcommand.

**COMP-OBS-LOOPS — Open Loops panel + CLI + STATUS rollup fix:**
- `server/open-loops-store.js` *(new)* — `addOpenLoop`/`resolveOpenLoop`/`listOpenLoops`/`isStaleLoop`. Server fills `id` (UUID v4), `created_at`, `parent_feature` (from item lifecycle); rejects when item lacks `featureCode`. Append-only: resolution mutates in-place, never deletes.
- `server/vision-routes.js` — 3 new REST endpoints (`GET/POST .../loops`, `POST .../loops/:loopId/resolve`). Schema-aligned validation: `kind ∈ {deferred, blocked, open_question}`, `summary` 1–280 chars, `ttl_days` non-negative integer. Each route broadcasts `openLoopsUpdate` + recomputes status snapshot.
- `server/status-snapshot.js` — `open_loops_count` is now `filter(l => l.resolution == null).length` (was `.length` — counted resolved entries forever); inline TTL math replaced by `isStaleLoop` import so panel/CLI/STATUS agree exactly.
- `src/components/vision/OpenLoopsPanel.jsx` *(new)* — 320px sticky right panel collapsible to 40px (per CONTRACT layout.md §④); per-feature scope; oldest-first sort; inline resolve; add modal; `localStorage` collapse persisted as `compose:<feature-code>:openLoopsCollapsed`.
- `src/components/vision/openLoopsPanelLogic.js` *(new)* — pure helpers mirroring server predicates.
- `src/components/vision/visionMessageHandler.js` — `openLoopsUpdate` handler patches the affected item's `lifecycle.lifecycle_ext.open_loops` in-place.
- `src/App.jsx` — mounts `<OpenLoopsPanel>` adjacent to ContextPanel; `handleAddLoop`/`handleResolveLoop` REST callbacks wire the panel to the new endpoints.
- `bin/compose.js` — new `compose loops add|list|resolve --feature <FC> ...` subcommand. `--feature` is required on every action (cross-feature aggregate listing is explicitly out of scope for v1).

**Reviews:** 4 Codex spec rounds across both designs (8+ findings → 4 → 2 → 1 → 0, REVIEW CLEAN); 2 Codex implementation rounds. Round 1 caught six bugs that tests had passed: (1) outcome whitelist missing on resolve (any string passed through), (2) lazy-expiry guard missing on resolve (parity with GET), (3) gate events absent from hydrate snapshot (live cards disappeared on reconnect), (4) `OpenLoopsPanel` mounted in App.jsx without `onAddLoop`/`onResolveLoop` callbacks (UI was non-functional), (5) gate-log was COMPOSE_HOME-scoped (would bleed across repos), (6) OpenLoop request body bypassed schema constraints. All six fixed; round 2 REVIEW CLEAN.

**Tests:** 90 new tests (15+6+6 GATELOG node:test + 22+11+9+14 LOOPS node:test/vitest + 7 wave-6 integration/compliance). Full suite: **1823 pass, 0 fail, 1 intentional skip** (DRIFT only — the last unshipped Wave 6 sibling). Wave 6 contract-compliance suite un-skipped both placeholders.

### COMP-OBS-STATUS — Situational status band + main-cockpit mount fix

**Why:** Wave 6 region ① per CONTRACT layout — the one-sentence "where are we, what's next" projection. Server rolls per-feature state (active phase, pending gates, drift breaches, stale open loops, iteration in flight) into a `StatusSnapshot` and broadcasts on every state-changing event. Click expands a 200px detail panel showing `pending_gates`, `drift_alerts`, `open_loops_count`, `gate_load_24h` verbatim. Also fixes a previously-shipped TIMELINE bug — both region ① and region ② were only mounted in the popout `VisionTracker`, not in the main cockpit (`App.jsx → CockpitView`). They are now mounted at the top of `<main>` so the status surface is visible in the primary UI.

**Server (snapshot producer + 11-site dual-emit + REST):**
- `server/status-snapshot.js` *(new)* — pure `computeStatusSnapshot(state, featureCode, now)` returning a contract-valid `StatusSnapshot`. Internal `buildStatusSentence(...)` implements 8 deterministic rule branches (no-feature → killed → complete → pending gate → drift breach → stale open loops → iteration in flight → idle baseline) with explicit null/unknown-phase fallbacks. Sentence ≤280 chars; gate id truncated with ellipsis when needed.
- `server/status-emit.js` *(new)* — `emitStatusSnapshot(broadcastMessage, state, featureCode, now)` recomputes + broadcasts `{type: 'statusSnapshot', featureCode, snapshot}`. Single choke point.
- `server/vision-routes.js` — emit at every state-changing site: lifecycleStarted, lifecycleTransition (advance/skip/kill/complete), iterationStarted, **iterationUpdate (per-attempt — STATUS-only, TIMELINE intentionally skips)**, iterationComplete (report + abort), gateCreated, gateResolved. New `GET /api/lifecycle/status?featureCode=<FC>` returns `{snapshot}`.
- `server/cc-session-watcher.js` — optional `emitStatusSnapshot` + `getState` deps; emit after lineage broadcast.
- `server/vision-server.js` — wires the deps into `CCSessionWatcher` construction.

**Client (32px sticky band + main-cockpit + popout mount + reconnect invalidation):**
- `src/components/vision/StatusBand.jsx` *(new)* — 32px sticky region ①, renders the sentence only (v1: `cta` is always `null`; no CTA element). Click toggles a 200px expansion panel showing snapshot fields.
- `src/components/vision/statusBandLogic.js` *(new)* — pure helpers (`truncateForSentence`, `formatExpansionPanel`).
- `src/components/vision/DecisionTimelineStrip.jsx` — sticky `top: 0 → 32px`, `z-index: 10 → 20` so it stacks below STATUS.
- `src/components/vision/useVisionStore.js` — `statusSnapshots: {}` slice (map keyed by featureCode) + `setStatusSnapshot(featureCode, snap)` + new `clearStatusSnapshots()` action (called on hydrate; ensures WS reconnect refetches against current server state).
- `src/components/vision/visionMessageHandler.js` — `statusSnapshot` WS handler; `clearStatusSnapshots()` on hydrate.
- `src/App.jsx` — imports `StatusBand` + `DecisionTimelineStrip`; mounts both at the top of `<main>` so they render in the cockpit (not just popout); adds a `useEffect` that fetches `/api/lifecycle/status` on `activeFeatureCode` change. **This also fixes TIMELINE's invisible-in-main-cockpit bug** (it had the same VisionTracker-only mount).
- `src/components/vision/VisionTracker.jsx` (popout) — retains its own band + strip mount + hydration effect; both surfaces now keep parity.

**Reviews:** 4 Codex review rounds against the design (5 → 4 → 1 → 0 actionable findings, REVIEW CLEAN), 2 rounds against the implementation. Round 1 caught two real bugs: (a) HIGH — the band was only mounted in the popout `VisionTracker`, never in the main cockpit (TIMELINE had the same bug, fixed in this commit); (b) MEDIUM — `statusSnapshots` would go stale indefinitely on WS reconnect because there was no invalidation path. Both fixed: dual-mount in `App.jsx` + popout, plus `clearStatusSnapshots` called from the hydrate handler. Refactor pass also removed a leaky `_openLoopsCount` field injected onto `iterationState` — replaced with an explicit `openLoopsCount` parameter on `buildStatusSentence`. REVIEW CLEAN at round 2.

**Tests:** 70 new tests (36 snapshot-branch + 6 emit + 10 route + 12 band-logic + 11 ui + 5 integration + 1 compliance activated). Full suite: **1747 pass, 0 fail, 3 intentional skips** (siblings DRIFT / GATELOG / LOOPS still pending). Wave 6 contract-compliance suite un-skipped STATUS placeholder.

### COMP-OBS-TIMELINE — Decision timeline strip + dual-emit pipeline

**Why:** Wave 6 region ② per CONTRACT layout. Closes the orphaned `decisionEvent` broadcast that COMP-OBS-BRANCH has been emitting into the void since 2026-04-20, and adds two new event kinds (`phase_transition`, `iteration`) so the strip is populated immediately on first lifecycle interaction. Strip already renders `gate` and `drift_threshold` cards via the same `DecisionCard` component — zero code change here when GATELOG and DRIFT ship their emitters.

**Server (single emit choke point + dual-emit at every existing broadcast site):**
- `server/decision-event-emit.js` *(new)* — `emitDecisionEvent(broadcastMessage, event)` + per-kind builders (`buildPhaseTransitionEvent`, `buildIterationEvent`). Builder output byte-matches BRANCH's existing emit envelope (`cc-session-watcher.js:146-167`).
- `server/decision-event-id.js` — extended with `phaseTransitionDecisionEventId(featureCode, fromPhase, toPhase, timestamp)` and `iterationDecisionEventId(featureCode, loopId, stage)`. Same uuidv5/per-feature-namespace pattern as existing `branchDecisionEventId`. Deterministic — re-derive == identity.
- `server/lifecycle-phase-history.js` *(new)* — sole writer for `lifecycle.phaseHistory[]`, plugging `project_lifecycle_phasehistory_gap` (memory note). Entries carry BOTH the legacy shape (`phase`, `step`, `enteredAt`, `exitedAt`, `outcome`) consumed by `ItemDetailPanel.jsx`, `ContextPipelineDots.jsx`, and `session-routes.js`, AND the new shape (`from`, `to`, `outcome`, `timestamp`) consumed by snapshot derivation. Appending a successor closes out the prior entry's `exitedAt`.
- `server/decision-events-snapshot.js` *(new)* — `deriveDecisionEvents(state, featureCode)` walks `phaseHistory[]` + `iterationState` + `lifecycle.lifecycle_ext.branch_lineage.branches[]` to seed the strip on WS connect. Computes `sibling_branch_ids` per fork_uuid grouping (matches BRANCH live-emitter semantics — including self).
- `server/vision-routes.js` — dual-emit at 8 broadcast sites (lines 183, 237, 260, 283, 305 for phase transitions; 357, 414, 446 for iteration start/complete/abort; line 418 deliberately untouched — per-attempt `iterationUpdate` does not flood the strip).
- `server/vision-server.js` — `getVisionSnapshot` now attaches `decisionEventsSnapshot` to the hydrate envelope.

**Client (region ② render + store wiring):**
- `src/components/vision/DecisionTimelineStrip.jsx` *(new)* — 72px sticky band, full-width, horizontally scrollable, newest-right ordering. Filtered to current feature.
- `src/components/vision/DecisionCard.jsx` *(new)* — 160px card per CONTRACT layout.md §②: timestamp top-right, title, role chips (`IMPLEMENTER` / `REVIEWER` / `PRODUCER`), linked-run status dot.
- `src/components/vision/decisionTimelineLogic.js` *(new)* — pure helpers (`formatRelativeTime`, `kindIcon`, `kindColor`, `roleChipClass`, `sortAndFilterEvents`).
- `src/components/vision/useVisionStore.js` — `decisionEvents: []` slice + `setDecisionEventsSnapshot(arr)` and `appendDecisionEvent(ev)` (dedupe by id).
- `src/components/vision/visionMessageHandler.js` — handlers for `decisionEvent`, `decisionEventsSnapshot`, plus seeding from `hydrate.decisionEventsSnapshot`.
- `src/components/vision/VisionTracker.jsx` — strip mounted at top-of-tree.
- `src/components/vision/constants.js` — `DECISION_KINDS` map for color/icon/label.

**Reviews:** 2 Codex review rounds against the implementation. Round 1 surfaced three real bugs that tests had passed over: (a) `phaseHistory` writer used the new `{from, to, outcome, timestamp}` shape only — silently broke `ItemDetailPanel`, `ContextPipelineDots`, and `session-routes` legacy readers; (b) snapshot derivation read `item.lifecycle_ext` (top-level) instead of the production-real `item.lifecycle.lifecycle_ext`, so cold reconnect would have dropped all branch cards; (c) snapshot rebuilt branch events with hardcoded `sibling_branch_ids: []`, dropping fork context after refresh. All three fixed; round 2 added an executable assertion for sibling rehydration. REVIEW CLEAN at round 2 close.

**Tests:** 121 new tests (117 node:test + 10 vitest, plus regression tests for the three Codex fixes). Full suite: **1677 pass, 0 fail, 4 intentional skips** (siblings STATUS / GATELOG / LOOPS / DRIFT awaiting ship). Wave 6 contract-compliance suite un-skipped TIMELINE placeholder.



### COMP-OBS-CONTRACT — Wave 6 shared contract, locked

**Why:** Gates the rest of Wave 6 (Situational Awareness). Six sibling features (COMP-OBS-STATUS, TIMELINE, STEPDETAIL, LOOPS, GATELOG, DRIFT) now build against a single frozen schema + layout + integration-smoke spec, so cross-feature drift (the failure class that motivated `feedback_integration_review`) can't land silently.

**Schema (`docs/features/COMP-OBS-CONTRACT/schema.json` → v0.2.3):**
- Propagates the 2026-04-23 SURFACE → TIMELINE+STEPDETAIL split through `_consumers`. Emitter ownership restated: BRANCH→kind=branch, GATELOG→kind=gate, TIMELINE→kind=phase_transition + kind=iteration, DRIFT→kind=drift_threshold.
- `StatusSnapshot.drift_alerts[]` now a closed subschema that mandates `breached: true` (STATUS can no longer emit non-alert axes through the alerts field).
- Gate `DecisionEvent.metadata.gate_log_entry_id` promoted to required. Canonical join is the forward edge; `GateLogEntry.decision_event_id` remains nullable only as an emission-failure escape hatch, with reconciliation rule documented (gate_id + timestamp ±5s).

**Spec artifacts:**
- `design.md` *(new)* — unifying index, read order, versioning discipline, in-/out-of-scope for v1.
- `layout.md` — region ⑤ rewritten to describe the shipped `BranchComparePanelMount` at `ItemDetailPanel.jsx:419-422`; region ⑥ (DRIFT ribbon) re-anchored above BRANCH mount (the former "above chat input" anchor didn't exist in code); mobile-stacking and 50-branch-pagination claims relaxed to match shipped BranchComparePanel (no responsive breakpoint, no branch-picker UI in v1).
- `integration-test.md` — two-file ownership documented (BRANCH-slice integration + new contract-compliance); golden flow extended with `kind=drift_threshold` so Timeline exercises all five DecisionEvent kinds.
- `blueprint.md` *(new)* — file:line-verified plan with corrections table (wave-6-integration.test.js already existed; Playwright deferred; real-CC-in-tests a non-goal).
- `plan.md` *(new)* — ordered T1–T10 acceptance-gate plan.

**Code:**
- `compose/test/wave-6-contract-compliance.test.js` *(new)* — 30 tests, 5 intentional `test.skip()` placeholders (one per unshipped sibling, named after its feature code so `grep COMP-OBS-<CODE>` finds the un-skip line on landing). Covers: schema-load, dataset gate, per-fixture BranchOutcome round-trip (6 fixtures including `failed-branch` and `truncated` so state=failed is exercised), BranchLineage positive + unbound-branches negative, state=unknown shape, DecisionEvent all five kinds + gate-without-`gate_log_entry_id` negative + per-kind metadata `additionalProperties` closure negative, OpenLoop positive/resolved/non-UUID, 4 error-harness rows, 50-branch lineage + `pickInitialPair`.
- `compose/package.json` — new `test:wave-6` script runs both Wave 6 files as one suite.

**Tests:** 25 new tests (30 defined, 5 skipped). Full suite: 1558 pass, 0 fail, 5 intentional skips.

**Reviewed:** 3 Codex review rounds against the spec artifacts (6 findings → 3 follow-ups → REVIEW CLEAN), 2 Codex review rounds against the implementation (2 findings → 1 follow-up → implicit clean after state=unknown coverage added).



**Why:** First shipping feature of Wave 6 (Situational Awareness). Forge reads Claude Code's existing parent-pointer branch tree at `~/.claude/projects/**/*.jsonl` — no new fork mechanism, no new storage. Ships first because it's the structural validator that the CC JSONL assumption holds; failures here invalidate the branch-outcome shape the rest of the Wave 6 batch depends on.

**Producer (backend):**
- `server/schema-validator.js` *(new)* — ajv wrapper over `docs/features/COMP-OBS-CONTRACT/schema.json` v0.2.2. Used at the lineage-POST boundary and in tests.
- `server/cc-session-reader.js` *(new)* — parses a single CC session JSONL, builds a parent-pointer tree over non-sidechain records, classifies each leaf's state (`running` / `complete` / `failed` / `unknown`), derives BranchOutcome metrics per blueprint §6.5. Truncated files tolerated.
- `server/cc-session-feature-resolver.js` *(new)* — joins `cc_session_id` → `feature_code` via (1) `basename(transcriptPath)` match in `.compose/data/sessions.json`; (2) fallback probe of `docs/features/<CODE>/sessions/<cc_session_id>.*`; (3) unbound → null (counted in `stats.unbound_count`, never emitted per the contract's required `feature_code` rule).
- `server/decision-event-id.js` *(new)* — deterministic `uuidv5` event id keyed on `(feature_code, branch_id)` + pure `shouldEmit` dedupe helper. Prevents full-rescan replay on restart.
- `server/cc-session-watcher.js` *(new)* — orchestrator. Per-feature × per-session accumulator (so a feature with multiple CC sessions never has branches clobbered on POST), aggregated lineage POST, debounced `fs.watch` with polling fallback, persisted `emitted_event_ids` round-trip across restart.
- `server/vision-store.js` — `updateLifecycle` now preserves prior `lifecycle_ext` across partial-update callers (the 31 existing callsites, notably `feature-scan.js`, safely write non-extension fields without clobbering Wave 6 additions). New `updateLifecycleExt(id, key, value)` is the single public method Wave 6 features use to write extensions.
- `server/vision-routes.js` — new `POST /api/vision/items/:id/lifecycle/branch-lineage`, schema-validated at the boundary; emits `branchLineageUpdate` WebSocket event. Idempotent.
- `server/vision-server.js` — opt-in `CCSessionWatcher` wire-up. **Default OFF.** Enable via `capabilities.cc_session_watcher: true` in `compose.json` or `CC_SESSION_WATCHER=1` env var. When on, seeds emitted event ids from persisted lineage on startup (no replay), runs a full scan, then watches.

**Consumer (frontend):**
- `src/components/vision/BranchComparePanel.jsx` *(new)* — collapsed 1-liner (`N branches · last fork Xh ago · [Compare]`); expanded 2-column metric grid with inline `ArtifactDiff` below. Compare button disabled when <2 `state: complete` branches; mid-progress shows `X of N branches ready`. Metric rows pluggable via `extraMetricsForBranch` prop (future COMP-OBS-DRIFT injection point).
- `src/components/vision/branchComparePanelLogic.js` *(new)* — pure helpers (summary/age/number formatters + `pickInitialPair`) extracted for unit testing without a DOM.
- `src/components/vision/useVisionStore.js` — Zustand `selectedBranches: { [featureCode]: [branchIdA, branchIdB] }` slice + `setSelectedBranches` action. Session-local, not persisted.
- `src/components/vision/ItemDetailPanel.jsx` — mounts `<BranchComparePanel>` as the first child of the scroll body when `item.lifecycle.featureCode` is set.

**Dependencies:** `ajv` `^8.18.0`, `ajv-formats` `^3.0.1` — JSON Schema draft-07 + date-time/uuid formats, used at all contract boundaries.

**Tests:**
- `test/fixtures/cc-sessions/` *(new)* — 6 synthesized+scrubbed JSONL fixtures + multi-session dir + byte-deterministic `capture.js`. Covers linear, two-branch fork, three-branch fork, mid-progress, failed-branch (via `tool_result.is_error:true`), truncated.
- 9 new test files under `test/comp-obs-branch/` + `test/vision-store-server.test.js` + `test/wave-6-integration.test.js`. Coverage: schema boundaries (12), reader (24), resolver (9), event id (8), watcher (6), route (7), logic (27), store (11), integration (6) = 110 new tests.
- Integration test runs entirely on tmp dirs — never touches `~/.claude/projects/` or `$HOME`.

**Verified:**
- Full suite `node --test test/*.test.js test/comp-obs-branch/*.test.js`: **1522/1522 pass** (1515 pre-review + 7 added in response to Codex findings), zero regressions across the 31 existing `updateLifecycle` callsites.
- `npm run build` succeeds in ~8.5s.
- UI not manually verified in a browser (dev server was not started to avoid disrupting the active developer session). Vite dev server smoke via curl: `BranchComparePanel.jsx`, `ItemDetailPanel.jsx`, `branchComparePanelLogic.js`, `useVisionStore.js` all serve HTTP 200 with compiled JSX — import graph resolves cleanly.

**Codex review pass (2026-04-20):** six findings, five accepted + fixed, one deferred with rationale:
1. ✅ **Bug** — `parseJsonlSafe` silently dropped mid-line parse failures. Fixed: any unparseable line now flags `truncated=true`, and `running` leaves under a truncated session are downgraded to `unknown` (positive identifications on the leaf itself — `is_error`, `stop_reason: end_turn` — remain trustworthy).
2. 📎 **Deferred** — Codex flagged that `failed` branches get completion-only metrics (`turn_count`, `files_touched`, etc.) populated, citing per-field "Populated when state=complete" descriptions. The plan (T1 acceptance criteria) and the schema's `ended_at` description ("Populated when state is terminal (complete / failed). Null while running.") both codify "terminal = complete OR failed" for completion-only fields. Keeping implementation aligned with the plan. If COMP-OBS-CONTRACT wants stricter semantics, it needs a schema bump that unambiguously says "complete only" across all completion-only fields.
3. ✅ **Contract** — `final_artifact.path` was chosen at the reader before `feature_code` resolution, so a session touching multiple feature folders could attach another feature's artifact. Fixed: watcher re-filters `final_artifact` against `docs/features/<resolved feature_code>/` and nulls it when out-of-scope.
4. ✅ **Contract** — Branch-lineage route didn't verify `body.feature_code === item.lifecycle.featureCode`. Fixed: route rejects with 400 when the item has no `lifecycle.featureCode` or when `feature_code` mismatches.
5. ✅ **Race** — `_flush()` broadcast DecisionEvents before persisting the updated `emitted_event_ids`, so a crash between broadcast and POST could replay. Fixed: `_flush()` now stages ids in the lineage payload, POSTs first, and only commits ids to the in-memory dedupe set + broadcasts on POST success. On POST failure, the set is untouched and the next scan retries.
6. ✅ **Schema** — Production watcher path bypassed schema validation (direct `updateLifecycleExt`). Fixed: `vision-server.js`'s `postBranchLineage` callback now validates against `BranchLineage` and verifies the `feature_code`/`featureCode` match before persisting.

**Not in v1** (per feature.json): no new fork mechanism (users still fork via CC `Esc Esc` / rewind); no transcript-level side-by-side diff; no tool-call timeline; no cross-session ancestry; no mid-session fork UI in Forge. Read-only visualizer over CC's native state.

**Heuristic-in-v1 metrics:** `tests.passed/failed/skipped` parsed from `tool_result` stdout via a pytest/jest/vitest/mocha regex — exact where matchable, else `0`. `cost.usd` is `0` unless `CC_USD_PER_1K_INPUT` / `CC_USD_PER_1K_OUTPUT` env vars are set. `final_artifact.snapshot` is `null` (lazy-load via `path` deferred to v2).

## 2026-04-18

### COMP-REACT19 — React 18.3.1 → 19.2.5

**Why:** Unblocks COMP-TUI-COCKPIT (ink 7.x requires React ≥19.2.0); also picks up `use()`, form actions, and ref-as-prop ergonomics for the app.

**Changes:**
- `package.json`: `react` `^18.3.1` → `^19.2.5`; `react-dom` `^18.2.0` → `^19.2.5` (aligned).

**Verified safe:**
- No `ReactDOM.render`/`hydrate`, no `propTypes`/`defaultProps` on function components, no string refs, no legacy context usage.
- Zero block-bodied `useMemo`/`useCallback` with implicit-undefined returns (breaking change #6 is a no-op here).
- `src/main.jsx` already uses `createRoot`; app is not wrapped in `<StrictMode>` (no double-invoke surfacing).
- `React.forwardRef` (61 call sites across 13 UI files) retained — still supported in React 19; ref-as-prop codemod deferred to a future cleanup.
- All React-consuming deps (`@radix-ui/*`, `@hello-pangea/dnd`, `@tanstack/react-virtual`, `react-markdown`, `lucide-react`, `ink`, `zustand`) compatible with React 19 at current pins.

**Tests:** 1420 tests pass (baseline unchanged); 10 integration tests pass; `npm run build` succeeds in 5.07s.

### T2-F5-CONSUMER-MERGE-STATUS-COMPOSE — close the T2-F5 arc

**Why:** T2-F5-COMPOSE-MIGRATE-WORKTREE landed with a known trade-off (W1): client-side merge conflicts halted the CLI via a throw, but the stream-writer closed with `buildStatus='complete'` because the throw bypassed the terminal `buildStatus='failed'` branch. The flow state also reported `merge_status='clean'` server-side — Stratum auto-advanced before Compose could report the real status. T2-F5-DEFER-ADVANCE (stratum-side) added the back-channel; this feature wires Compose up to it.

**Changes:**

- `lib/stratum-mcp-client.js`: new `parallelAdvance(flowId, stepId, mergeStatus)` method.
- `lib/build.js`: split `applyServerDispatchDiffs` into a pure `applyServerDispatchDiffsCore` (returns `{mergeStatus, conflictedTaskId, conflictError, appliedFiles}`) + a thin throwing wrapper preserving the legacy non-deferred contract. Specs that haven't opted into `defer_advance: true` keep the old throw-on-conflict semantics.
- `lib/build.js:executeParallelDispatchServer`: now branches on `pollResult.outcome?.status === 'awaiting_consumer_advance'`. Defer path calls Core + `parallelAdvance(mergeStatus)`, replaces the sentinel with the real advance result (flow advances with truth). Legacy path uses the throwing wrapper. Defensive "spec mispairing" branch: if sentinel arrives without `capture_diff: true`, call `parallelAdvance('clean')` to unblock the flow and emit an actionable `build_error`.
- `lib/build.js`: new exported `resolveBuildStatusForCompleteResponse(response)` helper. In the main loop's complete branch, `buildStatus` is now derived via this helper — returns `'failed'` when `response.output.merge_status === 'conflict'`, else `'complete'`. Narrow check (not `output.outcome === 'failed'`) to avoid flipping on unrelated failure-flavored completions.
- `pipelines/build.stratum.yaml`: `execute` step opts in with both `capture_diff: true` and `defer_advance: true`. Under `COMPOSE_SERVER_DISPATCH=1` this activates the new path; otherwise the spec flags are inert (consumer-dispatch runs the agents itself).

**Tests:** 10 new (1 client + 4 integration with real temp git repos + 5 buildStatus unit). **1407 total passing**, 0 fail.

**T2-F5 arc status:** CLOSED end-to-end. Server-side enforcement, Python connectors, Compose routing for both isolation modes, diff export, defer-advance, and consumer merge status all shipped. Remaining T2-F5 tickets (BRANCH, DEPENDS-ON, STREAM, OPENCODE-DISPATCH, CLAUDE-CANCEL, RESUME, LEGACY-REMOVAL) are quality-of-life enhancements, not correctness gaps.

## 2026-04-17

### CodexConnector: swap opencode backend for the official `codex` CLI

**Why:** Codex review was broken for everyone — the opencode-backed path hit persistent auth/model-access issues. The official OpenAI `codex` CLI (`@openai/codex`) is the same primitive used by the `openai/codex-plugin-cc` Claude Code plugin and is the supported path going forward.

**Changes:**
- `server/connectors/codex-connector.js`: full rewrite. No longer extends `OpencodeConnector`; now spawns `codex exec --json --skip-git-repo-check --sandbox read-only -m <model> -C <cwd>` and translates its JSONL event stream (`item.completed` / `turn.completed`) into the shared connector envelope. `<model>/<effort>` suffix parses into `-c model_reasoning_effort=<effort>`.
- Supported model IDs unchanged (`CODEX_MODEL_IDS`). Auth via `codex login` (ChatGPT OAuth) or `OPENAI_API_KEY`.
- `OpencodeConnector` retained for non-Codex providers — only the Codex subclass was rewired.

**Setup:** `npm i -g @openai/codex` (or `brew install codex`), then `codex login`. See README.

**Tests:** Existing `test/codex-connector.test.js` (5 cases) passes. Live smoke test against `codex` returns assistant/usage/result events correctly.

### T2-F5-COMPOSE-MIGRATE-WORKTREE: Worktree Diff Consumption in Server-Side Dispatch

**Feature:** Extended T2-F5-COMPOSE-MIGRATE to accept `isolation: "worktree"` + `capture_diff: true` on server-dispatch. New `applyServerDispatchDiffs()` wrapper reads `ts.diff` from poll response and delegates to shared `applyTaskDiffsToBaseCwd` helper (extracted from consumer-dispatch). Both dispatch paths now merge through the same code. Client-side merge conflicts emit `build_error` and throw to halt CLI. Known trade-off: merge_status visibility gap until T2-F5-CONSUMER-MERGE-STATUS lands Stratum-side defer-advance (flow state stays advanced server-side; manual resume required).

**Changes:**
- `lib/build.js`: New `applyServerDispatchDiffs()` wrapper + extracted shared `applyTaskDiffsToBaseCwd()` helper from consumer-dispatch. Merge conflicts throw to halt CLI.
- `test/build.test.js`: 10 new tests (6 routing, 4 integration): worktree routing with `capture_diff`, diff application, conflict handling, merge failures

**Tests:** All new tests passing. Full suite: 1397 passing (10 new).

### T2-F5-COMPOSE-MIGRATE: Server-Side Parallel Dispatch for Read-Only Steps

**Feature:** Compose's `parallel_dispatch` branch now routes through Stratum's server-side `stratum_parallel_start` + `stratum_parallel_poll` when `COMPOSE_SERVER_DISPATCH=1` AND `isolation: "none"`. Code-writing paths (`isolation: "worktree"`) remain on consumer-dispatch pending T2-F5-DIFF-EXPORT. Poll loop correctly breaks on `outcome != null`, not `can_advance`, so failure-path `ensure_failed` / retry dispatches propagate correctly.

**Changes:**
- `lib/stratum-mcp-client.js`: Added `parallelStart()` and `parallelPoll()` client methods for server-side dispatch
- `lib/build.js`: Added `executeParallelDispatchServer()` executor function with routing check at top of `executeParallelDispatch()`
- `README.md`: Documented `COMPOSE_SERVER_DISPATCH` and `COMPOSE_SERVER_DISPATCH_POLL_MS` environment variables
- Test coverage: 15 new tests (2 client + 7 server + 6 routing), 1387 total passing

**Tests:** All new routing + server dispatch tests passing. Full suite clean.

## 2026-04-12

### Test suite fixes (34 failures across 15 suites)

**Root causes fixed:**
- Pipeline YAML specs: removed `metadata` top-level key rejected by stratum-mcp 0.1.0; removed `retries` on flow steps (not allowed per stratum schema)
- Pipeline spec: fixed `$.steps.execute.output.files_changed` reference (parallel_dispatch output uses `tasks` key)
- `visionMessageHandler`: test mocks missing new setters (`setSpawnedAgents`, `setAgentRelays`, `setIterationStates`, `setFeatureTimeline`, etc.) added in recent features
- `settings-store`: tests updated for `defaultView` change from `'attention'` to `'graph'`
- `selective-rerun`: tests updated to include `debug-discipline` in BASELINE_LENSES (added by COMP-DEBUG-1)
- `parallel-dispatch`: tests searched inline branch but code was refactored to `executeParallelDispatch()` function
- `project-config`: test imported removed `TARGET_ROOT` export, updated to `getTargetRoot()`
- `build-dag`: deduplicate entries by code to handle ROADMAP.md summary tables that repeat feature codes
- `vision-store`: gate labels updated to match `GATE_STEP_LABELS` constants (`'Review Design'` not `'design gate'`)
- `init`: test expected `stratum` skill but source only ships `compose` skill
- `proof-run`: mock connector updated for new pipeline steps (triage, merge, lens tasks, ship plan_items)

### COMP-DEBUG-1: Debug Discipline Engine (design)

**Feature design and pipeline enhancement for disciplined bug resolution.**

Derived from SmartMemory weekly retro analysis (132 commits, 4:1 fix:feat ratio). Four anti-patterns identified and codified:

1. **Fix-chain detection** — git analysis detects repeated edits to same file/function across commits, signals thrashing vs. root-cause fixing
2. **Trace-before-fix enforcement** — `diagnose` step now requires `trace_evidence` postcondition (actual command output, not prose assumptions)
3. **Cross-layer grep audit** — automatic scope expansion when diagnose detects provider switches, field renames, or config changes spanning repos
4. **Attempt counting with escalation** — hard stop on visual/layout bugs at attempt 2, cross-agent handoff to break "one more tweak" loops

**Pipeline changes:**
- `bug-fix.stratum.yaml`: 6 → 8 steps (added `scope_check` and `retro_check`)
- New contracts: `TraceEvidence`, `DiagnoseResult`, `ScopeResult`, `RetroCheckResult`
- `diagnose` step now has `ensure:` postconditions requiring trace evidence

**Docs:**
- `docs/features/COMP-DEBUG-1/design.md` — full feature design
- `docs/ROADMAP.md` — added to Phase 7 (Trusted Pipeline Harness)

## 2026-04-09

### COMP-IDEABOX Batch 3: Advanced Features (Items 184, 186, 187, 188, 189)

**Item 184: Lifecycle integration**
- **build.js:** after each agent step, scans output text for "we should/could/might" patterns and emits `idea_suggestion` stream events (hints only, nothing auto-filed).
- **bin/compose.js:** `compose new --from-idea <ID>` flag pre-populates intent from an ideabox entry's title + description + cluster, skips duplicate questionnaire fields.
- **AttentionQueueSidebar.jsx:** "Ideas" section below the attention queue showing untriaged idea count. Click navigates to the ideabox view.

**Item 186: Discussion threads**
- **lib/ideabox.js:** `parseIdeabox` and `serializeIdeabox` support inline discussion entries (`**Discussion:**` block with `- [date] author: text` entries). Discussion field parsed to `[{ date, author, text }]`.
- **lib/ideabox.js:** `addDiscussion(parsedData, ideaId, author, text)` mutation helper.
- **server/ideabox-routes.js:** `POST /api/ideabox/ideas/:id/discuss` endpoint.
- **bin/compose.js:** `compose ideabox discuss <ID> "<comment>"` subcommand.
- **IdeaboxView.jsx:** discussion thread rendered in detail panel; inline input to add comments.
- **useIdeaboxStore.js:** `addDiscussion` and `updateIdea` actions.

**Item 187: Impact/effort matrix**
- **lib/ideabox.js:** `effort` (S|M|L) and `impact` (low|medium|high) fields added to idea schema. Parsed from `**Effort:**` and `**Impact:**` lines.
- **server/ideabox-routes.js:** PATCH allows `effort` and `impact` fields.
- **IdeaboxMatrixView.jsx (new):** 2x2 scatter plot with Quick Wins / Big Bets / Fill-ins / Money Pits quadrants. Unassigned tray with inline EffortImpactForm. Dot colors by cluster.
- **IdeaboxView.jsx:** "Cards | Matrix" tab toggle in header.

**Item 188: Roadmap graph integration**
- **GraphView.jsx:** "Ideas" toggle (default off). When on, renders idea nodes as dashed amber circles connected via dashed edges to their `mapsTo` feature targets.

**Item 189: Source analytics + digest dashboard**
- **IdeaboxAnalytics.jsx (new):** collapsible analytics section in header — source breakdown bars, NEW→DISCUSSING→PROMOTED status funnel with kill rate, cluster health with promotion rate. Pure derived computation from store data.

- **Tests:** 68 tests, all passing. New suites: discussion parsing, addDiscussion, effort/impact fields, resurrectIdea.

### COMP-OBS-GATES: Tiered Gate Evaluation (Wave 4)

- **gate-tiers.js (new):** 5 tiers (T0 schema → T1 lint → T2 tests → T3 llm-review → T4 cross-model) with cost estimates. `classifyStepAsTier()` maps pipeline steps. `evaluateTiers()` short-circuits on first failure, tracks cost saved from skipped tiers.
- **build.js:** Accumulates tier results per step, emits `gate_tier_result`/`gate_tier_failed`/`gate_tier_summary` events, persists savings to `.compose/data/gate-savings.json`.
- **ContextStepDetail.jsx:** `TierPipeline` component with colored dots (green=pass, red=fail, gray=skipped), cost-saved badge, click-to-expand.
- 14 tests, all passing.

### COMP-QA: Diff-Aware QA Scoping (Wave 4)

- **qa-scoping.js (new):** `mapFilesToRoutes()` — framework-aware file→route mapper supporting Next.js (pages/app), Express, React Router, explicit routes.yaml config. React Router filename pattern takes precedence over routes/ directory (avoids misclassifying `AuthRoute.tsx`).
- **classifyRoutes():** splits into affected vs adjacent via path-prefix matching.
- **detectDevServer():** probes ports 3000/3001/4000/5173/8080 with AbortController timeout.
- **isDocsOnlyDiff():** flags builds where only docs/config changed.
- **build.js:** Emits `qa_scope` event before coverage dispatch. Persists `filesChanged` to feature.json for CLI inspection.
- **bin/compose.js:** `compose qa-scope <featureCode>` command reads feature's filesChanged and prints mapped routes.
- 39 tests, all passing.

### COMP-HEALTH: Quantified Quality Score (Wave 4)

- **health-score.js (new):** 6-dimension weighted score (test_coverage 25%, review_findings 25%, contract_compliance 15%, runtime_errors 15%, doc_freshness 10%, plan_completion 10%). Missing dimensions re-normalized out (no penalty). `computeCompositeScore()` returns score + breakdown + missing list.
- **health-history.js (new):** Append-only `.compose/data/health-scores.json`. `getTrend()` returns improving/declining/stable.
- **build.js:** Collects signals per phase (test_coverage from coverage_check, review_findings from parallel_review, plan_completion from ship, runtime_errors from violations, doc_freshness from staleness check, contract_compliance from ensure pass/fail tracking). Emits `health_score` event at build end. Persists to history.
- **settings-store.js:** `health.enabled`, `health.gate_threshold`, `health.weights` config. Validation: threshold 0-100, weights sum 1.0.
- **Enforcement:** When gate_threshold is set and score < threshold, build status downgraded to 'failed'.
- **ContextStepDetail.jsx:** Health Score panel with big color-coded number, trend arrow, per-dimension mini bars.
- **App.jsx:** Wires tierEvents and healthEvents from activeBuild to ContextStepDetail.
- 55 tests, all passing.

**Codex fixes:** health threshold now enforces via build status downgrade, App.jsx wires tier/health events to ContextStepDetail, filesChanged persisted to feature.json for qa-scope command, contract_compliance dimension now populated from ensure pass/fail tracking, React Router filename detection precedes routes/ dir check.

### STRAT-TIER: Model Tier Routing (Wave 4)

- **agent-string.js:** Extended parser to support `provider:template:tier` format. `parseAgentString()` returns `{ provider, template, tier }`. `resolveAgentConfig()` resolves tier → modelID.
- **model-tiers.js (new):** MODEL_TIERS map (critical → Opus, standard → Sonnet, fast → Haiku). `resolveTierModel()` lookup.
- **agent-chains.js (new):** Chain presets (plan-execute-review, review-fix, security-audit). `applyChain()` rewrites agent strings to include tier so runtime actually routes.
- **build.js:** defaultConnectorFactory passes resolved model via both `model` and `modelID` for cross-connector compatibility. Emits `step_model` stream events with tier + modelID.
- **build.stratum.yaml:** Targeted tier assignments — blueprint → critical, ship → critical, run_tests → fast. Defaults unchanged.
- 46 tests (model-tiers + agent-string extensions).

### COMP-OBS-COST: Token and Cost Tracking (Wave 4)

- **model-pricing.js (new):** Per-model token pricing (Opus $15/$75, Sonnet $3/$15, Haiku $1/$5 per MTok). `calculateCost()` with prefix matching for dated variants.
- **claude-sdk-connector.js:** Extracts usage from SDK result messages, yields `usage` events.
- **opencode-connector.js:** Forwards `step_finish` cost/token data as `usage` events (previously logged to stderr only).
- **result-normalizer.js:** Accumulates usage per step, calculates cost_usd via `calculateCost`, returns `{ text, result, usage }`, forwards per-step usage to streamWriter.
- **build-stream-writer.js:** `writeUsage()` emits `step_usage` events. `close()` accepts cost totals for `build_end`.
- **build.js:** Accumulates `buildCostTotals`. Includes tokens/cost on `build_step_done`. Emits cumulative totals on `build_end`. Persists to active-build.json so resumed builds seed correctly.
- **build-stream-bridge.js:** Passes through cost fields on build_step_done, build_end, and new step_usage event type.
- **opsStripLogic.js:** `formatCost()` helper. Active build entry shows `· $0.42` when cost > 0.
- **ContextStepDetail.jsx:** Per-step cost row + sortable breakdown table (most expensive step highlighted).
- 27 tests (model-pricing + cost-tracking).

**Codex fixes:** Chain presets now actually rewrite agent strings (were inert). Resumed builds seed cost totals from active-build.json (were zero-reset). Tier model passed as both `model` and `modelID` for Codex+Claude connector compat.

### COMP-IDEABOX: Product Idea Capture & Triage (Wave 3) — Batches 1+2

**Batch 1 (Backend + CLI):**
- **lib/ideabox.js (new):** pure markdown parser/writer. parseIdeabox/serializeIdeabox round-trip, addIdea, promoteIdea, killIdea, resurrectIdea, setPriority, addDiscussion, loadLens. Handles SmartMemory canonical format.
- **server/ideabox-routes.js (new):** REST API — GET, POST, PATCH, /promote, /kill, /resurrect, /discuss. PATCH rejects status mutations (must use /promote or /kill).
- **server/ideabox-cache.js (new):** mtime-invalidated JSON cache for fast UI queries.
- **bin/compose.js:** `compose init` scaffolds `docs/product/ideabox.md`. `compose ideabox` subcommands: add, list, promote, kill, pri, triage, discuss. Respects `paths.ideabox` and `paths.features` from compose.json.
- 48 parser/CLI tests.

**Batch 2 (Core Web UI):**
- **IdeaboxView.jsx (new):** main view with digest header, filter bar (tag/status/priority/search), priority lanes, drag-and-drop, click-to-detail panel, graveyard.
- **IdeaboxTriagePanel.jsx (new):** modal triage flow with keyboard shortcuts, similarity hints, progress.
- **IdeaboxPromoteDialog.jsx (new):** 3-step wizard (feature code → preview → confirm).
- **useIdeaboxStore.js (new):** Zustand store with WS-driven hydration.
- ViewTabs registers ideabox tab; App.jsx routes it.
- 24 store tests.

**Batch 3 (Advanced + Integrations):**
- **Discussion threads:** parse/serialize, addDiscussion endpoint, CLI `compose ideabox discuss`, detail panel thread UI.
- **Effort/impact matrix:** schema fields with enum validation, IdeaboxMatrixView.jsx (2x2 scatter with quadrants, unassigned tray).
- **Graph integration:** GraphView "Ideas" toggle renders idea nodes as dashed amber circles connected to mapsTo features. Nodes carry status='idea' for handler compatibility.
- **Source analytics:** IdeaboxAnalytics.jsx — source breakdown bars, status funnel, cluster health.
- **Lifecycle integration:** build.js scans agent output for "we should/could" patterns, emits idea_suggestion stream events. AttentionQueueSidebar shows untriaged count. `compose new --from-idea <ID>` pre-populates intent.
- 20 additional tests (discussion, addDiscussion, effort/impact, resurrect).

**Codex fixes:** REST promote now creates feature folder (CLI parity), enum validation on effort/impact, idea graph nodes interactive, idea_suggestion events bridged to UI.

92 total tests, all passing.

### COMP-CTX: Ambient Context Layer (Wave 3)

- **compose init:** scaffolds `docs/context/` with tech-stack.md, conventions.md, decisions.md. Path configurable via `compose.json` `paths.context`.
- **step-prompt.js:** ambient context injected into every agent prompt as `## Project Context`. Cached per-build, invalidated after decision log append.
- **staleness.js:** `checkStaleness()` reads `<!-- phase: ... -->` markers from artifacts, flags stale files in gate context.
- **Decision log:** gate outcomes auto-appended to decisions.md with date, feature, step, outcome, rationale.
- 33 tests, all passing.

### COMP-CAPS-ENFORCE: Runtime Violation Detection (Wave 3)

- **result-normalizer.js:** `onToolUse` callback tap on tool_use events — passive, doesn't change event flow.
- **capability-checker.js:** `checkCapabilityViolation()` compares tools against agent template. Violation (disallowed) vs warning (not in allowedTools).
- **build.js:** violations checked in both main loop and child flow steps. Logged to stream + console.
- **settings-store.js:** `capabilities.enforcement` setting — `log` (default) or `block`. Block mode fails the step on violation.
- 11 tests, all passing.

### COMP-TEST-BOOTSTRAP: Test Framework Bootstrap (Wave 3)

- **test-bootstrap.js:** `detectTestFramework()` checks config files + package.json deps. `scaffoldTestFramework()` creates vitest/jest/pytest/go/rust test setup.
- **build.js:** before coverage step, detects framework; if missing, scaffolds then annotates step intent for golden flow generation.
- **Ship step:** uses detected test command instead of hardcoded `npm test`.
- 25 tests, all passing.

### COMP-OBS-SURFACE + COMP-OBS-STREAM (Wave 3)

- **OBS-SURFACE:** Items 146, 148, 150 already implemented. Item 192 (live budget counters): OpsStrip shows "review 3/5, 2:34/15:00" during active iterations with live elapsed timer.
- **OBS-STREAM:** Items 145, 151-152 already implemented. Bridge mapping, ToolResultBlock, verbose gating all in place.

### COMP-UX-3: Workflow Approachability (Wave 3)

- **Scaffold defaults (137):** `compose feature` detects language, test framework, counts existing features. Pre-populates profile in feature.json (needs_prd, needs_architecture, etc.).
- **Conversational gates (138):** `buildRecommendation()` derives 1-sentence summary + recommended action from artifact assessment. Enter key defaults to recommendation. "d" shows full details. Web UI RecommendationBadge above gate actions.
- **Status narration (139):** 1-line console summaries after each step, gate resolution, and iteration. Full detail still in stream events.

### STRAT-REV-7: Cross-Model Adversarial Synthesis (Wave 2)

- **review-lenses.js:** `classifyDiffSize()` (small/medium/large by file count) and `shouldRunCrossModel()` gate.
- **build.js:** `runCrossModelReview()` — after Claude lenses complete on large diffs (≥9 files), dispatches Codex review, parses string findings, runs Claude synthesis agent to classify CONSENSUS/CLAUDE_ONLY/CODEX_ONLY. Fail-open: Codex errors return original result.
- **Opt-out:** `opts.skipCrossModel`, `COMPOSE_CROSS_MODEL=0` env var, graceful skip when Codex unavailable.
- No pipeline YAML changes — all orchestration in build.js.
- 29 tests (13 diff-size + 16 cross-model), all passing.

### COMP-DESIGN-2: Compose New Integration (Wave 2)

- Already implemented in prior session. `compose new` detects `docs/design.md`, appends to intent, skips questionnaire. Each pipeline step receives design doc via `$.input.intent`.

### COMP-BUDGET: Iteration Budget Enforcement (Wave 1)

- **vision-routes.js:** Wall-clock timeout enforcement (checked at each report, configurable per loop type), action count ceiling (accumulated from agent reports), auto-abort with structured outcomes (`timeout`, `action_limit`).
- **budget-ledger.js:** Cumulative cross-session budget tracking in `.compose/data/budget-ledger.json`. `recordIteration()` called from both report and abort routes. `checkCumulativeBudget()` blocks iteration start when cumulative limits exceeded (429).
- **settings-store.js:** Per-loop-type settings: `iterations.review.timeout` (15min default), `iterations.coverage.timeout` (30min), `iterations.review.maxTotal` (20), `iterations.coverage.maxTotal` (50).
- **visionMessageHandler.js:** Client handles `timeout` and `action_limit` outcomes with distinct messages.
- 15 tests, all passing.

### HOOK-CACHE: Read Cache Hook (Wave 1)

- **read-cache.py:** PreToolUse hook on Read. Per-agent mtime + line-range tracking. Blocks redundant reads of unchanged files with covered ranges. Merges overlapping intervals. Metrics to `stats.json`.
- **read-cache-invalidate.py:** PostToolUse hook on Edit/Write/MultiEdit. Invalidates cache entry for modified file.
- **read-cache-compact.py:** PreCompact hook. Clears entire session cache (context no longer has the content).
- **hooks.json:** Registered all three hooks, replacing old `read-cache.sh`.
- 15 tests, all passing.

### COMP-PLAN-VERIFY: Plan-Diff Verification (Wave 1)

- **plan-parser.js:** Agent-side helper — `parsePlanItems()` extracts checkbox items with file paths and critical flags, `matchItemsToDiff()` classifies done/missing/extra.
- **spec.py:** `plan_completion(plan_items, files_changed, threshold=90)` ensure builtin. Division-by-zero guard. Critical missing items → plain string violations. Below threshold → violation with percentage.
- **executor.py:** Registered `plan_completion` in ensure sandbox.
- **build.stratum.yaml:** Ship step ensure clause: `plan_completion(result.plan_items, result.files_changed)`. Ship step intent updated to instruct agent to extract plan items.
- 12 Python + 16 JS tests, all passing.

### STRAT-IMMUTABLE: Spec Immutability During Execution (Wave 1)

- **Stratum executor:** `spec_checksum` on FlowState — SHA-256 of parsed FlowDefinition computed at flow start, verified at every `stratum_step_done` and `stratum_parallel_done`. Detects in-memory spec mutation. Checksum persisted/restored across MCP restarts.
- **build.js Layer 2:** Pipeline file hash and policy hash captured at build start. `verifyPipelineIntegrity()` re-reads YAML from disk before each step transition — detects on-disk tampering. `verifyPolicyIntegrity()` hashes settings.json policies before gate resolution — detects gate criteria weakening.
- 9 Python tests + 7 JS tests, all passing.

### COMP-AGENT-CAPS: Agent Capability Profiles (Wave 1)

- **agent-templates.js:** 4 built-in profiles — `read-only-reviewer` (Read/Grep/Glob only), `implementer` (full access), `orchestrator` (no Edit/Write), `security-auditor` (Read/Grep/Glob/Bash).
- **agent-string.js:** Centralized `parseAgentString("claude:read-only-reviewer")` → `{ provider, template }` + `resolveAgentConfig()` for full resolution with tool restrictions.
- **claude-sdk-connector.js:** Accepts `allowedTools`/`disallowedTools`, passes to SDK. Falls back to `preset: claude_code` when no restrictions (backward compat).
- **build.js:** `defaultConnectorFactory` resolves agent string through template registry. Emits `capability_profile` stream events.
- **build.stratum.yaml:** Review sub-flow steps use `claude:orchestrator` (triage, merge) and `claude:read-only-reviewer` (lens dispatch).
- 28 tests, all passing.

### COMP-TRIAGE: Task Tier Classification (Wave 1)

- **triage.js:** Pure file analysis — counts paths in plan/blueprint, detects security/core paths, assigns tier 0-4 and build profile (`needs_prd`, `needs_architecture`, `needs_verification`, `needs_report`).
- **build.js integration:** Triage runs before `stratum_plan()`, mutates `skip_if` on skippable steps based on profile. Cached in feature.json with mtime-based invalidation.
- **CLI:** `compose triage <feature>` standalone command. `compose build --template <name>` and `--skip-triage` flags.
- No new pipeline templates — reuses existing `build.stratum.yaml` with `skip_if` toggling.
- 13 tests, all passing.

### COMP-DESIGN-1c: Live Design Doc (Wave 0)

- **DesignDocPanel.jsx** (new): Context panel component showing a live markdown preview of the design document as it builds from decisions. Preview mode (react-markdown + remark-gfm) and edit mode (monospace textarea). Manual edits survive across assistant turns. "Reset to auto-generated" rebuilds from current decisions.
- **designSessionState.js**: Added `buildDraftDoc(messages, decisions)` — constructs markdown draft from problem statement + active decisions + open threads. Added `buildTopicOutline(messages, decisions)` — extracts decided topics for the research sidebar.
- **useDesignStore.js**: New state fields (`draftDoc`, `docManuallyEdited`, `researchItems`, `topicOutline`). Draft rebuilds on each assistant turn unless manually edited. Manual edit state preserved across rehydration.
- **design-routes.js**: `POST /api/design/complete` accepts optional `draftDoc` body field — uses human-edited draft as seed for final LLM polish pass instead of generating from scratch.
- **App.jsx**: Context panel auto-shows DesignDocPanel when design view is active.

### COMP-DESIGN-1d: Research Sidebar (Wave 0)

- **DesignSidebar.jsx**: Added tab bar (Decisions / Research) with count badges. Existing decision log under Decisions tab. Research tab shows live research activity.
- **ResearchTab.jsx** (new): Three collapsible sections — Topic Outline (decided/open topics), Codebase References (Read/Grep/Glob tool uses with file paths), Web Searches (queries + summaries). Live updates as research events stream in.
- **design-routes.js**: Broadcasts `research` and `research_result` SSE events from `tool_use` and `tool_use_summary` events during design conversations. Unique `tu-N` IDs for reliable event correlation.
- **useDesignStore.js**: SSE handlers for research events with ID-based correlation. Research items accumulate across the full session.
- 38 design tests, all pass. 8 new test cases for `buildDraftDoc` and `buildTopicOutline`.

## 2026-03-28

### STRAT-REV: Parallel Multi-Lens Review (1-4, 6)

- **Stratum:** Added `isolation: "none"` to IR v0.3 schema (`spec.py`) for read-only parallel_dispatch tasks. 2 new tests.
- **Lens library:** `lib/review-lenses.js` — 4 lens definitions (diff-quality, contract-compliance, security, framework) with confidence gates and false-positive exclusions. `triageLenses()` activates lenses based on file patterns. 10 tests.
- **Pipeline:** `pipelines/build.stratum.yaml` — new contracts (LensFinding, LensTask, LensResult, TriageResult, MergedReviewResult), `parallel_review` sub-flow (triage → parallel lens dispatch → merge), main flow review step wired to `parallel_review`.
- **Build.js:** Review timeout bumped to 15min, added triage (2min) and merge (3min) timeouts. `isolation: "none"` path verified for read-only tasks.
- **Fix loop:** Parent-level ensure/retry drives the fix loop — ensure fails → build.js claude fix → whole sub-flow re-invoked with fresh triage/lenses/merge.
- STRAT-REV-5 (selective re-review) complete: sidecar `.compose/prior_dirty_lenses.json` written on review ensure_failed, triage reads it on retry. STRAT-REV-7 (cross-model synthesis) deferred.

### COMP-UI-6: Polish and Teardown

- Deleted dead components: `AppSidebar.jsx` (~120 lines), `ItemRow.jsx` (~960 lines)
- Cleaned `VisionTracker.jsx`: removed @deprecated tag, scoped to PopoutView only
- Consolidated 13 scattered JS color constants from 9 files into `constants.js`
- Wrapped 6 remaining UI zones in `PanelErrorBoundary` (NotificationBar, GateNotificationBar, ChallengeModal, CommandPalette, ItemFormDialog, SettingsModal)
- Removed 8 dead functions from `vision-logic.js` (kept `filterSessions`, `relativeTime`)
- Deleted 17 dead `--row-*` CSS variables and `.row-chevron` class from `index.css`
- Removed dead `expandAgentBar()` export from `agentBarState.js`
- Updated tests: removed dead function tests, all 46 remaining tests pass
- **COMP-UI feature complete** — all 6 items done

### COMP-AGT-1-4: Agent Lifecycle Control

- `server/agent-health.js`: HealthMonitor class — stdout+stderr liveness probes, 60s silence warning, 5min auto-kill, wall-clock timeout, memory RSS polling, terminal reason tracking
- `server/worktree-gc.js`: WorktreeGC class — .owner file ownership, orphan scanning, age-based pruning, git worktree remove + rm fallback
- `server/agent-spawn.js`: `POST /api/agent/:id/stop` (SIGTERM→grace→SIGKILL), `POST /api/agent/gc`, health monitor wiring, terminal state precedence
- `server/agent-server.js`: 5s interrupt escalation timer for SDK sessions
- `server/agent-registry.js`: getRunning() and updateStatus() methods
- `lib/build.js`: .owner file on worktree creation, disk quota check (500MB default)
- UI: kill button per agent tab, silence warning yellow dot, agentKilled terminal state
- 16 tests (agent-health: 10, worktree-gc: 6)

### COMP-PIPE-1-3: Pipeline Authoring Loop

- 4 new pipeline templates: bug-fix (6 steps), refactor (7), content (4), research (3)
- Metadata blocks on all 7 templates (id, label, description, category, steps, estimated_minutes)
- `server/pipeline-routes.js`: template listing, spec fetch, draft CRUD with draftId concurrency, approve/reject with safe lifecycle
- `lib/build.js`: template selection via `opts.template`
- Store: `pipelineDraft` state + WS handlers for `pipelineDraft`/`pipelineDraftResolved`
- `TemplateSelector.jsx`: template card picker
- `PipelineView.jsx`: three modes — Empty (template selector), Draft (read-only + approve/reject), Active (existing)
- Version-aware step derivation (v0.1 flows + v0.3 workflow)
- Approved specs written to `.compose/data/approved-specs/` (not template library)
- 18 tests for pipeline-routes

### Phase 6.9: Agent Fleet Management — Roadmap

Added 17 items (COMP-AGT-1 through COMP-AGT-17) across 5 feature groups:
- Agent Lifecycle Control: interrupt, health monitoring, resource limits, worktree GC
- Agent Coordination: parent-child RPC, inter-task coordination, message ordering
- Merge & Recovery: conflict recovery strategies, graceful degradation with retry
- Registry & Observability: rich queries, structured metrics, dependency validation
- Agent Templates & Parent Skills: template library, capability registry, root parent
  orchestration skill, parallel dispatch skill, persistent state machine

### COMP-UX-11: Feature Event Timeline

- Collapsible right panel on Dashboard showing chronological feature lifecycle events
- 5 event categories: Phase, Gate, Session, Iteration, Error — each with distinct icons and severity colors
- Historical hydration from sessions.json + gates; live updates via WebSocket
- Virtualized scrolling (`@tanstack/react-virtual`) for large event histories
- Filter chips to narrow by event category
- Added client-side handlers for previously unhandled `lifecycleStarted` and `lifecycleTransition` WebSocket messages
- Gate outcome normalization handles both short-form (`approve`) and long-form (`approved`) variants
- New files: `timelineAssembler.js`, `EventTimeline.jsx`, `TimelineEvent.jsx`
- 11 unit tests for timeline assembler

## 2026-03-19

### Phase 4.5 Closed + Phase 6 Closed

**18h: Acceptance Gate (Phase 4.5)**
- Registered `agents` MCP server in `.mcp.json` — `agent_run` tool now discoverable
- Copied `review-fix.stratum.yaml` to `pipelines/` (was only in worktree)
- Fixed JSON code block extraction in `agent-mcp.js` schema mode
- Golden flow tests: 6 MCP protocol tests + live smoke test stubs
- `run-pipeline.mjs` script for end-to-end pipeline acceptance testing
- Phase 4.5 fully closed (all 18a–18h items COMPLETE)

**ITEM-23: Policy Enforcement Runtime**
- `evaluatePolicy()` pure function — reads per-phase policy modes from settings
- Build.js integration: skip (silent), flag (auto-approve + notify), gate (human approval)
- Gate records enriched with `policyMode` and `resolvedBy` fields
- Settings loaded lazily from disk at build start
- 10 unit tests + 2 Stratum integration tests (skip + flag paths verified e2e)

**ITEM-24: Gate UI Polish**
- `resolvedBy` badge on resolved gates (human vs auto-flag/auto-skip)
- Full gate history (replaces "Resolved Today" — last 10, expandable to 50)
- Prior revision feedback displayed on re-gated pending gates
- Handles both normalized outcome forms (approve/approved, revise/revised)

**ITEM-25a: Subagent Activity Nesting**
- `AgentRegistry` class — persistent parent-child tracking of spawned agents
- `agent-spawn.js` registers with registry, derives agentType from prompt heuristics
- `agentSpawned` WebSocket event broadcast on spawn
- `GET /api/agents/tree` returns hierarchy for current session
- AgentPanel "Subagents" section: pulsing dot for running, check/X for complete
- 11 unit tests for AgentRegistry

**ITEM-26: Iteration Orchestration**
- 3 REST endpoints: `iteration/start`, `iteration/report`, `iteration/abort`
- 3 MCP tools: `start_iteration_loop`, `report_iteration_result`, `abort_iteration_loop`
- Server-side exit criteria evaluation (review: clean==true, coverage: passing==true)
- Server-side max iteration enforcement (from settings: review=4, coverage=15)
- `iterationState` on item.lifecycle with full iteration history
- WebSocket broadcasts: iterationStarted/Update/Complete (client handler pre-existed)
- `coverage-sweep.stratum.yaml` pipeline
- 9 integration tests

**COMP-UI-6: Polish and Teardown**
- Deleted `compose-ui/` (old prototype), `SkeletonCard`, unused hooks
- Zone error boundaries on header, sidebar, ops strip, agent bar
- Migrated all legacy CSS token refs to modern `hsl(var(--*))` across 11 files
- Deleted legacy CSS token block from `index.css`
- Zero legacy token refs remaining in `src/`

## 2026-03-16

### COMP-DESIGN-1: Interactive Design Conversation

- **Design tab** in cockpit header — new view for interactive product design conversations with the LLM
- **Decision cards** — LLM presents options as clickable cards with recommendations; cards render from inline ` ```decision ``` ` JSON blocks in markdown
- **Design sidebar** — running decision log replacing AttentionQueueSidebar when Design tab is active; supports decision revision
- **Session management** — one session per scope (product or feature), persisted to `.compose/data/design-sessions.json`, survives page reloads
- **SSE streaming** — real-time LLM response streaming via session-scoped Server-Sent Events with in-flight dispatch guard
- **Design doc generation** — "Complete Design" action writes structured design doc to `docs/design.md` (product) or `docs/features/{code}/design.md` (feature)
- **`compose new` integration** — detects existing design doc and uses it as enriched intent, skipping the questionnaire
- **Security hardening** — prototype pollution protection, input validation, completed session guards, optimistic rollback

## 2026-03-15

### COMP-UX-1d: Ops Strip

- **OpsStrip component** (`src/components/cockpit/OpsStrip.jsx`): persistent 36px bar between main workspace and agent bar, surfaces active builds, pending gates, and recent errors as horizontally-scrollable pills
- **OpsStripEntry component** (`src/components/cockpit/OpsStripEntry.jsx`): pill component with design-token colors (blue/amber/red/green HSL), inline gate approve button, dismiss button for errors
- **Pure logic module** (`src/components/cockpit/opsStripLogic.js`): `deriveEntries()` and `filterRecentErrors()` — testable without React
- **recentErrors derived state** in `useVisionStore`: filters `agentErrors` to 60s window (max 5), recomputes on 10s interval for reactive aging
- **Entry animations**: slide-in on enter, flash green on build complete (2s), fade-out on dismiss
- **Visibility**: hidden when `activeView === 'docs'`, hidden when no entries
- **Build key uniqueness**: keyed by flowId/startedAt to prevent dismissal collision across builds for the same feature

## 2026-03-13

### STRAT-COMP-6: Web Gate Resolution

- **Gate enrichment**: CLI populates `fromPhase`, `toPhase`, `artifact`, `round`, and `summary` on gate creation
- **Shared constants** (`lib/constants.js`): canonical `STEP_LABELS`, `GATE_ARTIFACTS`, and `buildGateSummary()` — single source for CLI and frontend
- **GateView enhancements**: summary display, artifact link (opens canvas), build-gate prominence (amber border, larger buttons when `flowId` present), feature grouping by `itemId`, collapsible gate history with count badge
- **Imperative outcome vocabulary**: `approve`/`revise`/`kill` throughout GateView, ItemDetailPanel, and resolve calls (legacy past-tense keys retained as fallbacks in color maps)
- **`gateCreated` event**: renamed from `gatePending`; `visionMessageHandler.js` and tests updated
- **URL-encoded gate IDs**: `encodeURIComponent(gateId)` in `useVisionStore.js` resolve calls and `visionMessageHandler.js` fetch
- **Idempotent re-resolve**: `POST /api/vision/gates/:id/resolve` returns 200 on already-resolved gates instead of 400
- **StratumPanel gate link**: gate list replaced with "View gates in sidebar" link using `sessionStorage` + custom event for cross-panel navigation
- **VisionTracker listener**: responds to `vision-view-change` event to switch sidebar view

### STRAT-COMP-4: Vision Store Unification

- **Canonical port resolution** (`lib/resolve-port.js`): `COMPOSE_PORT > PORT > 3001` used by all components
- **Server probe** (`lib/server-probe.js`): lightweight health check with timeout for dual-dispatch routing
- **Dual-dispatch VisionWriter**: routes mutations through REST when server is up, writes directly to disk when down
- **featureCode migration**: legacy `featureCode: "feature:X"` auto-migrated to `lifecycle.featureCode` on load
- **Gate outcome normalization**: canonical `approve`/`revise`/`kill` enforced at all write boundaries
- **Atomic writes**: temp file + `renameSync` in both VisionStore and VisionWriter
- **AD-4 gate delegation**: server stores gate state and broadcasts events; CLI owns all lifecycle transitions
- **Gate expiry persistence**: expired gates written to disk so restarts don't resurrect them
- **55 integration tests** across 5 test files covering all unification behaviors

### STRAT-COMP-5: Build Visibility

- **Atomic `active-build.json`**: writes via temp file + rename, extended fields (stepNum, totalSteps, retries, violations, status, startedAt)
- **Terminal state retention**: completed/aborted builds retain `active-build.json` on disk (overwritten on next build start)
- **`buildState` WebSocket handler**: `visionMessageHandler.js` handles `buildState` messages, updates `activeBuild` state
- **File watcher extension**: server watches `.compose/` directory for `active-build.json` changes

### STRAT-COMP-7: Agent Stream Bridge

- **`BuildStreamWriter`** (`lib/build-stream-writer.js`): appends JSONL events to `.compose/build-stream.jsonl` with monotonic `_seq` and ISO timestamps
- **`BuildStreamBridge`** (`server/build-stream-bridge.js`): watches JSONL file, maps CLI events to SSE-compatible shapes, broadcasts to AgentStream
- **Build instrumentation**: `build.js` creates `BuildStreamWriter` after plan/resume, writes `build_start`, `build_step_start`, `build_step_done`, `build_gate`, `build_gate_resolved`, `build_error`, and `build_end` events
- **Crash detection**: bridge emits synthetic `build_end(crashed)` after configurable timeout during active step
- **27 tests** covering writer, bridge, event mapping, crash detection, and stale file handling
