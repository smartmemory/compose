# Design — FOH-6 COLLEAGUE-PANE (Maya in the Compose cockpit)

**Status:** DRAFT — pending self-adversary pass + Codex design gate + owner gate.
**Feature:** COMP-FOH FOH-6. **Mode:** build, full lifecycle.
**Depends on:** FOH-3 CHALLENGE @e114e53, FOH-4 CONVICTION @8a477bb, FOH-5 CONTRADICTION @7731043.
**Related:** [design.md](design.md) (epic), [architecture.md](architecture.md) (§Sequencing deferred the colleague),
[foh-5-progress.md](foh-5-progress.md), owner ruling `COLLEAGUE-ALL-IN`
(docs/product/2026-07-20-what-to-build-vision.md §8k).

## Owner decisions already made (2026-08-11, do not re-litigate)

1. **FOH-6 = the colleague slice.** Chosen over exhaust-loop, portfolio rollup, pausing the epic.
2. **Maya is the existing SmartMemory assistant** (`/Users/ruze/reg/my/SmartMemory/maya/`). We **layer
   over her; her core is never modified.** No Maya code changes in this slice.
3. **V1 surface: a colleague pane inside the Compose cockpit**, relaying to Maya's existing chat API.
   (Not Maya's own web UI; not headless gate annotations.)
4. **Token source is pluggable, local-first**: provisioned local identity now, pasted real token later.

## What this builds

A **Colleague panel** in the cockpit — a summonable slide-over, not a main-area tab (owner
direction 2026-08-11: "alongside the other content") — where the owner converses with Maya about
the fluid corpus while looking at whatever view they're already on.
Compose does the memory reasoning itself — challenge, conviction, contradictions via the shipped
provider seam — and hands Maya the findings as per-turn context. Maya provides the conversational
intelligence over them. Her replies about a specific idea write back into that idea's discussion
trail as `author: 'maya'`.

**This makes the panel the first production consumer of the three dark capabilities** (FOH-3/4/5
shipped `challenge`/`conviction`/`contradictions` with zero production callers). Concretely: the
context builder becomes the first production call site of the existing `challengeIdea` and
`convictionOf` wrappers plus a new `contradictions` consumer (small `ideabox-ops` wrapper to add).
`resolveIdeaChallenge` is **not** in this inventory — resolution stays out of the panel (see Scope
fences). First-production-caller status is an acceptance criterion, not a side effect.

## The load-bearing design choice: shallow binding (v1), not deep

Two ways to make Maya "aware" of compose fluid records:

- **Deep binding (rejected for v1):** mint Maya a JWT whose workspace claim IS the compose fluid
  workspace, so her own recall/challenging/turn-ingestion operate there. Maya derives workspace
  **solely** from the verified JWT claim (`maya/api/client.py:73-83` — no header/body/query lever
  exists, deliberately). Deep binding therefore requires minting real per-workspace JWTs, and it
  makes her background turn-ingestion a *writer* into the fluid workspace (cohabitation is
  namespace-shielded on our read side — FOH-5 verified the `fluid_ns` filter — but it's a decision,
  not a side effect). Deferred to a later slice as a config option once real JWT minting exists.
- **Shallow binding (chosen):** Maya's JWT points at her own conversation workspace (a dedicated
  provisioned identity — see Token source). Compose computes the memory findings itself through the
  existing API-key client (`lib/smartmemory-client.js` auths via `Authorization` + `X-Workspace-Id`,
  no JWT problem) and injects them per turn. Her conversation memory accumulates in her identity's
  workspace; the fluid workspace is never written by her. Zero cross-contamination, zero core changes
  anywhere (Maya, smart-memory-service, or SmartMemory core).

## Architecture

### 1. Server relay — `server/maya-routes.js` (new)

