/**
 * gatePublishers.js — COMP-SUBAPP-ATTENTION-1 (row 307): the two gate publishers into the host attention sink
 * (subappHost.js `attentionSink`), so Stratum's waiting gates and Compose's own pending gates reach the cockpit inbox beside
 * Cadence's rows. Publishers live in Compose and read the data the panes read, independent of which room is open: the
 * Stratum poller calls the Compose Stratum client's `listGates` (the GatesInbox's own read) on the notify cadence, and App
 * publishes the vision store's `gates`. No React here; nothing in this file resolves, approves or dismisses a gate, and no row
 * carries a `gateToken`: a row carries only the ids its click needs.
 * COMP-SUBAPP-ATTENTION-FU-2: a row key names ONE gate instance, `<source>:<scope>:<gate>:<round>` (`gateKeyOf` reads it
 * back), and every publish carries its scope, so an answer from another round or another project is never this gate's answer.
 */
// No imports: notifyLogic.js imports this file (its sink adapter merges these rows), never the other way round.

/** Age in seconds of an ISO time, null when unparseable (moved here from notifyLogic.js, which imports it back). */
export const ageSince = (iso, now) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
};

export const STRATUM_SOURCE = 'stratum';
export const COMPOSE_SOURCE = 'compose-gates';
export const STRATUM_LABEL = 'stratum gates';
export const COMPOSE_LABEL = 'compose gates';
export const GATE_KINDS = new Set(['stratum-gate', 'compose-gate']);

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const at = (iso) => (Number.isFinite(Date.parse(iso ?? '')) ? iso : null);

/**
 * Stratum `PendingGate[]` (stratum/ui/src/data-client.ts) -> inbox rows; `dropped` counts gates with no run or step id
 * (they cannot be opened, so the poller names them in a WARNING instead of inventing a key).
 */
export function stratumGateRows(gates, now = Date.now()) {
  const list = Array.isArray(gates) ? gates : [];
  const rows = [];
  for (const g of list) {
    const runId = str(g?.runId);
    const stepId = str(g?.stepId);
    if (!runId || !stepId) continue;
    const sinceAt = at(g.waitingSince);
    rows.push({
      // FU-2: the round is part of the identity: a revised gate's next round is a new gate, never the dismissed one.
      key: `stratum-gate:${runId}:${stepId}:${Number.isInteger(g.round) && g.round >= 0 ? g.round : 0}`,
      kind: 'stratum-gate',
      severity: 'warn',
      title: `Gate waiting: ${str(g.flowName) ?? runId} · ${stepId}`,
      detail: Number.isFinite(g.round) && g.round > 0 ? `Stratum flow gate, round ${g.round}` : 'Stratum flow gate',
      since: sinceAt ? ageSince(sinceAt, now) : null,
      sinceAt,
      sourceLabel: STRATUM_LABEL,
      action: 'stratum',
      runId,
      stepId,
    });
  }
  return { rows, dropped: list.length - rows.length };
}

/** The pending rule `PendingGates` already draws (DashboardView.jsx:290): pending, or never resolved. */
export const isPendingGate = (g) => !!g && (g.status === 'pending' || !g.resolvedAt);

/**
 * FU-2: a Compose gate's key, `compose-gate:<workspaceId>:<gateId>`. The gate id is the store's own identity, already
 * `<flowId>:<stepId>:<round>` (lib/vision-writer.js:337, server/vision-routes.js:1070), so the key is
 * `compose-gate:<workspaceId>:<flow>:<step>:<round>`: scope first, like `<source>:<scope>:<gate>:<round>` for every source.
 * The workspace id is URI-encoded, so it never holds a `:` and `gateKeyOf` can split it off unambiguously.
 */
export const composeGateKey = (scope, gateId) => `compose-gate:${encodeURIComponent(scope)}:${gateId}`;

/**
 * Who answers for a gate key: `{source, label, scope}`, or null for a key that is not a gate's. `scope` is null for Stratum
 * (its run ids are global) and the workspace id for Compose. A Compose key stored before FU-2 (`compose-gate:<flow>:<step>:
 * <round>`, three parts) has no scope: `legacy: true`, and any Compose answer covers it, so it is released once (its key
 * never comes back). A pre-FU-2 Stratum key (no round) needs no such case: its scope was already null. Never throws.
 */
export function gateKeyOf(key) {
  const k = String(key ?? '');
  if (k.startsWith('stratum-gate:')) return { source: STRATUM_SOURCE, label: STRATUM_LABEL, scope: null, legacy: false };
  if (!k.startsWith('compose-gate:')) return null;
  const parts = k.slice('compose-gate:'.length).split(':');
  if (parts.length < 4) return { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: null, legacy: true };
  try {
    return { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: decodeURIComponent(parts[0]), legacy: false };
  } catch {
    return { source: COMPOSE_SOURCE, label: COMPOSE_LABEL, scope: null, legacy: true };
  }
}

