import React, { useMemo, useState } from 'react';
import GraphRenderer from '@/components/GraphRenderer.jsx';
import UnitName from '@/components/shared/UnitName.jsx';
import { useUnitIndex } from '@/lib/useUnitIndex.js';
import { dagGraph, nodeState, STATE_META, localTime } from './opsLogic.js';

/** Left-to-right dagre, fit to the panel; a node click opens a small detail panel. Colours: see STATE_META. */
const LAYOUT = { name: 'dagre', rankDir: 'LR', rankSep: 56, nodeSep: 18, padding: 20 };

export default function OpsDag({ nodes, lane }) {
  const { data: unitIndex } = useUnitIndex();
  const [picked, setPicked] = useState(null);
  const graph = useMemo(() => dagGraph(nodes, lane, unitIndex), [nodes, lane, unitIndex]);
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
      <div className="rounded-md border overflow-hidden" style={{ height: 520 }}>
        <GraphRenderer
          nodes={graph.nodes}
          edges={graph.edges}
          layout={LAYOUT}
          graphKey={`ops-dag-${lane}`}
          onNodeClick={setPicked}
          legend={false}
          sublabelInNode
        />
      </div>
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
