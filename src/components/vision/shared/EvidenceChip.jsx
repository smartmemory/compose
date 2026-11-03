/**
 * EvidenceChip — the receipt behind a feature's shown state (COMP-DOGFOOD-EVIDENCE-GATE-1).
 *
 * A state set through record_completion / set_feature_status / complete_feature /
 * approve_gate carries a server-checked receipt (lib/evidence.js). This chip
 * shows `ev` when the evidence store holds a receipt for the item's CURRENT
 * status (kind and `ev:<id>` on hover), and `no receipt` in the needs-you hue
 * when it does not, so an unproven state reads as one. An unreadable store says
 * so in muted text: unknown is not the same as none.
 *
 * Self-fetching like CompletionBadge (wsFetch + AbortController + a monotonic
 * token so a stale response never overwrites a newer one). Renders null for
 * items with no lifecycle.featureCode.
 *
 * Props: { featureCode: string|null, status: string|null }
 */
import React, { useState, useEffect, useRef } from 'react';
import { wsFetch } from '../../../lib/wsFetch.js';

/** Feature statuses are UPPER_SNAKE (COMPLETE), board statuses lower (complete). */
const norm = (s) => String(s || '').toLowerCase();

/** The newest record whose subject claims `status`, or null. Exported for tests. */
export function receiptFor(records, status) {
  const want = norm(status);
  if (!want || !Array.isArray(records)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    if (norm(records[i]?.subject?.claim) === want) return records[i];
  }
  return null;
}

export default function EvidenceChip({ featureCode, status }) {
  const [state, setState] = useState({ loading: true, records: null, failed: false });
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!featureCode) { setState({ loading: false, records: [], failed: false }); return undefined; }
    const token = ++tokenRef.current;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    wsFetch(`/api/evidence?feature=${encodeURIComponent(featureCode)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (token !== tokenRef.current) return;
        setState({ loading: false, records: Array.isArray(data?.records) ? data.records : [], failed: false });
      })
      .catch(() => {
        if (token === tokenRef.current) setState({ loading: false, records: null, failed: true });
      });
    return () => controller.abort();
  }, [featureCode, status]);

  if (!featureCode || state.loading) return null;
  if (state.failed) {
    return <span className="text-[10px] text-muted-foreground italic" data-testid="evidence-unknown">receipts unreadable</span>;
  }
  const rec = receiptFor(state.records, status);
  if (!rec) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[hsl(var(--needs-you))] text-white"
        title={`No server-checked receipt for the state "${status || 'unset'}"`}
        data-testid="evidence-none"
      >
        no receipt
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-muted text-foreground"
      title={`${rec.kind || 'receipt'} · ${rec.id}${rec.checked_at ? ` · checked ${rec.checked_at}` : ''}`}
      data-testid="evidence-chip"
      data-evidence-id={rec.id}
    >
      ev
    </span>
  );
}
