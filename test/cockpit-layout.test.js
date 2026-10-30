/**
 * cockpit-layout.test.js
 *
 * TDD tests for COMP-UI-1: Cockpit shell layout logic.
 * Tests cover the pure-logic modules that back the cockpit UI:
 *   - agentBarState.js  — state machine for the collapsible agent bar
 *   (viewTabsState.js was retired by COMP-AUDIT-17: rooms are tested in nav-rooms.test.js)
 *
 * Tests use node:test (the project's existing test runner).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// These imports will FAIL until the modules are created (red phase).
import {
  AGENT_BAR_STATES,
  nextAgentBarState,
  collapseAgentBar,
  maximizeAgentBar,
  isValidAgentBarState,
  agentBarHeightClass,
} from '../src/components/cockpit/agentBarState.js';

// ---------------------------------------------------------------------------
// agentBarState
// ---------------------------------------------------------------------------

describe('agentBarState — state constants', () => {
  it('exports the three canonical states', () => {
    assert.equal(AGENT_BAR_STATES.COLLAPSED, 'collapsed');
    assert.equal(AGENT_BAR_STATES.EXPANDED, 'expanded');
    assert.equal(AGENT_BAR_STATES.MAXIMIZED, 'maximized');
    assert.equal(Object.keys(AGENT_BAR_STATES).length, 3);
  });
});

describe('agentBarState — nextAgentBarState (cycle)', () => {
  it('collapsed → expanded', () => {
    assert.equal(nextAgentBarState('collapsed'), 'expanded');
  });

  it('expanded → maximized', () => {
    assert.equal(nextAgentBarState('expanded'), 'maximized');
  });

  it('maximized → collapsed', () => {
    assert.equal(nextAgentBarState('maximized'), 'collapsed');
  });

  it('unknown state falls back to collapsed', () => {
    assert.equal(nextAgentBarState('bogus'), 'collapsed');
    assert.equal(nextAgentBarState(null), 'collapsed');
    assert.equal(nextAgentBarState(undefined), 'collapsed');
  });
});

describe('agentBarState — direct transitions', () => {
  it('collapseAgentBar always returns collapsed', () => {
    assert.equal(collapseAgentBar('expanded'), 'collapsed');
    assert.equal(collapseAgentBar('maximized'), 'collapsed');
    assert.equal(collapseAgentBar('collapsed'), 'collapsed');
  });

  it('maximizeAgentBar always returns maximized', () => {
    assert.equal(maximizeAgentBar('collapsed'), 'maximized');
    assert.equal(maximizeAgentBar('expanded'), 'maximized');
    assert.equal(maximizeAgentBar('maximized'), 'maximized');
  });
});

describe('agentBarState — isValidAgentBarState', () => {
  it('accepts all three valid states', () => {
    assert.equal(isValidAgentBarState('collapsed'), true);
    assert.equal(isValidAgentBarState('expanded'), true);
    assert.equal(isValidAgentBarState('maximized'), true);
  });

  it('rejects invalid values', () => {
    assert.equal(isValidAgentBarState('open'), false);
    assert.equal(isValidAgentBarState(''), false);
    assert.equal(isValidAgentBarState(null), false);
    assert.equal(isValidAgentBarState(undefined), false);
  });
});

describe('agentBarState — agentBarHeightClass', () => {
  it('collapsed returns a non-empty string', () => {
    const cls = agentBarHeightClass('collapsed');
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0, 'should return a CSS class/style descriptor');
  });

  it('expanded returns a non-empty string different from collapsed', () => {
    const collapsed = agentBarHeightClass('collapsed');
    const expanded = agentBarHeightClass('expanded');
    assert.equal(typeof expanded, 'string');
    assert.notEqual(expanded, collapsed);
  });

  it('maximized returns a non-empty string', () => {
    const cls = agentBarHeightClass('maximized');
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0);
  });
});
