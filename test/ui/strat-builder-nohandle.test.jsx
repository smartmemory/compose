/**
 * COMP-STRAT-BUILDER-HANDLE-1: a builder build without `getDocument()` (an older @smartmemory/stratum-ui) is not saved from silently:
 * Save falls back to the last onChange export and logs one console.warn saying what may be missing.
 */
import React, { forwardRef, useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('@smartmemory/stratum-ui/builder', () => ({
  FlowBuilder: forwardRef(function OldBuilder({ onChange }, ref) { // eslint-disable-line no-unused-vars
    useEffect(() => { onChange({ version: 1, flows: { entry: 'main', main: { steps: [{ id: 'exported' }] } } }); }, [onChange]);
    return <div data-testid="old-builder" />;
  }),
  buildExport: (doc) => doc,
  parseImport: (doc) => doc,
  emptySpec: () => ({ version: 1, flows: { entry: 'main', main: { steps: [] } } }),
}));

describe('Save with a builder that has no getDocument()', () => {
  it('sends the last onChange export and warns once, naming what was lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { default: StratumBuilderPane } = await import('../../src/components/cockpit/StratumBuilderPane.jsx');
    const client = { saveSpec: vi.fn(async (name) => ({ ok: true, name, created: true })) };
    render(<StratumBuilderPane client={client} />);
    fireEvent.change(screen.getByTestId('builder-save-name'), { target: { value: 'old' } });
    await act(async () => { screen.getByTestId('builder-save').click(); });
    expect(client.saveSpec.mock.calls[0][1].flows.main.steps[0].id).toBe('exported');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no FlowBuilder getDocument\(\).*last 400 ms/);
  });
});
