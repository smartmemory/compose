# COMPOSE-UI-INTEGRATION-1 v2: each app publishes its screens, Compose imports them

**Status:** DESIGN v2, 2026-10-30, Opus (`hard:`). Replaces the 2026-10-29 pull design (summary
at the bottom; [read-model-contract.json](read-model-contract.json) superseded, kept for history).
**Hold:** the rewrite brief (2026-10-29 23:55) said "after 2.0.0"; the owner LIFTED it for this set
at 2026-10-30 00:3x (`OPS/units/COMPOSE-UI-INTEGRATION-1/wave-plan.md:3`); unit states are live.
`OPS/` = `SmartMemory/smart-memory-ops`, `C/` = this repo, `S/` = `forge/stratum`, `W/` =
`SmartMemory/smart-memory-wiki` (all under `/Users/ruze/reg/my/`).

## Related Documents

- Facts: `OPS/units/STRATUM-CADENCE-UI-AUDIT-1/{embed-inventory,stratum-dag-check}.md` (cited
  `EI:<line>`, `DAG:<line>`); wave: `OPS/units/COMPOSE-UI-INTEGRATION-1/{wave-plan,brief-common,base44-apps}.md`.
- Supersedes [COMPOSE-APP-INTEGRATION-1](../COMPOSE-APP-INTEGRATION-1/design.md) W1/W2 (note there).

## Owner decisions (2026-10-30, via s1-chat)

"their UIs should work standalone or integrate seamlessly into compose. stratum should have a
visual pipeline builder/editor at least if not realtime tracking." Components imported, not
iframes, not pulled JSON (ops static pages excepted). Wiki: "loosen the locks wtf it's just a
wiki" (Mac only, one security pre-land review). Base44 first, s1-chat's 3 prompts (`base44-apps.md:1`).

## 1. Shape in plain English

**Each app ships its screens like Lego bricks plus a power socket.** The bricks are React components;
the socket is a `DataClient`, a plain object of async methods passed in through a React context
provider. Components never fetch. The standalone shell plugs in the app's own client, Compose plugs
in one that goes through Compose's server: same bricks, two houses, nothing to drift.

- **Spine:** a components package per app (`S/ui/`, `W/ui/packages/wiki-components/`): DataClient
  contract written FIRST, screens, `DataClientProvider`, a thin Vite shell, and optionally a `server/`
  handler both hosts mount (one reader, two hosts; COMP-COCKPIT-12 "no second set of parsers").
- **Swappable part / adapter:** the DataClient per host; Compose's live in `src/lib/clients/<app>.js`.
- **One-off:** ops status pages, iframed as-is from Compose's static server.
- **Bottleneck:** Compose's import seam: Mac-only workspace links vs a CI/npm build with no siblings.

### Shared conventions (every package)

| Convention | Rule | Evidence |
|---|---|---|
| React | `peerDependencies` `react`/`react-dom` `>=18 <20`; no single major, because the hosts differ | C `package.json:110-111` (`^19.2.5`), W `ui/package.json:65,67` (`^18.2.0`) |
| One React copy | Compose's Vite sets `resolve.dedupe: ['react','react-dom']` (absent today: no `dedupe` in `C/vite.config.js`); two copies break hooks | grep, 2026-10-30 |
| Router | screens take route params as props (`featureId`, `runId`, `query`) and call `onNavigate(target)`; never `useParams`/`window.location` | Compose has no router, `switch (activeView)` `C/src/App.jsx:256` (EI:9) |
| Theme | CSS custom properties only, no CSS-in-JS runtime; Tailwind colours map to `var(--token)` with fallbacks; the host adds the package's `src/**` to its Tailwind `content` | 73 tokens in `C/src/index.css` (EI:11); Tailwind 3 in both: C `package.json:128`, W `ui/package.json:103` |
| Linking | Mac workspace links, no npm publish. Compose resolves `@stratum/ui`, `@wiki/components` through a Vite alias to a sibling path that exists only on the Mac; when absent the alias points at a stub and the tab is hidden (PROVIDER-SEAM: absent = visibly absent) | CI builds without siblings: `.github/workflows/publish.yml:61-62` `npm install && npm run build`; npm ships prebuilt `dist/**` (`C/package.json` `files`) |
| Base44 | scaffold by `--app-id`, never `eject`/`deploy`; no Base44 SDK import survives in a package | `base44-apps.md:9-17` |

## 2. Per tool

