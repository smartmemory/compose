# COMP-PARITY-1 — Blueprint

**Status:** BLUEPRINT (refs read this session; no Boundary Map → Phase-5 verification folded in)

## Single file changed: `bin/compose.js`

### 1. Alias the command verb (line 2827)
`} else if (cmd === 'gates') {` → `} else if (cmd === 'gates' || cmd === 'gate') {`
Keeps `gates report` and adds `gate`/`gates` `list`/`resolve`.

### 2. Inside the block, add `list` + `resolve` branches beside `report`
Current shape (verified `bin/compose.js:2833-2907`):
```
const gatesSubcmd = args[0]
if (gatesSubcmd === 'report') { … process.exit(0) }
console.error(`Unknown gates subcommand: ${gatesSubcmd}`)   // ← extend usage line
```
Add `if (gatesSubcmd === 'list') {…}` and `if (gatesSubcmd === 'resolve') {…}` before the
unknown-subcommand error; update the usage text to include list/resolve.

### 3. HTTP helpers — mirror `compose loops` (`bin/compose.js:2935-3007`, verified)
- `baseUrl = process.env.COMPOSE_URL || \`http://127.0.0.1:${resolvePort()}\`` (`resolvePort` already imported, line 19).
- Workspace: tolerant `getWorkspaceFlag(args)` + `resolveWorkspace(...)` → `X-Compose-Workspace-Id` (swallow errors, mirror loops 2946-2952).
- `httpGet(url, wsId)` / `httpPost(url, body, wsId)` copied from loops, **plus** for POST:
  `if (process.env.COMPOSE_API_TOKEN) headers['x-compose-token'] = process.env.COMPOSE_API_TOKEN`
  (verified header name: `server/auth-middleware.js:137,200`; guardAuth is opt-in so token is
  only needed when `capabilities.guardAuth===true`).
- Wrap calls in try/catch; on `ECONNREFUSED` print
  `compose server not reachable on :${resolvePort()} — start it with \`npm run dev:server\`` and exit 1.

### 4. `gate list` — `GET /api/vision/gates`
- Flags: `--item <id>` → `?itemId=`; `--status pending|all|resolved` (default pending) → `?status=` (omit for pending; server treats absent as pending); `--format text|json`.
- Response `{ gates: [...] }` (verified `vision-routes.js:762-773`). Gate fields available:
  `id, flowId, stepId, round, itemId, fromPhase, toPhase, status, summary, createdAt` (verified `vision-routes.js:809-825`).
- `text`: table — `ID | ITEM | STEP | PHASE (from→to) | AGE | STATUS`; age = now−createdAt humanized; empty → "No <status> gates.".
- `json`: `console.log(JSON.stringify(gates, null, 2))`.

### 5. `gate resolve <gateId> (--approve|--revise|--kill) [--comment|--reason <text>]`
- Positional `args[1]` = gateId (required; error if missing).
- Exactly one of `--approve|--revise|--kill` → `outcome ∈ {approve,revise,kill}` (error if zero/multiple).
- `comment = flagVal('--comment') ?? flagVal('--reason') ?? undefined`.
- `POST /api/vision/gates/${gateId}/resolve` body `{ outcome, comment, resolvedBy: 'cli' }`
  (verified endpoint `vision-routes.js:860-872`: requires outcome, whitelist approve/revise/kill, 404 unknown gate).
- 2xx → `Gate <id> resolved: <outcome>`; non-2xx → print `body.error || body` and exit 1.

## Corrections table
| Spec assumption | Reality | Resolution |
|---|---|---|
| `compose gate …` (singular) | shipped command is `gates report` (plural) | alias both verbs |
| `--reason` is a distinct field | endpoint body has only `comment` | `--comment`/`--reason` both map to `comment` |
| resolve is unauthenticated | wrapped in `guardAuth` (opt-in via `capabilities.guardAuth`) | send `x-compose-token` when `COMPOSE_API_TOKEN` set; no-op otherwise |
| (none) | list endpoint default (no `?status`) returns **pending** | omit `?status` for the pending default |

## Tests — `test/cli-gate.test.js` (new)
Minimal Express stub (`express` is a dep) exposing `GET /api/vision/gates` (honors `status`/`itemId`)
and `POST /api/vision/gates/:id/resolve` (mirrors the whitelist + 404), bound to an ephemeral port;
run the CLI with `COMPOSE_URL=http://127.0.0.1:<port>` and assert: list pending/all/json,
resolve approve/revise/kill body shape, exactly-one-outcome enforcement, gate-not-found 404 surfaced,
server-down (bad URL) → friendly message + exit 1.
