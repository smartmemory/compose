/**
 * DriftRibbon.jsx — COMP-OBS-DRIFT region ⑥ ribbon.
 *
 * 28px sticky single-line warning when any drift axis is breached.
 * Click to expand an axis table. Hidden when no axis breached.
 *
 * CONTRACT layout.md §⑥: mounted inside ItemDetailPanel.jsx's ScrollArea
 * body as the FIRST child (before BranchComparePanelMount).
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { axisLabel, formatRatio, getBreachedAxes } from './driftRibbonLogic.js';

/**
 * DriftRibbon — renders drift alert ribbon for a single feature item.
 *
 * @param {{ item: object }} props
 *   item — vision item with lifecycle.lifecycle_ext.drift_axes[]
 */
export default function DriftRibbon({ item }) {
  const [expanded, setExpanded] = useState(false);

  const breachedAxes = getBreachedAxes(item);

  // Hidden when no axis is breached
  if (breachedAxes.length === 0) return null;

  const count = breachedAxes.length;

  return (
    <div
      className="drift-ribbon"
      style={{
        background: 'hsl(var(--destructive) / 0.12)',
        borderLeft: '3px solid hsl(var(--destructive))',
        minHeight: '28px',
        padding: expanded ? '6px 10px 8px' : '0 10px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 0,
        borderRadius: '4px',
        marginBottom: '4px',
      }}
    >
      {/* Single-line header — always visible when breached */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 0',
          color: 'hsl(var(--destructive))',
          fontSize: '12px',
          fontWeight: 600,
          width: '100%',
          textAlign: 'left',
        }}
        aria-expanded={expanded}
        data-testid="drift-ribbon-toggle"
      >
        <AlertTriangle size={13} />
        <span>{count} drift alert{count !== 1 ? 's' : ''} — click to {expanded ? 'collapse' : 'expand'}</span>
        {expanded ? <ChevronUp size={13} style={{ marginLeft: 'auto' }} /> : <ChevronDown size={13} style={{ marginLeft: 'auto' }} />}
      </button>

      {/* Expanded axis table */}
      {expanded && (
        <table
          style={{
            width: '100%',
            fontSize: '11px',
            borderCollapse: 'collapse',
            marginTop: '4px',
          }}
          data-testid="drift-ribbon-table"
        >
          <thead>
            <tr style={{ color: 'hsl(var(--muted-foreground))' }}>
              <th style={{ textAlign: 'left', padding: '2px 4px', fontWeight: 500 }}>Axis</th>
              <th style={{ textAlign: 'right', padding: '2px 4px', fontWeight: 500 }}>Ratio</th>
              <th style={{ textAlign: 'right', padding: '2px 4px', fontWeight: 500 }}>Threshold</th>
              <th style={{ textAlign: 'left', padding: '2px 4px', fontWeight: 500 }}>Explanation</th>
            </tr>
          </thead>
          <tbody>
            {breachedAxes.map(axis => (
              <tr
                key={axis.axis_id}
                data-testid={`drift-axis-row-${axis.axis_id}`}
              >
                <td style={{ padding: '2px 4px', color: 'hsl(var(--foreground))', fontWeight: 500 }}>
                  {axisLabel(axis.axis_id)}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right', color: 'hsl(var(--destructive))' }}>
                  {formatRatio(axis.ratio)}
                </td>
                <td style={{ padding: '2px 4px', textAlign: 'right', color: 'hsl(var(--muted-foreground))' }}>
                  {formatRatio(axis.threshold)}
                </td>
                <td style={{ padding: '2px 4px', color: 'hsl(var(--muted-foreground))', maxWidth: '200px', wordBreak: 'break-word' }}>
                  {axis.explanation ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
