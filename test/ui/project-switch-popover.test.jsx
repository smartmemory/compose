/**
 * BUG-25: Project tooltip in upper-left doesn't dismiss on click-away
 *
 * Regression tests for the project switch popover dismissal behavior.
 * Tests the real component from src/, which is the same one App.jsx renders.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectSwitchPopover from '../../src/components/ProjectSwitchPopover.jsx';

function renderWithOutside(props = {}) {
  return render(
    <div>
      <div data-testid="outside-area" style={{ padding: 8 }}>
        rest of the app
      </div>
      <ProjectSwitchPopover
        projectName="my-project"
        projectRoot="/projects/foo"
        onSwitch={vi.fn()}
        {...props}
      />
    </div>
  );
}

function Wrapper({ projectName = 'my-project', projectRoot, onSwitch }) {
  return (
    <div>
      <div data-testid="outside-area" style={{ padding: 8 }}>
        rest of the app
      </div>
      <ProjectSwitchPopover
        projectName={projectName}
        projectRoot={projectRoot}
        onSwitch={onSwitch}
      />
    </div>
  );
}

describe('BUG-25: project switch popover dismissal', () => {
  it('opens when the project button is clicked (baseline)', () => {
    renderWithOutside();
    expect(screen.queryByTestId('project-popover')).toBeNull();

    fireEvent.click(screen.getByTestId('project-btn'));

    expect(screen.queryByTestId('project-popover')).not.toBeNull();
  });

  it('closes when a mousedown occurs outside the popover', () => {
    renderWithOutside();

    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.queryByTestId('project-popover')).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId('outside-area'));

    expect(screen.queryByTestId('project-popover')).toBeNull();
  });

  it('does not close when a mousedown occurs inside the popover', () => {
    renderWithOutside();

    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.queryByTestId('project-popover')).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId('project-input'));

    expect(screen.queryByTestId('project-popover')).not.toBeNull();
  });

  it('closes when Escape is pressed on the document', () => {
    renderWithOutside();

    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.queryByTestId('project-popover')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByTestId('project-popover')).toBeNull();
  });

  it('syncs the controlled input when projectRoot prop changes', () => {
    const { rerender } = render(<Wrapper projectRoot="/projects/foo" onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.getByTestId('project-input').value).toBe('/projects/foo');

    rerender(<Wrapper projectRoot="/projects/bar" onSwitch={vi.fn()} />);

    expect(screen.getByTestId('project-input').value).toBe('/projects/bar');
  });

  it('closes the popover after Enter when onSwitch reports success', async () => {
    const onSwitch = vi.fn().mockResolvedValue(true);
    render(<Wrapper projectRoot="/projects/foo" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByTestId('project-btn'));
    expect(screen.queryByTestId('project-popover')).not.toBeNull();

    fireEvent.keyDown(screen.getByTestId('project-input'), { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByTestId('project-popover')).toBeNull();
    });
  });

  it('keeps the popover open and preserves input when onSwitch reports failure', async () => {
    const onSwitch = vi.fn().mockResolvedValue(false);
    render(<Wrapper projectRoot="/projects/foo" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByTestId('project-btn'));

    const input = screen.getByTestId('project-input');
    fireEvent.change(input, { target: { value: '/bad/path' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // Let the async onSwitch resolve before asserting.
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('/bad/path'));

    expect(screen.queryByTestId('project-popover')).not.toBeNull();
    expect(screen.getByTestId('project-input').value).toBe('/bad/path');
  });

  it('calls onSwitch with the typed value when Enter is pressed', () => {
    const onSwitch = vi.fn();
    render(<Wrapper projectRoot="/projects/foo" onSwitch={onSwitch} />);
    fireEvent.click(screen.getByTestId('project-btn'));

    const input = screen.getByTestId('project-input');
    fireEvent.change(input, { target: { value: '/projects/elsewhere' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onSwitch).toHaveBeenCalledWith('/projects/elsewhere');
  });

  it('exposes aria attributes that reflect open state and dialog semantics', () => {
    renderWithOutside();
    const btn = screen.getByTestId('project-btn');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-label')).toBe('Switch project');

    fireEvent.click(btn);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const popover = screen.getByTestId('project-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Switch project');
  });
});
