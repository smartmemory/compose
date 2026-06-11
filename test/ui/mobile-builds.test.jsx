import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import BuildsTab from '../../src/mobile/tabs/BuildsTab.jsx';
import BuildStepsList from '../../src/mobile/components/BuildStepsList.jsx';
import BuildHistoryList from '../../src/mobile/components/BuildHistoryList.jsx';
import BuildDetailView from '../../src/mobile/components/BuildDetailView.jsx';
import { useBuildHistory } from '../../src/mobile/hooks/useBuildHistory.js';
import { setSensitiveToken, withComposeToken } from '../../src/lib/compose-api.js';

// EventSource stub — useAgentStream uses it
class FakeEventSource {
  constructor(url) { this.url = url; this.readyState = 0; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.readyState = 2; }
  set onopen(_) {}
  set onmessage(_) {}
  set onerror(_) {}
}
FakeEventSource.instances = [];

class FakeWS {
  constructor(url) { this.url = url; FakeWS.instances.push(this); }
  close() {}
  set onmessage(_) {}
  set onerror(_) {}
  set onclose(_) {}
}
FakeWS.instances = [];

let fetchCalls = [];
let buildState = null;
let startResponse = { ok: true, status: 200, body: { started: true, featureCode: 'F-1' } };
let historyBuilds = [];

