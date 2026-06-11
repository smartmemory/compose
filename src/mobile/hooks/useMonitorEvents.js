import { useEffect, useRef } from 'react';
import { notify } from '../../components/cockpit/NotificationBar.jsx';

/**
 * useMonitorEvents — maps build/gate state transitions to compose:notify alerts.
 *
 * Called from MobileApp shell (uses the already-lifted hooks' data — no extra
 * WS connections).
 *
 * Detection logic:
 * - New gate id appearing in `gates` after first load (skips initial population)
 *   → notify('Gate pending: <item title>', 'warn', 0) [sticky]
 * - active build status transitions per flowId:
 *   → to 'failed':             notify('Build failed: <featureCode>', 'error', 0) [sticky]
 *   → to 'complete'/'completed': notify('Build complete: <featureCode>', 'info', 4000)
 *
 * @param {object} params
 * @param {object|null} params.active — active build from useActiveBuild
 * @param {Array}  params.gates       — pending gates from usePendingGates
 * @param {Array}  params.items       — vision items from useRoadmapItems (for gate title lookup)
 */
export default function useMonitorEvents({ active, gates, items }) {
  // null = not yet initialized; after first non-empty render → Set of known ids
  const seenGateIds = useRef(null);

  // Previous build status per flowId → Map<flowId, status>
  const prevBuildStatus = useRef(new Map());

  // ── Gate monitoring ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!Array.isArray(gates)) return;

    if (seenGateIds.current === null) {
      // First render: seed the set without alerting
      seenGateIds.current = new Set(gates.map(g => g.id));
      return;
    }

    for (const gate of gates) {
      if (!seenGateIds.current.has(gate.id)) {
        seenGateIds.current.add(gate.id);
        // Look up item title for the alert message
        const item = (Array.isArray(items) ? items : []).find(i => i.id === gate.itemId);
        const title = item?.title || 'Gate pending';
        notify(`Gate pending: ${title}`, 'warn', 0);
      }
    }
  }, [gates, items]);

  // ── Build status transition monitoring ────────────────────────────────────
  useEffect(() => {
    if (!active || !active.flowId) return;

    const prev = prevBuildStatus.current.get(active.flowId);
    const curr = active.status;

    if (prev !== undefined && prev !== curr) {
      if (curr === 'failed') {
        notify(`Build failed: ${active.featureCode || active.flowId}`, 'error', 0);
      } else if (curr === 'complete' || curr === 'completed') {
        notify(`Build complete: ${active.featureCode || active.flowId}`, 'info', 4000);
      }
    }

    prevBuildStatus.current.set(active.flowId, curr);
  }, [active]);
}
