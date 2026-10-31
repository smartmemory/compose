import React from 'react';
import { useUnitIndex } from '@/lib/useUnitIndex.js';
import { unitLabel, SOURCE_TEXT } from '@/lib/unitLabel.js';
import { explain } from '@/lib/glossary.js';

/**
 * UnitName — the plain title first, the code after (COMP-COCKPIT-RULE-PLAIN-1, M12).
 * "<title> · <code>", or "<code> · no title recorded" for a hole; the code alone while the index loads or is unreachable.
 * The hover (title attribute) carries title, code, source and any glossary sentence. Never a button or link.
 */
export default function UnitName({ id, lane, compact = false }) {
  const { data } = useUnitIndex();
  const { title, code, source } = unitLabel(id, data, lane);
  const gloss = explain(code, lane, data);
  const hover = [
    title, code, source in SOURCE_TEXT ? SOURCE_TEXT[source] : null, gloss && gloss !== title ? gloss : null,
  ].filter(Boolean).join('\n');
  const codeEl = <span className="font-mono text-[11px] text-muted-foreground">{code}</span>;
  return (
    <span data-testid="unit-name" data-title-source={source} title={hover || undefined} className="min-w-0">
      {title && <><span className={compact ? 'truncate inline-block max-w-full align-bottom' : undefined}>{title}</span> · </>}
      {codeEl}
      {source === 'none' && <span className="text-muted-foreground"> · no title recorded</span>}
    </span>
  );
}