Modeled on `attachAgentProxy` (`server/remote-utils.js:55-115`): fixed route table, hop-by-hop and
client-credential stripping, server-side `Authorization: Bearer <token>` injection, SSE pass-through,
502 on upstream connect failure.

- `GET  /api/maya/status` — degrade-never-fail probe in the `smartmemory-routes.js:66-112` shape:
  always a shaped 200: `{enabled:false}` (no config) / `{available:false, error}` (unreachable/auth
  failure) / `{available:true, session}`. **Never throws to the client.** The pane keys its funnel
  state off this.
- `POST /api/maya/message` — builds the upstream `POST /api/chat` body: user text + composed
  `channel_context` (see §3) + fixed `timezone`; relays the `ChatResponse`.
- Streaming (S5, stretch): **POST fetch-streaming on `/api/maya/message` (`?stream=1`), not
  EventSource.** A browser EventSource GET cannot carry the user text + composed context that Maya's
  upstream `POST /api/chat/stream` requires; the relay streams the upstream SSE back over the POST
  response body and the pane consumes it via `fetch` + ReadableStream. No `streamPaths` registration
  is needed under this transport.

**Auth posture (corrected after Codex design review):** the Maya routes stay **behind** the
remote-mode auth gate — they are **never added to the route allowlist**. Allowlisted paths bypass
authentication entirely (`server/auth-middleware.js:192`); allowlisting `/api/maya/message` would
publish an unauthenticated proxy wielding the server-held Maya credential. The
`smartmemory-routes.js` precedent (authenticated, degrade-never-fail) is the model.

Operational note pinned in the module header: a Maya deployment used by this relay must keep
`MAYA_PROACTIVE_CHECK_INTERVAL_S=0` (default). Non-zero turns Maya into a proactive *writer* against
the workspace of the last-seen JWT (`maya routes.py:3886-3956`) — not wanted from a relay identity.

### 2. Token source — pluggable, local-first

Config in `.compose/compose.json`, presence-gated like the `smartmemory` block:

```jsonc
"maya": {
  "baseUrl": "http://localhost:9005",
  "auth": { "mode": "provision" | "static" }
}
```

- **`provision` (local default):** on first use, the relay provisions a dedicated colleague identity
  via smart-memory-service `POST /test/provision-user` (root-mounted, unauthenticated, sanctioned
  test path — **the same path both FOH-4 and FOH-5 live-fires used**), accepts the beta NDA
  (`POST /memory/beta/nda/accept {"version":"v1"}` — FOH-4 ledger prereq 3), and persists
  `{user_id, tenant_id, team_id, access_token, email}` in `data/maya-identity.json` (gitignored,
  same tier as `data/design-sessions.json`). Teardown command supported
  (`DELETE /test/provision-user`).
- **`static`:** token pasted into settings, stored same place.
- **401 handling — never silently re-provision.** The colleague identity *owns* Maya's only
  conversation (see §6): provisioning a fresh identity destroys the standing thread, and a 401 does
  not prove expiry (issuer/audience/config failures look identical). On 401 the relay retries the
  same token once (transient), then renders the auth funnel with two *explicit* actions:
  "re-provision — starts a fresh conversation" and "paste a new token". Continuity is a user-visible
  trade, never an automatic side effect.
- **Workspace-isolation validation (both modes).** Shallow binding's safety claim depends on the
  colleague token's workspace being distinct from `fluid.smartmemory.workspaceId`
  (`lib/fluid/factory.js:136-161`): a fluid-workspace token silently enables the deferred
  deep-binding behavior (her turn-ingestion writing into the fluid workspace). The relay validates
  at configure time — token workspace claim ≠ fluid workspaceId, else it refuses with an explanatory
  funnel. Reusing one token across projects (which would merge their standing conversations) is
  **unsupported and documented, not detected** — the check runs against *this* project's fluid
  workspace and cannot see another project's config; a real cross-project binding mechanism is out
  of scope for v1.
