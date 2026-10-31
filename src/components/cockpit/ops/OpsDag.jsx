import React, { useMemo, useState } from 'react';
import GraphRenderer from '@/components/GraphRenderer.jsx';
import UnitName from '@/components/shared/UnitName.jsx';
import { useUnitIndex } from '@/lib/useUnitIndex.js';
import { dagGraph, nodeState, STATE_META, localTime } from './opsLogic.js';

const landedKey = (lane) => `compose:opsShowLanded:${lane}`;
const readShowLanded = (lane) => { try { return globalThis.localStorage?.getItem(landedKey(lane)) === '1'; } catch { return false; } };

/** Left-to-right dagre, fit to the panel; a node click opens a small detail panel. Colours: see STATE_META. */
const LAYOUT = { name: 'dagre', rankDir: 'LR', rankSep: 56, nodeSep: 18, padding: 20 };

export default function OpsDag({ nodes, lane }) {
  const { data: unitIndex } = useUnitIndex();
  const [picked, setPicked] = useState(null);
  const [shown, setShown] = useState({ lane, on: readShowLanded(lane) });
  const showLanded = shown.lane === lane ? shown.on : readShowLanded(lane); // a lane change re-reads that lane's own switch
  const toggleLanded = (on) => {
    setShown({ lane, on });
    try { globalThis.localStorage?.setItem(landedKey(lane), on ? '1' : '0'); } catch { /* ignore */ }
  };
  const graph = useMemo(() => dagGraph(nodes, lane, unitIndex, showLanded), [nodes, lane, unitIndex, showLanded]);
  const landedIds = useMemo(() => new Set(nodes.filter((n) => n.landedAt).map((n) => n.id)), [nodes]);
  const node = nodes.find((n) => n.id === picked);
  return (
    <section aria-label="Dependency graph" className="space-y-2">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {Object.entries(STATE_META).map(([k, m]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: m.color }} />{m.text}
          </span>
        ))}
      </div>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={showLanded} onChange={(e) => toggleLanded(e.target.checked)} />
        Show landed too
      </label>
      {graph.nodes.length === 0 ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="ops-all-landed">All {nodes.length} landed</div>
      ) : (
      <div className="rounded-md border overflow-hidden" style={{ height: 520 }}>
        <GraphRenderer
          nodes={graph.nodes}
          edges={graph.edges}
          layout={LAYOUT}
          graphKey={`ops-dag-${lane}`}
          onNodeClick={setPicked}
          legend={false}
          sublabelInNode
          fillFromColor
          minZoom={0.05}
        />
      </div>
      )}
      {node && (
        <div className="rounded-md border p-3 text-sm space-y-0.5" data-testid="ops-node-panel">
          <UnitName id={node.id} lane={lane} />
          <div className="text-xs text-muted-foreground">{STATE_META[nodeState(node, landedIds)].text}</div>
          {node.landedAt && <div className="text-xs text-muted-foreground">Landed {localTime(node.landedAt)}</div>}
        </div>
      )}
    </section>
  );
}
