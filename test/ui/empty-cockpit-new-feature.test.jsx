/**
 * COMP-AUDIT-8: on an empty cockpit the "Create your first feature" CTA opens the
 * New Feature scaffold dialog (POST /api/features/scaffold), not the generic item dialog.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
});

describe('empty cockpit CTA (COMP-AUDIT-8)', () => {
  it('opens the New Feature scaffold dialog, not the generic item dialog', async () => {
    const { default: App } = await import('../../src/App.jsx');
    render(<App />);
    const cta = (await screen.findAllByText('Create your first feature'))[0];
    fireEvent.click(cta);
    await waitFor(() => expect(screen.getByText('New Feature')).toBeTruthy());
    expect(screen.getByPlaceholderText(/COMP-FOO-1/i)).toBeTruthy();
  });
});
