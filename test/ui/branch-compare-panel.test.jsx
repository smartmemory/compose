import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import BranchComparePanel from '../../src/components/vision/BranchComparePanel.jsx';

const NOW = Date.parse('2026-04-20T12:00:00Z');

function makeBranch(overrides = {}) {
  return {
    branch_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    cc_session_id: 'sess-1',
    fork_uuid: 'fork-1',
    leaf_uuid: 'leaf-1',
    feature_code: 'COMP-OBS-BRANCH',
    state: 'complete',
    started_at: '2026-04-20T10:00:00Z',
    ended_at: '2026-04-20T11:30:00Z',
    turn_count: 5,
    files_touched: [
      { path: 'server/foo.js', turns_modified: 2 },
      { path: 'src/bar.jsx', turns_modified: 1 },
    ],
    tests: { passed: 3, failed: 0, skipped: 0, run_ids: ['r1'] },
    cost: { tokens_in: 1500, tokens_out: 800, usd: 0, wall_clock_ms: 5_400_000 },
    final_artifact: { path: 'docs/features/COMP-OBS-BRANCH/plan.md', kind: 'plan', snapshot: 'line 1\nline 2\noriginal' },
    open_loops_produced: [],
    ...overrides,
  };
}

describe('<BranchComparePanel>', () => {
  it('renders collapsed "0 branches" state with disabled button when lineage is null', () => {
    render(<BranchComparePanel lineage={null} now={NOW} />);
    expect(screen.getByText(/0 branches/)).toBeTruthy();
    const btn = screen.getByTestId('branch-compare-toggle');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows "1 of 2 branches ready" when one branch is still running', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa', state: 'complete' }),
        makeBranch({ branch_id: 'bbbb', state: 'running', ended_at: null, turn_count: null, files_touched: null, tests: null, cost: null, final_artifact: null }),
      ],
    };
    render(<BranchComparePanel lineage={lineage} now={NOW} />);
    expect(screen.getByText(/1 of 2 branches ready/)).toBeTruthy();
    const btn = screen.getByTestId('branch-compare-toggle');
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('renders "2 branches" collapsed summary with enabled button when both complete', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa', started_at: '2026-04-20T10:00:00Z' }),
        makeBranch({ branch_id: 'bbbb', started_at: '2026-04-20T11:00:00Z' }),
      ],
    };
    render(<BranchComparePanel lineage={lineage} now={NOW} />);
    expect(screen.getByText(/2 branches · last fork 1h ago/)).toBeTruthy();
    const btn = screen.getByTestId('branch-compare-toggle');
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('clicking Compare expands the panel and renders two metric columns', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa' }),
        makeBranch({ branch_id: 'bbbb', final_artifact: { ...makeBranch().final_artifact, snapshot: 'line 1\nline 2\nchanged\nline 3' } }),
      ],
    };
    const { container } = render(<BranchComparePanel lineage={lineage} now={NOW} />);
    const btn = screen.getByTestId('branch-compare-toggle');
    fireEvent.click(btn);

    // Two-column metric grid present
    const grid = container.querySelector('.grid.grid-cols-2');
    expect(grid).toBeTruthy();
    expect(grid.children.length).toBe(2);

    // Metric row labels render inside each column
    expect(screen.getAllByText('Files touched').length).toBe(2);
    expect(screen.getAllByText('Tests').length).toBe(2);
    expect(screen.getAllByText('Final artifact').length).toBe(2);

    // Collapse link appears
    expect(screen.getByText(/Collapse/i)).toBeTruthy();
  });

  it('invokes onSelectPair with [a,b] branch_ids when Compare is clicked', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa' }),
        makeBranch({ branch_id: 'bbbb' }),
      ],
    };
    let received = null;
    render(<BranchComparePanel lineage={lineage} now={NOW} onSelectPair={(pair) => { received = pair; }} />);
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));
    expect(received).toEqual(['aaaa', 'bbbb']);
  });

  it('renders ArtifactDiff when both selected branches have snapshots', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa' }),
        makeBranch({ branch_id: 'bbbb', final_artifact: { path: 'docs/features/COMP-OBS-BRANCH/plan.md', kind: 'plan', snapshot: 'different text\nline 2\nline 3' } }),
      ],
    };
    render(<BranchComparePanel lineage={lineage} now={NOW} />);
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));

    // ArtifactDiff renders a "Show changes (+N -M)" button when snapshots differ
    expect(screen.getByText(/Show changes/i)).toBeTruthy();
  });

  it('renders "no artifact" fallback when one branch lacks a snapshot', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa' }),
        makeBranch({ branch_id: 'bbbb', final_artifact: null }),
      ],
    };
    render(<BranchComparePanel lineage={lineage} now={NOW} />);
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));
    expect(screen.getByText(/No artifact produced on branch B/i)).toBeTruthy();
  });

  it('metric rows include tokens formatted as "k" for large values', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa', cost: { tokens_in: 12500, tokens_out: 3500, usd: 0, wall_clock_ms: 3_600_000 } }),
        makeBranch({ branch_id: 'bbbb' }),
      ],
    };
    render(<BranchComparePanel lineage={lineage} now={NOW} />);
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));
    // fmtNum(12500) = "12.5k"; fmtNum(3500) = "3.5k"
    expect(screen.getByText('12.5k / 3.5k')).toBeTruthy();
  });

  it('extraMetricsForBranch prop injects additional rows into each column', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaa' }),
        makeBranch({ branch_id: 'bbbb' }),
      ],
    };
    render(
      <BranchComparePanel
        lineage={lineage}
        now={NOW}
        extraMetricsForBranch={(b) => [{ label: 'Drift', value: `${b.branch_id.slice(0, 4)}-drift` }]}
      />
    );
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));
    expect(screen.getAllByText('Drift').length).toBe(2);
    expect(screen.getByText('aaaa-drift')).toBeTruthy();
    expect(screen.getByText('bbbb-drift')).toBeTruthy();
  });

  it('honors selectedPair prop when both ids exist in complete branches', () => {
    const lineage = {
      feature_code: 'COMP-OBS-BRANCH',
      branches: [
        makeBranch({ branch_id: 'aaaaaaaaaaaa1111' }),
        makeBranch({ branch_id: 'bbbbbbbbbbbb2222' }),
        makeBranch({ branch_id: 'ccccccccccc3333' }),
      ],
    };
    const { container } = render(
      <BranchComparePanel lineage={lineage} selectedPair={['ccccccccccc3333', 'aaaaaaaaaaaa1111']} now={NOW} />
    );
    fireEvent.click(screen.getByTestId('branch-compare-toggle'));
    const grid = container.querySelector('.grid.grid-cols-2');
    // Component renders branch_id.slice(0, 8) + "…"
    expect(within(grid.children[0]).getByText(/^A: cccccccc…/)).toBeTruthy();
    expect(within(grid.children[1]).getByText(/^B: aaaaaaaa…/)).toBeTruthy();
  });
});
