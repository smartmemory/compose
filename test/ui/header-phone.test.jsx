/**
 * COMP-COCKPIT-PHONE-HEADER-1: the shell header controls fold into one ⋯ menu on a phone. jsdom has no layout, so this pins
 * the structure (which branch renders, what each item opens, that the panel and its popovers cannot leave the viewport);
 * the pixel claims (page overflow 0, no overlaps) are measured live in the unit report.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../../src/lib/startBuild.js', () => ({ startBuild: vi.fn(async () => new Response('{}', { status: 200 })) }));
vi.mock('../../src/lib/wsFetch.js', () => ({ wsFetch: vi.fn(async () => new Response('{}', { status: 200 })) }));
vi.mock('../../src/contexts/WorkspaceContext.jsx', () => ({ useWorkspace: () => ({ loading: true, workspace: null }) }));

import { DialogProvider } from '../../src/components/ui/DialogProvider.jsx';
import { HeaderControls } from '../../src/components/cockpit/HeaderOverflowMenu.jsx';

const setWidth = (w) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
const display = { isDark: true, onToggleTheme: vi.fn(), fontSize: 13, minFontSize: 10, maxFontSize: 20, defaultFontSize: 13, onChangeFont: vi.fn(), onResetFont: vi.fn(), onPairDevice: vi.fn() };

function Harness({ connected = true, onNewFeature = vi.fn(), onNewItem = vi.fn() }) {
  const [launchOpen, setLaunchOpen] = React.useState(false);
  return (
    <DialogProvider>
      <HeaderControls connected={connected} activeBuild={null} launchOpen={launchOpen} onLaunchOpenChange={setLaunchOpen}
        onNewFeature={onNewFeature} onNewItem={onNewItem} display={display} />
    </DialogProvider>
  );
}

afterEach(() => { cleanup(); setWidth(1024); });

// width, overflow button?, inline cluster?, run label?
const LAYOUTS = [
  { width: 390, overflow: true, inline: false, runLabel: false },
  { width: 360, overflow: true, inline: false, runLabel: false },
  { width: 767, overflow: true, inline: false, runLabel: false },
  { width: 1024, overflow: false, inline: true, runLabel: true },
  { width: 1440, overflow: false, inline: true, runLabel: true },
];

describe('header controls by width', () => {
  for (const row of LAYOUTS) {
    it(`${row.width}px: overflow=${row.overflow} inline=${row.inline}`, () => {
      setWidth(row.width);
      render(<Harness />);
      expect(!!screen.queryByTestId('header-overflow-trigger')).toBe(row.overflow);
      expect(!!screen.queryByTestId('header-controls-inline')).toBe(row.inline);
      expect(!!screen.queryByTestId('header-run-label')).toBe(row.runLabel);
      // the four buttons are inline on desktop, behind the menu on a phone
      for (const id of ['build-all-gsd-trigger', 'launch-popover-toggle', 'new-menu-trigger', 'display-menu-trigger']) {
        expect(!!screen.queryByTestId(id)).toBe(row.inline);
      }
    });
  }

  it('desktop keeps the inline order: health, Run, Batch build, Launch, New, Display', () => {
    setWidth(1440);
    render(<Harness />);
    const ids = [...screen.getByTestId('header-controls-inline').querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid'));
    const want = ['env-health-dot', 'header-run-label', 'build-all-gsd-trigger', 'launch-popover-toggle', 'new-menu', 'display-menu'];
    expect(want.map(w => ids.indexOf(w))).toEqual([...want.map(w => ids.indexOf(w))].sort((a, b) => a - b));
    expect(want.every(w => ids.includes(w))).toBe(true);
  });

  it('phone keeps the connection signal as a dot, not a word', () => {
    setWidth(390);
    render(<Harness connected={false} />);
    expect(screen.getByTestId('header-disconnected-dot')).toBeTruthy();
    expect(screen.queryByText('disconnected')).toBeNull();
    expect(screen.getByTestId('env-health-dot')).toBeTruthy();
  });
});

describe('phone overflow menu items', () => {
  const open = () => { setWidth(390); const h = render(<Harness />); fireEvent.click(screen.getByTestId('header-overflow-trigger')); return h; };

  it('panel is fixed 8px inside both edges', () => {
    open();
    const cls = screen.getByTestId('header-overflow-panel').className;
    expect(cls).toMatch(/\bfixed\b/);
    expect(cls).toMatch(/\bleft-2\b/);
    expect(cls).toMatch(/\bright-2\b/);
  });

  // trigger testid, popover testid
  const ITEMS = [
    ['build-all-gsd-trigger', 'build-all-gsd-popover'],
    ['launch-popover-toggle', 'launch-popover'],
    ['new-menu-trigger', 'new-menu-popover'],
    ['display-menu-trigger', 'display-menu-popover'],
  ];
  for (const [trigger, popover] of ITEMS) {
    it(`${trigger} opens ${popover} in flow inside the panel`, () => {
      open();
      const panel = screen.getByTestId('header-overflow-panel');
      fireEvent.click(within(panel).getByTestId(trigger));
      const pop = within(panel).getByTestId(popover);
      expect(pop.className).toMatch(/\bstatic\b/);
      expect(pop.className).not.toMatch(/\babsolute\b/);
      expect(pop.className).toMatch(/\bw-full\b/);
    });
  }

  it('New items call their handler and close the menu', () => {
    setWidth(390);
    const onNewFeature = vi.fn();
    render(<Harness onNewFeature={onNewFeature} />);
    fireEvent.click(screen.getByTestId('header-overflow-trigger'));
    fireEvent.click(screen.getByTestId('new-menu-trigger'));
    fireEvent.click(screen.getByTestId('new-feature-toggle'));
    expect(onNewFeature).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('header-overflow-panel')).toBeNull();
  });

  it('Escape closes the menu', () => {
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('header-overflow-panel')).toBeNull();
  });
});
