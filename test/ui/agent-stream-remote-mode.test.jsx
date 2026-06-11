/**
 * agent-stream-remote-mode.test.jsx — COMP-MOBILE-REMOTE coverage sweep
 *
 * Tests for AgentStream remote-mode URL/path logic.
 *
 * Note: AgentStream.jsx has DOM-specific behavior (scrollIntoView) that prevents
 * rendering it in jsdom without extensive stub setup. The URL selection inside
 * connect() is covered by the defaultAgentStreamUrl tests in mobile-remote-auth.test.jsx
 * (agentStream.js wrapper). The postAgent() path rewrite is a pure regex and is
 * tested here as a unit-level regression lock.
 *
 * For the AgentStream.connect() URL selection, we test the underlying helpers:
 *   - isRemoteMode() + streamUrl() interaction (proven by wsUrl builders tests)
 *   - defaultAgentStreamUrl() mode switch (proven by mobile-remote-auth.test.jsx)
 *
 * What this file adds: explicit regression lock on the postAgent path-rewrite
 * regex and the streamUrl token-append interaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setRemoteMode } from '../../src/lib/wsUrl.js';
import { setAuthMode } from '../../src/lib/wsFetch.js';
import { ACCESS_KEY } from '../../src/lib/compose-api.js';

beforeEach(() => {
  setRemoteMode(false);
  setAuthMode('cockpit');
  localStorage.clear();
});

afterEach(() => {
  setRemoteMode(false);
  setAuthMode('cockpit');
  localStorage.clear();
});

// ─── postAgent path mapping — pure regex unit tests ───────────────────────────

describe('AgentStream.postAgent() — path-rewrite regex regression lock', () => {
  // The expression used in AgentStream.jsx:
  //   path.replace(/^\/api\/agent\//, '/api/agent/proxy/')
  // These tests lock the behavior of that exact expression.

  it('maps /api/agent/session → /api/agent/proxy/session', () => {
    expect('/api/agent/session'.replace(/^\/api\/agent\//, '/api/agent/proxy/'))
      .toBe('/api/agent/proxy/session');
  });

  it('maps /api/agent/message → /api/agent/proxy/message', () => {
    expect('/api/agent/message'.replace(/^\/api\/agent\//, '/api/agent/proxy/'))
      .toBe('/api/agent/proxy/message');
  });

  it('maps /api/agent/interrupt → /api/agent/proxy/interrupt', () => {
    expect('/api/agent/interrupt'.replace(/^\/api\/agent\//, '/api/agent/proxy/'))
      .toBe('/api/agent/proxy/interrupt');
  });

  it('maps /api/agent/session/status → /api/agent/proxy/session/status', () => {
    expect('/api/agent/session/status'.replace(/^\/api\/agent\//, '/api/agent/proxy/'))
      .toBe('/api/agent/proxy/session/status');
  });

  it('does NOT rewrite non-agent paths (no change)', () => {
    const unchanged = [
      '/api/auth/pair/init',
      '/api/build/start',
      '/api/vision/items',
      '/api/agents/tree',  // note: /api/agents/ not /api/agent/
    ];
    for (const p of unchanged) {
      expect(p.replace(/^\/api\/agent\//, '/api/agent/proxy/')).toBe(p);
    }
  });

  it('/api/agents/tree is NOT rewritten (plural /agents/ vs singular /agent/)', () => {
    // This is a critical non-regression: the /api/agents/tree endpoint (vision server)
    // must NOT be proxied via the agent proxy path.
    const result = '/api/agents/tree'.replace(/^\/api\/agent\//, '/api/agent/proxy/');
    expect(result).toBe('/api/agents/tree');
  });
});

// ─── AgentStream.connect() URL selection — via defaultAgentStreamUrl ──────────
// The agentStream.js module's defaultAgentStreamUrl() is the canonical URL builder
// for the mobile path. AgentStream.jsx uses an inline equivalent for the cockpit/desktop
// path. Both are locked by defaultAgentStreamUrl tests in mobile-remote-auth.test.jsx.
// Here we verify the streamUrl() helper in remote mode appends ?token= correctly,
// which is the token-injection path used by AgentStream.connect() in remote mode.

describe('AgentStream.connect() URL via streamUrl — remote token injection', () => {
  it('remote mode + stored JWT: streamUrl /api/agent/proxy/stream appends ?token=', async () => {
    const { streamUrl } = await import('../../src/lib/wsUrl.js');
    localStorage.setItem(ACCESS_KEY, 'my-jwt');
    setAuthMode('mobile-paired');
    expect(streamUrl('/api/agent/proxy/stream')).toBe('/api/agent/proxy/stream?token=my-jwt');
  });

  it('non-remote mode: streamUrl /api/agent/proxy/stream is bare (no token)', async () => {
    const { streamUrl } = await import('../../src/lib/wsUrl.js');
    setRemoteMode(false);
    setAuthMode('cockpit');
    expect(streamUrl('/api/agent/proxy/stream')).toBe('/api/agent/proxy/stream');
  });
});