### Stratum (new standalone app `S/ui/`, Base44 "Stratum Studio" `6ae36eeefd9267ced8a797d1`)

- **Why new:** no Stratum HTTP server (EI:23); `S/app/` is a stale Compose fork, not built on (EI:25).
- **Run view (STRAT-UI-APP-1):** RunsList, RunDetail (step DAG coloured by status), StepDrawer,
  GatesInbox, from `~/.stratum/ts/flows/<runId>.json`: whole spec, per-step `status`, `events[].at`
  timing (DAG:16-21). Edges = `after` + `${step.output}` refs (`ts/src/engine/engine.ts:3011-3017`);
  `on_revise` is a back-arrow, not a cycle (DAG:13). Gate actions shell out to `stratum gate`.
- **Builder/editor (STRAT-UI-BUILDER-1):** emits exactly `SpecificationSchema` JSON v1 (strict zod,
  unknown keys fail, DAG:29), one kind key per step (`ir/schema.ts:91-96`; Base44's `serializeStep`
  flattening is the known bug, `base44-apps.md:13`). `validateSpec(spec)` runs `validateSpec()`
  (`ir/validate.ts:348`) server-side; errors `{code, path, message}` highlight by `path`.
  `planFlow` = dry `stratum_plan` (`mcp/server.ts:305-312`). **No run button:**
  `stratum_flow_run_bg` would dispatch agents from a UI.
- **Realtime (STRAT-UI-RUNVIEW-1):** optional `DataClient.subscribe(runId, cb)` over a flows-dir
  watch; absent = poll. Compose bridges it to its file-watcher WebSocket (`C/server/index.js:276`).
- **In Compose:** the package's `server/` handler mounts at `/api/stratum-ui/*` on 4001; the DataClient
  is the standalone one with that base URL. Meanwhile the orphaned `StratumPanel.jsx` (0 imports,
  EI:12) is the native gate view over `C/server/stratum-api.js:53-67` until GatesInbox replaces it.

### Wiki (`W/ui/packages/wiki-components/`, no Base44 step)

- **Components (WIKI-UI-COMPONENTS-1):** `FeatureHub`, `Search` lifted out of the Router SPA
  (`W/ui/src/screens.js:4-16`, `useParams` `FeatureHub.jsx:31`, `?q=` `SearchPage.jsx:18-20`);
  `/ui/` keeps working via thin route wrappers and a fetch DataClient, zero visible change.
- **Compose's DataClient goes through Compose's server:** wiki data calls are `POST /query/{name}`
  (`W/wiki/spine/api/app.py:232`) and the loosening keeps non-GET strict same-origin, so a browser
  call from Compose is refused by design. `/api/wiki/*` sends `x-wiki-owner-token` from an env var
  NAME, `wiki-eng` only, never `/commands` (COMPOSE-APP-INTEGRATION-1 §3 rules, kept).
- **Lock loosening (WIKI-FRAME-LOOSEN-1, security, Mac only):** CSP `frame-ancestors 'none'`
  (`W/wiki/spine/serve.py:79-82`), the `Sec-Fetch-Site` gate (`api/browser.py:488-490`),
  `SameSite=Strict` (`browser.py:463`) (EI:40-43) move together on one knob `WIKI_FRAME_PARENTS`
  = `http://127.0.0.1:4001 http://127.0.0.1:5195` on the Mac, empty on us1. It serves the "open
  full wiki" iframe for screens not yet componentized; needs Compose on `127.0.0.1` (landed `c6811498`).

### Ops status pages (iframe as-is)

`OPS/status/build.py` writes 8 single-file pages to `OPS/status/out/<name>/status.html` every 15 min
(EI:18-19). Compose serves that dir via `express.static` at `/ops-status/` and iframes it same-origin;
path from config, absent = tab hidden. **15-min staleness accepted.** Live ops = CADENCE-UI-BOARD-1.

## 3. Units (ordered; live state in the DAG below)

COMPOSE-UI-RUN-1 [LANDED `c6811498`] is first. CADENCE-UI-BOARD-1, CADENCE-UI-TYPED-1 stay Cadence's.

