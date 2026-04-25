/**
 * StatusBand.jsx — COMP-OBS-STATUS region ① sticky band.
 *
 * B4: 32px sticky band (top: 0, z-index: 30) rendering the situational
 * status sentence for the currently-selected feature. Click toggles a
 * 200px detail panel below the band.
 *
 * v1 constraints:
 *   - cta is always null — NO CTA element rendered
 *   - sentence only in the band
 *   - expansion panel shows pending_gates, drift_alerts, open_loops_count, gate_load_24h
 *
 * Props:
 *   featureCode {string|null}       — currently-selected feature code
 *   snapshot    {StatusSnapshot|null} — snapshot object (from store or REST)
 */
import React, { useState, useCallback } from 'react';
import { formatExpansionPanel } from './statusBandLogic.js';

const NO_FEATURE_SENTENCE = 'Select a feature to see status.';

export default function StatusBand({ featureCode, snapshot }) {
  const [expanded, setExpanded] = useState(false);

  const handleClick = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  const sentence = snapshot?.sentence ?? NO_FEATURE_SENTENCE;
  const panelRows = formatExpansionPanel(snapshot);

  return (
    <>
      {/* Status band — 32px sticky */}
      <div
        data-status-band
        onClick={handleClick}
        style={{
          position: 'sticky',
          top: '0px',
          zIndex: 30,
          height: '32px',
          minHeight: '32px',
          maxHeight: '32px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: '12px',
          paddingRight: '12px',
          userSelect: 'none',
          overflow: 'hidden',
        }}
        className="w-full bg-background/95 backdrop-blur-sm border-b border-border/30 text-sm text-foreground/80"
        title={sentence}
        aria-expanded={expanded}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      >
        <span
          style={{
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {sentence}
        </span>
        <span
          style={{ marginLeft: 8, opacity: 0.5, fontSize: 10 }}
          aria-hidden="true"
        >
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {/* Expansion panel — absolutely positioned below the band */}
      {expanded && (
        <div
          data-status-band-expansion
          style={{
            position: 'relative',
            width: '100%',
            zIndex: 29,
            maxHeight: 200,
            overflowY: 'auto',
          }}
          className="bg-background/98 border-b border-border/50 text-xs text-foreground/70"
        >
          <div style={{ padding: '8px 12px' }}>
            {panelRows.length === 0 ? (
              <span className="text-muted-foreground">No details available.</span>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {panelRows.map((row, i) => (
                    <tr key={i}>
                      <td
                        style={{ paddingRight: 16, paddingBottom: 2, fontWeight: 500, whiteSpace: 'nowrap' }}
                        className="text-foreground/60"
                      >
                        {row.label}
                      </td>
                      <td style={{ paddingBottom: 2 }}>
                        {String(row.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
      {/* NOTE: v1 — cta is always null; no CTA element is rendered here.
          If CTA support is added in a future version, it MUST be gated on
          a shipped routing/anchor system. See design.md Decision 2. */}
    </>
  );
}
