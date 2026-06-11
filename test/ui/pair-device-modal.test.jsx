/**
 * COMP-MOBILE-REMOTE S04: PairDeviceModal tests.
 *
 * Tests: renders + pair/init called with token on open; QR canvas present;
 * URL shown; devices listed; revoke two-step fires DELETE with token;
 * devicePaired CustomEvent refreshes list + shows success state;
 * 503 from init shows instructive error; closed modal renders nothing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setSensitiveToken } from '../../src/lib/compose-api.js';

// ─── Mock qrcode ──────────────────────────────────────────────────────────────
// The component does `await import('qrcode')` dynamically inside an async
// handler. We mock the module and import it here so vi.mocked() gives us a
// reference to the same spy the component will call.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(async () => {}) },
}));

// ─── Mock wsFetch ─────────────────────────────────────────────────────────────
vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';

// import AFTER mocks
import PairDeviceModal from '../../src/components/cockpit/PairDeviceModal.jsx';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const INIT_OK = {
  code: 'ABCDEF123',
  pair_url: 'http://example.com/m/pair?code=ABCDEF123',
  expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

const DEVICES_OK = {
  devices: [
    { id: 'dev_1', name: 'iPhone 15', paired_at: new Date(Date.now() - 60_000).toISOString(), last_seen: null, revoked: false },
    { id: 'dev_2', name: 'Pixel 8', paired_at: new Date(Date.now() - 3600_000).toISOString(), last_seen: new Date(Date.now() - 600_000).toISOString(), revoked: true },
  ],
};

function makeWsFetch({ initResponse = { ok: true, status: 200, json: async () => INIT_OK }, devicesResponse = { ok: true, status: 200, json: async () => DEVICES_OK } } = {}) {
  wsFetch.mockImplementation(async (url, opts) => {
    if (url === '/api/auth/pair/init') return initResponse;
    if (url === '/api/auth/devices') return devicesResponse;
    if (url.startsWith('/api/auth/devices/')) return { ok: true, status: 204, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  setSensitiveToken('test-token');
  vi.clearAllMocks();
});

afterEach(() => {
  setSensitiveToken(null);
  vi.restoreAllMocks();
});

// ─── closed modal ─────────────────────────────────────────────────────────────

describe('PairDeviceModal — closed', () => {
  it('renders nothing and makes no fetch calls when open=false', () => {
    makeWsFetch();
    render(<PairDeviceModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('pair-device-modal')).toBeNull();
    expect(wsFetch).not.toHaveBeenCalled();
  });
});

// ─── open: pair/init ──────────────────────────────────────────────────────────

describe('PairDeviceModal — open', () => {
  it('calls pair/init with x-compose-token header on open', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} />);
    await waitFor(() => expect(wsFetch).toHaveBeenCalledWith(
      '/api/auth/pair/init',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-compose-token': 'test-token' }),
      }),
    ));
  });

  it('renders the QR canvas after successful init', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('pair-device-qr')).toBeTruthy());
  });

  it('renders the pair URL as selectable text', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} publicHost="http://example.com" />);
    await waitFor(() => {
      const urlInput = screen.getByTestId('pair-device-url');
      expect(urlInput).toBeTruthy();
      expect(urlInput.value).toContain('ABCDEF123');
    });
  });

  it('renders the device list from GET /api/auth/devices', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} />);
    await waitFor(() => {
      const list = screen.getByTestId('pair-device-list');
      expect(list).toBeTruthy();
      expect(list.textContent).toContain('iPhone 15');
      expect(list.textContent).toContain('Pixel 8');
    });
  });

  it('shows revoked badge for revoked devices', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('revoked').length).toBeGreaterThan(0));
  });
});

// ─── 503 error ────────────────────────────────────────────────────────────────

describe('PairDeviceModal — 503 from pair/init', () => {
  it('shows the instructive COMPOSE_API_TOKEN error message', async () => {
    makeWsFetch({
      initResponse: { ok: false, status: 503, json: async () => ({ error: 'token unset' }) },
    });
    render(<PairDeviceModal open onClose={vi.fn()} />);
    await waitFor(() => {
      const errEl = screen.getByTestId('pair-device-error');
      expect(errEl.textContent).toContain('COMPOSE_API_TOKEN');
    });
  });
});

// ─── revoke two-step ──────────────────────────────────────────────────────────

describe('PairDeviceModal — revoke two-step', () => {
  it('arms on first click, fires DELETE with token on second click', async () => {
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} />);

    // wait for device list to appear
    await waitFor(() => screen.getByTestId('pair-device-revoke-0'));

    const revokeBtn = screen.getByTestId('pair-device-revoke-0');

    // First click → arms (shows Confirm)
    fireEvent.click(revokeBtn);
    await waitFor(() => expect(screen.getByTestId('pair-device-revoke-0').textContent).toContain('Confirm'));

    // Second click → fires DELETE
    fireEvent.click(screen.getByTestId('pair-device-revoke-0'));
    await waitFor(() => {
      const deleteCalls = wsFetch.mock.calls.filter(
        ([url, opts]) => url.startsWith('/api/auth/devices/') && opts?.method === 'DELETE',
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      const [, opts] = deleteCalls[0];
      expect(opts.headers).toMatchObject({ 'x-compose-token': 'test-token' });
    });
  });
});

// ─── devicePaired event ───────────────────────────────────────────────────────

describe('PairDeviceModal — devicePaired event', () => {
  it('shows success state and refreshes device list on compose:devicePaired', async () => {
    // Second devices call returns an updated list
    let devicesCallCount = 0;
    wsFetch.mockImplementation(async (url) => {
      if (url === '/api/auth/pair/init') return { ok: true, status: 200, json: async () => INIT_OK };
      if (url === '/api/auth/devices') {
        devicesCallCount += 1;
        if (devicesCallCount === 1) return { ok: true, status: 200, json: async () => ({ devices: [] }) };
        return {
          ok: true, status: 200,
          json: async () => ({
            devices: [{ id: 'dev_new', name: 'My Phone', paired_at: new Date().toISOString(), last_seen: null, revoked: false }],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(<PairDeviceModal open onClose={vi.fn()} />);

    // wait for initial render
    await waitFor(() => screen.getByTestId('pair-device-list'));

    // Fire devicePaired CustomEvent
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('compose:devicePaired', {
          detail: { device_id: 'dev_new', name: 'My Phone', timestamp: new Date().toISOString() },
        }),
      );
    });

    // Success state visible
    await waitFor(() => {
      expect(screen.getByText(/Paired: My Phone/i)).toBeTruthy();
    });

    // Device list refreshed
    await waitFor(() => {
      const list = screen.getByTestId('pair-device-list');
      expect(list.textContent).toContain('My Phone');
    });
  });
});

// ─── QR mock was called ───────────────────────────────────────────────────────
// The component does `await import('qrcode')` dynamically. We import the mocked
// module here to get a reference to the same spy instance.

describe('PairDeviceModal — qrcode.toCanvas called', () => {
  it('calls qrcode.toCanvas with a canvas element and the pair URL', async () => {
    const QRCode = (await import('qrcode')).default;
    QRCode.toCanvas.mockClear();
    makeWsFetch();
    render(<PairDeviceModal open onClose={vi.fn()} publicHost="http://example.com" />);
    await waitFor(() => expect(QRCode.toCanvas).toHaveBeenCalledWith(
      expect.any(Object), // canvas element
      expect.stringContaining('ABCDEF123'),
      expect.any(Object),
    ));
  });
});
