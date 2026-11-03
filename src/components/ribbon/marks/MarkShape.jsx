/**
 * MarkShape.jsx — COMP-DAYVIEW-DESIGN-FIX-1 U3 (AD#16, DT#17): the ribbon's event marks drawn as SVG shapes, not text
 * glyphs. Inter has no ⚖, so "decided for you" fell back to a system face and read as a smudge at 12 px; ✓ and ▲ changed
 * weight with the fallback too. One shape per kind, from the `--rb-*` tokens, used by the ribbon row, its legend and the
 * mark card, so the three can never drift apart.
 */
import React from 'react';

export const MARK_SHAPES = new Set(['land', 'deploy', 'deployFail', 'decide', 'refused']);

const f1 = (n) => Math.round(n * 10) / 10;
const INK = 'hsl(var(--foreground))';
const STYLE = {
  land: { fill: 'none', stroke: INK, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
  deploy: { fill: INK },
  deployFail: { fill: 'var(--rb-alert)' },
  decide: { fill: 'var(--rb-accent)' },
  // COMP-DOGFOOD-LAUNCH-GATE-1: a launch the gate refused, an alert-coloured cross.
  refused: { fill: 'none', stroke: 'var(--rb-alert)', strokeWidth: 2, strokeLinecap: 'round' },
};

/** The mark of `kind` centred on (cx, cy), `r` its half-size; null for a kind that is not drawn as a shape. */
export function MarkShape({ kind, cx, cy, r = 4.5 }) {
  const style = STYLE[kind];
  if (!style) return null;
  if (kind === 'land') {
    return <path data-shape="check" style={style} d={`M${f1(cx - r)} ${f1(cy)}L${f1(cx - r / 3)} ${f1(cy + r * 0.7)}L${f1(cx + r)} ${f1(cy - r * 0.7)}`} />;
  }
  if (kind === 'refused') {
    const d = r * 0.8;
    return <path data-shape="cross" style={style} d={`M${f1(cx - d)} ${f1(cy - d)}L${f1(cx + d)} ${f1(cy + d)}M${f1(cx + d)} ${f1(cy - d)}L${f1(cx - d)} ${f1(cy + d)}`} />;
  }
  if (kind === 'decide') {
    // DT#17: a filled square in the accent, which survives 12 px.
    const s = r * 1.6;
    return <rect data-shape="square" style={style} x={f1(cx - s / 2)} y={f1(cy - s / 2)} width={f1(s)} height={f1(s)} rx="1.2" />;
  }
  return <path data-shape="triangle" style={style} d={`M${f1(cx)} ${f1(cy - r)}L${f1(cx + r)} ${f1(cy + r * 0.8)}L${f1(cx - r)} ${f1(cy + r * 0.8)}Z`} />;
}

/** The same mark as a 12 px inline icon for HTML (the legend, the mark card). */
export function MarkIcon({ kind, size = 12 }) {
  if (!MARK_SHAPES.has(kind)) return null;
  return (
    <svg data-testid={`mark-icon-${kind}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-1px', flexShrink: 0 }}>
      <MarkShape kind={kind} cx={6} cy={6.3} r={4.6} />
    </svg>
  );
}
