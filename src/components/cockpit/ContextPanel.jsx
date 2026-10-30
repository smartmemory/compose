/**
 * ContextPanel — collapsible right-side panel for contextual detail content.
 *
 * Width is view-dependent and resizable via drag handle.
 *
 * Props:
 *   isOpen      {boolean}  whether the panel is visible
 *   onToggle    {fn}       called when the user clicks the toggle
 *   widthPx     {number}   panel width in pixels (computed by App.jsx)
 *   onResizePx  {fn}       called with new pixel width when user drags
 *   children    {node}     content to render inside the panel
 */
import React, { useCallback, useRef } from 'react';

const MIN_WIDTH = 280;
const MAX_WIDTH_FRACTION = 0.6;

export default function ContextPanel({
  isOpen = false,
  onToggle,
  widthPx = 380,
  onResizePx,
  children,
}) {
  const dragging = useRef(false);

  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;

    const onMove = (ev) => {
      if (!dragging.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      const max = window.innerWidth * MAX_WIDTH_FRACTION;
      const clamped = Math.max(MIN_WIDTH, Math.min(max, newWidth));
      onResizePx?.(clamped);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onResizePx]);

  return (
    <div
      className="flex shrink-0 h-full"
      style={{ borderLeft: '1px solid hsl(var(--border))' }}
      data-context-panel-open={isOpen}
    >
      {/* Drag handle */}
      {isOpen && onResizePx && (
        <div
          className="w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors flex-shrink-0"
          onMouseDown={handleDragStart}
        />
      )}

      {/* Toggle tab */}
      <button
        className={[
          'w-4 h-full flex items-center justify-center',
          'text-[10px] text-muted-foreground hover:text-foreground',
          'transition-colors select-none',
        ].join(' ')}
        onClick={onToggle}
        title={isOpen ? 'Close context panel' : 'Open context panel'}
        aria-expanded={isOpen}
        aria-label="Toggle context panel"
        style={{ background: 'hsl(var(--muted) / 0.3)' }}
      >
        {isOpen ? '›' : '‹'}
      </button>

      {/* Panel body */}
      {isOpen && (
        <div
          className="flex flex-col h-full overflow-hidden"
          style={{ width: `${widthPx}px` }}
        >
          {React.Children.toArray(children).length > 0 ? (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {children}
            </div>
          ) : (
            <EmptyHint />
          )}
        </div>
      )}
    </div>
  );
}

// COMP-AUDIT-18: with nothing selected the panel says so in one line. The
// project-wide build and gate status lives in the ops strip and Home.
function EmptyHint() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-4" data-testid="context-empty-hint">
      <p className="text-[11px] text-muted-foreground italic text-center">Select an item to see it here</p>
    </div>
  );
}