/**
 * Compose's vision-store gates -> inbox rows for the pending ones, keyed in the workspace `scope` (FU-2). `items` (optional)
 * names each gate's item.
 */
export function composeGateRows(gates, { items = [], now = Date.now(), scope } = {}) {
  const titleOf = new Map((Array.isArray(items) ? items : []).map((i) => [i?.id, i?.title]));
  return (Array.isArray(gates) ? gates : []).filter((g) => isPendingGate(g) && str(g.id)).map((g) => {
    // A gate's own time is `createdAt` (server/vision-routes.js:1001, lib/vision-writer.js:350); no time, no age.
    const sinceAt = at(g.createdAt);
    const what = str(titleOf.get(g.itemId)) ?? str(g.itemId) ?? 'Gate';
    return {
      key: composeGateKey(scope, g.id),
      kind: 'compose-gate',
      severity: 'warn',
      title: `${what}: ${str(g.stepId) ?? 'gate'} waiting`,
      detail: str(g.summary) ?? (g.fromPhase && g.toPhase ? `${g.fromPhase} → ${g.toPhase}` : null),
      since: sinceAt ? ageSince(sinceAt, now) : null,
      sinceAt,
      sourceLabel: COMPOSE_LABEL,
      action: 'gate',
      gateId: g.id,
      ...(str(g.flowId) ? { flowId: g.flowId } : {}),
      ...(str(g.stepId) ? { stepId: g.stepId } : {}),
    };
  });
}

const flowStep = (a, b) => `${a}\u0000${b}`;

/**
 * One row per gate: a Stratum row whose `(runId, stepId)` matches a pending Compose row's `(flowId, stepId)` is dropped,
 * and that Compose row says it is a Stratum flow gate (`stratumRunId`). The rule `openFlowGate` already applies (App.jsx).
 * Every other row passes through untouched, in order.
 */
export function mergeGateRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stratum = new Set(list.filter((r) => r.kind === 'stratum-gate').map((r) => flowStep(r.runId, r.stepId)));
  const composed = new Set(list.filter((r) => r.kind === 'compose-gate' && r.flowId && r.stepId).map((r) => flowStep(r.flowId, r.stepId)));
  const out = [];
  for (const r of list) {
    if (r.kind === 'stratum-gate' && composed.has(flowStep(r.runId, r.stepId))) continue;
    if (r.kind === 'compose-gate' && r.flowId && stratum.has(flowStep(r.flowId, r.stepId))) {
      out.push({ ...r, stratumRunId: r.flowId, detail: r.detail ? `Stratum flow gate · ${r.detail}` : 'Stratum flow gate' });
    } else out.push(r);
  }
  return out;
}

/**
 * Publish Compose's gates for the workspace `scope`: rows when the store is connected; when it is not, or no workspace is
 * known, keep the last rows and mark the source unknown (a disconnected store's `gates` is not "no gates", and a list with
 * no workspace is nobody's answer).
 */
export function publishComposeGates(sink, { gates, connected, items, now = Date.now(), scope }) {
  if (!connected || typeof scope !== 'string' || scope === '') sink.publish(COMPOSE_SOURCE, null, { unavailable: COMPOSE_LABEL });
  else sink.publish(COMPOSE_SOURCE, composeGateRows(gates, { items, now, scope }), { scope });
}

/**
 * FU-2: Compose's gate publisher over the vision store (`store`: a zustand store, `getState`/`getInitialState`/`subscribe`).
 * The store's `gates` belong to whichever workspace the server had when its socket opened, and a project switch closes every
 * socket (server/workspace-runtime.js, `suspend()`), so a connection is the unit of scope. Per connection:
 *   - the workspace is read (`readWorkspaceId`) AFTER the socket opened, so it is the server's workspace for that socket,
 *     whatever order the client's own workspace refresh lands in;
 *   - the store's first `gates` replacement after the open is that connection's first `visionState`/`hydrate`; the list
 *     left over from the previous connection (the old project's) is never published as an answer.
 * Until both hold, and while disconnected, the source is published unknown (last rows kept). Subscribing to the store, not
 * to React renders, sees every transition in order, so a close-open-hydrate inside one render batch is not missed.
 * Returns `stop()`, which retires the source.
 */
