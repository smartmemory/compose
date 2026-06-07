/**
 * COMP-COCKPIT-2: agentServerUrl — hostname-portable agent-server URL builder.
 * Replaces hardcoded http://localhost:4002 in ChallengeModal so the pressure-test
 * feature works on any non-localhost deploy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { agentServerUrl } from '../../src/lib/agentServer.js';

describe('agentServerUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds protocol//hostname:port/path from window.location (default port 4002)', () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'staging.example.com' });
    expect(agentServerUrl('/api/terminal/inject')).toBe(
      'https://staging.example.com:4002/api/terminal/inject',
    );
  });

  it('does NOT hardcode localhost — uses the page hostname', () => {
    vi.stubGlobal('location', { protocol: 'http:', hostname: '10.0.0.42' });
    expect(agentServerUrl('/api/agent/stream')).toBe('http://10.0.0.42:4002/api/agent/stream');
  });

  it('honors VITE_AGENT_PORT when set', () => {
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost' });
    vi.stubEnv('VITE_AGENT_PORT', '5005');
    expect(agentServerUrl('/x')).toBe('http://localhost:5005/x');
  });
});
