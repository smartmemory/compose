import React, { useEffect, useRef, useState } from 'react';
import { useFleetRoots } from '../lib/fleetProjects.js';

/**
 * The project selector. COMP-COCKPIT-PROJECTS-TAB-1: it sits at the left of the Projects sub-row (`brand={false}`), and its
 * popover lists the known projects (fleet lanes whose root has a `.compose`) above the path box. A row calls the same `onSwitch`.
 */
export default function ProjectSwitchPopover({ projectName, projectRoot, onSwitch, brand = true }) {
  const { roots } = useFleetRoots(!brand);
  const known = !brand && roots ? Object.entries(roots).filter(([, r]) => r?.root && r.hasCompose) : [];
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(projectRoot || '');
  const rootRef = useRef(null);

  useEffect(() => {
    setInputValue(projectRoot || '');
  }, [projectRoot]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  return (
    <div ref={rootRef} className="flex items-center shrink-0 gap-2 relative">
      {brand && (
        <span className="text-xs font-semibold tracking-widest uppercase text-blue-600 dark:text-accent">
          Compose
        </span>
      )}
      <button
        data-testid="project-btn"
        className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen(v => !v)}
        title={projectRoot || 'Switch project'}
        aria-label="Switch project"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {projectName || 'no project'}
      </button>
      {open && (
        <div
          data-testid="project-popover"
          role="dialog"
          aria-label="Switch project"
          className="absolute top-full left-0 mt-1 z-50 p-2 rounded-md shadow-lg max-[479px]:fixed max-[479px]:top-auto max-[479px]:left-2 max-[479px]:right-2 max-[479px]:mt-5"
          style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', minWidth: 'min(280px, calc(100vw - 16px))' }}
        >
          <div className="text-[10px] text-muted-foreground mb-1 px-1">
            Current: {projectRoot}
          </div>
          {known.length > 0 && (
            <ul className="mb-1" data-testid="project-list" aria-label="Known projects">
              {known.map(([lane, r]) => (
                <li key={lane}>
                  <button
                    type="button"
                    data-testid={`project-row-${lane}`}
                    aria-current={r.root === projectRoot ? 'true' : undefined}
                    title={r.root}
                    className={`w-full text-left px-2 py-1 text-xs rounded hover:bg-muted ${r.root === projectRoot ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
                    onClick={async () => { if (r.root === projectRoot || (await onSwitch?.(r.root))) setOpen(false); }}
                  >
                    {lane}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            autoFocus
            data-testid="project-input"
            className="w-full px-2 py-1 text-xs rounded border bg-background text-foreground"
            style={{ borderColor: 'hsl(var(--border))' }}
            placeholder="Absolute path to project..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                // Only close on successful switch — failed switches keep the
                // popover open so the user can correct the typed path.
                const ok = await onSwitch(inputValue);
                if (ok) setOpen(false);
              }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
