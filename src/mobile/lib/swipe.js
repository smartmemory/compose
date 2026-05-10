/**
 * useSwipe — pointer-event-based swipe detection.
 *
 * Subscribes to the element via native pointer events; reports horizontal drag
 * deltas to the caller while the pointer is down, and fires onSwipeLeft /
 * onSwipeRight when the pointer is released past the threshold.
 *
 * Pure React. No external dependencies.
 */

import { useEffect, useRef } from 'react';

export function useSwipe(elementRef, options = {}) {
  const {
    onSwipeLeft,
    onSwipeRight,
    onDrag,        // (dx) => void  — called continuously while dragging
    onDragEnd,     // (dx, fired)   — called once on release
    threshold = 80,
    axis = 'x',
  } = options;

  // Stable refs so the effect doesn't re-attach when the consumer reidentifies
  // its callback functions on every render.
  const cbRef = useRef({ onSwipeLeft, onSwipeRight, onDrag, onDragEnd });
  cbRef.current = { onSwipeLeft, onSwipeRight, onDrag, onDragEnd };

  useEffect(() => {
    const el = elementRef && elementRef.current;
    if (!el) return undefined;

    let startX = 0;
    let startY = 0;
    let activeId = null;
    let active = false;
    let lastDx = 0;

    function onDown(ev) {
      // Primary pointer only
      if (ev.button !== undefined && ev.button !== 0) return;
      activeId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      active = true;
      lastDx = 0;
      try { el.setPointerCapture(ev.pointerId); } catch { /* */ }
    }

    function onMove(ev) {
      if (!active || ev.pointerId !== activeId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // If vertical drag dominates, abandon horizontal swipe
      if (axis === 'x' && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        active = false;
        cbRef.current.onDragEnd?.(0, false);
        return;
      }
      lastDx = dx;
      cbRef.current.onDrag?.(dx);
    }

    function finish(ev) {
      if (!active || (ev && ev.pointerId !== activeId)) return;
      const dx = lastDx;
      active = false;
      try { el.releasePointerCapture(activeId); } catch { /* */ }
      activeId = null;
      let fired = false;
      if (dx <= -threshold) {
        cbRef.current.onSwipeLeft?.();
        fired = true;
      } else if (dx >= threshold) {
        cbRef.current.onSwipeRight?.();
        fired = true;
      }
      cbRef.current.onDragEnd?.(dx, fired);
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
    };
  }, [elementRef, threshold, axis]);
}