- **`dev-bypass` is explicitly NOT a mode.** FOH-4 proved `SMARTMEMORY_AUTH_BYPASS` synthesizes
  `tenant-<id>` (hyphen) which matches no real tenant row — the quota middleware 500s on any
  mutating route. Recording it here so nobody re-derives it.

Maya-side workspace claim: her `_extract_team_id` reads `workspace_id`/`current_workspace_id`/
`default_team_id` off the *verified* user. The provisioned identity carries a real `team_id`.
**VERIFY-1 (blueprint entry-gate):** confirm a provision-user token passes Maya's auth middleware and
yields a usable workspace claim end-to-end.

### 3. Context injection — `channel_context` (at-risk dependency, managed)

Per turn, the relay composes `channel_context: [{author, text}]` from the record in focus:

- the record's rendered content (idea title/body),
- `convictionOf(id)` — current confidence + recent history,
- `contradictions(handle)` — the itemized contradicting records,
- `challengeIdea(id)` — conflicts detected against the corpus (30s timeout path from FOH-3),
- recent discussion entries (already author-attributed).

Facts about this field, stated before the gate, not after:

- It is **bridge-only by comment convention, not enforcement** (`ChatRequest`, maya
  `routes.py:3230-3246`): `SkipJsonSchema` + `exclude=True` suppress it from docs/serialization but
  pydantic **accepts it on input**, and `_chat_impl` consumes it unconditionally
  (`routes.py:4090, 4482`), token-capped at priority 2 (`llm_manager.py:501-506`).
- Her prompt frames the block as a **Discord channel transcript** wrapped in an untrusted-data label
  (`routes.py:714-754`, `llm_manager.py:366`). Acceptable for v1: the framing still lands the
  content; authorship strings make provenance explicit (`compose:idea IDEA-42`, `compose:conviction`, …).
- It is **ephemeral** — she discusses it but does not remember it. Continuity comes from her own
  conversation memory (session per identity) plus our re-injection each turn.
- **Truncation priority (Codex design finding):** Maya token-caps the block
  (`CHANNEL_CONTEXT_MAX_TOKENS`), so the composer enforces its own ordering *before* sending —
  the capability findings are the point of the slice and must survive:
  **contradictions > conviction > challenge > record body (truncated first to headline+summary) >
  recent discussion (dropped first)**. Anything omitted is named in the panel's per-turn context
  note ("context sent: record · conviction · 1 contradiction — discussion omitted, over budget"),
  so the owner never mistakes a truncated turn for a clean one. Exact token arithmetic is blueprint
  detail; the ordering and the visible-omission rule are design contracts.

Mitigations (both, per advisor):
1. **Smoke test that fails loudly** if a Maya upgrade stops accepting the field (an integration test
   against a running Maya asserting the injected fact is reflected in her reply, plus a cheap
   request-shape assertion in the relay).
2. **Upstream issue** on the Maya repo requesting a supported, documented per-turn context field —
   the FOH-5 pattern (three upstream issues filed there). Filed at implement time as smartmem-dev.

**VERIFY-2 (blueprint entry-gate):** live check against a running Maya that `channel_context`
is accepted on `/api/chat` and reaches the prompt (the Phase-1 pydantic verification was
static/local, not the live endpoint).

### 4. Cockpit panel — summonable colleague slide-over (owner direction 2026-08-11)

**Not a main-area tab.** Maya is ambient: a right-side slide-over panel overlaying the current
view, summoned from a chrome button in the tab strip (next to the connection pill). The owner talks
to her *alongside* the graph/ideabox/gate they're already looking at.

- **No `DEFAULT_MAIN_TABS` change.** This deliberately sidesteps the tab-persistence machinery
  (`viewTabsState.js:91` auto-migrates every default into persisted tab lists, and `App.jsx:414`
  initializes once without config filtering — a tab could not implement "hidden when unconfigured"
  with the tab primitives alone; Codex design finding, confirmed). The chrome button renders iff
  `/api/maya/status` reports the feature installed — a plain conditional, no persistence involved.
