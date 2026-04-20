import React, { useState } from 'react';
import ArtifactDiff from '../shared/ArtifactDiff.jsx';
import {
  fmtNum,
  fmtUsd,
  fmtWallClock,
  summarizeLineage,
  pickInitialPair,
} from './branchComparePanelLogic.js';

function MetricRows({ branch, extraRows = [] }) {
  const files = branch.files_touched || [];
  const tests = branch.tests || {};
  const cost = branch.cost || {};
  const rows = [
    { label: 'Files touched', value: files.length },
    { label: 'Tests', value: `${tests.passed ?? 0} / ${tests.failed ?? 0} / ${tests.skipped ?? 0}` },
    { label: 'Tokens in / out', value: `${fmtNum(cost.tokens_in)} / ${fmtNum(cost.tokens_out)}` },
    { label: 'USD', value: fmtUsd(cost.usd) },
    { label: 'Wall clock', value: fmtWallClock(cost.wall_clock_ms) },
    { label: 'Final artifact', value: branch.final_artifact?.path || '—' },
    ...extraRows,
  ];
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">{r.label}</span>
          <span className="font-mono text-right truncate" title={typeof r.value === 'string' ? r.value : undefined}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BranchComparePanel({
  lineage,
  selectedPair = [],
  onSelectPair = () => {},
  extraMetricsForBranch = () => [],
  now = Date.now(),
}) {
  const [expanded, setExpanded] = useState(false);

  const { summary, canCompare, completeBranches } = summarizeLineage(lineage, now);
  const [branchA, branchB] = pickInitialPair(completeBranches, selectedPair);

  const toggle = () => {
    if (!canCompare) return;
    setExpanded(x => !x);
    if (!expanded && branchA && branchB) {
      onSelectPair([branchA.branch_id, branchB.branch_id]);
    }
  };

  if (!expanded) {
    return (
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{summary}</span>
        <button
          disabled={!canCompare}
          onClick={toggle}
          className={
            'text-[10px] px-2 py-0.5 rounded border border-border ' +
            (canCompare ? 'hover:bg-muted/40 text-foreground cursor-pointer' : 'opacity-40 cursor-not-allowed')
          }
          data-testid="branch-compare-toggle"
        >
          Compare
        </button>
      </div>
    );
  }

  const aSnap = branchA?.final_artifact?.snapshot;
  const bSnap = branchB?.final_artifact?.snapshot;
  const bothHaveArtifact = !!aSnap && !!bSnap;

  return (
    <div className="space-y-2 rounded border border-border p-2 bg-muted/10">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">{summary}</span>
        <button
          onClick={() => setExpanded(false)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          Collapse
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] font-semibold mb-1 font-mono truncate" title={branchA?.branch_id}>
            {branchA ? `A: ${branchA.branch_id.slice(0, 8)}…` : 'A: (none)'}
          </div>
          {branchA && <MetricRows branch={branchA} extraRows={extraMetricsForBranch(branchA)} />}
        </div>
        <div>
          <div className="text-[10px] font-semibold mb-1 font-mono truncate" title={branchB?.branch_id}>
            {branchB ? `B: ${branchB.branch_id.slice(0, 8)}…` : 'B: (none)'}
          </div>
          {branchB && <MetricRows branch={branchB} extraRows={extraMetricsForBranch(branchB)} />}
        </div>
      </div>
      <div className="col-span-2">
        {bothHaveArtifact ? (
          <ArtifactDiff oldText={aSnap} newText={bSnap} />
        ) : (
          <div className="text-[10px] italic text-muted-foreground">
            No artifact produced on {!aSnap && !bSnap ? 'either branch' : !aSnap ? 'branch A' : 'branch B'}.
          </div>
        )}
      </div>
    </div>
  );
}
