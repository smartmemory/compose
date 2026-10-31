/**
 * opsLogic.js — pure helpers for the native Fleet › Ops view (COMP-COCKPIT-INIT-VIEW-1).
 * Input is the `progress.nodes` of GET /api/ops-status/<name>/data: `{id, title, titleSource, landedAt, builderStatus, deps}`.
 */
import { unitLabel } from '@/lib/unitLabel.js';

export const OPS_POLL_MS = 60_000;
/** The builder rewrites data.json every 900 s (BUILDER_TICK_S), so "stale" starts after two missed writes. */
export const OPS_STALE_AFTER_S = 1800;

/** Cytoscape cannot read CSS variables, so these are hex mirrors of the semantic tokens (success, primary, muted). */
export const STATE_META = {
  landed: { text: 'Landed', color: '#22c55e' },
  progress: { text: 'In progress', color: '#FBBF24' },
  waiting: { text: 'Waiting on another unit', color: '#94a3b8' },
  planned: { text: 'Planned', color: '#60a5fa' },
};

/** landed (a stamp has a landing time) > in progress (author or review) > waiting (held, or a dep not landed) > planned. */
export function nodeState(node, landedIds) {
  if (node.landedAt) return 'landed';
  if (node.builderStatus === 'author' || node.builderStatus === 'review') return 'progress';
  if (node.builderStatus === 'held' || (node.deps ?? []).some((d) => !landedIds.has(d))) return 'waiting';
  return 'planned';
}

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** GraphRenderer props: label = plain title, sublabel = the code, edges dep → unit, dangling deps dropped. */
export function dagGraph(nodes, lane, unitIndex) {
  const ids = new Set(nodes.map((n) => n.id));
  const landedIds = new Set(nodes.filter((n) => n.landedAt).map((n) => n.id));
  return {
    nodes: nodes.map((n) => {
      const { title } = unitLabel(n.id, unitIndex, lane);
      return {
        id: n.id,
        label: clip(title ?? n.title ?? 'no title recorded', 44),
        sublabel: clip(n.id, 26),
        color: STATE_META[nodeState(n, landedIds)].color,
      };
    }),
    edges: nodes.flatMap((n) => (n.deps ?? []).filter((d) => ids.has(d)).map((d) => ({ from: d, to: n.id }))),
  };
}

/** "P50 13h · P80 48h (estimate as of …)" or "No estimate yet (<reason>)"; null while the route has no eta. */
export function etaText(eta) {
  if (!eta) return null;
  if (eta.p50 && eta.p80) return `P50 ${eta.p50} · P80 ${eta.p80} (estimate as of ${eta.asOf ?? 'unknown'})`;
  return `No estimate yet (${eta.raw ?? eta.error ?? 'no reason given'})`;
}

export const localTime = (iso) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 'time unknown' : new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
