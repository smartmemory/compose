/**
 * launch-popover.test.js — pure-logic test for buildLaunchPayload, the payload
 * shaper behind LaunchPopover's Fix / New / Resume modes (COMP-PARITY-2).
 *
 * Run: node --test test/launch-popover.test.js
 *
 * The helper lives in launchPopoverState.js (not the .jsx) so node --test can
 * import it without a JSX transform — same pattern as opsStripLogic.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchPayload } from '../src/components/cockpit/launchPopoverState.js';

describe('buildLaunchPayload — fix', () => {
  it('shapes a bug-fix payload from bug code + description', () => {
    const out = buildLaunchPayload('fix', { bugCode: 'BUG-7', description: 'crash on save' });
    assert.deepEqual(out, { args: { featureCode: 'BUG-7', mode: 'bug', description: 'crash on save' } });
  });

  it('trims the bug code and description', () => {
    const out = buildLaunchPayload('fix', { bugCode: '  BUG-7  ', description: '  hi  ' });
    assert.deepEqual(out.args, { featureCode: 'BUG-7', mode: 'bug', description: 'hi' });
  });

  it('defaults description to empty string when omitted', () => {
    const out = buildLaunchPayload('fix', { bugCode: 'BUG-7' });
    assert.deepEqual(out.args, { featureCode: 'BUG-7', mode: 'bug', description: '' });
  });

  it('does NOT include a resume flag for a fix', () => {
    const out = buildLaunchPayload('fix', { bugCode: 'BUG-7' });
    assert.equal('resume' in out.args, false);
  });

  it('errors when the bug code is empty', () => {
    const out = buildLaunchPayload('fix', { bugCode: '   ', description: 'x' });
    assert.ok(out.error);
    assert.match(out.error, /bug code/i);
    assert.equal('args' in out, false);
  });
});

describe('buildLaunchPayload — new', () => {
  it('shapes a new-product payload carrying the intent in description', () => {
    const out = buildLaunchPayload('new', { intent: 'a CLI tool' });
    assert.deepEqual(out, { args: { mode: 'new', description: 'a CLI tool' } });
  });

  it('does NOT include a featureCode for a new build', () => {
    const out = buildLaunchPayload('new', { intent: 'a CLI tool' });
    assert.equal('featureCode' in out.args, false);
  });

  it('trims the intent', () => {
    const out = buildLaunchPayload('new', { intent: '   build me a thing   ' });
    assert.equal(out.args.description, 'build me a thing');
  });

  it('errors when the intent is empty', () => {
    const out = buildLaunchPayload('new', { intent: '   ' });
    assert.ok(out.error);
    assert.match(out.error, /intent/i);
    assert.equal('args' in out, false);
  });
});

describe('buildLaunchPayload — resume', () => {
  it('shapes a resume payload from the resumable code with resume:true', () => {
    const out = buildLaunchPayload('resume', { resumableCode: 'BUG-7' });
    assert.deepEqual(out, { args: { featureCode: 'BUG-7', mode: 'bug', resume: true } });
  });

  it('errors when there is no active fix to resume', () => {
    const out = buildLaunchPayload('resume', { resumableCode: '' });
    assert.ok(out.error);
    assert.match(out.error, /resume/i);
    assert.equal('args' in out, false);
  });
});
