import React, { useEffect, useRef, useState } from 'react';

export default function ProjectSwitchPopover({ projectName, projectRoot, onSwitch }) {
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
      <span className="text-xs font-semibold tracking-widest uppercase text-accent">
        Compose
      </span>
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
          className="absolute top-full left-0 mt-1 z-50 p-2 rounded-md shadow-lg"
          style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', minWidth: '280px' }}
        >
          <div className="text-[10px] text-muted-foreground mb-1 px-1">
            Current: {projectRoot}
          </div>
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
                await onSwitch(inputValue);
                setOpen(false);
              }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
