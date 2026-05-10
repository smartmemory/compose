import React, { useCallback, useState } from 'react';
import { useActiveBuild } from '../hooks/useActiveBuild.js';
import BuildCard from '../components/BuildCard.jsx';
import BuildDetailView from '../components/BuildDetailView.jsx';
import StartBuildSheet from '../components/StartBuildSheet.jsx';
import Toast from '../components/Toast.jsx';

function isTerminal(status) {
  return status === 'completed' || status === 'aborted' || status === 'failed' || status === 'done';
}

export default function BuildsTab() {
  const { active, loading, error, startBuild, abortBuild } = useActiveBuild();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [toast, setToast] = useState(null);

  const hasActive = !!(active && active.featureCode && !isTerminal(active.status));

  const handleStart = useCallback(async ({ featureCode, mode, description }) => {
    try {
      await startBuild({ featureCode, mode, description });
      setToast({ kind: 'ok', message: `Build started for ${featureCode}` });
    } catch (err) {
      // 409 already-active surfaces here.
      const msg = err?.status === 409
        ? `A build for ${featureCode} is already active`
        : (err?.message || 'Failed to start build');
      setToast({ kind: 'error', message: msg });
      throw err;
    }
  }, [startBuild]);

  const handleAbort = useCallback(async ({ featureCode }) => {
    setAborting(true);
    try {
      await abortBuild({ featureCode });
      setToast({ kind: 'ok', message: `Aborted ${featureCode}` });
      setDetailOpen(false);
    } catch (err) {
      setToast({ kind: 'error', message: err?.message || 'Failed to abort' });
      throw err;
    } finally {
      setAborting(false);
    }
  }, [abortBuild]);

  return (
    <section data-testid="mobile-tab-builds" className="m-builds-tab">
      <div className="m-section">
        <h2 className="m-section-title">Current build</h2>
        {loading ? (
          <div className="m-empty" data-testid="mobile-build-loading">Loading…</div>
        ) : hasActive ? (
          <BuildCard
            active={active}
            onOpen={() => setDetailOpen(true)}
            onAbort={handleAbort}
            aborting={aborting}
          />
        ) : (
          <div className="m-empty-state" data-testid="mobile-build-empty">
            <div className="m-empty-title">No active build</div>
            <div className="m-empty-body">
              {active && isTerminal(active.status)
                ? `Last build: ${active.featureCode} (${active.status})`
                : 'Start a build to track progress here.'}
            </div>
            <button
              type="button"
              className="m-btn m-btn-primary"
              data-testid="mobile-build-start"
              onClick={() => setSheetOpen(true)}
            >Start build</button>
          </div>
        )}
        {error && (
          <div className="m-empty" data-testid="mobile-build-error">Error: {error}</div>
        )}
      </div>

      {hasActive && (
        <div className="m-section">
          <button
            type="button"
            className="m-btn m-btn-sm"
            data-testid="mobile-build-start-secondary"
            onClick={() => setSheetOpen(true)}
          >Start another build</button>
        </div>
      )}

      <StartBuildSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSubmit={handleStart}
      />

      {detailOpen && active && (
        <BuildDetailView
          active={active}
          onClose={() => setDetailOpen(false)}
          onAbort={handleAbort}
        />
      )}

      <Toast
        message={toast?.message}
        kind={toast?.kind}
        onDismiss={() => setToast(null)}
      />
    </section>
  );
}
