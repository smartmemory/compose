import { describe, it, expect, afterEach, vi } from 'vitest';
import { agentServerUrl } from '../../src/lib/agentServer.js';

describe('agentServerUrl', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it('routes agent calls through the workspace-aware same-origin proxy', () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'staging.example.com' });
    expect(agentServerUrl('/api/agent/message')).toBe('/api/agent/proxy/message');
    expect(agentServerUrl('/api/agent/stream')).toBe('/api/agent/proxy/stream');
  });
  it('routes session creation through workspace selection', () => {
    expect(agentServerUrl('/api/agent/session')).toBe('/api/agent/proxy/session');
  });
  it('does not rewrite unrelated or already proxied endpoints', () => {
    expect(agentServerUrl('/api/agent/proxy/session')).toBe('/api/agent/proxy/session');
    expect(agentServerUrl('/other')).toBe('/other');
  });
});