- Panel body reuses `ChatInput.jsx` + `MessageCard.jsx` (the AgentStream components) with Maya's
  message shape adapted; no new message-list component. Findings (conviction / contradictions /
  challenge) render as a collapsible section inside the panel header.
- **Record-in-focus follows the cockpit.** Default: the current selection context (the idea open in
  Ideabox, the item under a gate). A manual "discussing: <idea>" override picker is retained. No
  focus → corpus-level context (recent ideas list).
- **Funnel, not hide** (seam doctrine, `provider.js:209-228`): once the feature is installed
  (config present), the button is always there; every degraded condition renders an explanatory
  funnel state *inside the panel* with the fix. **`RecallTab`'s hide-when-disabled is the named
  anti-pattern — do not copy it** (`ContextItemDetail.jsx:55-65`).
- No `maya` config block at all → no button (feature not installed ≠ capability degraded).

### 5. Write-back — Maya joins the discussion trail

When the turn was about a record in focus, the relay appends her reply to that idea's discussion:
`addDiscussion(ctx, id, {author: 'maya', text})` (`lib/fluid/ideabox-ops.js:464` — the author field
already exists; routes accept it, `server/ideabox-routes.js:199-204`). Zero schema change. Toggleable
in the panel (default on). Full transcript persistence beyond per-idea write-back is **out of scope**
v1 — her own session memory covers continuity.

**Partial-failure contract (Codex design finding):** the chat result is authoritative and the two
outcomes are decoupled. Maya's reply always renders once received — a write-back failure must never
surface as a failed turn (that invites resending the chat and double-charging her session with the
same turn). The relay's `/message` response carries `{reply, writeback: 'ok'|'landed-unrendered'|'failed'}`:
`landed-unrendered` (durable mutation succeeded, projection render failed — the distinction
`addDiscussion` already exposes, `server/ideabox-routes.js:80`) renders a non-blocking notice with a
**re-render repair affordance** — the projection stays stale until a successful render, so this is a
visible warning state with a repair action, not silent success; `failed` renders a warning chip with
a **retry-append-only** affordance — never the chat turn.

**Write-back is idempotent, keyed on Maya's `message_id`.** A `failed` outcome does not prove the
append didn't land (the durable write can succeed and the call still fail afterward — e.g. on the
event append); a blind retry would duplicate her reply in the append-only trail. Every write-back
entry embeds the reply's `message_id` (from her `ChatResponse`), and retry is **reconcile-then-append**:
check the record's discussion for that `message_id` marker first, append only if absent. The
blueprint decides the marker encoding; the design contract is the key and the check-before-retry.

### 6. Session model

Maya keeps **one continuous conversation per identity** (`session_registry.py:486-527`; no
conversation_id in her API; 30-min inactivity / 24-h rollover). V1 is therefore **a single standing
colleague thread** — the relay uses one provisioned identity. Per-idea/parallel threads would mean
one identity per thread; named follow-up, not v1.

## Scope fences (verbatim, for the blueprint)

- **V1 discusses ideas only.** Not clusters — the seam refuses `cluster` as non-assertional for
  challenge (`provider.js:171-178`), so a cluster focus would need a per-kind context matrix; named
  follow-up. Not decisions — `decision` is a supported, challengeable kind with **no producer in
  Compose** (design-session decisions live in `data/design-sessions.json`, judgment positions in
  `docs/judgment/`); a decision producer is a named follow-up, not scope creep here.
- **`src/components/vision/ChallengeModal.jsx` is a false friend** — it is the vision-item challenge
  flow posting to `/api/agent/message`, unrelated to `CAP.CHALLENGE`/fluid records. Do not wire it.
