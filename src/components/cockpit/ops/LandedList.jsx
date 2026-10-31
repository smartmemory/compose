import React, { useState } from 'react';
import UnitName from '@/components/shared/UnitName.jsx';
import { localTime } from './opsLogic.js';

const SHOWN = 20;

/** Landed nodes, newest first; the server sorts nothing, so this does (a bad time sorts last). */
export default function LandedList({ nodes, lane }) {
  const [all, setAll] = useState(false);
  const ms = (n) => { const t = Date.parse(n.landedAt); return Number.isNaN(t) ? -Infinity : t; };
  const landed = nodes.filter((n) => n.landedAt).sort((a, b) => ms(b) - ms(a));
  const shown = all ? landed : landed.slice(0, SHOWN);
  return (
    <section aria-label="Landed units" className="space-y-1">
      <h3 className="text-sm font-semibold">Landed ({landed.length})</h3>
      <ul className="text-sm divide-y">
        {shown.map((n) => (
          <li key={n.id} className="flex justify-between gap-3 py-1" data-testid="landed-row">
            <UnitName id={n.id} lane={lane} compact />
            <span className="shrink-0 text-xs text-muted-foreground">{localTime(n.landedAt)}</span>
          </li>
        ))}
      </ul>
      {landed.length > SHOWN && (
        <button type="button" className="text-xs underline" onClick={() => setAll(!all)}>
          {all ? 'show fewer' : `show all ${landed.length}`}
        </button>
      )}
    </section>
  );
}