**STRAT-UI-APP-1**: `S/ui/` (new), `S/ui/src/data-client.ts` (new), `S/ui/server/` (new)
*Breaks:* a wrong edge rule draws a DAG the engine disagrees with.
- [ ] DataClient written first: `listRuns`, `getRun`, `listGates`, `resolveGate(runId, stepId, action, note)`
- [ ] RunsList, RunDetail, StepDrawer, GatesInbox each render from a fake DataClient (test)
- [ ] standalone server on a test-range port reads flow files read-only; gate round-trip on a throwaway flow only
- [ ] one table test of status→style and edge derivation (`after` + output refs)

**STRAT-UI-BUILDER-1**: `S/ui/src/screens/Builder*` (new), `S/ui/server/` (existing by then)
*Breaks:* an engine schema change (`ir/schema.ts`) silently breaks export; the round-trip test trips.
- [ ] 3 real specs round-trip import → export → equal, and `validateSpec` returns `valid` for each
- [ ] exactly one kind key per step (fixes Base44 `serializeStep`)
- [ ] `validateSpec` errors highlight the node named by `path`
- [ ] `planFlow` is a dry plan; no run-in-background control exists

**STRAT-UI-RUNVIEW-1**: `S/ui/server/watch.*` (new)
*Breaks:* a leaked watcher adds FSEvents load; one watcher per server, closed on exit.
- [ ] `subscribe` delivers a step status change within 2 s of the flow file write
- [ ] screens poll when the host's DataClient has no `subscribe`

**COMPOSE-OPS-TAB-1**: `C/server/index.js` (existing), `C/src/App.jsx` (existing)
*Breaks:* a loose static root leaks other OPS files.
- [ ] `/ops-status/<name>/status.html` iframed, the 8 pages selectable; only `status/out` is served
- [ ] tab hidden when the configured path is unset

**COMPOSE-STRAT-GATE-WIRE-1**: `C/src/components/StratumPanel.jsx`, `C/src/App.jsx` (existing)
*Breaks:* a gate resolved from two places; the CLI's gate token decides, the panel re-reads.
- [ ] panel mounted as a view: gates list + approve/reject/revise via `/api/stratum`
- [ ] the "STRAT-COMP-8 deletes" header note (`StratumPanel.jsx:285`) rewritten to point at COMPOSE-STRAT-TAB-1

**COMPOSE-STRAT-TAB-1**: `C/src/lib/clients/stratum.js` (new), a
`/api/stratum-ui/*` mount in `C/server/` (new), `C/vite.config.js` and `C/src/App.jsx` (existing)
*Breaks:* CI/npm build if the alias is not optional; two React copies break hooks.
- [ ] Stratum view imports `@stratum/ui`; `resolve.dedupe` set for react/react-dom
- [ ] `npm run build` green with the sibling absent (stub, tab hidden)
- [ ] StratumPanel retired in favour of GatesInbox

**WIKI-FRAME-LOOSEN-1** (security-tagged, stops at READY for one pre-land review):
`W/wiki/spine/serve.py`, `W/wiki/spine/api/browser.py` (existing)
*Breaks:* a listed parent can frame the signed-in wiki (clickjacking); relaxed SameSite widens CSRF to GETs.
- [ ] one knob `WIKI_FRAME_PARENTS` drives CSP, Sec-Fetch-Site (GET navigations only) and SameSite
- [ ] us1 headers byte-identical; empty knob = `frame-ancestors 'none'`
- [ ] one table test: parent origin × method × profile → allow/deny + header values

**WIKI-UI-COMPONENTS-1**: `W/ui/packages/wiki-components/` (new)
*Breaks:* the live `/ui/` app (the wiki deploys on land); screenshots gate it.
- [ ] typed DataClient listing exactly the calls FeatureHub and Search make today
- [ ] `/ui/` unchanged: before/after screenshots of `/ui/feature/<code>` and `/ui/search?q=<code>`
- [ ] existing ui tests green plus one fake-client render test per component

**COMPOSE-WIKI-TAB-1**: `C/server/wiki-routes.js` (new),
`C/src/lib/clients/wiki.js` (new), `C/src/App.jsx` (existing)
*Breaks:* config reaching `wiki-private`; the adapter refuses it.
- [ ] FeatureHub for the selected feature code; Search prefilled with it
- [ ] token from an env var NAME, `wiki-eng` only (`wiki-private` refused whatever config says), never `/commands`
- [ ] "open full wiki" iframe carries the session on the Mac

### Dropped from v1 (one line each)