- **CALIBRATION stays out.** Undeclared on the provider (`smartmemory-provider.js:329-334`), blocked
  upstream ("no subject"). The `COLLEAGUE-ALL-IN` ruling lists it as one of Maya's three hard-required
  capabilities — v1 ships without it and says so in the pane's capability funnel.
- **No Maya core changes** — includes NOT wiring her MCP tool loop into `/api/chat` (that ~5-line
  edit is the cleanest deep integration and is explicitly deferred with the deep-binding slice).
- **`resolveIdeaChallenge` (the decaying write) stays out of the pane in v1.** The pane surfaces
  findings; resolving a conflict (chunky, near-irreversible 0.5 decay) remains the explicit CLI/ops
  action shipped in FOH-4. Adding a resolve affordance to the pane is a follow-up with its own
  gate/flag/skip decision.

## Config & capability gating — aligned with `COLLEAGUE-ALL-IN`

The owner ruling (what-to-build §8k, quoted in [design.md](design.md) §116) is the activation
contract, and FOH-6 **implements it, not refines it**: *"the colleague (Maya — conviction,
challenge, calibration) is what hard-requires SmartMemory and never runs degraded. Missing
capabilities surface as visibly unavailable, not faked."* An earlier draft of this design allowed a
plain-conversation mode without the SmartMemory provider — **that contradicted the ruling and is
removed** (Codex design finding). The funnel state machine the blueprint derives:

1. No `maya` config block → feature not installed → no chrome button.
2. `maya` config present, fluid provider is the local floor (no SmartMemory) → panel opens to the
   **connect-SmartMemory funnel**. No chat. The colleague does not run degraded.
3. SmartMemory provider up, Maya unreachable → **offline funnel** (start command shown).
4. Maya up, auth rejected after the single same-token retry → **auth funnel** (§2 actions).
5. All up → conversation. Within it, the *declared subset* `{CHALLENGE, CONVICTION, CONTRADICTION}`
   powers the findings; **CALIBRATION renders as visibly unavailable** — exactly the ruling's
   "visibly unavailable, not faked" clause. Shipping without calibration is not a degraded
   colleague; it is the declared-capability surface of the provider today (blocked upstream,
   "no subject").

- Feature switch: presence of `maya` block in `.compose/compose.json` (mirrors `smartmemory` block
  precedent, `lib/smartmemory-config.js:20-28`).
- Per-capability inclusion in the context builder remains capability-derived
  (`provider.has(CAP.X)`) — but per the state machine above, reaching the conversation at all
  requires the SmartMemory provider; capability checks only govern *which findings sections* exist.
- Note: **this repo's own `.compose/compose.json` currently has neither `smartmemory` nor `fluid`
  blocks** — the dogfood config must be set up as part of implementation verification (it was
  provisioned ad hoc for the FOH-4/5 live-fires).

## Slice plan (indicative, for the blueprint)

1. **S1 relay + token source:** `server/maya-routes.js`, provision/static token store, `/status`,
   `/message` (non-streaming first), config block, unit tests against a Maya stub
   (`test/helpers/` gains a maya-stub mirroring the smartmemory-stub pattern).
2. **S2 context composition:** the `channel_context` builder over
   `challengeIdea`/`convictionOf`/`contradictions` — **first production callers**; per-capability
   inclusion; tests per capability-present/absent.
3. **S3 panel:** slide-over colleague panel + chrome button, ChatInput/MessageCard reuse,
   cockpit-following record-in-focus with manual override, the full funnel state machine (§gating).
4. **S4 write-back:** `author:'maya'` discussion append + toggle + partial-failure contract
   (retry-append-only chip).
5. **S5 streaming (stretch):** POST fetch-streaming on `/message` (upstream SSE piped through the
   POST response body; no EventSource, no `streamPaths`). Non-streaming v1 is acceptable; her
   non-stream `/api/chat` returns complete responses. **Write-back outcome in streaming mode:** the
   relay performs the append after her `final` event and emits its own terminal `writeback` event
   (same `ok|landed-unrendered|failed` payload as the non-streaming response field) before closing
   the stream — the outcome contract is transport-independent.
