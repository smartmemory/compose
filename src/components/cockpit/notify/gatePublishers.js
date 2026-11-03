/**
 * gatePublishers.js — COMP-SUBAPP-ATTENTION-1 (row 307): the two gate publishers into the host attention sink
 * (subappHost.js `attentionSink`), so Stratum's waiting gates and Compose's own pending gates reach the cockpit inbox beside
 * Cadence's rows. Publishers live in Compose and read the data the panes read, independent of which room is open: the
 * Stratum poller calls the Compose Stratum client's `listGates` (the GatesInbox's own read) on the notify cadence, and App
 * publishes the vision store's `gates`. No React here; nothing in this file resolves, approves or dismisses a gate, and no row
 * carries a `gateToken`: a row carries only the ids its click needs.
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
      key: `stratum-gate:${runId}:${stepId}`,
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

/** Compose's vision-store gates -> inbox rows for the pending ones. `items` (optional) names each gate's item. */
export function composeGateRows(gates, { items = [], now = Date.now() } = {}) {
  const titleOf = new Map((Array.isArray(items) ? items : []).map((i) => [i?.id, i?.title]));
  return (Array.isArray(gates) ? gates : []).filter((g) => isPendingGate(g) && str(g.id)).map((g) => {
    // A gate's own time is `createdAt` (server/vision-routes.js:1001, lib/vision-writer.js:350); no time, no age.
    const sinceAt = at(g.createdAt);
    const what = str(titleOf.get(g.itemId)) ?? str(g.itemId) ?? 'Gate';
    return {
      key: `compose-gate:${g.id}`,
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
 * Publish Compose's gates: rows when the store is connected; when it is not, keep the last rows and mark the source unknown
 * (a disconnected store's `gates` is not "no gates").
 */
export function publishComposeGates(sink, { gates, connected, items, now = Date.now() }) {
  if (!connected) sink.publish(COMPOSE_SOURCE, null, { unavailable: COMPOSE_LABEL });
  else sink.publish(COMPOSE_SOURCE, composeGateRows(gates, { items, now }));
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
  };
}
