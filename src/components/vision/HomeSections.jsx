import React from 'react';
import { AlertTriangle, Shield, Lightbulb, Zap, CheckCircle2, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { GATE_STEP_LABELS, LIFECYCLE_PHASE_LABELS } from './constants.js';
import RelativeTime from './shared/RelativeTime.jsx';
import PhaseTimeline from './PhaseTimeline.jsx';
import HomeFleetGlance from './HomeFleetGlance.jsx';
import { needsYouCount } from './homeSectionsState.js';

/**
 * HomeSections — the project-wide sections of Home (COMP-AUDIT-18, design §4.2).
 * Each section is hidden when empty. Data arrives through `sections`
 * (homeSectionsState.deriveHomeSections); nothing here fetches.
 */

function Section({ id, title, count, children }) {
  return (
    <section data-testid={`home-${id}`} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{title}</h3>
        {count > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-400 font-medium">{count}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({ icon, children, onClick, testId, trailing }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-foreground',
        onClick && 'hover:bg-muted/50 cursor-pointer transition-colors',
      )}
    >
      {icon}
      <span className="truncate flex-1 min-w-0">{children}</span>
      {trailing}
    </Tag>
  );
}

function gateLabel(gate) {
  return GATE_STEP_LABELS[gate.stepId] ?? LIFECYCLE_PHASE_LABELS[gate.fromPhase] ?? gate.fromPhase ?? 'Gate';
}

export default function HomeSections({
  sections, untriagedIdeas = 0, showFleet = false,
  onSelect, onJumpToGate, onStopAgent, onNavigate,
}) {
  const { needsYou, running, inProgress, recentlyChanged, recentBuilds } = sections;
  const needs = needsYouCount(needsYou);

  return (
    <div className="space-y-5" data-testid="home-sections">
      {needs > 0 && (
        <Section id="needs-you" title="Needs you" count={needs}>
          <div className="space-y-0.5">
            {needsYou.gates.map(({ gate, item }) => (
              <Row
                key={`gate-${gate.id}`}
                testId="home-gate-row"
                icon={<Shield className="w-3 h-3 shrink-0 text-amber-400" />}
                onClick={() => (onJumpToGate || (() => {}))(gate.id)}
                trailing={<span className="text-[10px] text-muted-foreground shrink-0">{gateLabel(gate)}</span>}
              >
                {item?.title ?? 'Unknown'}
              </Row>
            ))}
            {needsYou.queue.map(({ item, reason }) => (
              <Row
                key={`q-${item.id}`}
                icon={<AlertTriangle className="w-3 h-3 shrink-0 text-destructive" />}
                onClick={() => onSelect?.(item.id)}
                trailing={<span className="text-[10px] text-muted-foreground shrink-0">{reason}</span>}
              >
                {item.title}
              </Row>
            ))}
            {needsYou.errors.map((e, i) => (
              <Row
                key={`e-${e.timestamp}-${i}`}
                icon={<AlertTriangle className="w-3 h-3 shrink-0 text-destructive" />}
                trailing={<span className="text-[10px] text-muted-foreground shrink-0">agent error</span>}
              >
                {e.message || e.errorType || 'Agent error'}
              </Row>
            ))}
          </div>
        </Section>
      )}

      {(running.build || running.agents.length > 0) && (
        <Section id="running" title="Running now">
          <div className="space-y-0.5">
            {running.build && (
              <Row
                testId="home-build-row"
                icon={<Zap className="w-3 h-3 shrink-0 text-blue-400" />}
                trailing={(
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {running.build.currentStepId || running.build.currentStep || running.build.status || 'running'}
                    {running.build.stepNum && running.build.totalSteps ? ` · ${running.build.stepNum}/${running.build.totalSteps}` : ''}
                  </span>
                )}
              >
                Build {running.build.featureCode || ''}
              </Row>
            )}
            {running.agents.map(a => (
              <Row
                key={a.agentId}
                testId="home-agent-row"
                icon={<span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                trailing={onStopAgent && (
                  <Button
                    variant="outline" size="sm"
                    className="h-5 text-[10px] px-2 shrink-0"
                    onClick={() => onStopAgent(a.agentId)}
                    data-testid="home-agent-stop"
                  >
                    Stop
                  </Button>
                )}
              >
                {a.agentType || 'agent'}
              </Row>
            ))}
          </div>
        </Section>
      )}

      {inProgress.length > 0 && (
        <Section id="in-progress" title="In progress" count={0}>
          <div className="grid grid-cols-2 gap-3">
            {inProgress.map(f => {
              const phase = f.lifecycle?.currentPhase || f.phase || null;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onSelect?.(f.id)}
                  className="text-left rounded border border-border bg-card/50 p-2 hover:bg-muted/40 transition-colors"
                  data-testid="home-in-progress-card"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-foreground truncate">{f.title}</span>
                    {f.featureCode && (
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono ml-auto shrink-0">{f.featureCode}</Badge>
                    )}
                  </div>
                  {phase && <PhaseTimeline currentPhase={phase} compact />}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {recentlyChanged.length > 0 && (
        <Section id="recently-changed" title="Recently changed (done)">
          <div className="space-y-0.5">
            {recentlyChanged.map(f => (
              <Row
                key={f.id}
                icon={<CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />}
                onClick={() => onSelect?.(f.id)}
                trailing={(
                  <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                    last changed <RelativeTime date={f.updatedAt} className="text-[10px]" />
                  </span>
                )}
              >
                {f.title}
              </Row>
            ))}
          </div>
        </Section>
      )}

      {recentBuilds.length > 0 && (
        <Section id="recent-builds" title="Recent builds">
          <div className="space-y-0.5">
            {recentBuilds.map((b, i) => (
              <Row
                key={`${b.featureCode}-${b.completedAt || i}`}
                testId="home-build-history-row"
                icon={<CircleDot className={cn('w-3 h-3 shrink-0', b.status === 'complete' ? 'text-emerald-400' : 'text-destructive')} />}
                trailing={<span className="text-[10px] text-muted-foreground shrink-0">{b.status}</span>}
              >
                {b.featureCode || 'build'}
              </Row>
            ))}
          </div>
        </Section>
      )}

      {untriagedIdeas > 0 && (
        <Section id="ideas" title="Ideas">
          <Row
            testId="home-ideas-link"
            icon={<Lightbulb className="w-3 h-3 shrink-0 text-amber-400" />}
            onClick={() => onNavigate?.('ideabox')}
          >
            {untriagedIdeas} untriaged
          </Row>
        </Section>
      )}

      {showFleet && (
        <Section id="fleet" title="Fleet">
          <HomeFleetGlance />
        </Section>
      )}
    </div>
  );
}