6. **Live-fire:** provisioned identity end-to-end against running Maya + smart-memory-service:
   inject a known contradicting idea, verify her reply reflects the injected findings, verify the
   discussion write-back, verify teardown.

## Blueprint entry-gates (must pass before Phase 4 completes)

- **VERIFY-1:** provision-user token accepted by Maya middleware; workspace claim extracted; a chat
  turn round-trips. (Needs the local stack up — owner starts it; standing rule: never restart
  servers unasked.)
- **VERIFY-2:** `channel_context` accepted and reflected on the live `/api/chat`.
- **VERIFY-3:** her turn-ingestion writes land in the *colleague identity's* workspace, not the fluid
  workspace (confirm shallow-binding isolation on the real wire) — **and** the configure-time
  validation demonstrably refuses a token whose workspace claim equals the fluid `workspaceId`
  (the invariant, not just the happy configuration).

## Risks

| Risk | Exposure | Mitigation |
|---|---|---|
| `channel_context` gated/removed in a Maya upgrade | Whole context path | Smoke test fails loudly; upstream issue for a supported field; the panel enters an **unavailable funnel** ("this Maya version doesn't support context injection") — never plain conversation, per the no-degraded-mode contract |
| Provisioned-token TTL is **24 h** (VERIFY-1 measured), and same-email re-provision is refused (409, probed live) | Daily auth expiry; recovery-by-reprovision costs the identity AND her accumulated colleague-workspace memory, not just the session | 401 → one same-token retry, then auth funnel with explicit continuity-costing actions (§2) — never silent re-provision. S1 probes for a same-identity re-auth path on the test surface; if none exists, file the upstream ask (a `POST /test/login {email}` → fresh token) alongside the channel_context issue |
| `/test/provision-user` is a test endpoint doing standing-identity duty | Upstream could restrict it | Honest v1 trade-off for a local dev stack; `static` mode is the durable path |
| Colleague token accidentally scoped to the fluid workspace | Silent deep binding — her turn writes land in fluid records' workspace | Configure-time validation: token workspace ≠ `fluid.smartmemory.workspaceId`, refuse otherwise (§2) |
| Maya not running locally | Pane dead | `/status` funnel with the start command; degrade-never-fail probe |
| Discord-transcript framing colors her replies | Tone/format oddities | Explicit provenance authors; acceptable v1; upstream issue covers the proper fix |
| Challenge call latency (LLM path, 30s cap) | Slow turns | Compose findings concurrently with capability timeouts; include partial findings; label omissions |
| Her session rollover (30 min/24 h) loses thread context | Continuity | Re-injection each turn carries the record context; acceptable v1 |

## Acceptance criteria

- [ ] Colleague panel (slide-over, summoned from chrome) converses with local Maya through the relay; her core untouched (zero diffs under `SmartMemory/maya/`)
- [ ] `challengeIdea`, `convictionOf`, `contradictions` each have a production call site in the context builder (capabilities no longer dark)
- [ ] Findings for the record in focus demonstrably reach her reply (live-fire assertion)
- [ ] Her replies append to the idea's discussion trail as `author:'maya'` (toggleable)
- [ ] Funnel-not-hide: unreachable Maya / missing capability / expired token each render an actionable explanation
- [ ] Token source pluggable: `provision` and `static` both pass the relay auth test; a fluid-workspace token is refused at configure time
- [ ] No writes from Maya land in the fluid workspace (VERIFY-3)
- [ ] Write-back partial failure renders the warning chip with retry-append-only — the chat turn is never re-sent
- [ ] No degraded plain-chat mode exists: without the SmartMemory provider the panel is a funnel, per `COLLEAGUE-ALL-IN`
- [ ] Upstream issue filed for a supported context-injection field
