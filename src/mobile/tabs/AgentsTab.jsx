import React, { useState, useCallback } from 'react';
import { useLiveAgents } from '../hooks/useLiveAgents.js';
import { usePendingGates } from '../hooks/usePendingGates.js';
import { useInteractiveSession } from '../hooks/useInteractiveSession.js';
import AgentCard from '../components/AgentCard.jsx';
import AgentDetailView from '../components/AgentDetailView.jsx';
import InteractiveSessionCard from '../components/InteractiveSessionCard.jsx';
import GateCard from '../components/GateCard.jsx';
import GatePromptSheet from '../components/GatePromptSheet.jsx';

export default function AgentsTab() {
  const { agents, loading: agentsLoading, refetch: refetchAgents } = useLiveAgents();
  const { gates, loading: gatesLoading, resolve } = usePendingGates();
  const session = useInteractiveSession();

  const [activeAgent, setActiveAgent] = useState(null);
  const [activeGate, setActiveGate] = useState(null);

  const onAfterKill = useCallback(() => {
    refetchAgents();
    setActiveAgent(null);
  }, [refetchAgents]);

  return (
    <section data-testid="mobile-tab-agents" className="m-agents-tab">
      <div className="m-section" data-testid="mobile-section-spawned">
        <h2 className="m-section-title">Spawned agents</h2>
        {agentsLoading ? (
          <div className="m-empty">Loading agents…</div>
        ) : agents.length === 0 ? (
          <div className="m-empty">No spawned agents.</div>
        ) : (
          <div className="m-stack">
            {agents.map((a) => (
              <AgentCard
                key={a.agentId || a.id}
                agent={a}
                onOpen={setActiveAgent}
                onAfterKill={onAfterKill}
              />
            ))}
          </div>
        )}
      </div>

      <div className="m-section" data-testid="mobile-section-session">
        <h2 className="m-section-title">Interactive session</h2>
        <InteractiveSessionCard session={session} />
      </div>

      <div className="m-section" data-testid="mobile-section-gates">
        <h2 className="m-section-title">Pending gates</h2>
        {gatesLoading ? (
          <div className="m-empty">Loading gates…</div>
        ) : gates.length === 0 ? (
          <div className="m-empty">No pending gates.</div>
        ) : (
          <div className="m-stack">
            {gates.map((g) => (
              <GateCard key={g.id} gate={g} onOpen={setActiveGate} />
            ))}
          </div>
        )}
      </div>

      {activeAgent && (
        <AgentDetailView agent={activeAgent} onClose={() => setActiveAgent(null)} />
      )}
      {activeGate && (
        <GatePromptSheet
          gate={activeGate}
          onResolve={resolve}
          onClose={() => setActiveGate(null)}
        />
      )}
    </section>
  );
}
