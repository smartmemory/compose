import React, { useCallback, useEffect, useRef, useState } from 'react';

const MAX_ALERTS = 3;

/**
 * MobileAlertBar — full-width sticky alert strip for the mobile PWA.
 *
 * Listens for the same `compose:notify` CustomEvent contract as the desktop
 * NotificationBar: { message, level, ttl } where ttl=0 means sticky.
 *
 * Stacks up to 3 alerts (oldest dropped on overflow). Each alert:
 *   - Tap body → call optional onNavigate(level → tab) then dismiss
 *   - ✕ button → dismiss immediately
 *   - ttl > 0 → auto-dismiss after ttl ms
 *   - ttl = 0 / null / Infinity → sticky until explicitly dismissed
 *
 * @param {function} [onNavigate] — called with the relevant tab name when an alert is tapped
 */
export default function MobileAlertBar({ onNavigate }) {
  const [alerts, setAlerts] = useState([]);
  const timersRef = useRef(new Map()); // alertId → timerId
  const nextIdRef = useRef(0);

  const dismiss = useCallback((id) => {
    clearTimeout(timersRef.current.get(id));
    timersRef.current.delete(id);
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  useEffect(() => {
    function handleNotify(e) {
      const { message, level = 'info', ttl } = e.detail ?? {};
      if (!message) return;

      const id = ++nextIdRef.current;

      setAlerts(prev => {
        const next = [...prev, { id, message, level }];
        if (next.length > MAX_ALERTS) {
          // Drop oldest
          const dropped = next.shift();
          clearTimeout(timersRef.current.get(dropped.id));
          timersRef.current.delete(dropped.id);
        }
        return next;
      });

      // Schedule auto-dismiss if ttl is a positive finite number
      const ttlMs = typeof ttl === 'number' && ttl > 0 && isFinite(ttl) ? ttl : 0;
      if (ttlMs > 0) {
        const timer = setTimeout(() => {
          setAlerts(prev => prev.filter(a => a.id !== id));
          timersRef.current.delete(id);
        }, ttlMs);
        timersRef.current.set(id, timer);
      }
    }

    window.addEventListener('compose:notify', handleNotify);
    return () => {
      window.removeEventListener('compose:notify', handleNotify);
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  if (alerts.length === 0) return null;

  function levelToTab(level) {
    if (level === 'warn') return 'agents';
    if (level === 'error') return 'builds';
    return 'builds';
  }

  return (
    <div className="m-alert-bar" data-testid="mobile-alert-bar" aria-live="polite">
      {alerts.map(alert => (
        <div
          key={alert.id}
          className={`m-alert m-alert-${alert.level}`}
          data-testid={`mobile-alert-${alert.level}`}
          role="status"
          onClick={() => {
            onNavigate?.(levelToTab(alert.level));
            dismiss(alert.id);
          }}
        >
          <span className="m-alert-msg">{alert.message}</span>
          <button
            type="button"
            className="m-alert-dismiss"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(alert.id);
            }}
          >✕</button>
        </div>
      ))}
    </div>
  );
}
