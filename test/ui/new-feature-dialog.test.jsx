/**
 * new-feature-dialog.test.jsx — NewFeatureDialog (COMP-PARITY-9).
 *
 * - Submit golden: fill code + description, click Create → wsFetch called once
 *   with the relative scaffold URL, POST, body carrying the upper-cased code +
 *   description; success state renders the created code.
 * - Client validation: an invalid code blocks the request (wsFetch not called).
 * - Server error: a non-ok response surfaces the error, no success state.
 * - No hardcoded host: the called URL is relative (no localhost/:4001).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn() }));
import { wsFetch } from '../../src/lib/wsFetch.js';
import NewFeatureDialog from '../../src/components/vision/NewFeatureDialog.jsx';

const renderDialog = (props = {}) =>
  render(<NewFeatureDialog open onClose={vi.fn()} onCreated={vi.fn()} {...props} />);

function fill(code, description) {
  // Inputs are unlabeled-by-control here; target by placeholder.
  fireEvent.change(screen.getByPlaceholderText(/COMP-FOO-1/i), { target: { value: code } });
  if (description !== undefined) {
    fireEvent.change(screen.getByPlaceholderText(/ROADMAP cell/i), { target: { value: description } });
  }
}

describe('NewFeatureDialog (COMP-PARITY-9)', () => {
  beforeEach(() => wsFetch.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('submits via a relative URL with the upper-cased code + description, shows success', async () => {
    wsFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, code: 'COMP-FOO-1', featurePath: 'docs/features/COMP-FOO-1' }),
    });
    renderDialog();
    fill('comp-foo-1', 'Do the thing');
    fireEvent.click(screen.getByRole('button', { name: /Create Feature/i }));

    await waitFor(() => expect(wsFetch).toHaveBeenCalledTimes(1));
    const [url, opts] = wsFetch.mock.calls[0];
    expect(url).toBe('/api/features/scaffold');
    expect(url).not.toMatch(/localhost|127\.0\.0\.1|:4001/);
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.code).toBe('COMP-FOO-1');
    expect(body.description).toBe('Do the thing');

    await waitFor(() => expect(screen.getByText(/Created!/i)).toBeTruthy());
    expect(screen.getByText('COMP-FOO-1')).toBeTruthy();
  });

  it('blocks an invalid code client-side without calling wsFetch', async () => {
    renderDialog();
    // Trailing hyphen fails CODE_RE even after upper-casing ('FOO' alone would
    // be a valid code), so this exercises the client-side block, not the server.
    fill('foo-', 'whatever');
    fireEvent.click(screen.getByRole('button', { name: /Create Feature/i }));

    await waitFor(() => expect(screen.getByText(/Use a code like/i)).toBeTruthy());
    expect(wsFetch).not.toHaveBeenCalled();
  });

  it('surfaces a server error and shows no success state', async () => {
    wsFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'feature-writer: feature "COMP-FOO-1" already exists' }),
    });
    renderDialog();
    fill('COMP-FOO-1', 'dup');
    fireEvent.click(screen.getByRole('button', { name: /Create Feature/i }));

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
    expect(screen.queryByText(/Created!/i)).toBeNull();
  });
});