function buildFetchMock() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    const u = String(url);
    if (u.includes('/api/build/state')) {
      return new Response(JSON.stringify({ state: buildState }), { status: 200 });
    }
    if (u.includes('/api/build/start') && opts.method === 'POST') {
      return new Response(JSON.stringify(startResponse.body), { status: startResponse.status });
    }
    if (u.includes('/api/build/abort') && opts.method === 'POST') {
      return new Response(JSON.stringify({ aborted: true }), { status: 200 });
    }
    if (u.includes('/api/builds')) {
      return new Response(JSON.stringify({ builds: historyBuilds }), { status: 200 });
    }
    if (u.includes('/api/vision/items')) {
      return new Response(JSON.stringify({ items: [
        { id: 'COMP-MOBILE', lifecycle: { featureCode: 'COMP-MOBILE' } },
        { id: 'COMP-X', lifecycle: { featureCode: 'COMP-X' } },
      ] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('<BuildsTab>', () => {
  beforeEach(() => {
    setSensitiveToken('test-token');
    globalThis.EventSource = FakeEventSource;
    globalThis.WebSocket = FakeWS;
    FakeEventSource.instances = [];
    FakeWS.instances = [];
    buildState = null;
    startResponse = { ok: true, status: 200, body: { started: true, featureCode: 'F-1' } };
    historyBuilds = [];
    buildFetchMock();
  });

  afterEach(() => {
    setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  // Helper: create a startBuild function that calls the mock fetch (identical headers/body)
  function makeStartBuild() {
    return async ({ featureCode, mode, description }) => {
      const res = await fetch('/api/build/start', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ featureCode, mode, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    };
  }

  function makeAbortBuild() {
    return async ({ featureCode }) => {
      const res = await fetch('/api/build/abort', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ featureCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    };
  }

  it('renders empty state with Start button when no active build', async () => {
    render(<BuildsTab active={null} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-empty'));
    expect(screen.getByTestId('mobile-build-start')).toBeTruthy();
  });

  it('renders BuildCard when an active build exists', async () => {
    const active = {
      featureCode: 'COMP-MOBILE',
      mode: 'feature',
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    render(<BuildsTab active={active} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-card'));
    const card = screen.getByTestId('mobile-build-card');
    expect(card.getAttribute('data-feature')).toBe('COMP-MOBILE');
    expect(screen.getByTestId('mobile-build-abort')).toBeTruthy();
  });

  it('StartBuildSheet submits with featureCode + mode + description', async () => {
    render(<BuildsTab active={null} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-start'));

    fireEvent.click(screen.getByTestId('mobile-build-start'));
    expect(screen.getByTestId('mobile-start-build-sheet')).toBeTruthy();

    fireEvent.change(screen.getByTestId('mobile-build-feature-input'), {
      target: { value: 'COMP-MOBILE' },
    });
    fireEvent.click(screen.getByTestId('mobile-build-mode-bug'));
    fireEvent.change(screen.getByTestId('mobile-build-description'), {
      target: { value: 'fix the thing' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-submit'));
    });

    const startCall = fetchCalls.find(c =>
      c.url.includes('/api/build/start') && c.opts.method === 'POST'
    );
    expect(startCall).toBeTruthy();
    expect(startCall.opts.headers['x-compose-token']).toBe('test-token');
    const body = JSON.parse(startCall.opts.body);
    expect(body.featureCode).toBe('COMP-MOBILE');
    expect(body.mode).toBe('bug');
    expect(body.description).toBe('fix the thing');
  });

  it('Abort button hits /api/build/abort with featureCode and x-compose-token', async () => {
    const active = {
      featureCode: 'COMP-MOBILE',
      mode: 'feature',
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    render(<BuildsTab active={active} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-card'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-abort'));
    });

    const abortCall = fetchCalls.find(c =>
      c.url.includes('/api/build/abort') && c.opts.method === 'POST'
    );
    expect(abortCall).toBeTruthy();
    expect(abortCall.opts.headers['x-compose-token']).toBe('test-token');
    const body = JSON.parse(abortCall.opts.body);
    expect(body.featureCode).toBe('COMP-MOBILE');
  });

  it('409 already-active surfaces a toast', async () => {
    startResponse = {
      ok: false,
      status: 409,
      body: { error: 'Build is already active for COMP-MOBILE' },
    };
    render(<BuildsTab active={null} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-start'));

    fireEvent.click(screen.getByTestId('mobile-build-start'));
    fireEvent.change(screen.getByTestId('mobile-build-feature-input'), {
      target: { value: 'COMP-MOBILE' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-build-submit'));
    });

    await waitFor(() => screen.getByTestId('mobile-toast'));
    const toast = screen.getByTestId('mobile-toast');
    expect(toast.getAttribute('data-kind')).toBe('error');
    expect(toast.textContent.toLowerCase()).toContain('already active');
  });

  it('renders history section with BuildHistoryList', async () => {
    historyBuilds = [
      { flowId: 'flow-1', featureCode: 'COMP-A', status: 'complete', completedAt: new Date().toISOString() },
    ];
    render(<BuildsTab active={null} loading={false} error={null} startBuild={makeStartBuild()} abortBuild={makeAbortBuild()} />);
    await waitFor(() => screen.getByTestId('mobile-build-history-section'));
    await waitFor(() => screen.getByTestId('mobile-build-history'));
    // Should show the history row once loaded
    await waitFor(() => screen.getByTestId('mobile-build-history-0'));
  });
});

// ── S02: BuildStepsList tests ─────────────────────────────────────────────

describe('<BuildStepsList>', () => {
  it('renders all 4 phase headers when active has no steps', () => {
    render(<BuildStepsList active={{ featureCode: 'TEST', status: 'running', steps: [], currentStepId: null }} />);
    const container = screen.getByTestId('mobile-build-steps');
    expect(container).toBeTruthy();
    // All 4 phase headers
    expect(container.textContent).toContain('Design');
    expect(container.textContent).toContain('Blueprint');
    expect(container.textContent).toContain('Implementation');
    expect(container.textContent).toContain('Ship');
  });

  it('renders step rows with data-testids', () => {
    render(<BuildStepsList active={{ featureCode: 'TEST', status: 'running', steps: [], currentStepId: null }} />);
    // explore_design should exist
    expect(screen.getByTestId('mobile-build-step-explore_design')).toBeTruthy();
    expect(screen.getByTestId('mobile-build-step-ship')).toBeTruthy();
  });

  it('marks currentStepId step as active with ◉ glyph', () => {
    render(<BuildStepsList active={{
      featureCode: 'TEST',
      status: 'running',
      steps: [],
      currentStepId: 'blueprint',
    }} />);
    const activeRow = screen.getByTestId('mobile-build-step-blueprint');
    expect(activeRow.getAttribute('data-status')).toBe('active');
    expect(activeRow.textContent).toContain('◉');
  });

  it('shows active glyph from currentStepId, not from steps[]', () => {
    // steps[] is completed history — blueprint is listed there as 'done'
    // but currentStepId=verification means verification should be active
    render(<BuildStepsList active={{
      featureCode: 'TEST',
      status: 'running',
      steps: [{ id: 'blueprint', status: 'done' }],
      currentStepId: 'verification',
    }} />);
    const bpRow = screen.getByTestId('mobile-build-step-blueprint');
    expect(bpRow.getAttribute('data-status')).toBe('done');
    const verRow = screen.getByTestId('mobile-build-step-verification');
    expect(verRow.getAttribute('data-status')).toBe('active');
  });

  it('applies failed emphasis styling to failed steps', () => {
    render(<BuildStepsList active={{
      featureCode: 'TEST',
      status: 'failed',
      steps: [{ id: 'execute', status: 'failed', summary: 'Tests broke' }],
      currentStepId: null,
    }} />);
    const row = screen.getByTestId('mobile-build-step-execute');
    expect(row.className).toContain('m-step-row--failed');
    // summary visible in failed row
    expect(row.textContent).toContain('Tests broke');
  });

  it('collapses a run of 3+ done steps into a single "N done" row', () => {
    // Make design phase steps all done (there are 9 design steps)
    const donedSteps = [
      { id: 'explore_design', status: 'done' },
      { id: 'design_review', status: 'done' },
      { id: 'design_gate', status: 'done' },
      { id: 'prd', status: 'done' },
      { id: 'prd_review', status: 'done' },
    ];
    render(<BuildStepsList active={{
      featureCode: 'TEST',
      status: 'running',
      steps: donedSteps,
      currentStepId: 'prd_gate',
    }} />);
    const container = screen.getByTestId('mobile-build-steps');
    // There should be at least one collapsed row in the design phase
    const collapsedRows = container.querySelectorAll('[data-testid="mobile-build-steps-collapsed"]');
    expect(collapsedRows.length).toBeGreaterThan(0);
    // The collapsed label should mention the count
    const collapsed = collapsedRows[0];
    expect(collapsed.textContent).toContain('done ✓');
  });

  it('expands collapsed done-run on tap', async () => {
    const donedSteps = [
      { id: 'explore_design', status: 'done' },
      { id: 'design_review', status: 'done' },
      { id: 'design_gate', status: 'done' },
    ];
    render(<BuildStepsList active={{
      featureCode: 'TEST',
      status: 'running',
      steps: donedSteps,
      currentStepId: 'prd',
    }} />);
    const collapsed = screen.getByTestId('mobile-build-steps-collapsed');
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(collapsed);
    expect(collapsed.getAttribute('aria-expanded')).toBe('true');
    // After expand, individual step rows should appear inside
    expect(collapsed.textContent).toContain('Design Review');
  });

  it('renders null active gracefully', () => {
    render(<BuildStepsList active={null} />);
    const container = screen.getByTestId('mobile-build-steps');
    expect(container).toBeTruthy();
    // All steps shown as pending
    expect(screen.getByTestId('mobile-build-step-explore_design')).toBeTruthy();
  });
});

// ── S02: BuildDetailView toggle tests ────────────────────────────────────

describe('<BuildDetailView> Steps/Log toggle', () => {
  beforeEach(() => {
    globalThis.EventSource = FakeEventSource;
    globalThis.WebSocket = FakeWS;
    FakeEventSource.instances = [];
    FakeWS.instances = [];
  });

  const activeBase = {
    featureCode: 'COMP-TEST',
    flowId: 'flow-abc',
    status: 'running',
    mode: 'feature',
    steps: [],
    currentStepId: 'blueprint',
  };

  it('shows Steps tab by default', () => {
    render(<BuildDetailView active={activeBase} onClose={() => {}} onAbort={() => {}} />);
    const stepsTab = screen.getByTestId('mobile-build-detail-tab-steps');
    expect(stepsTab.getAttribute('aria-pressed')).toBe('true');
    // BuildStepsList should be visible
    expect(screen.getByTestId('mobile-build-steps')).toBeTruthy();
  });

  it('switches to Log tab on click', async () => {
    render(<BuildDetailView active={activeBase} onClose={() => {}} onAbort={() => {}} />);
    const logTab = screen.getByTestId('mobile-build-detail-tab-log');
    fireEvent.click(logTab);
    expect(logTab.getAttribute('aria-pressed')).toBe('true');
    // Log content area should be visible; steps list gone
    expect(screen.queryByTestId('mobile-build-steps')).toBeFalsy();
    // "No live events yet" message appears when stream is empty
    expect(screen.getByText('No live events yet.')).toBeTruthy();
  });

  it('preserves existing testids', () => {
    render(<BuildDetailView active={activeBase} onClose={() => {}} onAbort={() => {}} />);
    expect(screen.getByTestId('mobile-build-detail')).toBeTruthy();
    expect(screen.getByTestId('mobile-build-detail-abort')).toBeTruthy();
    expect(screen.getByTestId('mobile-build-detail-close')).toBeTruthy();
  });
});

// ── S02: BuildHistoryList tests ───────────────────────────────────────────

describe('<BuildHistoryList>', () => {
  it('renders per-step results in expanded row when steps[] present (COMP-MOBILE-1-1)', () => {
    const builds = [{
      flowId: 'f-steps', featureCode: 'FEAT-S', status: 'failed',
      completedAt: new Date().toISOString(), stepCount: 2, failureReason: 'review red',
      steps: [
        { id: 'execute', status: 'done', agent: 'claude', durationMs: 1000 },
        { id: 'review', status: 'failed', agent: 'codex', durationMs: 500, summary: 'tests red' },
      ],
    }];
    render(<BuildHistoryList builds={builds} loading={false} error={null} />);
    fireEvent.click(screen.getByTestId('mobile-build-history-0'));
    const steps = screen.getByTestId('mobile-build-history-steps-0');
    expect(steps.textContent).toContain('execute');
    expect(steps.textContent).toContain('review');
    expect(steps.textContent).toContain('tests red');
    const failedRow = steps.querySelector('[data-status="failed"]');
    expect(failedRow).toBeTruthy();
    expect(failedRow.className).toContain('is-failed');
  });

  it('omits the steps block for legacy records without steps[]', () => {
    const builds = [{
      flowId: 'f-legacy', featureCode: 'FEAT-L', status: 'complete',
      completedAt: new Date().toISOString(), stepCount: 3,
    }];
    render(<BuildHistoryList builds={builds} loading={false} error={null} />);
    fireEvent.click(screen.getByTestId('mobile-build-history-0'));
    expect(screen.queryByTestId('mobile-build-history-steps-0')).toBeNull();
  });

  it('renders empty state when no builds', () => {
    render(<BuildHistoryList builds={[]} loading={false} error={null} />);
    const container = screen.getByTestId('mobile-build-history');
    expect(container.textContent).toContain('No past builds.');
  });

  it('renders loading state', () => {
    render(<BuildHistoryList builds={[]} loading={true} error={null} />);
    const container = screen.getByTestId('mobile-build-history');
    expect(container.textContent.toLowerCase()).toContain('loading');
  });

  it('renders error state', () => {
    render(<BuildHistoryList builds={[]} loading={false} error="Network error" />);
    const container = screen.getByTestId('mobile-build-history');
    expect(container.textContent).toContain('Network error');
  });

  it('renders a row per build with data-testid', () => {
    const builds = [
      { flowId: 'f1', featureCode: 'COMP-A', status: 'complete', completedAt: new Date().toISOString() },
      { flowId: 'f2', featureCode: 'COMP-B', status: 'failed', completedAt: new Date().toISOString(), failureReason: 'Step crashed hard' },
    ];
    render(<BuildHistoryList builds={builds} loading={false} error={null} />);
    expect(screen.getByTestId('mobile-build-history-0')).toBeTruthy();
    expect(screen.getByTestId('mobile-build-history-1')).toBeTruthy();
    expect(screen.getByTestId('mobile-build-history-0').textContent).toContain('COMP-A');
    expect(screen.getByTestId('mobile-build-history-1').textContent).toContain('COMP-B');
  });

  it('shows truncated failureReason in summary for failed builds', () => {
    const builds = [
      { flowId: 'f1', featureCode: 'COMP-X', status: 'failed', failureReason: 'Something broke quite badly in the CI pipeline', completedAt: new Date().toISOString() },
    ];
    render(<BuildHistoryList builds={builds} loading={false} error={null} />);
    const row = screen.getByTestId('mobile-build-history-0');
    expect(row.textContent).toContain('Something broke');
  });

  it('expands inline to show full details on tap', () => {
    const builds = [
      {
        flowId: 'f1',
        featureCode: 'COMP-Y',
        status: 'failed',
        mode: 'bug',
        durationMs: 125000,
        stepCount: 7,
        failureReason: 'Full failure reason text',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ];
    render(<BuildHistoryList builds={builds} loading={false} error={null} />);
    const row = screen.getByTestId('mobile-build-history-0');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    // Expanded detail shows mode, duration, stepCount, failureReason
    expect(row.textContent).toContain('bug');
    expect(row.textContent).toContain('2m 5s');
    expect(row.textContent).toContain('7');
    expect(row.textContent).toContain('Full failure reason text');
  });
});

// ── S02: useBuildHistory hook tests ──────────────────────────────────────

describe('useBuildHistory hook', () => {
  beforeEach(() => {
    globalThis.EventSource = FakeEventSource;
    globalThis.WebSocket = FakeWS;
    FakeEventSource.instances = [];
    FakeWS.instances = [];
    historyBuilds = [];
    buildFetchMock();
  });

  afterEach(() => {
    setSensitiveToken(null);
    vi.restoreAllMocks();
  });

  function HookHarness({ active, limit }) {
    const { builds, loading, error } = useBuildHistory({ active, limit });
    return (
      <div>
        <span data-testid="loading">{loading ? 'loading' : 'done'}</span>
        <span data-testid="error">{error || ''}</span>
        <span data-testid="count">{builds.length}</span>
        {builds.map((b, i) => (
          <span key={i} data-testid={`build-${i}`}>{b.featureCode}</span>
        ))}
      </div>
    );
  }

  it('does NOT fire corrective alert when the rebroadcast already flipped active to failed (COMP-MOBILE-1-1)', async () => {
    const notifications = [];
    const onNotify = (e) => notifications.push(e.detail);
    window.addEventListener('compose:notify', onNotify);
    try {
      historyBuilds = [];
      const { rerender } = render(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'running' }} />);
      await waitFor(() => screen.getByTestId('loading').textContent === 'done');

      // First terminal observation: complete (pre-health-gate broadcast)
      historyBuilds = [];
      await act(async () => {
        rerender(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'complete' }} />);
      });

      // Backend rebroadcast: same flowId now failed (health-gate downgrade)
      await act(async () => {
        rerender(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'failed' }} />);
      });

      // History row lands with failed — observed status agrees, so no corrective alert
      historyBuilds = [{ flowId: 'f-hg', featureCode: 'F-HG', status: 'failed' }];
      await act(async () => {
        rerender(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'failed' }} limit={21} />);
      });
      await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

      const corrective = notifications.filter(n => String(n?.message || '').includes('post-checks'));
      expect(corrective.length).toBe(0);
    } finally {
      window.removeEventListener('compose:notify', onNotify);
    }
  });

  it('fetches on mount', async () => {
    historyBuilds = [
      { flowId: 'f1', featureCode: 'F-MOUNT', status: 'complete' },
    ];
    render(<HookHarness active={null} />);
    await waitFor(() => screen.getByTestId('loading').textContent === 'done');
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('build-0').textContent).toBe('F-MOUNT');
    const buildsCalls = fetchCalls.filter(c => c.url.includes('/api/builds'));
    expect(buildsCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('refetches when active build reaches terminal status', async () => {
    historyBuilds = [];
    const { rerender } = render(<HookHarness active={{ flowId: 'f-run', featureCode: 'F-RUN', status: 'running' }} />);
    await waitFor(() => screen.getByTestId('loading').textContent === 'done');

    const callsBefore = fetchCalls.filter(c => c.url.includes('/api/builds')).length;

    // Now set terminal status
    historyBuilds = [{ flowId: 'f-run', featureCode: 'F-RUN', status: 'complete' }];
    rerender(<HookHarness active={{ flowId: 'f-run', featureCode: 'F-RUN', status: 'complete' }} />);

    await waitFor(() => {
      const callsAfter = fetchCalls.filter(c => c.url.includes('/api/builds')).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it('schedules 2.5s retry when flowId not in fetched builds', async () => {
    // Spy on setTimeout to detect that the 2500ms retry is scheduled
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // First fetch returns empty — flowId not present
    historyBuilds = [];

    const { rerender } = render(<HookHarness active={{ flowId: 'f-missing', featureCode: 'F-X', status: 'running' }} />);
    await waitFor(() => screen.getByTestId('loading').textContent === 'done');

    // Clear any prior setTimeout calls from mount
    setTimeoutSpy.mockClear();

    // Transition to terminal — triggers refetch (flowId missing → schedules retry)
    await act(async () => {
      rerender(<HookHarness active={{ flowId: 'f-missing', featureCode: 'F-X', status: 'complete' }} />);
    });

    // Wait for the terminal-triggered refetch to complete
    await waitFor(() => {
      const calls = fetchCalls.filter(c => c.url.includes('/api/builds'));
      expect(calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    // The 2500ms retry setTimeout should have been scheduled
    const retryTimers = setTimeoutSpy.mock.calls.filter(args => args[1] === 2500);
    expect(retryTimers.length).toBeGreaterThan(0);

    setTimeoutSpy.mockRestore();
  }, 10000);

  it('fires corrective notify when active said complete but history says failed', async () => {
    // Spy on the CustomEvent dispatch to detect notify()
    const dispatchedEvents = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((evt) => {
      if (evt && evt.type === 'compose:notify') {
        dispatchedEvents.push(evt.detail || {});
      }
    });

    // First: active running
    historyBuilds = [];
    const { rerender } = render(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'running' }} />);
    await waitFor(() => screen.getByTestId('loading').textContent === 'done');

    // Transition to terminal 'complete' but history records it as 'failed'
    historyBuilds = [{ flowId: 'f-hg', featureCode: 'F-HG', status: 'failed' }];
    await act(async () => {
      rerender(<HookHarness active={{ flowId: 'f-hg', featureCode: 'F-HG', status: 'complete' }} />);
    });

    // Wait for the terminal effect to fire the refetch and then the alert check
    await waitFor(
      () => {
        const alertEvents = dispatchedEvents.filter(d => d?.message && d.message.includes('post-checks'));
        expect(alertEvents.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
  }, 10000);

  it('does NOT fire corrective notify when statuses agree (both failed)', async () => {
    const dispatchedEvents = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((evt) => {
      if (evt && evt.type === 'compose:notify') {
        dispatchedEvents.push(evt.detail || {});
      }
    });

    historyBuilds = [];
    const { rerender } = render(<HookHarness active={{ flowId: 'f-agree', featureCode: 'F-AGREE', status: 'running' }} />);
    await waitFor(() => screen.getByTestId('loading').textContent === 'done');

    // active.status = failed, history also = failed — should NOT alert
    historyBuilds = [{ flowId: 'f-agree', featureCode: 'F-AGREE', status: 'failed' }];
    await act(async () => {
      rerender(<HookHarness active={{ flowId: 'f-agree', featureCode: 'F-AGREE', status: 'failed' }} />);
    });

    // Wait for the refetch to complete
    await waitFor(
      () => {
        const calls = fetchCalls.filter(c => c.url.includes('/api/builds'));
        expect(calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );

    const alertEvents = dispatchedEvents.filter(d => d?.message && d.message.includes('post-checks'));
    expect(alertEvents.length).toBe(0);
  }, 10000);
});
