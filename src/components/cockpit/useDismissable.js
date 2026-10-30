import { useEffect } from 'react';

/** Close a popover on outside mousedown or Escape (the EnvironmentHealthPanel pattern). */
export default function useDismissable(open, rootRef, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, rootRef, onClose]);
}