export function trackComposeGates({ store, sink, readWorkspaceId, warn = console.warn, now = () => Date.now() }) {
  let stopped = false;
  let epoch = 0; // one per socket connection
  let scope = null; // the workspace the open connection serves, once read
  let hydrated = false; // the store's gates were replaced since the connection opened
  const publish = () => {
    if (stopped) return;
    const s = store.getState();
    if (s.connected && hydrated && scope) publishComposeGates(sink, { gates: s.gates, items: s.items, connected: true, scope, now: now() });
    else sink.publish(COMPOSE_SOURCE, null, { unavailable: COMPOSE_LABEL });
  };
  const opened = () => {
    const mine = ++epoch;
    scope = null;
    const lost = (why) => {
      if (!stopped && mine === epoch) warn(`[notify] compose gates: ${why}; the source stays unknown until the vision socket reconnects`);
    };
    Promise.resolve().then(readWorkspaceId).then((id) => {
      if (stopped || mine !== epoch) return;
      if (typeof id === 'string' && id !== '') { scope = id; publish(); } else lost('the workspace read answered no id');
    }, (e) => lost(`the workspace is unreadable (${String(e?.message ?? e)})`));
  };
  const onChange = (s, prev) => {
    if (s.connected && !prev.connected) { hydrated = false; opened(); }
    else if (!s.connected && prev.connected) { epoch += 1; scope = null; hydrated = false; }
    if (s.connected && s.gates !== prev.gates) hydrated = true;
    if (s.connected !== prev.connected || s.gates !== prev.gates || s.items !== prev.items) publish();
  };
  const s0 = store.getState();
  if (s0.connected) {
    // Already open when we started: its hydrate has happened iff the gates are no longer the store's initial list.
    hydrated = typeof store.getInitialState === 'function' && s0.gates !== store.getInitialState().gates;
    opened();
  }
  publish();
  const unsubscribe = store.subscribe(onChange);
  return () => {
    stopped = true;
    epoch += 1;
    unsubscribe();
    sink.retire?.(COMPOSE_SOURCE);
  };
}

/**
 * FU-2 (F3): a built Stratum whose availability check has not answered is expected but silent, so it is published unknown,
 * never left out (left out reads "All clear"). Returns the cleanup, which retires the mark.
 */
export function markStratumUnknown(sink) {
  sink.publish(STRATUM_SOURCE, null, { unavailable: STRATUM_LABEL });
  return () => sink.retire?.(STRATUM_SOURCE);
}

/** One `listGates` read published: a failed or non-list answer keeps the last rows and marks the source unknown. */
export async function pollStratumGates({ client, sink, warn = console.warn, now = () => Date.now(), isLive = () => true }) {
  let gates;
  try {
    gates = await client.listGates();
  } catch (e) {
    if (!isLive()) return;
    warn(`[notify] stratum gates unreadable: ${String(e?.message ?? e)}; last rows kept, source marked unknown`);
    sink.publish(STRATUM_SOURCE, null, { unavailable: STRATUM_LABEL });
    return;
  }
  if (!isLive()) return; // stopped while the read was in flight: the source is gone, publish nothing
  if (!Array.isArray(gates)) {
    warn('[notify] stratum gates: listGates answered a non-list; last rows kept, source marked unknown');
    sink.publish(STRATUM_SOURCE, null, { unavailable: STRATUM_LABEL });
    return;
  }
  const { rows, dropped } = stratumGateRows(gates, now());
  if (dropped) warn(`[notify] stratum gates: ${dropped} gate(s) without a run or step id left out of the inbox`);
  sink.publish(STRATUM_SOURCE, rows);
}

/**
 * The Stratum gate poller, on the notify cadence (useNotifySources.js NOTIFY_POLL_MS) and paused while the document is
 * hidden (the cadence loop's rule). Returns `stop()`, which also removes the source from the sink: a Stratum that went away
 * is no source at all, not an unknown one.
 */
export function startStratumGatePoller({ client, sink, intervalMs, warn = console.warn, doc = globalThis.document }) {
  let timer = null;
  let inflight = false;
  let stopped = false;
  const hidden = () => !!doc && doc.visibilityState === 'hidden';
  const tick = async () => {
    if (inflight || stopped) return;
    inflight = true;
    try { await pollStratumGates({ client, sink, warn, isLive: () => !stopped }); } finally { inflight = false; }
  };
  const schedule = () => {
    clearInterval(timer);
    timer = hidden() ? null : setInterval(tick, intervalMs);
  };
  const onVisibility = () => {
    if (!hidden()) tick();
    schedule();
  };
  doc?.addEventListener?.('visibilitychange', onVisibility);
  if (!hidden()) tick();
  schedule();
  return () => {
    stopped = true;
    clearInterval(timer);
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    sink.publish(STRATUM_SOURCE, []);
    sink.retire?.(STRATUM_SOURCE); // gone is not "answered with no rows": releaseKeys must keep Stratum dismissals
  };
}
