import React, { useId } from 'react';
import { TONES } from './processTones.js';

/**
 * Tip — a hover/focus tooltip whose text is always in the DOM (unlike the Radix tooltip, which portals only while
 * open), so the verbatim builder text it carries stays readable by tests and screen readers. The trigger is
 * focusable; the tip shows on hover and on keyboard focus.
 */
export function Tip({ children, tip, tipTestId, tipStyle, className = '', align = 'left', as: As = 'span', ...rest }) {
  const id = useId();
  return (
    <As {...rest} className={`group/tip relative ${className}`} tabIndex={0} aria-describedby={id}>
      {children}
      <span id={id} role="tooltip" data-testid={tipTestId} style={tipStyle}
        className={`pointer-events-none invisible absolute top-full z-30 mt-1 w-max max-w-[320px] whitespace-normal break-words rounded-md border border-border bg-popover px-2 py-1 text-left font-mono text-[11px] font-normal normal-case tracking-normal text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover/tip:visible group-hover/tip:opacity-100 group-focus/tip:visible group-focus/tip:opacity-100 ${align === 'right' ? 'right-0' : 'left-0'}`}>
        {tip}
      </span>
    </As>
  );
}

const LABEL = { stale: 'stale', failed: 'build failed', missing: 'no data', good: 'good', warn: 'watch', bad: 'outlier' };

/** Pill for a state (stale | failed | missing | ...); `labelTestId` sits on the label text only, `tip` explains it. */
export function StateBadge({ state, label, labelTestId, tip, tipTestId, tipStyle, align }) {
  const pill = (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none"
      style={(TONES[state] ?? TONES.neutral).badge}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      <span data-testid={labelTestId}>{label ?? LABEL[state] ?? state}</span>
    </span>
  );
  if (tip == null) return pill;
  return <Tip tip={tip} tipTestId={tipTestId} tipStyle={tipStyle} align={align} className="inline-flex cursor-help rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring">{pill}</Tip>;
}
