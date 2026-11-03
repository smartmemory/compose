import React from 'react';
import { useUnitIndex } from '@/lib/useUnitIndex.js';
import { unitLabel, SOURCE_TEXT } from '@/lib/unitLabel.js';
import { explain } from '@/lib/glossary.js';
import { sourceNoteText } from '@/lib/sourceState.js';

/**
 * UnitName — the plain title first, the code after (COMP-COCKPIT-RULE-PLAIN-1, M12).
 * "<title> · <code>", or "<code> · no title recorded" for a hole; the code alone while the index loads or is unreachable.
 * The explanation (title, code, source and any glossary sentence) is a `role="tooltip"` the name points at with
 * `aria-describedby`; it is drawn on hover and on keyboard focus (the name is focusable), only then, so the name's own
 * text is unchanged for anything reading it, and the same text stays in the native title. Never a button or link.
 * COMP-COCKPIT-SOURCE-FAULTS-1 (FORGE-SMALL-BATCH-3 M1-M2): a failed index reads `source=unavailable`, distinct from
 * a pending request, and names from a retained index after a failed refresh say so in the explanation.
 */
export default function UnitName({ id, lane, compact = false }) {
  const src = useUnitIndex();
  const { title, code, source } = unitLabel(id, src.data, lane, { error: src.error });
  const gloss = explain(code, lane, src.data);
  const [shown, setShown] = React.useState(false);
  const tipId = React.useId();
  const hover = [
    title, code, source in SOURCE_TEXT ? SOURCE_TEXT[source] : null, gloss && gloss !== title ? gloss : null,
    src.stale ? sourceNoteText('unit index', src, { short: true }) : null,
  ].filter(Boolean).join('\n');
  const codeEl = <span className="font-mono text-[11px] text-muted-foreground">{code}</span>;
  return (
    <span
      data-testid="unit-name"
      data-title-source={source}
      title={hover || undefined}
      tabIndex={hover ? 0 : undefined}
      aria-describedby={hover && shown ? tipId : undefined}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      onMouseEnter={() => setShown(true)}
      onMouseLeave={() => setShown(false)}
      className="relative min-w-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {title && <><span className={compact ? 'truncate inline-block max-w-full align-bottom' : undefined}>{title}</span> · </>}
      {codeEl}
      {source === 'none' && <span className="text-muted-foreground"> · no title recorded</span>}
      {hover && shown && (
        <span
          id={tipId}
          role="tooltip"
          data-testid="unit-name-tip"
          className="absolute left-0 top-full z-50 mt-1 w-max max-w-xs whitespace-pre-line rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
        >
          {hover}
        </span>
      )}
    </span>
  );
}
