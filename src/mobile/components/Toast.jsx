import React, { useEffect } from 'react';

export default function Toast({ message, kind = 'error', durationMs = 3000, onDismiss }) {
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(() => onDismiss?.(), durationMs);
    return () => clearTimeout(t);
  }, [message, durationMs, onDismiss]);
  if (!message) return null;
  return (
    <div className="m-toast" role="status" data-kind={kind} data-testid="mobile-toast">
      {message}
    </div>
  );
}
