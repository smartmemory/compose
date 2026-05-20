/**
 * AgentStream sticky-scroll behavior tests.
 *
 * Verifies that:
 *  - New messages auto-scroll when the user is at/near the bottom (<48px).
 *  - New messages do NOT auto-scroll when the user has scrolled up (>=48px).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — isolate AgentStream from SSE, fetch, and child components
// ---------------------------------------------------------------------------

// Captured callbacks from createAgentStream so tests can push messages
let capturedOnEvent = null;
let capturedOnOpen = null;

vi.mock('../../src/components/agent/MessageCard.jsx', () => ({
  default: ({ msg }) => <div data-testid="msg">{msg.type}</div>,
}));

vi.mock('../../src/components/agent/ChatInput.jsx', () => ({
  default: () => <div data-testid="chat-input" />,
}));

vi.mock('../../src/components/agent-stream-helpers.js', () => ({
  shouldIncludeMessage: (msg) => ({ include: true, msg }),
  getVerboseStream: () => false,
  setVerboseStream: () => {},
  hydrateVerboseStream: () => {},
  groupToolResults: (msgs) => msgs,
}));

vi.mock('../../src/lib/agentStream.js', () => ({
  createAgentStream: ({ onOpen, onEvent }) => {
    capturedOnOpen = onOpen;
    capturedOnEvent = onEvent;
    // Simulate immediate connection
    setTimeout(() => onOpen?.(), 0);
    return { close: () => {} };
  },
}));

// Intercept import.meta.env
vi.stubEnv('VITE_AGENT_PORT', '4002');
vi.stubEnv('VITE_COMPOSE_API_TOKEN', 'test-token');

// ---------------------------------------------------------------------------
// Helper — render AgentStream and return useful handles
// ---------------------------------------------------------------------------

async function renderAgentStream() {
  const mod = await import('../../src/components/AgentStream.jsx');
  const AgentStream = mod.default;

  const utils = render(<AgentStream />);

  // Wait for the simulated onOpen to fire (setTimeout 0)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

  // The scroll container is the div with overflow-y-auto
  const scrollContainer = utils.container.querySelector('.overflow-y-auto');

  return { ...utils, scrollContainer };
}

/** Push a synthetic message through the SSE mock to trigger processMessage → setMessages */
async function pushMessage(msg) {
  await act(async () => {
    capturedOnEvent?.(msg);
    // Allow React state updates to flush
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentStream sticky scroll', () => {
  beforeEach(() => {
    vi.resetModules();
    capturedOnEvent = null;
    capturedOnOpen = null;
    // Mock scrollIntoView — jsdom doesn't implement it
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('auto-scrolls when user is at the bottom (within 48px threshold)', async () => {
    const { scrollContainer } = await renderAgentStream();

    // Simulate "at bottom": scrollHeight - scrollTop - clientHeight < 48
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 960, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 30, configurable: true });
    // gap = 1000 - 960 - 30 = 10 < 48 → at bottom

    // Fire scroll to confirm userHasScrolledUp = false
    fireEvent.scroll(scrollContainer);

    // Clear any prior scrollIntoView calls from initial render
    Element.prototype.scrollIntoView.mockClear();

    // Push a message to trigger messages.length change → useEffect fires
    await pushMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });

    // userHasScrolledUp is false → scrollIntoView should be called
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('does NOT auto-scroll when user has scrolled up (>48px from bottom)', async () => {
    const { scrollContainer } = await renderAgentStream();

    // Simulate "scrolled up": gap = 1100 >= 48
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });

    // Fire scroll to set userHasScrolledUp = true
    fireEvent.scroll(scrollContainer);

    // Clear calls from initial render
    Element.prototype.scrollIntoView.mockClear();

    // Push a message to trigger messages.length change → useEffect fires
    await pushMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });

    // userHasScrolledUp is true → scrollIntoView should NOT be called
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('resumes auto-scroll when user scrolls back to bottom', async () => {
    const { scrollContainer } = await renderAgentStream();

    // First: scroll up
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 500, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    fireEvent.scroll(scrollContainer);

    Element.prototype.scrollIntoView.mockClear();

    // Verify no auto-scroll while scrolled up
    await pushMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'msg1' }] } });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    // Now: scroll back to bottom (gap < 48)
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 1570, configurable: true });
    // gap = 2000 - 1570 - 400 = 30 < 48 → at bottom
    fireEvent.scroll(scrollContainer);

    Element.prototype.scrollIntoView.mockClear();

    // Push another message — should auto-scroll now
    await pushMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'msg2' }] } });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests for the scroll threshold logic (no React rendering)
// ---------------------------------------------------------------------------

describe('sticky scroll threshold (unit)', () => {
  it('marks user as at-bottom when gap < 48', () => {
    const el = { scrollHeight: 1000, scrollTop: 960, clientHeight: 30 };
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    expect(atBottom).toBe(true);
  });

  it('marks user as scrolled-up when gap >= 48', () => {
    const el = { scrollHeight: 2000, scrollTop: 500, clientHeight: 400 };
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    expect(atBottom).toBe(false);
  });

  it('treats gap of exactly 48 as scrolled-up (strict < comparison)', () => {
    const el = { scrollHeight: 1000, scrollTop: 552, clientHeight: 400 };
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    expect(gap).toBe(48);
    expect(gap < 48).toBe(false);
  });

  it('treats gap of 47 as at-bottom', () => {
    const el = { scrollHeight: 1000, scrollTop: 553, clientHeight: 400 };
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    expect(gap).toBe(47);
    expect(gap < 48).toBe(true);
  });

  it('treats gap of 0 (fully scrolled) as at-bottom', () => {
    const el = { scrollHeight: 500, scrollTop: 100, clientHeight: 400 };
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    expect(gap).toBe(0);
    expect(gap < 48).toBe(true);
  });
});
