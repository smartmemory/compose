/**
 * BUG-25: Project tooltip in upper-left doesn't dismiss on click-away
 *
 * Regression tests for the project switch popover dismissal behavior.
 * Tests the real component from src/, which is the same one App.jsx renders.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
