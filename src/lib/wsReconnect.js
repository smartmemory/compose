/**
 * wsReconnect.js — reusable WebSocket reconnect helper.
 *
 * Extracted from useVisionStore.js (M2 prep for COMP-MOBILE). Replaces the
 * fixed 2s reconnect delay with exponential backoff capped at maxBackoffMs
 * (default 30s). Single connection identity, idempotent close().
 *
 * Behavior parity for desktop: first reconnect attempt is ~1s (2^0 * 1000),
 * mirroring the previous ~2s feel. Subsequent attempts back off: 2s, 4s, 8s,
 * 16s, then capped at maxBackoffMs. The attempt counter resets to 0 on a
 * successful onopen so a long-stable session starts fresh after a future drop.
 */

export function createReconnectingWS({
  url,
  onMessage,
  onOpen,
  onClose,
  onError,
  maxBackoffMs = 30_000,
}) {
  let ws = null;
  let attempt = 0;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      // URL/protocol level failure — schedule retry rather than throw
      onError?.(err);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      onOpen?.(ws);
    };
    ws.onmessage = (ev) => onMessage?.(ev);
    ws.onclose = () => {
      onClose?.();
      scheduleReconnect();
    };
    ws.onerror = (err) => {
      onError?.(err);
      // Let onclose fire to drive reconnection.
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    const backoff = Math.min(maxBackoffMs, 1000 * Math.pow(2, attempt++));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
  }

  connect();

  return {
    get socket() { return ws; },
    isOpen() { return ws?.readyState === 1; },
    send(data) {
      if (ws?.readyState === 1) ws.send(data);
    },
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          // Drop reconnect handlers before close so we don't schedule a retry
          ws.onclose = null;
          ws.onerror = null;
          ws.close();
        } catch { /* ignore */ }
        ws = null;
      }
    },
  };
}
