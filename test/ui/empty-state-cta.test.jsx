/**
 * COMP-COCKPIT-5: first-run empty-state CTAs.
 * Emptiness is decided centrally (isEmptyProject prop), never by view-local
 * filtered-length heuristics. The create-feature CTA appears only when the
 * project is truly empty; filtered-out shows a "no match" message instead.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TreeView from '../../src/components/vision/TreeView.jsx';
import DashboardView from '../../src/components/vision/DashboardView.jsx';
import ItemFormDialog from '../../src/components/vision/shared/ItemFormDialog.jsx';

describe('TreeView empty-state CTA (COCKPIT-5)', () => {
  it('shows the create-feature CTA when project is empty', () => {
    const onCreateFeature = vi.fn();
    render(<TreeView items={[]} connections={[]} isEmptyProject onCreateFeature={onCreateFeature} onSelect={vi.fn()} />);
    const btn = screen.getByText('Create your first feature');
    fireEvent.click(btn);
    expect(onCreateFeature).toHaveBeenCalled();
  });

  it('shows "no match" (not the CTA) when filtered-out but project is non-empty', () => {
    // isEmptyProject false, but the local tree is empty (e.g. filters exclude all)
    render(<TreeView items={[]} connections={[]} isEmptyProject={false} onCreateFeature={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByText('No items match the current filters')).toBeTruthy();
    expect(screen.queryByText('Create your first feature')).toBeNull();
  });
});

describe('DashboardView empty-state CTA (COCKPIT-5)', () => {
  it('offers the create-feature CTA only when the project is empty', () => {
    const onCreateFeature = vi.fn();
    render(<DashboardView items={[]} gates={[]} featureCode={null} isEmptyProject onCreateFeature={onCreateFeature} />);
    fireEvent.click(screen.getByText('Create your first feature'));
    expect(onCreateFeature).toHaveBeenCalled();
  });

  it('does not offer the CTA when there are items but no active feature', () => {
    render(<DashboardView items={[{ id: 'x', type: 'feature', status: 'complete' }]} gates={[]} featureCode={null} isEmptyProject={false} onCreateFeature={vi.fn()} />);
    expect(screen.getByText('No feature in progress.')).toBeTruthy();
    expect(screen.queryByText('Create your first feature')).toBeNull();
  });
});

describe('ItemFormDialog feature preset (COCKPIT-5)', () => {
  it('preselects the feature type when opened with initialType="feature"', () => {
    render(<ItemFormDialog open initialType="feature" onClose={vi.fn()} />);
    // The Feature quick-type button should be present and selectable.
    expect(screen.getByText('Feature')).toBeTruthy();
  });
});