- COMPOSE-OPS-READMODEL-1: Compose no longer aggregates; each app's DataClient reads its own sources.
- COMPOSE-OPS-BELT-1: the belt is a Cadence Board screen (CADENCE-UI-BOARD-1) and the ops pages.
- COMPOSE-OPS-FLEET-1: the seat strip is a Cadence Board screen; no Compose read model to feed it.
- COMPOSE-OPS-ATTENTION-1: gates move to GatesInbox, owner asks to Cadence Board's attention list.
- COMPOSE-OPS-HEALTH-1: no providers left to watch; re-file only on an incident (FILING BAR).
- STRAT-QUERY-EVENTS-1: the run file already carries spec, status and events (DAG:21); no CLI verb.
- STRAT-QUERY-AGENTS-1: no screen consumes agent runs in v2; re-file when one does.

## DAG

Live state's one home is `wave-plan.md`; states here were read 2026-10-30 ~02:00.

| step | depends_on | state | artifact | repo |
|---|---|---|---|---|
| COMPOSE-UI-RUN-1 | - | DONE | units/COMPOSE-UI-RUN-1/report.md | compose |
| STRAT-UI-APP-1 | - | RUNNING | units/STRAT-UI-APP-1/report.md | stratum |
| STRAT-UI-BUILDER-1 | STRAT-UI-APP-1 | WAITING ON STRAT-UI-APP-1 | units/STRAT-UI-BUILDER-1/report.md | stratum |
| STRAT-UI-RUNVIEW-1 | STRAT-UI-APP-1 | WAITING ON STRAT-UI-APP-1 | units/STRAT-UI-RUNVIEW-1/report.md | stratum |
| COMPOSE-OPS-TAB-1 | COMPOSE-UI-RUN-1 | HELD for s2-coord dispatch (RUN-1 landed c6811498, wave-plan still says RUNNING) | units/COMPOSE-OPS-TAB-1/report.md | compose |
| COMPOSE-STRAT-GATE-WIRE-1 | COMPOSE-OPS-TAB-1 | WAITING ON COMPOSE-OPS-TAB-1 | units/COMPOSE-STRAT-GATE-WIRE-1/report.md | compose |
| COMPOSE-STRAT-TAB-1 | STRAT-UI-APP-1, COMPOSE-STRAT-GATE-WIRE-1 | WAITING ON STRAT-UI-APP-1, COMPOSE-STRAT-GATE-WIRE-1 | units/COMPOSE-STRAT-TAB-1/report.md | compose |
| WIKI-FRAME-LOOSEN-1 | - | RUNNING | units/WIKI-FRAME-LOOSEN-1/report.md | wiki |
| WIKI-UI-COMPONENTS-1 | - | RUNNING | units/WIKI-UI-COMPONENTS-1/report.md | wiki |
| COMPOSE-WIKI-TAB-1 | WIKI-UI-COMPONENTS-1, WIKI-FRAME-LOOSEN-1, COMPOSE-UI-RUN-1 | WAITING ON WIKI-UI-COMPONENTS-1, WIKI-FRAME-LOOSEN-1 | units/COMPOSE-WIKI-TAB-1/report.md | compose |

OPS-TAB, GATE-WIRE, STRAT-TAB run in series (each edits the `activeView` switch, `wave-plan.md:26`; STRAT-TAB
retires GATE-WIRE's panel). COMPOSE-WIKI-TAB-1 rebases onto whichever lands first.

## Owner questions

1. Published npm Compose ships without the Stratum/wiki tabs (no npm publish of the packages).
   Accept, or publish the packages later? Recommend accept until 2.0.0.

## ELI5 TLDR

**Each tool builds its screens once, and Compose borrows those exact screens instead of redrawing
them.** Stratum gets its first real app: a picture of each run and a flow editor whose output the
engine checks before anything runs. The wiki's two key pages become borrowable and the wiki trusts
Compose on this Mac only. Ops pages stay a framed window, 15 minutes stale. The catch: borrowed
screens exist only in a Compose built on this Mac. Your call: fine until 2.0.0?

## Superseded 2026-10-30 (v1, 2026-10-29)

v1: one live Ops board in Compose fed by pull "reporters" (provider runner, in-memory read model,
`GET /api/ops/state`, `opsEvent` over `ops-event/1`/`ops-snapshot/1`, new `stratum query
events|agent-runs|audit`, `ev.py export`) and eight units. Replaced by published components:
Compose owning every panel makes the standalone UIs a drifting second renderer (EI:31). Full v1:
`git show 14be5511:docs/features/COMPOSE-UI-INTEGRATION-1/design.md`.
