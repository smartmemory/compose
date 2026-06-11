/**
 * PairPage — /m/pair?code=XXX (COMP-MOBILE-REMOTE S05).
 *
 * Two states:
 *   1. With ?code= → device-name form (prefilled from UA) → POST
 *      /api/auth/pair/complete → store tokens → paired mode → /m/agents.
 *   2. Without ?code= → codeless re-pair screen: instructions plus a
 *      paste-the-pairing-URL input (camera-less fallback). wsFetch redirects
 *      here on unrecoverable gate 401s. No API calls until a code is present.
 *
 * Uses raw fetch (NOT wsFetch) for the pair/complete exchange — this is the
 * bootstrap path, before any auth state exists.
 */

import React, { useCallback, useState } from 'react';
import {
  ACCESS_KEY, REFRESH_KEY, EXPIRY_KEY,
  setSensitiveToken,
} from '../../lib/compose-api.js';
import { setAuthMode } from '../../lib/wsFetch.js';
import { setRemoteMode } from '../../lib/wsUrl.js';

function parsePlatformFromUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Win/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

function parseBrowserFromUA(ua) {
  if (!ua) return 'Browser';
  if (/Edg/.test(ua)) return 'Edge';
  if (/CriOS|Chrome/.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox/.test(ua)) return 'Firefox';
  if (/Safari/.test(ua)) return 'Safari';
  return 'Browser';
}

function extractCodeFromUrl(input) {
  const idx = String(input).indexOf('?');
  if (idx === -1) return null;
  try {
    const params = new URLSearchParams(String(input).slice(idx + 1));
    return params.get('code') || null;
  } catch {
    return null;
  }
}

export default function PairPage() {
  const [code, setCode] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search || '');
      return params.get('code') || null;
    } catch {
      return null;
    }
  });
  const [deviceName, setDeviceName] = useState(() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return `${parsePlatformFromUA(ua)} (${parseBrowserFromUA(ua)})`;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pastedUrl, setPastedUrl] = useState('');

  const handlePastedUrl = useCallback((e) => {
    const val = e.target.value;
    setPastedUrl(val);
    const extracted = extractCodeFromUrl(val);
    if (extracted) {
      setCode(extracted);
      setError(null);
    }
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      // Raw fetch — bootstrap path, deliberately not wsFetch.
      const res = await fetch('/api/auth/pair/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, device_name: deviceName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error || `HTTP ${res.status}`;
        setError(`Pairing failed: ${msg}. On your desktop, run \`compose remote pair\` to generate a new code.`);
        return;
      }
      localStorage.setItem(ACCESS_KEY, data.access_token);
      localStorage.setItem(REFRESH_KEY, data.refresh_token);
      localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
      setSensitiveToken(data.access_token);
      setAuthMode('mobile-paired');
      setRemoteMode(true);
      window.location.href = '/m/agents';
    } catch (err) {
      setError(`Pairing failed: ${err.message}. On your desktop, run \`compose remote pair\` to generate a new code.`);
    } finally {
      setLoading(false);
    }
  }, [code, deviceName]);

  if (!code) {
    // Codeless re-pair screen — also the landing page for unrecoverable gate 401s.
    return (
      <div className="m-root" data-testid="mobile-pair-codeless-screen">
        <header className="m-header">
          <div className="m-header-title">Pair this device</div>
        </header>
        <main className="m-main m-pair-page">
          <p data-testid="mobile-pair-codeless-instructions" className="m-pair-instructions">
            This device is no longer paired (or pairing has expired). On your
            desktop, run <code>compose remote pair</code> or open Cockpit →
            Pair mobile, then scan the new QR code. If your camera is
            unavailable, paste the pairing URL below:
          </p>
          <div className="m-pair-field">
            <label htmlFor="m-pair-url-input" className="m-pair-label">Pairing URL</label>
            <input
              id="m-pair-url-input"
              data-testid="mobile-pair-url-input"
              className="m-pair-input"
              type="text"
              placeholder="https://your-host/m/pair?code=..."
              value={pastedUrl}
              onChange={handlePastedUrl}
              autoComplete="off"
            />
          </div>
          {error && (
            <p data-testid="mobile-pair-error" className="m-pair-error">{error}</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="m-root" data-testid="mobile-pair-code-screen">
      <header className="m-header">
        <div className="m-header-title">Complete pairing</div>
      </header>
      <main className="m-main m-pair-page">
        <p className="m-pair-instructions">
          Give this device a name so you can recognize it in the paired devices
          list.
        </p>
        <form onSubmit={handleSubmit} className="m-pair-form">
          <div className="m-pair-field">
            <label htmlFor="m-pair-device-name" className="m-pair-label">Device name</label>
            <input
              id="m-pair-device-name"
              data-testid="mobile-pair-device-name-input"
              className="m-pair-input"
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          {error && (
            <p data-testid="mobile-pair-error" className="m-pair-error">{error}</p>
          )}
          <button
            type="submit"
            data-testid="mobile-pair-submit-btn"
            className="m-pair-btn"
            disabled={loading || !deviceName.trim()}
          >
            {loading ? 'Pairing…' : 'Pair this device'}
          </button>
        </form>
      </main>
    </div>
  );
}
