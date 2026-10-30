import React from 'react';
import { cn } from '@/lib/utils.js';
import { CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import { LIFECYCLE_PHASE_LABELS } from './constants.js';

export const PHASES = ['explore_design', 'prd', 'architecture', 'blueprint', 'plan', 'execute', 'report'];

/**
 * PhaseTimeline: the seven lifecycle phases. `compact` is the one-line dot row
 * used on Home's in-progress cards (COMP-AUDIT-18).
 */
export default function PhaseTimeline({ currentPhase, compact = false }) {
  const currentIdx = PHASES.indexOf(currentPhase);
  if (compact) {
    return (
      <div className="mt-1.5 flex items-center gap-1" data-testid="phase-timeline-compact" title={LIFECYCLE_PHASE_LABELS[currentPhase] ?? currentPhase}>
        {PHASES.map((phase, idx) => (
          <span
            key={phase}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              currentIdx > idx ? 'bg-emerald-400' : currentIdx === idx ? 'bg-blue-400' : 'bg-muted',
            )}
          />
        ))}
        <span className="ml-1 text-[10px] text-muted-foreground shrink-0">{LIFECYCLE_PHASE_LABELS[currentPhase] ?? currentPhase}</span>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {PHASES.map((phase, idx) => {
        const done = currentIdx > idx;
        const active = currentIdx === idx;
        const label = LIFECYCLE_PHASE_LABELS[phase] ?? phase;
        return (
          <div
            key={phase}
            className="flex items-center gap-2"
            style={{
              animation: `phase-slide-in 300ms ease-out ${idx * 50}ms both`,
            }}
          >
            {done ? (
              <CheckCircle2
                className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                style={{ animation: 'phase-check-pop 400ms ease-out' }}
              />
            ) : active ? (
              <ArrowRight
                className="w-3.5 h-3.5 text-blue-400 shrink-0"
                style={{ animation: 'phase-active-pulse 2s ease-in-out infinite' }}
              />
            ) : (
              <Circle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            )}
            <span className={cn(
              'text-[11px] transition-colors duration-500',
              done && 'text-emerald-400',
              active && 'text-blue-400 font-medium',
              !done && !active && 'text-muted-foreground/50',
            )}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
