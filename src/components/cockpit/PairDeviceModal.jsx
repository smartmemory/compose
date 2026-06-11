/**
 * PairDeviceModal — "Pair mobile device" modal for the cockpit.
 *
 * Props:
 *   open {boolean}      — whether the modal is visible
 *   onClose {Function}  — called to close the modal
 *   publicHost {string} — optional public tunnel URL (e.g. https://forge.example.com)
 *                         falls back to window.location.origin; shows a hint when absent
 *
 * Wiring note (devicePaired): visionMessageHandler.js dispatches a
 * `compose:devicePaired` CustomEvent when it receives a {type:'devicePaired'}
 * WS broadcast. This modal subscribes to that event to show success state and
 * refresh the device list. No new store field is needed — the modal manages
 * its own ephemeral pairing state.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Smartphone, Loader2, CheckCircle2, WifiOff, Trash2 } from 'lucide-react';
import { wsFetch } from '../../lib/wsFetch.js';
import { withComposeToken } from '../../lib/compose-api.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatRelative(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatCountdown(expiresAt) {
  if (!expiresAt) return '';
  const secs = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (secs <= 0) return 'expired';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── DeviceRow ────────────────────────────────────────────────────────────────

function DeviceRow({ device, idx, onRevoke }) {
  const [armed, setArmed] = useState(false);
  const disarmRef = useRef(null);

  const handleRevoke = useCallback(() => {
    if (!armed) {
      setArmed(true);
      disarmRef.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(disarmRef.current);
    setArmed(false);
    onRevoke(device.id);
  }, [armed, device.id, onRevoke]);

  useEffect(() => () => clearTimeout(disarmRef.current), []);

  return (
    <div
      className="flex items-center gap-3 py-2 px-3 rounded-lg bg-muted/30 border border-border"
      style={{ opacity: device.revoked ? 0.5 : 1 }}
    >
      <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground truncate">{device.name || 'Unknown device'}</span>
          {device.revoked && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive shrink-0">
              revoked
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          Paired {formatRelative(device.paired_at)}
          {device.last_seen && !device.revoked && ` · seen ${formatRelative(device.last_seen)}`}
        </div>
      </div>
      {!device.revoked && (
        <button
          data-testid={`pair-device-revoke-${idx}`}
          onClick={handleRevoke}
          className={`shrink-0 text-[10px] px-2 py-1 rounded transition-colors ${
            armed
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          }`}
          title={armed ? 'Click again to confirm revoke' : 'Revoke device'}
        >
          {armed ? (
            <span className="flex items-center gap-1"><Trash2 className="h-3 w-3" /> Confirm</span>
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  );
}

// ─── PairDeviceModal ──────────────────────────────────────────────────────────

export default function PairDeviceModal({ open, onClose, publicHost }) {
  const [initState, setInitState] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [pairCode, setPairCode] = useState(null);
  const [pairUrl, setPairUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState(null);
  const [countdown, setCountdown] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [pairedDevice, setPairedDevice] = useState(null); // success state
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const canvasRef = useRef(null);
  const countdownRef = useRef(null);

  // ── fetch device list ──────────────────────────────────────────────────────

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await wsFetch('/api/auth/devices', {
        headers: withComposeToken(),
      });
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
      }
    } catch {
      // non-fatal — device list is best-effort
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  // ── revoke ─────────────────────────────────────────────────────────────────

  const handleRevoke = useCallback(async (deviceId) => {
    try {
      const res = await wsFetch(`/api/auth/devices/${deviceId}`, {
        method: 'DELETE',
        headers: withComposeToken(),
      });
      if (res.ok) {
        await fetchDevices();
      }
    } catch {
      // tolerate
    }
  }, [fetchDevices]);

  // ── pair/init ──────────────────────────────────────────────────────────────

  const initPairing = useCallback(async () => {
    setInitState('loading');
    setErrorMsg('');
    setPairedDevice(null);
    setPairCode(null);
    setPairUrl('');
    setExpiresAt(null);
    setCountdown('');

    try {
      const res = await wsFetch('/api/auth/pair/init', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
      });

      if (res.status === 503) {
        setInitState('error');
        setErrorMsg(
          'COMPOSE_API_TOKEN is not set — the server cannot authenticate this request. ' +
          'Start compose via `compose start` so the supervisor generates the token, ' +
          'or set COMPOSE_API_TOKEN manually.',
        );
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInitState('error');
        setErrorMsg(body.error || `Server returned ${res.status}`);
        return;
      }

      const data = await res.json();
      const host = publicHost || (typeof window !== 'undefined' ? window.location.origin : '');
      const url = `${host}/m/pair?code=${data.code}`;

      setPairCode(data.code);
      setPairUrl(url);
      setExpiresAt(data.expires_at);
      setInitState('ready');
      // QR canvas render happens in the useEffect below (watches pairUrl + initState)
      // so canvasRef.current is guaranteed populated after the re-render.
    } catch (err) {
      setInitState('error');
      setErrorMsg(err.message || 'Network error');
    }
  }, [publicHost]);

  // ── open effect ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) {
      // Reset state on close
      setInitState('idle');
      setPairCode(null);
      setPairUrl('');
      setExpiresAt(null);
      setCountdown('');
      setErrorMsg('');
      setPairedDevice(null);
      clearInterval(countdownRef.current);
      return;
    }
    initPairing();
    fetchDevices();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── QR render (runs after canvas mounts on re-render to 'ready') ─────────

  useEffect(() => {
    if (initState !== 'ready' || !pairUrl || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        if (!cancelled && canvasRef.current) {
          await QRCode.toCanvas(canvasRef.current, pairUrl, {
            width: 200,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
        }
      } catch {
        // QR render failure is non-fatal; URL text is still present
      }
    })();
    return () => { cancelled = true; };
  }, [initState, pairUrl]);

  // ── countdown ticker ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!expiresAt) { clearInterval(countdownRef.current); return; }
    clearInterval(countdownRef.current);
    const tick = () => setCountdown(formatCountdown(expiresAt));
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => clearInterval(countdownRef.current);
  }, [expiresAt]);

  // ── devicePaired event ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    function handleDevicePaired(e) {
      const { name, device_id } = e.detail ?? {};
      setPairedDevice({ name: name || 'New device', id: device_id });
      clearInterval(countdownRef.current);
      setCountdown('');
      fetchDevices();
    }
    window.addEventListener('compose:devicePaired', handleDevicePaired);
    return () => window.removeEventListener('compose:devicePaired', handleDevicePaired);
  }, [open, fetchDevices]);

  // ─────────────────────────────────────────────────────────────────────────

  if (!open) return null;

  const noPublicHost = !publicHost;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Pair mobile device"
      data-testid="pair-device-modal"
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative w-full max-w-md max-h-[85vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl mx-4">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 p-4 pb-3 border-b border-border shrink-0">
          <Smartphone className="h-5 w-5 text-accent shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-foreground">Pair mobile device</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Scan the QR code on your phone to connect remotely
            </p>
          </div>
          <button
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-auto p-4 space-y-4">

          {/* Success banner */}
          {pairedDevice && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-success/10 border border-success/20">
              <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              <span className="text-xs text-success font-medium">
                Paired: {pairedDevice.name}
              </span>
            </div>
          )}

          {/* Loading */}
          {initState === 'loading' && (
            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">Generating pairing code…</span>
            </div>
          )}

          {/* Error */}
          {initState === 'error' && (
            <div
              data-testid="pair-device-error"
              className="px-3 py-3 rounded-lg bg-destructive/10 border border-destructive/20 space-y-2"
            >
              <div className="flex items-start gap-2">
                <WifiOff className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive leading-relaxed">{errorMsg}</p>
              </div>
              <button
                className="text-[10px] text-accent hover:underline"
                onClick={initPairing}
              >
                Retry
              </button>
            </div>
          )}

          {/* QR + URL */}
          {initState === 'ready' && (
            <div className="space-y-3">
              {/* Public host hint */}
              {noPublicHost && (
                <div className="text-[10px] text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
                  No public host configured — the URL below uses your local origin.
                  For remote pairing, configure a public host (e.g. via{' '}
                  <code className="font-mono">compose remote pair --public-host=&lt;URL&gt;</code>).
                </div>
              )}

              <div className="flex justify-center">
                <canvas
                  ref={canvasRef}
                  data-testid="pair-device-qr"
                  className="rounded border border-border bg-white"
                  width={200}
                  height={200}
                  aria-label="QR code for pairing"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Pairing URL
                </label>
                <input
                  data-testid="pair-device-url"
                  readOnly
                  value={pairUrl}
                  className="w-full text-[10px] font-mono bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none select-all cursor-text"
                  onFocus={e => e.target.select()}
                  aria-label="Pairing URL"
                />
              </div>

              {countdown && (
                <p className="text-[10px] text-center text-muted-foreground">
                  Expires in{' '}
                  <span className={countdown === 'expired' ? 'text-destructive font-semibold' : 'text-foreground font-mono'}>
                    {countdown}
                  </span>
                  {countdown !== 'expired' && (
                    <button
                      className="ml-2 text-accent hover:underline"
                      onClick={initPairing}
                    >
                      Refresh
                    </button>
                  )}
                  {countdown === 'expired' && (
                    <button
                      className="ml-2 text-accent hover:underline"
                      onClick={initPairing}
                    >
                      Generate new code
                    </button>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Device list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Paired devices
              </h3>
              {devicesLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            </div>

            <div data-testid="pair-device-list" className="space-y-1.5">
              {!devicesLoading && devices.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">
                  No paired devices yet
                </p>
              )}
              {devices.map((device, idx) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  idx={idx}
                  onRevoke={handleRevoke}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
